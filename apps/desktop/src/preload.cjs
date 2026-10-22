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
  getSettings: () => ipcRenderer.invoke('settings:get'),
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
  onCommand: subscribe('automix:command', (v) => ['toggle', 'pause', 'next', 'prev'].includes(v)),
  onBackend: subscribe('automix:backend', (v) => typeof v === 'string'),
  onImport: subscribe('automix:import', (v) => v && typeof v.done === 'number'),
});
