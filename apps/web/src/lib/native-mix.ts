import type { ArmedTransition } from '@automix/core/engine/mixer.ts';
import type { ToneSettings } from '@automix/core/dsp/tone.ts';
import type { PlaybackSettings } from '@automix/core/dsp/playback.ts';
import type { NativeProbeState } from './playback-trace.ts';

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
  position: number;
  index?: number;
  paused?: boolean;
}
export interface NativeMixState extends NativeProbeState {
  preparation?: { state: string; ready: number; remaining: number; reason?: string; failedCount?: number };
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
  prepareQueue?(from: number, entries: { trackId: string; entryId: string }[], previousId: string,
    loopEntries?: { trackId: string; entryId: string }[], signal?: AbortSignal): Promise<NativeMixState>;
  /** Isolates WebKit audio on first use, then appends PCM to a native file. */
  upload(file: number, offset: number, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void>;
  /** (Re)starts native playback of uploaded files. */
  start(config: NativeMixConfig, signal?: AbortSignal): Promise<NativeMixState>;
  /** Replaces the tracks from `from` onwards without interrupting the audible one. */
  update(from: number, tracks: NativeMixTrack[]): Promise<NativeMixState>;
  /** Live speed/pitch, tone and volume; later tracks keep them. */
  settings(values: Pick<NativeMixConfig, 'tone' | 'preDb' | 'playback' | 'volume'>): Promise<void>;
  stop(): Promise<void>;
  state(): Promise<NativeMixState>;
  command(action: MediaSessionAction, seekTime?: number): Promise<NativeMixState>;
}
