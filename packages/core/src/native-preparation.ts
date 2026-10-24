import type { AutoMixSettings, TrackAnalysis } from './types.ts';

/** Private in-app handoff. Credentials/addresses must never enter telemetry or Now Playing. */
export type NativeMediaSource =
  | { kind: 'direct' | 'hls'; url: string; headers?: Record<string, string>; ext?: string; allowHTTP?: boolean }
  | { kind: 'yandex'; externalId: string; token: string; apiBase: string }
  | { kind: 'upload'; trackId: string }
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
}
export interface NativePreparationManifest {
  from: number;
  items: NativePreparationItem[];
  loopItems?: NativePreparationItem[];
  previous: { trackId: string; duration: number; mixingAllowed: boolean; analysis?: TrackAnalysis | null };
  settings: AutoMixSettings;
}
