// End-to-end check of the desktop app (dev or packaged) with an isolated profile.
// Measures start-up, first sound, memory/CPU, underruns; exercises tray/hidden
// playback, second instance, backend crash recovery, offline, quit and restore.
//
//   node apps/desktop/scripts/smoke.mjs --exe "apps/desktop/dist/win-unpacked/MORA.exe" --tracks <dir> --out <dir>
//
// Never point --profile at a real profile: the script imports, plays and quits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep, waitForPage } from './cdp.mjs';
import { captureWindow, closeMainWindow, cpuSeconds, pinWindow, placeWindow, processTable, tree } from './proctree.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const exe = arg('--exe', path.join(desktop, 'dist/win-unpacked/MORA.exe'));
const dev = exe.endsWith('electron.exe');
const out = path.resolve(arg('--out', path.join(os.tmpdir(), `automix-smoke-${Date.now()}`)));
const profile = path.resolve(arg('--profile', fs.mkdtempSync(path.join(os.tmpdir(), 'automix-profile-'))));
const tracksDir = arg('--tracks', path.join(root, 'examples/library'));
const hiddenSeconds = Number(arg('--hidden-seconds', 60));
const PORT = 9333;
fs.mkdirSync(out, { recursive: true });

const report = { exe, dev, profile, startedAt: new Date().toISOString(), machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}` }, steps: {} };
const step = (name, value) => { report.steps[name] = value; console.log(name, JSON.stringify(value)); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); };

function launch(extra = []) {
  const args = [...(dev ? [desktop] : []), `--remote-debugging-port=${PORT}`, ...extra];
  // Packaged runs get a bare PATH: no Node, Python or FFmpeg from this machine.
  const env = { ...process.env, AUTOMIX_PROFILE_DIR: profile };
  if (!dev) { env.PATH = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'); delete env.NODE_OPTIONS; delete env.PYTHONPATH; }
  const proc = spawn(exe, args, { env, stdio: 'ignore', windowsHide: false });
  return { proc, t0: performance.now() };
}

async function attach(t0) {
  const page = await waitForPage(PORT);
  const tPage = performance.now() - t0;
  const c = await connect(page.webSocketDebuggerUrl);
  await c.waitFor("!!document.querySelector('.sidebar') && !!document.querySelector('.main-inner')");
  const tUi = performance.now() - t0;
  await c.evaluate(`window.__underruns = 0; { const orig = automix.onEngine.bind(automix); automix.onEngine = (e) => { if (e.type === 'underrun') window.__underruns++; orig(e); }; } true`);
  return { c, tPage: Math.round(tPage), tUi: Math.round(tUi) };
}

const appTree = (pid) => tree(pid).filter((p) => p.name !== 'conhost.exe');
const summary = (t) => ({ totalWsMB: +t.reduce((n, p) => n + p.wsMB, 0).toFixed(1), totalPrivateMB: +t.reduce((n, p) => n + p.privateMB, 0).toFixed(1), processes: t.map(({ pid, type, wsMB, privateMB }) => ({ pid, type, wsMB, privateMB })) });

async function cpuOver(pid, ms) {
  const pids = appTree(pid).map((p) => p.pid);
  const a = cpuSeconds(pids);
  await sleep(ms);
  const b = cpuSeconds(pids);
  const types = Object.fromEntries(appTree(pid).map((p) => [p.pid, p.type]));
  return Object.fromEntries(pids.filter((p) => a[p] !== undefined && b[p] !== undefined).map((p) => [`${types[p] || 'proc'}#${p}`, +(((b[p] - a[p]) / (ms / 1000)) * 100).toFixed(2)]));
}

const state = (c) => c.evaluate('({ status: automix.state.status, position: automix.state.position, index: automix.state.index, queue: automix.state.queue.length, duration: automix.state.duration, underruns: window.__underruns, transition: !!automix.state.transition?.active, hidden: document.hidden })');

async function screenshot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
}

async function setBounds(c, b) {
  const dpr = await c.evaluate('devicePixelRatio');
  placeWindow(proc.pid, b.maximized ? { maximized: true } : { width: Math.round(b.width * dpr), height: Math.round(b.height * dpr) });
  await sleep(900);
  return c.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, overflowX: document.documentElement.scrollWidth > innerWidth })');
}

async function exited(proc, ms) {
  if (proc.exitCode !== null) return true;
  return Promise.race([new Promise((r) => proc.once('exit', () => r(true))), sleep(ms).then(() => false)]);
}

// ------------------------------------------------------------------ scenario

let { proc, t0 } = launch();
let { c, tPage, tUi } = await attach(t0);
pinWindow(proc.pid, true); // other windows must not occlude it while measuring
const health = await c.evaluate("fetch('/api/health').then((r) => r.json())");
step('coldStart', { windowPageMs: tPage, uiRenderedMs: tUi, ffmpeg: health.ffmpeg, title: await c.evaluate('document.title'), note: 'fresh profile; OS file cache may hold Electron binaries' });

// Import a folder with a Unicode name in place (same API as the folder picker).
const uni = path.join(out, 'Музыка — Ёлка ♪ тест');
fs.mkdirSync(uni, { recursive: true });
for (const f of fs.readdirSync(tracksDir).filter((f) => /\.(mp3|flac|m4a|ogg|opus|wav)$/i.test(f)).slice(0, 8)) fs.copyFileSync(path.join(tracksDir, f), path.join(uni, `трек ${f}`));
const imp = await c.evaluate(`fetch('/api/import/folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(uni)} }) }).then((r) => r.json())`);
await c.waitFor(`fetch('/api/library').then((r) => r.json()).then((l) => (l.tracks ?? l).length >= ${imp.total})`, { timeoutMs: 120_000 });
await sleep(1500);
step('analysisLoad', { imported: imp.total, unicodeFolder: uni, ...summary(appTree(proc.pid)), cpuPct: await cpuOver(proc.pid, 5000) });
await c.waitFor("fetch('/api/health').then((r) => r.json()).then((h) => !h.analysis.running && !h.analysis.queued)", { timeoutMs: 600_000, intervalMs: 1000 });
await sleep(5000);
step('idle', { ...summary(appTree(proc.pid)), cpuPct: await cpuOver(proc.pid, 10_000) });

// First sound: library already analysed, nothing decoded yet.
const ids = await c.evaluate("fetch('/api/library').then((r) => r.json()).then((l) => (l.tracks ?? l).map((t) => t.id))");
const tPlay = performance.now();
await c.evaluate(`automix.playTracks(${JSON.stringify(ids)}, 0, { type: 'library', label: 'Медиатека' }).then(() => true)`);
await c.waitFor("automix.state.status === 'playing' && automix.state.position > 0.05", { intervalMs: 20 });
step('firstSound', { ms: Math.round(performance.now() - tPlay), note: 'from playTracks() to playhead moving; includes engine init and first PCM window' });
await sleep(4000);
const u0 = (await state(c)).underruns;
step('playing', { ...summary(appTree(proc.pid)), cpuPct: await cpuOver(proc.pid, 10_000), state: await state(c), steadyUnderruns: (await state(c)).underruns - u0 });

// Backward seek after forward seek.
await c.evaluate('automix.seek(60), true');
await sleep(2500);
await c.evaluate('automix.seek(8), true');
await sleep(2500);
const afterSeek = await state(c);
step('seekBack', { ...afterSeek, ok: afterSeek.status === 'playing' && afterSeek.position > 8 && afterSeek.position < 14 });

// Transition into the next track.
const before = await state(c);
await c.evaluate(`automix.seek(${Math.max(0, before.duration - 40)}), true`);
await c.waitFor('automix.state.index === 1', { timeoutMs: 90_000, intervalMs: 250 });
await sleep(3000);
step('transition', await state(c));

// Pause while the next track is still loading must stick.
await c.evaluate(`automix.playTracks(${JSON.stringify(ids.slice(2))}, 0, { type: 'library', label: 'Медиатека' }); true`);
await c.waitFor("automix.state.status === 'loading'", { intervalMs: 5 });
await c.evaluate('automix.pause(), true');
await sleep(4000);
const p1 = await state(c);
await sleep(1500);
const p2 = await state(c);
step('pauseDuringLoad', { ...p2, ok: p2.status === 'paused' && Math.abs(p2.position - p1.position) < 0.01 });

// Close to tray: window hides, music continues, decorative work stops.
await c.evaluate('automix.resume().then(() => true)');
await sleep(2000);
const h0 = await state(c);
closeMainWindow(proc.pid);
await sleep(3000);
const hiddenCpu = await cpuOver(proc.pid, 15_000);
await sleep(Math.max(0, hiddenSeconds * 1000 - 18_000));
const h1 = await state(c);
step('hiddenInTray', { before: h0, after: h1, advancedSeconds: +(h1.position - h0.position + (h1.index !== h0.index ? h0.duration : 0)).toFixed(1), wallSeconds: hiddenSeconds, cpuPct: hiddenCpu, ...summary(appTree(proc.pid)) });

// Second launch: must not start a second app/backend, only show the window.
const second = launch();
const secondExited = await exited(second.proc, 15_000);
await sleep(1500);
const backends = appTree(proc.pid).filter((p) => p.type.includes('utility') && !p.type.includes('network') && !p.type.includes('audio') && !p.type.includes('storage'));
step('secondInstance', { secondExited, exitCode: second.proc.exitCode, visibleAgain: !(await c.evaluate('document.hidden')), utilityProcesses: backends.map((p) => p.type) });

// Backend crash: kill the Node service process and watch bounded recovery.
const nodeService = processTable().filter((p) => p.Name === path.basename(exe) && /node\.mojom\.NodeService/.test(p.CommandLine ?? '') && appTree(proc.pid).some((a) => a.pid === p.ProcessId));
const killed = nodeService.map((p) => p.ProcessId);
for (const pid of killed) process.kill(pid);
const tKill = performance.now();
await sleep(500);
await c.waitFor("fetch('/api/health').then((r) => r.ok).catch(() => false)", { timeoutMs: 60_000, intervalMs: 200 });
const recoveredMs = Math.round(performance.now() - tKill);
await sleep(5000);
step('backendCrash', { killed, recoveredMs, state: await state(c) });

// Offline renderer (all requests fail) for 10 s, then back.
await c.send('Network.enable');
await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(10_000);
const offline = await state(c);
await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const bannerShown = await c.evaluate("!!document.querySelector('#main > .toast.error')");
const back = await c.waitFor("!document.querySelector('#main > .toast.error')", { timeoutMs: 30_000 }).catch(() => false);
await sleep(3000);
step('offlineThenOnline', { offline, bannerShownWhileOffline: bannerShown, bannerClearedAfter: !!back, after: await state(c) });

// Window geometry and screenshots.
await c.evaluate("location.hash = '/'; true");
await sleep(800);
for (const [name, b] of [['min-960x680', { width: 960, height: 680 }], ['normal-1280x820', { width: 1280, height: 820 }], ['maximized', { maximized: true }]]) {
  const v = await setBounds(c, b);
  await sleep(600);
  await screenshot(c, `home-${name}`);
  captureWindow(proc.pid, path.join(out, `window-${name}.png`));
  step(`window-${name}`, v);
}
await setBounds(c, { width: 1280, height: 820 });
for (const route of ['library', 'liked', 'settings', 'wave']) {
  await c.evaluate(`location.hash = '/${route}'; true`);
  await sleep(1200);
  await screenshot(c, `${route}-1280x820`);
}
await c.evaluate("location.hash = '/'; true");

// Quit for real (as the tray "Выйти" does via app.quit) and check nothing is left.
const playingBeforeQuit = await state(c);
const pidsBeforeQuit = appTree(proc.pid).map((p) => p.pid);
await c.evaluate('window.automixDesktop.setCloseToTray(false).then(() => true)');
c.close();
closeMainWindow(proc.pid);
const quitOk = await exited(proc, 20_000);
await sleep(2000);
const alive = processTable().filter((p) => pidsBeforeQuit.includes(p.ProcessId)).map((p) => `${p.Name}#${p.ProcessId}`);
step('quit', { exited: quitOk, leftover: alive, playingBeforeQuit });

// Warm start and queue restore.
({ proc, t0 } = launch());
({ c, tPage, tUi } = await attach(t0));
await c.waitFor('automix.state.queue.length > 0', { timeoutMs: 20_000 }).catch(() => false);
const restored = await state(c);
step('warmStartAndRestore', { windowPageMs: tPage, uiRenderedMs: tUi, restored, ok: restored.queue === playingBeforeQuit.queue && restored.index === playingBeforeQuit.index && restored.status !== 'playing' });

// Disk caches.
const du = (p) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else n += fs.statSync(f).size; } }; if (fs.existsSync(p)) { if (fs.statSync(p).isFile()) return +(fs.statSync(p).size / 2 ** 20).toFixed(1); walk(p); } return +(n / 2 ** 20).toFixed(1); };
const data = path.join(profile, 'data');
step('diskMB', Object.fromEntries(['library', 'remote', 'covers', 'cache/pcm', 'cache/stems', 'automix.sqlite'].map((d) => [d, du(path.join(data, d))]).concat([['electronProfile', du(profile) - du(data)]])));

await c.evaluate('window.automixDesktop.setCloseToTray(false).then(() => true)');
closeMainWindow(proc.pid);
await exited(proc, 20_000);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`report: ${path.join(out, 'report.json')}`);
process.exit(0);
