/** Bridge to the Windows shell (apps/desktop/src/preload.cjs); null in a browser. */
export interface ResolverStatus { selected: string; latest: string | null; canRollback: boolean; busy: boolean }
export interface AppUpdateStatus {
  phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  version: string | null;
  size: number | null;
  percent: number;
  error: string | null;
}
export interface DesktopBridge {
  nativeMix?: Pick<import('./native-mix.ts').NativeMix, 'startSource' | 'startStation' | 'setStation' | 'prepareQueue' | 'settings' | 'stop' | 'state' | 'command'>;
  audioStart?(device?: string): Promise<{ sampleRate: number; engine: 'rust'; queueFrames: number }>;
  audioCommand?(command: import('../audio/engine.worklet.ts').EngineCommand | { cmd: 'output'; device: string } | { cmd: 'suspend' | 'resume' }): Promise<void>;
  audioStop?(): Promise<void>;
  audioDevices?(): Promise<{ deviceId: string; label: string }[]>;
  onAudio?(cb: (event: import('../audio/engine.worklet.ts').EngineEvent | { type: 'fatal'; error: string } | { type: 'waveform'; samples: number[] }) => void): () => void;
  appUpdateStatus(): Promise<AppUpdateStatus>;
  appUpdateCheck(): Promise<AppUpdateStatus>;
  appUpdateDownload(): Promise<AppUpdateStatus>;
  appUpdateCancel(): Promise<AppUpdateStatus>;
  appUpdateInstall(): Promise<AppUpdateStatus>;
  onAppUpdate(cb: (status: AppUpdateStatus) => void): () => void;
  resolverStatus(): Promise<ResolverStatus>;
  resolverCheck(): Promise<ResolverStatus>;
  resolverInstall(): Promise<ResolverStatus>;
  resolverRollback(): Promise<ResolverStatus>;
  getSettings(): Promise<{ closeToTray: boolean; dataDir: string; version: string; backend: string; compact: boolean; compactOnTop: boolean;
    audio?: Pick<import('./native-mix.ts').NativeMixSettings, 'tone' | 'preDb' | 'playback' | 'volume' | 'muted'> & { outputDevice: string } }>;
  setCompact(on: boolean, onTop?: boolean): Promise<{ on: boolean; onTop: boolean }>;
  setTitlebarOverlay(transparent: boolean): Promise<{ transparent: boolean }>;
  onCompact(cb: (on: boolean) => void): () => void;
  setCloseToTray(value: boolean): Promise<{ closeToTray: boolean }>;
  pickFolder(): Promise<string | null>;
  openDataFolder(): Promise<string>;
  importLibrary(): Promise<{ status: 'done' | 'cancelled' | 'error'; message?: string }>;
  restartBackend(): Promise<void>;
  reportPlayer(s: { playing: boolean; title: string; artist: string }): void;
  reportMediaTrack?(s: { token: string; title: string; artist: string; album: string; coverUrl: string | null }): void;
  onCommand(cb: (cmd: 'toggle' | 'play' | 'pause' | 'next' | 'prev') => void): () => void;
  onSeek?(cb: (position: number) => void): () => void;
  onBackend(cb: (state: 'ready' | 'restarting' | 'importing' | 'failed' | 'starting') => void): () => void;
  onImport(cb: (p: { done: number; total: number }) => void): () => void;
}

declare global {
  interface Window { automixDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | null = typeof window === 'undefined' ? null : window.automixDesktop ?? null;
