/** Messages between the page (bridge) and the in-app server worker. */

export type Body = string | ArrayBuffer | Blob | null;

/** Page → worker */
export type ToWorker =
  | { t: 'req'; id: number; method: string; url: string; headers: Record<string, string>; body: Body }
  | { t: 'abort'; id: number }
  | { t: 'rpc-res'; id: number; ok: true; value: unknown }
  | { t: 'rpc-res'; id: number; ok: false; error: string }
  | { t: 'lifecycle'; state: 'background' | 'foreground' }
  /** The phone is hot (thermal state serious+) or in Low Power Mode: skip optional work. */
  | { t: 'power'; saver: boolean }
  /** Key for provider secrets from the iOS Keychain (64 hex chars); null where there is none (browser). */
  | { t: 'secret-key'; key: string | null };

/** Worker → page */
export type FromWorker =
  | { t: 'ready' }
  | { t: 'boot-error'; error: string }
  | { t: 'head'; id: number; status: number; headers: Record<string, string> }
  | { t: 'chunk'; id: number; data: ArrayBuffer | string }
  | { t: 'end'; id: number }
  | { t: 'fail'; id: number; error: string }
  | { t: 'rpc'; id: number; op: 'fetch'; args: FetchArgs }
  | { t: 'rpc'; id: number; op: 'decode'; args: DecodeArgs }
  | { t: 'rpc-abort'; id: number };

export interface FetchArgs { url: string; method: string; headers: Record<string, string>; body: string | ArrayBuffer | null }
export interface FetchResult { status: number; url: string; headers: Record<string, string>; body: ArrayBuffer }

/** Decodes a whole encoded file to interleaved PCM at `sampleRate`. */
export interface DecodeArgs { bytes: ArrayBuffer; sampleRate: number; channels: number; format: 'f32le' | 's16le' }
export interface DecodeResult { pcm: ArrayBuffer; sourceRate: number; duration: number }
/** What the page sends back: one Float32 plane per channel (the worker interleaves, off the UI thread). */
export interface DecodedPlanes { planes: ArrayBuffer[]; sourceRate: number; duration: number }
