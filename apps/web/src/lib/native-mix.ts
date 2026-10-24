import type { ArmedTransition } from '@automix/core/engine/mixer.ts';
import type { ToneSettings } from '@automix/core/dsp/tone.ts';
import type { NativeProbeState } from './playback-trace.ts';

export interface NativeMixConfig {
  sampleRate: number;
  tracks: { title: string; artist: string; totalFrames: number; gainDb: number;
    coverUrl?: string; artwork?: { base64: string; mime: string } }[];
  transition?: ArmedTransition;
  tone?: ToneSettings;
  preDb?: number;
  position: number;
  index?: number;
}
export interface NativeMixState extends NativeProbeState {
  preparing?: boolean;
  renderedFrames?: number;
  queuedFrames?: number;
  presentedFrames?: number;
  underruns?: number;
  maxRenderMs?: number;
  failed?: boolean;
  transitionStart?: number;
  artworkReady?: boolean;
}
export interface NativeMix {
  start(prepare: (put: (index: number, offset: number, bytes: ArrayBuffer) => Promise<void>) => Promise<NativeMixConfig>, signal?: AbortSignal): Promise<NativeMixState>;
  stop(): Promise<void>;
  state(): Promise<NativeMixState>;
  command(action: MediaSessionAction, seekTime?: number): Promise<NativeMixState>;
}
