import type {
  CatalogAlbum, CatalogAlbumPage, CatalogArtist, CatalogArtistPage, CatalogArtistRef,
  CatalogSearchResult, CatalogSearchType, CatalogTrack,
  ReactionValue,
} from '@automix/core';
import type { Library } from '../library.ts';
import { isYandexTrackId, validateYandexMediaUrl } from './yandex-audio.ts';

type ObjectValue = Record<string, unknown>;
type CatalogApi = <T>(method: 'GET' | 'POST', path: string, body?: unknown, form?: boolean) => Promise<T>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown, limit = 50): unknown[] => Array.isArray(value) ? value.slice(0, limit) : [];
const text = (value: unknown, max = 300): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const numericId = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && /^\d{1,24}$/.test(String(value)) ? String(value) : null;
const compact = <T>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null);
const unique = <T>(items: T[], key: (item: T) => string, max = 50): T[] => [...new Map(items.map((item) => [key(item), item])).values()].slice(0, max);

export class CatalogError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 502, message: string) { super(message); }
}

/** Metadata endpoints documented by MarshalX/yandex-music-api's search/artists/albums mixins.
 * Cache entries contain only our DTOs, never OAuth credentials or signed audio URLs. */
export class YandexCatalog {
  private cache = new Map<string, { expires: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  private readonly cacheLimit = 40;
  private readonly ttl = 120000;
  reactionReader?: () => Promise<unknown>;
  cachedReactionFor?: (externalId: string) => ReactionValue | undefined;
  localReactionFor?: (externalId: string) => ReactionValue | undefined;
  private reactionReadFailedAt = 0;

  constructor(private api: CatalogApi, private connected: () => boolean, private lib: Library, private apiBase: string) {}

  clear(): void { this.generation++; this.cache.clear(); this.pending.clear(); this.reactionReadFailedAt = 0; }
  invalidate(): void { this.cache.clear(); this.reactionReadFailedAt = 0; }

  private async cached<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (!this.connected()) throw new CatalogError(409, 'Подключите аккаунт Яндекс Музыки');
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) {
      this.cache.delete(key); this.cache.set(key, hit);
      return hit.value as T;
    }
    if (hit) this.cache.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= 24) throw new CatalogError(502, 'Каталог занят. Повторите запрос немного позже');
    const generation = this.generation;
    const job = (async () => {
      try {
        const value = await work();
        if (generation !== this.generation || !this.connected()) throw new CatalogError(409, 'Подключение Яндекс Музыки изменилось. Повторите запрос');
        this.cache.set(key, { value, expires: Date.now() + this.ttl });
        while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
        return value;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError(502, 'Не удалось загрузить каталог Яндекс Музыки. Повторите запрос');
      } finally {
        if (generation === this.generation) this.pending.delete(key);
      }
    })();
    this.pending.set(key, job);
    return job;
  }

  private image(value: unknown): string | null {
    let raw = text(value, 2048).replaceAll('%%', '400x400');
    if (!raw) return null;
    if (raw.startsWith('//')) raw = `https:${raw}`;
    else if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const url = validateYandexMediaUrl(raw, this.apiBase);
      // Catalog art is a public image, not an expiring audio/download transport.
      if (url.search || url.hash || /\/get-mp3\/|\.(mp3|flac|wav|m3u8|aac|ogg)(?:$|\/)/i.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }

  private description(value: unknown): string | null {
    const raw = typeof value === 'string' ? value : object(value).text;
    return text(raw, 8000).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 4000) || null;
  }

  private title(value: ObjectValue): string {
    const title = text(value.title), version = text(value.version, 160);
    return version ? `${title} (${version})` : title;
  }

  private artistRef(value: unknown): CatalogArtistRef | null {
    const raw = object(value), id = numericId(raw.id), name = text(raw.name, 200);
    if (!id || !name) return null;
    return { id, name, imageUrl: this.image(object(raw.cover).uri ?? raw.opImage ?? raw.ogImage) };
  }

  private artist(value: unknown, stats?: unknown): CatalogArtist | null {
    const raw = object(value), ref = this.artistRef(raw);
    if (!ref) return null;
    const counts = object(raw.counts), statistics = object(stats ?? raw.stats);
    return {
      ...ref, genres: list(raw.genres, 12).map((genre) => text(genre, 60)).filter(Boolean),
      description: this.description(raw.description ?? raw.handMadeDescription),
      ...(Object.keys(counts).length ? { counts: { tracks: count(counts.tracks) ?? 0, albums: count(counts.directAlbums ?? counts.albums) ?? 0 } } : {}),
      listeners: count(statistics.lastMonthListeners ?? raw.listeners),
    };
  }

  private album(value: unknown): CatalogAlbum | null {
    const raw = object(value), id = numericId(raw.id), title = this.title(raw);
    if (!id || !title || raw.error) return null;
    return { id, title, imageUrl: this.image(raw.coverUri ?? raw.ogImage),
      artists: compact(list(raw.artists, 20).map((artist) => this.artistRef(artist))),
      year: count(raw.year ?? raw.originalReleaseYear), type: text(raw.type, 40) || 'album', trackCount: count(raw.trackCount),
      available: raw.available !== false || raw.availableForPremiumUsers === true };
  }

  private track(value: unknown, albumContext?: ObjectValue, disc?: number, position?: number): CatalogTrack | null {
    const raw = object(value), rawId = raw.id;
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !isYandexTrackId(String(rawId)) || raw.error) return null;
    const title = this.title(raw);
    if (!title) return null;
    const sourceAlbums = list(raw.albums, 50).map(object);
    const sourceAlbum = albumContext ? sourceAlbums.find((album) => numericId(album.id) === numericId(albumContext.id)) : sourceAlbums[0];
    const selected = albumContext ?? sourceAlbum ?? {};
    const albumId = numericId(selected.id), baseId = String(rawId).split(':')[0];
    const externalId = albumId ? `${baseId}:${albumId}` : String(rawId);
    const artists = compact(list(raw.artists, 20).map((artist) => this.artistRef(artist)));
    const trackPosition = object(raw.trackPosition ?? sourceAlbum?.trackPosition ?? selected.trackPosition);
    const trackNumber = count(trackPosition.index) || position;
    const discNumber = count(trackPosition.volume) || disc;
    return {
      externalId, title, artist: artists.map((artist) => artist.name).join(', '), album: this.title(selected),
      duration: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.max(0, raw.durationMs / 1000) : 0,
      coverUrl: this.image(raw.coverUri ?? selected.coverUri), pageUrl: `https://music.yandex.ru/track/${baseId}`,
      license: null, playable: raw.available !== false || raw.availableForPremiumUsers === true, libraryTrackId: null,
      artists, albumId, explicit: raw.contentWarning === 'explicit' || raw.explicit === true,
      ...(trackNumber ? { position: trackNumber } : {}), ...(discNumber ? { disc: discNumber } : {}),
    };
  }

  /** Only `home` (which already reads account likes) refreshes the account reaction snapshot;
   * search and pages stay metadata-only and use whatever snapshot is cached. */
  private async markKnown(tracks: CatalogTrack[], refreshReactions = false): Promise<CatalogTrack[]> {
    const known = new Map<string, string>();
    for (const track of this.lib.all()) {
      if (track.provider !== 'yandex' || track.status !== 'ok') continue;
      for (const source of this.lib.sources(track.id)) if (source.provider === 'yandex' && source.kind === 'remote' && source.external_id) known.set(source.external_id, track.id);
    }
    if (refreshReactions && this.reactionReader && Date.now() - this.reactionReadFailedAt > 15000) {
      try { await this.reactionReader(); }
      catch { this.reactionReadFailedAt = Date.now(); }
    }
    return tracks.map((track) => {
      const reaction = this.localReactionFor?.(track.externalId) ?? this.cachedReactionFor?.(track.externalId);
      return { ...track, libraryTrackId: known.get(track.externalId) ?? null, ...(reaction !== undefined ? { reaction } : {}) };
    });
  }

  private more(sectionValue: unknown, page: number): boolean {
    const section = object(sectionValue), pager = object(section.pager);
    const total = count(section.total ?? pager.total), perPage = count(section.perPage ?? pager.perPage);
    return total !== null && perPage !== null && perPage > 0 ? (page + 1) * perPage < total : false;
  }

  async search(query: string, page = 0, type: CatalogSearchType = 'all'): Promise<CatalogSearchResult> {
    const result = await this.cached(`search:${type}:${page}:${query}`, async () => {
      const raw = object(await this.api('GET', `/search?${new URLSearchParams({ text: query, type, page: String(page), 'playlist-in-best': 'false' })}`));
      const tracks = compact(list(object(raw.tracks).results).map((track) => this.track(track)));
      const artists = compact(list(object(raw.artists).results).map((artist) => this.artist(artist)));
      const albums = compact(list(object(raw.albums).results).map((album) => this.album(album)));
      let best: CatalogSearchResult['best'] = null;
      const rawBest = object(raw.best), bestType = rawBest.type, bestResult = object(rawBest.result);
      if (bestType === 'track') {
        const track = this.track(bestResult);
        if (track) { best = { type: 'track', id: track.externalId }; if (!tracks.some((item) => item.externalId === track.externalId)) tracks.unshift(track); }
      } else if (bestType === 'artist') {
        const artist = this.artist(bestResult);
        if (artist) { best = { type: 'artist', id: artist.id }; if (!artists.some((item) => item.id === artist.id)) artists.unshift(artist); }
      } else if (bestType === 'album') {
        const album = this.album(bestResult);
        if (album) { best = { type: 'album', id: album.id }; if (!albums.some((item) => item.id === album.id)) albums.unshift(album); }
      }
      return { query, best, tracks, artists, albums, page,
        hasMore: { tracks: this.more(raw.tracks, page), artists: this.more(raw.artists, page), albums: this.more(raw.albums, page) } };
    });
    return { ...result, tracks: await this.markKnown(result.tracks) };
  }

  async home(): Promise<CatalogSearchResult> {
    const result = await this.cached('home', async () => {
      const account = object(await this.api('GET', '/account/status'));
      const uid = numericId(object(account.account).uid);
      if (!uid) throw new CatalogError(502, 'Не удалось загрузить медиатеку Яндекс Музыки');
      const likes = object(await this.api('GET', `/users/${uid}/likes/tracks`));
      const ids = list(object(likes.library).tracks, 60).map((value) => {
        const item = object(value), id = String(item.id ?? ''), albumId = numericId(item.albumId);
        return albumId ? `${id}:${albumId}` : id;
      }).filter((id) => isYandexTrackId(id)).slice(0, 20);
      const rawTracks = ids.length ? list(await this.api('POST', '/tracks', { 'track-ids': ids.join(',') }, true), 20) : [];
      const tracks = compact(rawTracks.map((track) => this.track(track)));
      const artists = unique(compact(rawTracks.flatMap((track) => list(object(track).artists, 20)).map((artist) => this.artist(artist))), (artist) => artist.id, 8);
      const albums = unique(compact(rawTracks.flatMap((track) => list(object(track).albums, 10)).map((album) => this.album(album))), (album) => album.id, 8);
      return { query: '', best: null, tracks, artists, albums, page: 0, hasMore: { tracks: false, artists: false, albums: false } } satisfies CatalogSearchResult;
    });
    return { ...result, tracks: await this.markKnown(result.tracks, true) };
  }

  async artistPage(id: string, page = 0): Promise<CatalogArtistPage> {
    const result = await this.cached(`artist:${id}:${page}`, async () => {
      const [briefResult, albumsResult] = await Promise.allSettled([
        this.api('GET', `/artists/${id}/brief-info`),
        this.api('GET', `/artists/${id}/direct-albums?${new URLSearchParams({ page: String(page), 'page-size': '20', 'sort-by': 'year' })}`),
      ]);
      if (briefResult.status === 'rejected') throw briefResult.reason;
      const brief = object(briefResult.value), artist = this.artist(brief.artist, brief.stats);
      if (!artist) throw new CatalogError(404, 'Артист не найден');
      if (albumsResult.status === 'rejected' && page > 0) throw albumsResult.reason;
      const direct = albumsResult.status === 'fulfilled' ? object(albumsResult.value) : null;
      const albums = compact(list(direct?.albums ?? brief.albums, 50).map((album) => this.album(album)));
      return { artist, popularTracks: compact(list(brief.popularTracks ?? object(brief.artist).popularTracks, 30).map((track) => this.track(track))),
        albums, similarArtists: compact(list(brief.similarArtists, 12).map((artist) => this.artist(artist))), page,
        hasMoreAlbums: direct ? this.more(direct, page) : false };
    });
    return { ...result, popularTracks: await this.markKnown(result.popularTracks) };
  }

  async albumPage(id: string): Promise<CatalogAlbumPage> {
    const result = await this.cached(`album:${id}`, async () => {
      const raw = object(await this.api('GET', `/albums/${id}/with-tracks`)), album = this.album(raw);
      if (!album) throw new CatalogError(404, 'Альбом не найден');
      // The endpoint returns volumes, not a flat catalog ranking. Keep disc order.
      const tracks = compact(list(raw.volumes, 30).flatMap((volume, disc) => list(volume, 300).map((track, position) => this.track(track, raw, disc + 1, position + 1))));
      tracks.sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.position ?? 0) - (b.position ?? 0));
      return { album, tracks, description: this.description(raw.description ?? raw.shortDescription) };
    });
    return { ...result, tracks: await this.markKnown(result.tracks) };
  }
}
