import type { ArmedTransition } from '@automix/core/engine/mixer.ts';
import type { ToneSettings } from '@automix/core/dsp/tone.ts';
import type { PlaybackSettings } from '@automix/core/dsp/playback.ts';

export interface NativeMixTrack {
  trackId?: string;
  plan?: import('@automix/core').TransitionPlan;
  title: string;
  artist: string;
  totalFrames: number;
  gainDb: number;
  /** Uploaded PCM file key; defaults to the track's index. */
  file?: number;
  entryId?: string;
  /** DJ transition from the previous track into this one. */
  transition?: ArmedTransition;
  coverUrl?: string;
  artwork?: { base64: string; mime: string };
}
export interface NativeMixConfig {
  sampleRate: number;
  tracks: NativeMixTrack[];
  tone?: ToneSettings;
  preDb?: number;
  playback?: PlaybackSettings;
  volume?: number;
  userVolume?: number;
  muted?: boolean;
  position: number;
  index?: number;
  paused?: boolean;
}
export type NativeSourceConfig = Omit<NativeMixConfig, 'tracks' | 'index'> & { gainDb?: number };
export type NativeMixSettings = Pick<NativeMixConfig, 'tone' | 'preDb' | 'playback' | 'volume'> & { gainDb?: number; userVolume?: number; muted?: boolean };
export interface NativeMixState {
  queue?: NativeQueueEntry[];
  context?: import('./queue-types.ts').PlayContext | null;
  station?: NativeRadioConfig | null;
  listeningOwned?: boolean;
  repeat?: 'off' | 'all' | 'one';
  lastTransition?: { plan: import('@automix/core').TransitionPlan; outcome: Record<string, unknown>; at: number; logId?: number };
  active: boolean;
  playing: boolean;
  index: number;
  position: number;
  duration: number;
  sampleRate?: number;
  analysis?: { state: string; role?: string; toIndex?: number; stageSeconds?: number; queued?: number; failedCount?: number };
  /** Audible native overlap; null explicitly means that no transition is playing. */
  blend?: { index: number; progress: number } | null;
  preparation?: { state: string; ready: number; remaining: number; reason?: string; failedCount?: number;
    running?: boolean; hasMore?: boolean; stageSeconds?: number; gateUpper?: number; gateWaiting?: number };
  currentTrack?: NativeMixTrack;
  nextTrack?: NativeMixTrack;
  waitingForPreparation?: boolean;
  preparing?: boolean;
  renderedFrames?: number;
  queuedFrames?: number;
  presentedFrames?: number;
  underruns?: number;
  maxRenderMs?: number;
  failed?: boolean;
  transitionStart?: number;
  artworkReady?: boolean;
  entryId?: string;
  count?: number;
  /** The last prepared track played to its end. */
  ended?: boolean;
}
export interface NativeMix {
  /** iOS: ~20 Hz band levels of the audible output (same contract as `DesktopAnalyser.levels`). */
  onLevels?(cb: (event: { rms: number; bands: number[] }) => void): () => void;
  startStation?(station: NativeRadioConfig, config: NativeSourceConfig): Promise<NativeMixState>;
  setStation?(station: NativeRadioConfig | null, context?: import('./queue-types.ts').PlayContext | null): Promise<NativeMixState>;
  /** Native download/decode and playback of the first recording, without page-side PCM. */
  startSource?(entry: NativeQueueEntry, config: NativeSourceConfig, signal?: AbortSignal): Promise<NativeMixState>;
  prepareQueue?(from: number, entries: NativeQueueEntry[], previousId: string,
    loopEntries?: NativeQueueEntry[], signal?: AbortSignal, replaceFuture?: boolean, manifest?: NativeQueueEntry[]): Promise<NativeMixState>;
  /** Isolates WebKit audio on first use, then appends PCM to a native file. */
  upload(file: number, offset: number, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void>;
  /** (Re)starts native playback of uploaded files. */
  start(config: NativeMixConfig, signal?: AbortSignal): Promise<NativeMixState>;
  /** Replaces the tracks from `from` onwards without interrupting the audible one. */
  update(from: number, tracks: NativeMixTrack[]): Promise<NativeMixState>;
  /** Live speed/pitch, tone and volume; later tracks keep them. */
  settings(values: NativeMixSettings): Promise<void>;
  stop(): Promise<void>;
  state(): Promise<NativeMixState>;
  command(action: MediaSessionAction, seekTime?: number): Promise<NativeMixState>;
}

export interface NativeQueueEntry {
  trackId: string;
  entryId: string;
  transitionContext?: { playlistId: string; fromItemId: number; toItemId: number };
  fromEntryId?: string;
  origin?: import('./queue-types.ts').Origin;
  sourcePlaylistId?: string;
  playlistEntryId?: number;
  yandexId?: string;
  yandexSessionId?: string;
  yandexBatchId?: string | null;
}

export interface NativeRadioConfig {
  kind: 'own' | 'yandex' | 'online';
  seed?: { title: string; artist: string };
  yandexSessionId?: string;
}
export interface NativeRecoverySnapshot {
  queue: NativeQueueEntry[];
  index: number;
  position: number;
  settings: NativeMixSettings;
  device: string;
  loop?: NativeQueueEntry[];
  station?: NativeRadioConfig;
  context?: import('./queue-types.ts').PlayContext;
}
