export type Origin = 'user' | 'wave' | 'context' | 'yandex';

export interface QueueEntry {
  entryId: string;
  trackId: string;
  origin: Origin;
  /** Original playlist occurrence: repeated tracks may have different saved transitions. */
  sourcePlaylistId?: string;
  playlistEntryId?: number;
  reasons?: string[];
  yandexId?: string;
  /** Attribution belongs to this recommendation, never to the latest fetched batch. */
  yandexSessionId?: string;
  yandexBatchId?: string | null;
}

export interface PlayContext {
  type: 'library' | 'album' | 'artist' | 'playlist' | 'liked' | 'wave' | 'yandex-wave' | 'online-radio' | 'search' | 'queue' | 'history';
  id?: string;
  label: string;
}
