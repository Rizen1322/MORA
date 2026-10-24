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
  getSettings(): Promise<{ closeToTray: boolean; dataDir: string; version: string; backend: string; compact: boolean; compactOnTop: boolean }>;
  setCompact(on: boolean, onTop?: boolean): Promise<{ on: boolean; onTop: boolean }>;
  setTitlebarOverlay(transparent: boolean): Promise<{ transparent: boolean }>;
  onCompact(cb: (on: boolean) => void): () => void;
  setCloseToTray(value: boolean): Promise<{ closeToTray: boolean }>;
  pickFolder(): Promise<string | null>;
  openDataFolder(): Promise<string>;
  importLibrary(): Promise<{ status: 'done' | 'cancelled' | 'error'; message?: string }>;
  restartBackend(): Promise<void>;
  reportPlayer(s: { playing: boolean; title: string; artist: string }): void;
  onCommand(cb: (cmd: 'toggle' | 'pause' | 'next' | 'prev') => void): () => void;
  onBackend(cb: (state: 'ready' | 'restarting' | 'importing' | 'failed' | 'starting') => void): () => void;
  onImport(cb: (p: { done: number; total: number }) => void): () => void;
}

declare global {
  interface Window { automixDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | null = typeof window === 'undefined' ? null : window.automixDesktop ?? null;
