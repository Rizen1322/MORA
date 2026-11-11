import type { AutoMixSettings, PhraseMixRecipe, TrackAnalysis } from './types.ts';
import type { RatingStats } from './plan/feedback.ts';

/** Private in-app handoff. Credentials/addresses must never enter telemetry or Now Playing. */
export type NativeMediaSource =
  | { kind: 'direct' | 'hls'; url: string; headers?: Record<string, string>; ext?: string; allowHTTP?: boolean }
  | { kind: 'yandex'; externalId: string; token: string; apiBase: string }
  | { kind: 'upload'; trackId: string; serverPath?: string }
  | { kind: 'unavailable' }
  | { kind: 'local'; file: number };
export interface NativePreparationItem {
  trackId: string;
  entryId: string;
  file: number;
  title: string;
  artist: string;
  duration: number;
  mixingAllowed: boolean;
  source: NativeMediaSource;
  analysis?: TrackAnalysis | null;
  coverUrl?: string;
  artwork?: { base64: string; mime: string };
  /** Validated playlist edge; legacy edges without an occurrence ID are ignored. */
  phraseTransition?: { fromTrackId: string; fromEntryId?: string; recipe: PhraseMixRecipe };
}
export interface NativePreparationManifest {
  replaceFuture?: boolean;
  /** Source uploads kept alive until a progressive handoff reaches its final batch. */
  retainedSources?: number[];
  from: number;
  items: NativePreparationItem[];
  loopItems?: NativePreparationItem[];
  previous: { trackId: string; duration: number; mixingAllowed: boolean; analysis?: TrackAnalysis | null };
  settings: AutoMixSettings;
  feedback?: RatingStats | null;
}
