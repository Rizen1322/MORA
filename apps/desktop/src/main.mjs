// MORA desktop shell: owns the window, tray, system integration and the
// backend utility process. Audio stays in the renderer's AudioWorklet; closing
// to the tray only hides the window, so there is exactly one transport.
import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, safeStorage, screen, session, shell, utilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeWindow } from './bounds.mjs';
import { proxyFromPac } from './public-network.mjs';
import { publishLibrary } from './publish.mjs';
import { ResolverUpdater } from './resolver-update.mjs';
import electronUpdater from 'electron-updater';
import { AppUpdates } from './app-update.mjs';
import { watchPower } from './idle-power.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : path.join(here, '..', 'build');
const assets = path.join(here, '..', 'assets');

// Caches reach many GB: keep the profile in Local AppData, not Roaming.
// AUTOMIX_PROFILE_DIR gives tests an isolated profile and data folder.
app.setPath('userData', process.env.AUTOMIX_PROFILE_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MORA'));
app.setAppUserModelId('ru.mora.desktop');

const DEFAULT_SIZE = { width: 1280, height: 820 };
const MIN_SIZE = { width: 960, height: 680 };
const TITLEBAR_H = 40;
const BG = '#050d0a';
const TITLEBAR_SYMBOL = '#b3c9bb';
// Only the local service; remote cover art may be https. No eval, no plugins, no framing.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

let win = null;
let tray = null;
let quitting = false;
let backend = null; // { proc, port, ready }
let powerWatch = null;
let origin = null;
let crashTimes = [];
let backendState = 'starting';
let player = { playing: false, title: '', artist: '' };
let appUpdates;
let updateConfirmation = false;

const userData = app.getPath('userData');
const settingsFile = path.join(userData, 'desktop.json');
const settings = Object.assign({ closeToTray: true, trayHintShown: false, window: null, dataDir: null, stemsPython: null }, readJson(settingsFile));
const dataDir = settings.dataDir || path.join(userData, 'data');
const launchToken = crypto.randomBytes(32).toString('hex');
const resolverUpdater = new ResolverUpdater({ directory: path.join(userData, 'resolver-updates'), bundled: path.join(resources, 'yt-dlp', 'yt-dlp.exe') });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const saveSettings = () => writeJsonAtomic(settingsFile, settings);

/** 32-byte key for provider secrets, stored encrypted with DPAPI via safeStorage. */
function secretKey() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const file = path.join(userData, 'secret.bin');
  try {
    const key = safeStorage.decryptString(fs.readFileSync(file));
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  } catch { /* first run or unreadable: create a new key below */ }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, safeStorage.encryptString(key));
  return key;
}

// ------------------------------------------------------------------ logging

const logDir = path.join(userData, 'logs');
let logStream = null;
function log(line) {
  if (!logStream) {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'automix.log');
    try { if (fs.statSync(file).size > 5 << 20) fs.renameSync(file, `${file}.old`); } catch { /* none yet */ }
    logStream = fs.createWriteStream(file, { flags: 'a' });
  }
  logStream.write(`${new Date().toISOString()} ${String(line).replaceAll(launchToken, '***')}\n`);
}

// ------------------------------------------------------------------ backend

/** Finishes or discards a library import interrupted by a crash or power loss. */
function recoverDataDir() {
  const staging = `${dataDir}.importing`;
  if (!fs.existsSync(staging)) return;
  if (fs.existsSync(path.join(staging, '.import-complete')) && !fs.existsSync(dataDir)) {
    fs.renameSync(staging, dataDir);
    fs.rmSync(path.join(dataDir, '.import-complete'), { force: true });
    log('import: finished interrupted publish');
  } else {
    fs.rmSync(staging, { recursive: true, force: true });
    log('import: removed incomplete staging folder');
  }
}

async function startBackend(port = 0) {
  const resolve = async (url) => {
    let timer;
    try {
      return proxyFromPac(await Promise.race([
        session.defaultSession.resolveProxy(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('proxy timeout')), 3000); }),
      ]));
    } catch { return undefined; } finally { clearTimeout(timer); }
  };
  const [youtubeProxy, soundcloudProxy] = await Promise.all([
    resolve('https://www.youtube.com/'), resolve('https://soundcloud.com/'),
  ]);
  const ff = path.join(resources, 'ffmpeg');
  const key = secretKey();
  const env = { ...process.env };
  for (const k of ['HOST', 'PORT', 'ACCESS_TOKEN', 'AUTOMIX_DATA_DIR', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  Object.assign(env, {
    AUTOMIX_DESKTOP: '1',
    AUTOMIX_ROOT: resources,
    AUTOMIX_WEB_DIST: path.join(resources, 'web'),
    AUTOMIX_ANALYSIS_WORKER: path.join(resources, 'backend', 'analysisWorker.mjs'),
    AUTOMIX_DATA_DIR: dataDir,
    AUTOMIX_LAUNCH_TOKEN: launchToken,
    AUTOMIX_PORT: String(port),
    FFMPEG_PATH: path.join(ff, 'ffmpeg.exe'),
    FFPROBE_PATH: path.join(ff, 'ffprobe.exe'),
    // Public sources: bundled yt-dlp; its JS challenges run on this app's own Electron binary (Node mode).
    YTDLP_PATH: resolverUpdater.executable(),
    STEMS_PYTHON: settings.stemsPython || '',
  });
  if (youtubeProxy !== undefined) env.AUTOMIX_YOUTUBE_PROXY = youtubeProxy;
  if (soundcloudProxy !== undefined) env.AUTOMIX_SOUNDCLOUD_PROXY = soundcloudProxy;
  if (key) env.AUTOMIX_SECRET_KEY = key;
  else log('safeStorage unavailable: provider secrets stay unencrypted');

  const proc = utilityProcess.fork(path.join(resources, 'backend', 'backend.mjs'), [], { serviceName: 'MORA Backend', stdio: 'pipe', env });
  proc.stdout?.on('data', (d) => log(`[backend] ${d.toString().trimEnd()}`));
  proc.stderr?.on('data', (d) => log(`[backend:err] ${d.toString().trimEnd()}`));
  const b = { proc, port: 0, stopping: false };
  b.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend start timeout')), 90_000);
    proc.on('message', (m) => {
      if (m?.type === 'ready') { clearTimeout(timer); b.port = m.port; resolve(m.port); powerWatch?.resend(); }
      else if (m?.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`backend exited with ${code}`)); });
  });
  proc.once('exit', (code) => onBackendExit(b, code));
  backend = b;
  return b.ready;
}

function stopBackend(timeoutMs = 8000) {
  const b = backend;
  if (!b) return Promise.resolve();
  b.stopping = true;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { log('backend did not stop in time, killing'); b.proc.kill(); resolve(); }, timeoutMs);
    b.proc.once('exit', done);
    try { b.proc.postMessage({ type: 'shutdown' }); } catch { done(); }
  });
}

function setBackendState(state) {
  backendState = state;
  win?.webContents.send('automix:backend', state);
}

function onBackendExit(b, code) {
  log(`backend exited with code ${code}`);
  if (backend === b) backend = null;
  if (b.stopping || quitting || !b.port) return; // a failed start is reported by startBackend
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 5 * 60_000).concat(now);
  // Bounded recovery: three crashes in five minutes stop automatic restarts.
  if (crashTimes.length > 3) { setBackendState('failed'); return; }
  setBackendState('restarting');
  setTimeout(() => void restartBackend(b.port), 1000 * crashTimes.length);
}

async function restartBackend(port) {
  try {
    const p = await startBackend(port);
    if (p !== port) await openApp(p); // the old port was taken: the page must move
    else setBackendState('ready');
  } catch (e) {
    log(`backend restart failed: ${e.message}`);
    setBackendState('failed');
  }
}

// ------------------------------------------------------------------ window

let saveTimer = null;
/** Compact mini-player: the same window shrunk, so there is still one audio engine. */
let compact = null; // { bounds, maximized } of the full window while compact
function rememberWindow() {
  if (!win || win.isDestroyed() || win.isMinimized() || compact) return;
  settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 400);
}

function createWindow() {
  const bounds = placeWindow(settings.window, screen.getAllDisplays().map((d) => d.workArea), screen.getPrimaryDisplay().workArea, DEFAULT_SIZE);
  const area = screen.getDisplayMatching(bounds).workArea;
  win = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(MIN_SIZE.width, area.width),
    minHeight: Math.min(MIN_SIZE.height, area.height),
    show: false,
    title: 'MORA',
    icon: path.join(assets, 'icon.ico'),
    backgroundColor: BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: TITLEBAR_SYMBOL, height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.AUTOMIX_DEVTOOLS === '1',
    },
  });
  if (settings.window?.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberWindow);
  win.on('close', (e) => {
    log(`close requested (quitting=${quitting}, tray=${settings.closeToTray})`);
    rememberWindow();
    saveSettings();
    if (quitting || !settings.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      settings.trayHintShown = true;
      saveSettings();
      tray?.displayBalloon({ iconType: 'info', title: 'MORA продолжает играть', content: 'Музыка не прерывается. Выйти можно через значок MORA в области уведомлений.' });
    }
  });
  win.on('closed', () => { win = null; });
  // Mouse back/forward buttons navigate inside the app.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
    if (cmd === 'browser-forward' && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`));
}

/** The caption buttons are native and sit above the page. Over the full player
    their strip becomes transparent, so the artwork shows through instead of a
    dark rectangle painted by the fixed overlay color. */
function titlebarOverlay(transparent) {
  if (!win || win.isDestroyed()) return { transparent: false };
  win.setTitleBarOverlay({ color: transparent === true ? '#00000000' : BG, symbolColor: TITLEBAR_SYMBOL, height: TITLEBAR_H });
  return { transparent: transparent === true };
}

function showWindow() {
  if (!win) { createWindow(); if (origin) void win.loadURL(`${origin}/`); else void showError(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function openApp(port) {
  origin = `http://127.0.0.1:${port}`;
  // The page never sees the token: it is added to its own requests here.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (d, cb) => {
    d.requestHeaders['X-Access-Token'] = launchToken;
    cb({ requestHeaders: d.requestHeaders });
  });
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (d, cb) => {
    d.responseHeaders['Content-Security-Policy'] = [CSP];
    cb({ responseHeaders: d.responseHeaders });
  });
  setBackendState('ready');
  if (win) await win.loadURL(`${origin}/`);
}

async function showError() {
  origin = null;
  setBackendState('failed');
  await win?.loadFile(path.join(here, 'error.html'));
}

// ------------------------------------------------------------------ tray

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: player.title ? `${player.title}${player.artist ? ` — ${player.artist}` : ''}`.slice(0, 60) : 'MORA', enabled: false },
    { type: 'separator' },
    { label: player.playing ? 'Пауза' : 'Слушать', click: () => command('toggle') },
    { label: 'Следующий трек', click: () => command('next') },
    { label: 'Предыдущий трек', click: () => command('prev') },
    { type: 'separator' },
    { label: 'Открыть MORA', click: showWindow },
    { label: 'Закрывать окно в трей', type: 'checkbox', checked: settings.closeToTray, click: (i) => { settings.closeToTray = i.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(player.title ? `MORA — ${player.title}${player.artist ? ` — ${player.artist}` : ''}`.slice(0, 127) : 'MORA');
  tray.setContextMenu(trayMenu());
}

function command(cmd) {
  win?.webContents.send('automix:command', cmd);
}

// Chromium publishes a Windows media session (SMTC) only for <audio>/<video>
// players, not for Web Audio output, so hardware media keys never reach
// navigator.mediaSession here. Take them globally while a track is loaded.
const MEDIA_KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'pause' };
let mediaKeysOn = false;
let mediaKeysRetry = null;
function setMediaKeys(on) {
  if (on === mediaKeysOn) return;
  mediaKeysOn = on;
  clearTimeout(mediaKeysRetry);
  if (!on) { for (const key of Object.keys(MEDIA_KEYS)) globalShortcut.unregister(key); return; }
  const grab = () => {
    let missing = 0;
    for (const [key, cmd] of Object.entries(MEDIA_KEYS)) {
      if (!globalShortcut.isRegistered(key) && !globalShortcut.register(key, () => command(cmd))) missing++;
    }
    // Another player may hold the keys for a while; try again instead of giving up.
    if (missing && mediaKeysOn) mediaKeysRetry = setTimeout(grab, 30_000);
    if (missing) log(`media keys held by another app: ${missing}`);
  };
  grab();
}

// ------------------------------------------------------------------ IPC

/** Only our own page (or the local error page) may call the bridge. */
function trusted(e) {
  const url = e.senderFrame?.url ?? '';
  return (origin && url.startsWith(`${origin}/`)) || url.startsWith('file:');
}

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('недоступно');
    return fn(...args);
  });
}

function registerIpc() {
  handle('app-update:status', () => appUpdates.status());
  handle('app-update:check', () => appUpdates.check());
  handle('app-update:download', () => appUpdates.download());
  handle('app-update:cancel', () => appUpdates.cancel());
  handle('app-update:install', async () => {
    if (updateConfirmation || quitting) return appUpdates.status();
    if (backendState === 'importing') throw new Error('Дождитесь окончания переноса медиатеки');
    if (appUpdates.status().phase !== 'downloaded') throw new Error('Сначала скачайте обновление');
    updateConfirmation = true;
    try {
      const answer = await dialog.showMessageBox(win, { type: 'question',
        title: 'Обновление MORA', message: `Установить MORA ${appUpdates.status().version}?`,
        detail: 'Музыка остановится, MORA закроется и запустится после установки. Медиатека и настройки сохранятся.',
        buttons: ['Установить и перезапустить', 'Позже'], defaultId: 1, cancelId: 1 });
      if (answer.response === 0 && !quitting) {
        if (backendState === 'importing') throw new Error('Дождитесь окончания переноса медиатеки');
        return appUpdates.install();
      }
      return appUpdates.status();
    } finally { updateConfirmation = false; }
  });
  handle('resolver:status', () => resolverUpdater.status());
  handle('resolver:check', () => resolverUpdater.check());
  handle('resolver:install', () => resolverUpdater.install());
  handle('resolver:rollback', () => resolverUpdater.rollback());
  handle('settings:get', () => ({ closeToTray: settings.closeToTray, dataDir, version: app.getVersion(), backend: backendState, compact: !!compact, compactOnTop: settings.compactOnTop !== false }));
  handle('settings:set', (patch) => {
    if (patch && typeof patch.closeToTray === 'boolean') settings.closeToTray = patch.closeToTray;
    saveSettings();
    updateTray();
    return { closeToTray: settings.closeToTray };
  });
  handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Папка с музыкой', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('data:open', () => shell.openPath(dataDir));
  handle('backend:restart', async () => {
    crashTimes = [];
    await stopBackend();
    setBackendState('restarting');
    try { await openApp(await startBackend(0)); } catch (e) { log(`manual restart failed: ${e.message}`); await showError(); }
  });
  handle('library:import', importLibrary);
  handle('window:compact', (opts) => {
    if (!win) return { on: false };
    const on = opts?.on === true;
    const onTop = opts?.onTop !== false;
    if (on && !compact) {
      compact = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
      if (win.isMaximized()) win.unmaximize();
      win.setMinimumSize(320, 150);
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setBounds({ width: 420, height: 176, x: area.x + area.width - 440, y: area.y + area.height - 196 });
    } else if (!on && compact) {
      const back = compact;
      compact = null;
      win.setAlwaysOnTop(false);
      const area = screen.getDisplayMatching(back.bounds).workArea;
      win.setMinimumSize(Math.min(MIN_SIZE.width, area.width), Math.min(MIN_SIZE.height, area.height));
      win.setBounds(back.bounds);
      if (back.maximized) win.maximize();
    }
    if (compact) win.setAlwaysOnTop(onTop, 'floating');
    settings.compactOnTop = onTop;
    saveSettings();
    win.webContents.send('automix:compact', !!compact);
    return { on: !!compact, onTop };
  });
  handle('window:overlay', (transparent) => titlebarOverlay(transparent));
  ipcMain.on('player:state', (e, s) => {
    if (!trusted(e) || !s || typeof s !== 'object') return;
    const next = { playing: s.playing === true, title: String(s.title ?? '').slice(0, 200), artist: String(s.artist ?? '').slice(0, 200) };
    if (next.playing === player.playing && next.title === player.title && next.artist === player.artist) return;
    player = next;
    setMediaKeys(!!next.title);
    updateTray();
  });
}

// ------------------------------------------------------------------ library import

async function importLibrary() {
  const pick = await dialog.showOpenDialog(win, { title: 'Папка медиатеки (с файлом automix.sqlite)', properties: ['openDirectory'] });
  if (pick.canceled) return { status: 'cancelled' };
  const source = pick.filePaths[0];
  if (path.resolve(source) === path.resolve(dataDir)) return { status: 'error', message: 'Это уже текущая медиатека приложения' };
  if (!fs.existsSync(path.join(source, 'automix.sqlite'))) return { status: 'error', message: 'В папке нет automix.sqlite — это не медиатека MORA/AutoMix' };
  const answer = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Импортировать', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'Импорт медиатеки',
    message: 'Перенести медиатеку в MORA?',
    detail: `Источник: ${source}\n\nКопируются база, треки, обложки и готовые вокальные партии. Исходная папка не изменяется. Текущая медиатека приложения сохраняется резервной копией рядом с ней. Временный кэш воспроизведения и отчёты не копируются.\n\nНа время импорта музыка остановится.`,
  });
  if (answer.response !== 0) return { status: 'cancelled' };

  const staging = `${dataDir}.importing`;
  fs.rmSync(staging, { recursive: true, force: true });
  setBackendState('importing');
  await stopBackend();
  let result;
  try {
    await new Promise((resolve, reject) => {
      const proc = utilityProcess.fork(path.join(here, 'migrate.mjs'), [source, staging, dataDir], { serviceName: 'MORA Import', stdio: 'pipe' });
      proc.stderr?.on('data', (d) => log(`[import:err] ${d.toString().trimEnd()}`));
      proc.on('message', (m) => {
        if (m?.type === 'progress') { win?.setProgressBar(m.total ? m.done / m.total : 2); win?.webContents.send('automix:import', { done: m.done, total: m.total }); }
        else if (m?.type === 'done') resolve(m);
        else if (m?.type === 'error') reject(new Error(m.message));
      });
      proc.once('exit', (code) => code ? reject(new Error(`импорт прерван (код ${code})`)) : resolve());
    });
    await publishLibrary(fs, dataDir, staging, new Date().toISOString().replace(/[:.]/g, '-'));
    log(`import: published library from ${source}`);
    result = { status: 'done' };
  } catch (e) {
    log(`import failed: ${e.message}`);
    // Without a library in place, staging is the only copy left: recoverDataDir publishes it on next start.
    if (fs.existsSync(dataDir)) fs.rmSync(staging, { recursive: true, force: true });
    result = { status: 'error', message: e.message };
  } finally {
    win?.setProgressBar(-1);
  }
  try { await openApp(await startBackend(0)); } catch (e) { log(`start after import failed: ${e.message}`); await showError(); }
  return result;
}

// ------------------------------------------------------------------ app lifecycle

function hardenSessions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  app.on('web-contents-created', (_e, wc) => {
    const external = (url) => { if (/^https?:\/\//i.test(url) && !(origin && url.startsWith(`${origin}/`))) void shell.openExternal(url); };
    wc.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => {
      if (origin && url.startsWith(`${origin}/`)) return;
      e.preventDefault();
      external(url);
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });
}

async function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', showWindow);
  app.on('gpu-info-update',()=>log(`graphics ${JSON.stringify(app.getGPUFeatureStatus())}`));
  Menu.setApplicationMenu(null);
  await app.whenReady();
  appUpdates = new AppUpdates({ updater: electronUpdater.autoUpdater, currentVersion: app.getVersion(),
    enabled: app.isPackaged && process.platform === 'win32', onChange: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('automix:app-update', state);
    } });
  log(`start ${app.getVersion()} electron ${process.versions.electron} data ${dataDir}`);
  hardenSessions();
  registerIpc();
  recoverDataDir();

  tray = new Tray(nativeImage.createFromPath(path.join(assets, 'tray.png')));
  tray.on('click', showWindow);
  updateTray();

  createWindow();
  // idle + mains power lets the backend analyze the whole library (setting analysis.onlyWhenIdle)
  powerWatch = watchPower(powerMonitor, (s) => { try { backend?.proc.postMessage({ type: 'power', ...s }); } catch { /* backend restarting: resent when ready */ } });
  try {
    await openApp(await startBackend(0));
  } catch (e) {
    log(`backend failed: ${e.message}`);
    await showError();
  }

  // Stop music before Windows sleeps; never resume on wake by itself.
  powerMonitor.on('suspend', () => command('pause'));

  appUpdates.start();
  app.on('before-quit', () => { quitting = true; appUpdates.dispose(); });
  let stopped = false;
  app.on('will-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    stopped = true;
    globalShortcut.unregisterAll();
    powerWatch?.stop();
    tray?.destroy();
    void stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (!settings.closeToTray || quitting) app.quit(); });
}

void main();
