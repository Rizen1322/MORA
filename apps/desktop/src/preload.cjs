// Narrow bridge between the AutoMix page and the desktop shell. No Node APIs,
// no generic IPC: each call is a fixed channel with validated arguments.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, check) => (cb) => {
  if (typeof cb !== 'function') return () => {};
  const fn = (_e, value) => { if (check(value)) cb(value); };
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('automixDesktop', {
  nativeMix: {
    startSource: (entry, config) => ipcRenderer.invoke('native-mix:startSource', entry, config),
    prepareQueue: (from, entries, previousId, loopEntries, _signal, replaceFuture) => ipcRenderer.invoke('native-mix:prepareQueue', from, entries, previousId, loopEntries, replaceFuture),
    settings: (values) => ipcRenderer.invoke('native-mix:settings', values),
    stop: () => ipcRenderer.invoke('native-mix:stop'),
    state: () => ipcRenderer.invoke('native-mix:state'),
    command: (action, seekTime) => ipcRenderer.invoke('native-mix:command', action, seekTime),
  },
  audioStart: (device) => ipcRenderer.invoke('audio:start', device),
  audioCommand: (command) => ipcRenderer.invoke('audio:command', command),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  audioDevices: () => ipcRenderer.invoke('audio:devices'),
  onAudio: subscribe('automix:audio', (v) => v && typeof v.type === 'string'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  appUpdateStatus: () => ipcRenderer.invoke('app-update:status'),
  appUpdateCheck: () => ipcRenderer.invoke('app-update:check'),
  appUpdateDownload: () => ipcRenderer.invoke('app-update:download'),
  appUpdateCancel: () => ipcRenderer.invoke('app-update:cancel'),
  appUpdateInstall: () => ipcRenderer.invoke('app-update:install'),
  onAppUpdate: subscribe('automix:app-update', (v) => v && typeof v.phase === 'string' && typeof v.currentVersion === 'string'),
  resolverStatus: () => ipcRenderer.invoke('resolver:status'),
  resolverCheck: () => ipcRenderer.invoke('resolver:check'),
  resolverInstall: () => ipcRenderer.invoke('resolver:install'),
  resolverRollback: () => ipcRenderer.invoke('resolver:rollback'),
  setCloseToTray: (value) => ipcRenderer.invoke('settings:set', { closeToTray: value === true }),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  setCompact: (on, onTop) => ipcRenderer.invoke('window:compact', { on: on === true, onTop: onTop !== false }),
  setTitlebarOverlay: (transparent) => ipcRenderer.invoke('window:overlay', transparent === true),
  onCompact: subscribe('automix:compact', (v) => typeof v === 'boolean'),
  reportPlayer: (s) => ipcRenderer.send('player:state', { playing: s?.playing === true, title: String(s?.title ?? ''), artist: String(s?.artist ?? '') }),
  reportMediaTrack: (s) => ipcRenderer.send('player:track', { token: s?.token, title: s?.title, artist: s?.artist, album: s?.album, coverUrl: s?.coverUrl }),
  onCommand: subscribe('automix:command', (v) => ['toggle', 'play', 'pause', 'next', 'prev'].includes(v)),
  onSeek: subscribe('automix:seek', (v) => Number.isFinite(v) && v >= 0),
  onBackend: subscribe('automix:backend', (v) => typeof v === 'string'),
  onImport: subscribe('automix:import', (v) => v && typeof v.done === 'number'),
});
