import type { SoundSettings } from '@automix/core';
import type { TrackAnalysis, TransitionPlan, AutoMixSettings, TransitionRating, TransitionRatingReason } from '@automix/core';
import type { CatalogAlbumPage, CatalogArtistPage, CatalogSearchResult, CatalogSearchType } from '@automix/core';
export interface ReactionSync { status: 'synced' | 'pending' | 'error' | 'local'; error?: string }
export interface ReactionResult { value: number; sync?: ReactionSync }
export interface YandexLikesJob { id: string; state: 'listing' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'; busy: boolean; total: number; done: number; failed: number; skipped: number; preparing: number; message: string }

export interface AnalysisSummary {
  status: 'none' | 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  bpm?: number | null;
  camelot?: string;
  keyName?: string;
  energy?: number;
  rhythm?: number;
  lufs?: number;
  truePeak?: number;
  error?: string;
  progress?: number;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string;
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  bitrate: number | null;
  coverUrl: string | null;
  provider: string;
  sourceKind: string;
  sourceUrl: string | null;
  status: 'ok' | 'missing' | 'error';
  error: string | null;
  addedAt: number;
  playCount: number;
  skipCount: number;
  lastPlayedAt: number | null;
  reaction: number;
  likedAt?: number;
  reactionSync?: ReactionSync;
  analysis: AnalysisSummary;
  mixingAllowed: boolean;
  catalogArtists?: { id: string; name: string }[];
  catalogAlbumId?: string | null;
  /** In the collection; false for a search result that was only played. */
  saved?: boolean;
  pinned?: boolean;
  origin?: { metadataSource: string; uploader: string; explicit: boolean; labels: VersionLabel[]; artistId: string | null; albumId: string | null };
  /** Another recording chosen by the listener plays for this track. */
  binding?: { assetId: string; provider: string; title: string; artist: string; origin?: Track['origin'] };
}

export interface VersionLabel { tag: string; origin: 'source' | 'title' }
export interface ImportCandidate { provider: 'youtube' | 'soundcloud'; externalId: string; title: string; artist: string; duration: number; coverUrl: string | null; labels: VersionLabel[] }
export interface ImportRow { position: number; title: string; artist: string; album?: string; duration?: number; status: 'pending' | 'matched' | 'uncertain' | 'missing'; confidence: number; how?: 'auto' | 'source' | 'user'; candidate?: ImportCandidate; trackId?: string | null }
export interface ImportJob { id: string; name: string; source: string; cover: string | null; total: number | null; complete: boolean; note?: string; state: 'matching' | 'ready' | 'creating' | 'done' | 'failed'; error: string | null; rows: ImportRow[]; playlistId: string | null; createdAt: number; counts?: { matched: number; uncertain: number; missing: number; pending: number } }
export interface DownloadJob { id: string; key: string; title: string; state: 'queued' | 'downloading' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled'; progress: number; error: string | null; trackId: string | null }
export interface DownloadUsage { cacheBytes: number; pinnedBytes: number; limitBytes: number; freeBytes: number | null }
export interface Lyrics {
  status: 'synced' | 'plain' | 'none';
  lines: { t: number; text: string }[];
  plain: string;
  source: 'lrclib' | 'file' | null;
  matched?: { title: string; artist: string; duration: number | null };
  /** Present only for an existing local Whisper transcript with genuine word timestamps. */
  wordLines?: { t: number; text: string; words: { t: number; end: number; text: string }[] }[];
  offsetMs: number;
}
export type PublicSource = 'ytmusic' | 'youtube' | 'soundcloud';
/** A search result from a public source (no account needed). */
export interface PublicTrack {
  externalId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string | null;
  pageUrl: string | null;
  playable: boolean;
  libraryTrackId: string | null;
  source: PublicSource;
  audioProvider: 'youtube' | 'soundcloud';
  kind: 'song' | 'video' | 'track';
  explicit: boolean;
  uploader: string;
  labels: VersionLabel[];
  artistId: string | null;
  albumId: string | null;
}

export interface PublicCatalogPage {
  id: string; type: 'artist' | 'album'; title: string; description: string; coverUrl: string | null;
  source: 'ytmusic'; tracks: PublicTrack[]; limited: boolean;
  albums: { id: string; title: string; coverUrl: string | null; artist: string }[];
  artists: { id: string; name: string }[];
}

export interface SoundCloudArtistPage {
  id: string; userId: string; permalink: string; type: 'artist'; title: string; description: string; coverUrl: string | null;
  source: 'soundcloud'; tracks: PublicTrack[]; limited: true;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  count: number;
  coverUrl: string | null;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  description: string;
  entries: { entryId: number; trackId: string; addedAt: number }[];
}

export interface Capabilities {
  search: boolean;
  library: boolean;
  playlists: boolean;
  recommendations: boolean;
  playback: boolean;
  seek: boolean;
  pcm: boolean;
  analysis: boolean;
  mixing: boolean;
  caching: 'persistent' | 'session' | 'none';
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'local' | 'self-hosted' | 'catalog' | 'unofficial' | 'restricted';
  official: boolean;
  capabilities: Capabilities;
  status: 'connected' | 'needs_credentials' | 'unavailable' | 'not_supported' | 'error' | 'disabled';
  statusText: string;
  notes: string[];
  docs: string[];
  configFields: { key: string; label: string; type: 'text' | 'password' | 'url'; secret: boolean; placeholder?: string; help?: string }[];
  config: Record<string, string>;
  hasSecret: boolean;
  account?: string | null;
}

export interface ExternalTrack {
  externalId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string | null;
  pageUrl: string | null;
  license: string | null;
  playable: boolean;
  libraryTrackId?: string | null;
}

export interface AppSettings {
  automix: AutoMixSettings;
  wave: { mood: 'calm' | 'normal' | 'energetic'; diversity: 'familiar' | 'balanced' | 'discover'; mode?: 'normal' | 'mix'; yandexSeeds?: string[] };
  ui: { showDiagnostics: boolean; motion?: 'system'|'full'|'reduced'; graphics?: 'auto'|'canvas' };
  sound: SoundSettings;
  yandex: { syncLikes: boolean; syncDislikes: boolean; importLikes: boolean; waveFeedback: boolean };
}

export interface WavePick {
  id: string;
  score: number;
  reasons: string[];
}

export interface HistoryItem {
  id: number;
  trackId: string;
  context: string;
  startedAt: number;
  playedMs: number;
  endReason: string | null;
}

export interface TransitionLogItem {
  id: number;
  planId: string;
  fromTrackId: string;
  toTrackId: string;
  method: string;
  executedAt: number;
  outcome: Record<string, unknown>;
  plan: TransitionPlan;
  rating: TransitionRating | null;
  ratingReason: TransitionRatingReason | null;
}

export interface StemHealth {
  runtime?: 'bundled-cpu' | 'external' | null;
  available: boolean;
  model: string;
  running: { hash: string; status: string; progress?: number }[];
  queued: number;
  ready: number;
  errors: number;
  /** Optional NVIDIA runtime of the Windows app; undefined gpu = still detecting. */
  gpu?: StemGpu;
}

export interface StemGpu {
  gpu: { name: string; vramMiB: number; driver: string } | null | undefined;
  status: 'absent' | 'downloading' | 'installing' | 'ready' | 'error';
  progress?: number;
  error?: string;
  fallback?: string;
  downloadBytes: number;
  diskBytes: number;
}

export interface HealthStatus {
  ok: boolean;
  ffmpeg: string | null;
  analyzer: string;
  planner: string;
  analysis: { queued: number; running: number; workers: number };
  pcmCacheBytes: number;
  pcmCacheLimit: number;
  pcmCacheProtectedBytes?:number;
  tracks: number;
  lan: boolean;
  stems?: StemHealth;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? `Ошибка сервера (${res.status})`, res.status);
  return data as T;
}

export const api = {
  publicSearch: (source: PublicSource, q: string, signal?: AbortSignal) => req<{ items: PublicTrack[] }>('GET', `/api/search/${source}?q=${encodeURIComponent(q)}`, undefined, signal),
  publicCatalog: (type: 'artist' | 'album', id: string, signal?: AbortSignal) => req<PublicCatalogPage>('GET', `/api/catalog/public/${type}s/${encodeURIComponent(id)}`, undefined, signal),
  soundCloudArtist: (id: string, signal?: AbortSignal) => req<SoundCloudArtistPage>('GET', `/api/catalog/soundcloud/artists/${encodeURIComponent(id)}`, undefined, signal),
  publicPrepare: (provider: 'youtube' | 'soundcloud', externalId: string, priority = 0) => req<{ trackId: string }>('POST', '/api/public/prepare', { provider, externalId, priority, progressive: true }),
  publicRadio: (videoId: string, signal?: AbortSignal) => req<{ items: PublicTrack[] }>('GET', `/api/public/radio/${encodeURIComponent(videoId)}`, undefined, signal),
  saveTrack: (id: string, saved = true) => req<{ ok: true }>('POST', `/api/tracks/${id}/save`, { saved }),
  lyrics: (id: string, refresh = false, signal?: AbortSignal) => req<Lyrics>('GET', `/api/tracks/${id}/lyrics${refresh ? '?refresh=1' : ''}`, undefined, signal),
  setLyricsOffset: (id: string, offsetMs: number) => req<{ ok: true }>('PUT', `/api/tracks/${id}/lyrics/offset`, { offsetMs }),
  imports: () => req<{ jobs: ImportJob[] }>('GET', '/api/imports'),
  importJob: (id: string) => req<ImportJob>('GET', `/api/imports/${id}`),
  startImport: (body: { url?: string; file?: { name: string; text: string } }) => req<ImportJob>('POST', '/api/imports', body),
  resolveImport: (id: string, position: number, choice: { trackId: string } | ImportCandidate | null) => req<ImportJob>('POST', `/api/imports/${id}/resolve`, { position, choice }),
  importPlaylist: (id: string, includeUncertain: boolean) => req<ImportJob>('POST', `/api/imports/${id}/playlist`, { includeUncertain }),
  deleteImport: (id: string) => req<{ ok: true }>('DELETE', `/api/imports/${id}`),
  downloads: () => req<{ jobs: DownloadJob[]; usage: DownloadUsage }>('GET', '/api/downloads'),
  download: (body: { trackId?: string; provider?: string; externalId?: string; title?: string }) => req<{ job: DownloadJob }>('POST', '/api/downloads', body),
  downloadAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => req<{ ok: true }>('POST', `/api/downloads/${id}/${action}`, {}),
  removeDownload: (trackId: string) => req<{ ok: true }>('DELETE', `/api/tracks/${trackId}/download`),
  downloadPlaylist: (id: string) => req<{ jobs: number }>('POST', `/api/playlists/${id}/download`, {}),
  setCacheLimit: (mb: number) => req<{ usage: DownloadUsage }>('PUT', '/api/downloads/settings', { cacheLimitMb: mb }),
  clearAudioCache: () => req<{ removed: number; usage: DownloadUsage }>('POST', '/api/downloads/clear-cache', {}),
  bindRecording: (id: string, assetId: string | null) => req<{ ok: true; mediaId: string }>('POST', `/api/tracks/${id}/binding`, { assetId }),
  catalogHome: (signal?: AbortSignal) => req<CatalogSearchResult>('GET', '/api/catalog/yandex/home', undefined, signal),
  catalogSearch: (q: string, type: CatalogSearchType = 'all', page = 0, signal?: AbortSignal) =>
    req<CatalogSearchResult>('GET', `/api/catalog/yandex/search?${new URLSearchParams({ q, type, page: String(page) })}`, undefined, signal),
  catalogArtist: (id: string, page = 0, signal?: AbortSignal) => req<CatalogArtistPage>('GET', `/api/catalog/yandex/artists/${encodeURIComponent(id)}?page=${page}`, undefined, signal),
  catalogAlbum: (id: string, signal?: AbortSignal) => req<CatalogAlbumPage>('GET', `/api/catalog/yandex/albums/${encodeURIComponent(id)}`, undefined, signal),
  library: () => req<{ tracks: Track[] }>('GET', '/api/library'),
  track: (id: string) => req<Track>('GET', `/api/tracks/${id}`),
  updateTrack: (id: string, patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre'>>) => req('PATCH', `/api/tracks/${id}`, patch),
  deleteTrack: (id: string) => req('DELETE', `/api/tracks/${id}`),
  react: (id: string, value: number) => req<ReactionResult>('POST', `/api/tracks/${id}/reaction`, { value }),
  orderFavorites: (trackIds: string[]) => req<{ ok: boolean }>('POST', '/api/library/favorites/order', { trackIds }),
  yandexLikesJob: () => req<YandexLikesJob | null>('GET', '/api/providers/yandex/likes/import'),
  startYandexLikes: () => req<YandexLikesJob>('POST', '/api/providers/yandex/likes/import'),
  pauseYandexLikes: () => req<YandexLikesJob>('POST', '/api/providers/yandex/likes/import/pause'),
  cancelYandexLikes: () => req<YandexLikesJob>('POST', '/api/providers/yandex/likes/import/cancel'),
  resumeYandexLikes: (retryFailed = false) => req<YandexLikesJob>('POST', '/api/providers/yandex/likes/import/resume', { retryFailed }),
  reactionSync: () => req<{ items: { externalId: string; value: number; sync: ReactionSync }[] }>('GET', '/api/providers/yandex/reactions/sync'),
  catalogReact: (externalId: string, value: number) => req<ReactionResult>('POST', `/api/catalog/yandex/tracks/${encodeURIComponent(externalId)}/reaction`, { value }),
  analysis: (id: string) => req<{ status: string; analysis: TrackAnalysis | null; error: string | null }>('GET', `/api/tracks/${id}/analysis`),
  reanalyze: (id: string) => req('POST', `/api/tracks/${id}/analyze`),
  focus: (b: { current?: string | null; next?: string[]; candidates?: string[] }) => req('POST', '/api/analysis/focus', b),
  rebuildVocals: (id: string) => req<{ status: string; quality?: { status: string; progress?: number; error?: string } }>('POST', `/api/tracks/${encodeURIComponent(id)}/stems/rebuild`),
  prepare: (id: string, sampleRate: number, role: 'current' | 'next' | 'candidate') =>
    req<{ totalFrames: number; complete: boolean; analysis: string }>('POST', `/api/tracks/${id}/prepare`, { sampleRate, role }),
  plan: (from: string, to: string) => req<{ plan: TransitionPlan; cached: boolean; pending: string[] }>('GET', `/api/automix/plan?from=${from}&to=${to}`),
  logTransition: (plan: TransitionPlan, outcome: Record<string, unknown>) => req<{ id: number }>('POST', '/api/automix/log', { plan, outcome }),
  rateTransition: (id: number, rating: TransitionRating | null, reason: TransitionRatingReason | null = null) => req('POST', `/api/automix/log/${id}/rating`, { rating, reason }),
  mixNow: (from:string,to:string,position:number) => req<{plan:TransitionPlan}>('POST','/api/automix/mix-now',{from,to,position}),
  transitions: (limit = 30) => req<{ items: TransitionLogItem[] }>('GET', `/api/automix/log?limit=${limit}`),
  waveNext: (b: { currentId: string | null; session: string[]; count: number; mood?: string; diversity?: string; exclude?: string[] }) =>
    req<{ picks: WavePick[] }>('POST', '/api/wave/next', b),
  startPlay: (trackId: string, context: string) => req<{ id: number }>('POST', '/api/plays', { trackId, context }),
  endPlay: (id: number, playedMs: number, endReason: string, transitionId?: string) => req('PATCH', `/api/plays/${id}`, { playedMs, endReason, transitionId }),
  history: (limit = 200) => req<{ items: HistoryItem[] }>('GET', `/api/history?limit=${limit}`),
  clearHistory: () => req('DELETE', '/api/history'),
  queue: () => req<unknown>('GET', '/api/queue'),
  saveQueue: (q: unknown) => req('PUT', '/api/queue', q),
  playlists: () => req<{ playlists: PlaylistSummary[] }>('GET', '/api/playlists'),
  restorePlaylists: (data: unknown) => req<{ playlists: number; tracks: number; missingFiles: number }>('POST', '/api/backup/playlists/restore', data),
  playlist: (id: string) => req<PlaylistDetail>('GET', `/api/playlists/${id}`),
  createPlaylist: (name: string, trackIds: string[] = []) => req<{ id: string }>('POST', '/api/playlists', { name, trackIds }),
  renamePlaylist: (id: string, name: string, description?: string) => req('PATCH', `/api/playlists/${id}`, { name, description }),
  deletePlaylist: (id: string) => req('DELETE', `/api/playlists/${id}`),
  addToPlaylist: (id: string, trackIds: string[]) => req<{ added: number }>('POST', `/api/playlists/${id}/tracks`, { trackIds }),
  removeFromPlaylist: (id: string, entryId: number) => req('DELETE', `/api/playlists/${id}/tracks/${entryId}`),
  reorderPlaylist: (id: string, entryIds: number[]) => req('PUT', `/api/playlists/${id}/order`, { entryIds }),
  settings: () => req<AppSettings>('GET', '/api/settings'),
  saveSettings: (s: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/settings', s),
  providers: (force = false) => req<{ providers: ProviderInfo[] }>('GET', `/api/providers${force ? '?force=1' : ''}`),
  connectProvider: (id: string, config: Record<string, string>, secret: Record<string, string>) => req<{ ok: boolean }>('POST', `/api/providers/${id}/connect`, { config, secret }),
  disconnectProvider: (id: string) => req('POST', `/api/providers/${id}/disconnect`),
  providerSearch: (id: string, q: string) => req<{ items: ExternalTrack[] }>('GET', `/api/providers/${id}/search?q=${encodeURIComponent(q)}`),
  providerImport: (id: string, track: ExternalTrack) => req<{ trackId: string }>('POST', `/api/providers/${id}/import`, { track }),
  yandexWaveSettings: () => req<{ groups: { id: string; name: string; values: { name: string; seed: string }[] }[] }>('GET', '/api/providers/yandex/wave/settings'),
  yandexWave: (session?: string | null, options: { queue?: string[]; count?: number } = {}) =>
    req<{ sessionId: string; batchId: string | null; items: { yandexId: string; title: string; artist: string; trackId: string | null }[] }>(
      'POST',
      '/api/providers/yandex/wave',
      { session: session ?? null, ...options },
      AbortSignal.timeout(180000),
    ),
  yandexFeedback: (sessionId: string, batchId: string | null, event: { type: string; trackId: string; totalPlayedSeconds?: number }) =>
    req('POST', '/api/providers/yandex/feedback', { sessionId, batchId, event }),
  importFolder: (path: string) => req<{ jobId: string; total: number }>('POST', '/api/import/folder', { path }),
  verify: () => req<{ ok: number; missing: number }>('POST', '/api/library/verify'),
  health: () =>
    req<HealthStatus>(
      'GET',
      '/api/health',
    ),
  clearCache: () => req('POST', '/api/system/clear-cache'),
  installStemGpu: (acceptBytes: number) => req<StemGpu>('POST', '/api/stems/gpu', { acceptBytes }),
  removeStemGpu: () => req<StemGpu>('DELETE', '/api/stems/gpu'),
};

/** Uploads one file into the managed library (raw body, streamed). */
export function uploadFile(file: File, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<{ trackId: string; duplicate: boolean; title: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/import/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } & Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else reject(new ApiError(data.error ?? `Ошибка загрузки (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером', 0));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}
