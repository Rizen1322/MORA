/** Enabled only by the diagnostic iOS shell. Shared through window across the two JS bundles. */
export type TraceFields = Record<string, string | number | boolean | undefined>;
export type NavigationRoute = 'webkit' | 'native';
export interface NativeProbeState { active: boolean; playing: boolean; index: number; position: number; duration: number }
export interface NativeProbe {
  start(): Promise<NativeProbeState>;
  stop(): Promise<void>;
  state(): Promise<NativeProbeState>;
  command(action: MediaSessionAction, seekTime?: number): Promise<NativeProbeState>;
}
export interface NativePlaybackControls {
  mix?: import('./native-mix.ts').NativeMix;
  mixActive?: boolean;
  ready?: Promise<void>;
  route: NavigationRoute;
  contextState?: string;
  snapshot?: () => TraceFields;
  suspend?: () => Promise<void>;
  probeActive?: boolean;
  probe?: NativeProbe;
  setRoute(route: NavigationRoute): Promise<void>;
}
export interface PlaybackDiagnostics {
  currentId?: string;
  allowAutoResume: boolean;
  nextId(): string;
  record(stage: string, fields?: TraceFields): void;
  mark(): Promise<void>;
  report(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
  share(): Promise<void>;
  test(action: MediaSessionAction, seekTime?: number): Promise<void>;
  setAutoResume(enabled: boolean): void;
}
declare global { interface Window { moraDiagnostics?: PlaybackDiagnostics; moraNativePlayback?: NativePlaybackControls } }
export function nativePlaybackControls(): NativePlaybackControls | undefined {
  return typeof window === 'undefined' ? undefined : window.moraNativePlayback;
}
export function playbackDiagnostics(): PlaybackDiagnostics | undefined {
  return typeof window === 'undefined' ? undefined : window.moraDiagnostics;
}
export function tracePlayback(stage: string, fields: TraceFields = {}): void {
  const d = playbackDiagnostics();
  d?.record(stage, { id: d.currentId, ...fields });
}
export function withPlaybackId<T>(id: string, fn: () => T): T {
  const d = playbackDiagnostics();
  if (!d) return fn();
  const previous = d.currentId;
  d.currentId = id;
  try { return fn(); } finally { d.currentId = previous; }
}

// No titles, URLs, provider IDs, tokens, arbitrary errors or device names enter the journal.
const numbers = new Set(['seq', 'position', 'seekTime', 'clock', 'peak', 'monotonicMs', 'duration', 'rate']);
const flags = new Set(['paused', 'starved', 'hidden', 'allowed', 'playing', 'intentPlaying', 'webAudioSession', 'seekable', 'node', 'probeActive']);
const codes = new Set(['id', 'action', 'command', 'status', 'context', 'source', 'reason', 'outcome', 'route', 'kind', 'mediaState']);
export function safeTraceFields(fields: TraceFields): TraceFields {
  const result: TraceFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    if (flags.has(key) && typeof value === 'boolean') result[key] = value;
    if (codes.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)) result[key] = value;
  }
  return result;
}
