(() => {
  if (location.origin !== 'http://127.0.0.1:__MORA_PORT__') return;
  const token = '__MORA_ACCESS_TOKEN__';
  document.cookie = `am_token=${token}; Path=/; SameSite=Strict`;
  const invoke = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Access-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body, (_key, value) => value instanceof Float32Array ? Array.from(value) : value) }) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Ошибка настольного приложения');
    return value;
  };
  const native = operation => (...args) => invoke(`/api/desktop/native-mix/${operation}`, args);
  const audioListeners = new Set();
  const backendListeners = new Set();
  const importListeners = new Set();
  let importing = false;
  let failedTimer;
  const events = new EventSource('/api/desktop/audio-events');
  events.onopen = () => { clearTimeout(failedTimer); failedTimer = undefined; for (const fn of backendListeners) fn('ready'); };
  events.onerror = () => {
    if (importing) return;
    if (!failedTimer) {
      for (const fn of backendListeners) fn('restarting');
      failedTimer = setTimeout(() => { for (const fn of backendListeners) fn('failed'); }, 30000);
    }
  };
  events.onmessage = e => {
    try { const value = JSON.parse(e.data); for (const fn of audioListeners) fn(value); } catch { /* invalid event */ }
  };
  const shell = (action, value) => window.__TAURI_INTERNALS__.invoke('desktop_action', { action, value });
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.titlebar, .fp-top') ||
        event.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    event.preventDefault();
    void shell(event.detail === 2 ? 'window-maximize' : 'window-drag').catch(() => {});
  });
  const subscribe = listeners => callback => {
    if (typeof callback !== 'function') return () => {};
    listeners.add(callback); return () => listeners.delete(callback);
  };
  const compactListeners = new Set();
  Object.defineProperty(window, '__moraImportProgress', { value: value => {
    if (value && Number.isFinite(value.done) && Number.isFinite(value.total)) for (const fn of importListeners) fn(value);
  } });
  const noEvents = () => () => {};
  const update = { phase: 'disabled', currentVersion: '__MORA_VERSION__', version: null, size: null, percent: 0, error: null };
  window.automixDesktop = {
    windowCommand: action => shell(`window-${action}`),
    nativeMix: {
      startStation: native('startStation'), setStation: native('setStation'), startSource: native('startSource'),
      prepareQueue: (from, entries, previousId, loop, _signal, replaceFuture, manifest) => native('prepareQueue')(from, entries, previousId, loop, replaceFuture, manifest),
      settings: native('settings'), stop: native('stop'), state: native('state'), command: native('command'),
    },
    audioStart: device => invoke('/api/desktop/audio-start', { device }),
    audioCommand: command => invoke('/api/desktop/audio-command', command), audioStop: () => invoke('/api/desktop/audio-stop', {}),
    audioDevices: () => invoke('/api/desktop/audio-devices'), onAudio: subscribe(audioListeners),
    getSettings: async () => ({ ...await invoke('/api/desktop/settings'), ...await shell('window-settings') }),
    appUpdateStatus: async () => update, appUpdateCheck: async () => update, appUpdateDownload: async () => update,
    appUpdateCancel: async () => update, appUpdateInstall: async () => update, onAppUpdate: noEvents,
    resolverStatus: () => invoke('/api/desktop/resolver'), resolverCheck: () => invoke('/api/desktop/resolver/check', {}),
    resolverInstall: () => invoke('/api/desktop/resolver/install', {}), resolverRollback: () => invoke('/api/desktop/resolver/rollback', {}),
    setCloseToTray: value => shell('close-to-tray', value === true), pickFolder: () => shell('pick-folder'),
    openDataFolder: () => shell('open-data-folder'), importLibrary: async () => {
      importing = true; for (const fn of backendListeners) fn('importing');
      try { return await shell('import-library'); }
      finally { importing = false; if (events.readyState === EventSource.OPEN) for (const fn of backendListeners) fn('ready'); }
    },
    restartBackend: () => shell('restart-backend'),
    setCompact: async (on, onTop) => {
      const result = await shell('compact', { on: on === true, onTop: onTop !== false });
      for (const fn of compactListeners) fn(result.on);
      return result;
    },
    setTitlebarOverlay: transparent => shell('overlay', transparent === true), onCompact: subscribe(compactListeners),
    reportPlayer: state => { void shell('player-state', { playing: state?.playing === true,
      title: String(state?.title ?? '').slice(0, 200), artist: String(state?.artist ?? '').slice(0, 200) }).catch(() => {}); },
    reportMediaTrack: track => { void invoke('/api/desktop/media-track', track).catch(() => {}); },
    onCommand: noEvents, onSeek: noEvents, onBackend: subscribe(backendListeners), onImport: subscribe(importListeners),
  };
})();
