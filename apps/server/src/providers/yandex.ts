import { createHash } from 'node:crypto';
import type { ReactionValue } from '@automix/core';
import type { AppConfig } from '../config.ts';
import { FfmpegTools } from '../ffmpeg.ts';
import type { Library, SourceRow } from '../library.ts';
import type { YandexReactionSession } from '../yandex-reactions.ts';
import { ProviderStore, StatusCache, makeInfo, type InfoParts } from './base.ts';
import { httpJson, normKey, type Capabilities, type ExternalTrack, type Provider, type ProviderInfo } from './types.ts';
import { YandexAudio, isYandexTrackId, validateYandexMediaUrl, type YandexDownloadVariant } from './yandex-audio.ts';
import { YandexCatalog } from './yandex-catalog.ts';

export interface YandexWaveSetting {
  id: string;
  name: string;
  values: { name: string; seed: string }[];
}

const CAPS: Capabilities = {
  search: true,
  library: true,
  playlists: false,
  recommendations: true,
  playback: true,
  seek: true,
  pcm: true,
  analysis: true,
  mixing: true,
  caching: 'persistent',
};

const PARTS: InfoParts = {
  id: 'yandex',
  name: 'Яндекс Музыка (экспериментально)',
  kind: 'unofficial',
  official: false,
  caps: CAPS,
  notes: [
    'Неофициальный API (по исходникам MarshalX/yandex-music-api). Может перестать работать в любой момент.',
    'Поиск, ваши лайки и добавление по ссылке на трек. При добавлении полный MP3 подготавливается локально для AutoMix и разделения вокала.',
    'Нужен доступ к полному треку в вашем аккаунте. Превью и зашифрованные форматы не поддерживаются; качество зависит от доступного MP3-потока.',
    'Это экспериментальное подключение, не партнёрская интеграция Яндекса. Доступность аудио не определяет разрешение на его обработку или распространение.',
    'Токен вы вставляете сами; он хранится только в локальной базе backend.',
  ],
  docs: ['https://github.com/MarshalX/yandex-music-api', 'https://ym.marshal.dev/'],
  fields: [{ key: 'token', label: 'OAuth-токен Яндекс Музыки', type: 'password', secret: true, help: 'Токен или ссылка после авторизации с access_token. Вставляйте только в это поле, не в чат.' }],
};

interface YTrack {
  id: string | number;
  title: string;
  artists?: { id?: string | number; name: string }[];
  albums?: { id: number; title?: string; version?: string; year?: number; genre?: string; coverUri?: string; trackPosition?: { index?: number; volume?: number } }[];
  durationMs?: number;
  coverUri?: string;
  available?: boolean;
  availableForPremiumUsers?: boolean;
  version?: string;
}

export interface YandexWaveItem {
  yandexId: string;
  title: string;
  artist: string;
  trackId: string | null;
  error?: string;
}

export class YandexProvider implements Provider {
  readonly id = 'yandex';
  readonly catalog: YandexCatalog;
  private cache = new StatusCache();
  private readonly base = process.env.YANDEX_API_BASE || 'https://api.music.yandex.net';
  private audio: YandexAudio;
  private imports = new Map<string, Promise<string>>();
  private reactionGeneration = 0;
  private reactionSnapshotVersion = 0;
  private reactionAccounts = new Map<string, Promise<string>>();
  private reactionSnapshot: { key: string; expiresAt: number; values: Map<string, ReactionValue> } | null = null;
  private reactionRead: { key: string; promise: Promise<Map<string, ReactionValue>> } | null = null;
  localReactionFor?: (externalId: string) => ReactionValue | undefined;
  onReactionConnectionChanged?: () => void;
  constructor(
    private readonly store: ProviderStore,
    private readonly lib: Library,
    cfg: AppConfig,
    ff = new FfmpegTools(cfg.ffmpeg, cfg.ffprobe),
  ) {
    this.audio = new YandexAudio(cfg, ff, this.base, (id) => this.call<YandexDownloadVariant[]>('GET', `/tracks/${encodeURIComponent(id)}/download-info`));
    this.catalog = new YandexCatalog((method, path, body, form) => this.call(method, path, body, undefined, form), () => !!this.token(), lib, this.base);
  }

  capabilities(): Capabilities {
    return CAPS;
  }

  private token(): string | null {
    return this.store.load(this.id).secret.token || null;
  }
  async nativeSource(src: SourceRow): Promise<import('@automix/core/native-preparation.ts').NativeMediaSource> {
    const token = this.token();
    if (!token) throw new Error('Подключите Яндекс Музыку');
    return { kind: 'yandex', externalId: String(src.external_id), token, apiBase: this.base };
  }

  private reactionKey(token = this.token()): string | null {
    return token ? createHash('sha256').update(token).digest('hex') : null;
  }

  private invalidateReactionSnapshot(): void {
    this.reactionSnapshotVersion++;
    this.reactionSnapshot = null;
    this.reactionRead = null;
  }

  private resetReactionConnection(): void {
    this.reactionGeneration++;
    this.reactionAccounts.clear();
    this.invalidateReactionSnapshot();
    this.onReactionConnectionChanged?.();
  }

  cachedReactionFor(externalId: string): ReactionValue | undefined {
    const cached = this.reactionSnapshot;
    if (!isYandexTrackId(externalId) || cached?.key !== this.reactionKey() || cached.expiresAt <= Date.now()) return undefined;
    return cached.values.get(externalId.split(':')[0]) ?? 0;
  }

  /** Capture an account connection without exposing its credential to callers. */
  reactionSession(): YandexReactionSession | null {
    const token = this.token();
    if (!token) return null;
    const key = this.reactionKey(token)!;
    const generation = this.reactionGeneration;
    const current = () => generation === this.reactionGeneration && this.reactionKey() === key;
    const assertCurrent = () => { if (!current()) throw new Error('Подключение Яндекс Музыки изменилось'); };
    const account = async (): Promise<string> => {
      assertCurrent();
      let pending = this.reactionAccounts.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            const result = await this.call<{ account?: { uid?: unknown } }>('GET', '/account/status', undefined, token);
            assertCurrent();
            const uid = String(result?.account?.uid ?? '');
            if (!/^\d{1,20}$/.test(uid)) throw new Error('Некорректный аккаунт');
            return uid;
          } catch {
            throw new Error('Не удалось проверить аккаунт Яндекс Музыки');
          }
        })();
        this.reactionAccounts.set(key, pending);
        const captured = pending;
        void pending.catch(() => { if (this.reactionAccounts.get(key) === captured) this.reactionAccounts.delete(key); });
      }
      const uid = await pending;
      assertCurrent();
      return uid;
    };
    return {
      key, current, account,
      write: async (uid, kind, action, externalId) => {
        try {
          assertCurrent();
          if (!/^\d{1,20}$/.test(uid) || !isYandexTrackId(externalId)
            || !['likes', 'dislikes'].includes(kind) || !['add-multiple', 'remove'].includes(action)) throw new Error('Некорректная реакция');
          if (uid !== await account()) throw new Error('Аккаунт изменился');
          assertCurrent();
          const result = await this.call<{ revision?: unknown }>('POST', `/users/${uid}/${kind}/tracks/${action}`,
            { 'track-ids': externalId }, token, true);
          assertCurrent();
          if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.revision) || Number(result.revision) < 0) throw new Error('Ответ не подтверждает запись');
          // Keep the account snapshot usable: patch the confirmed change instead of dropping it.
          const snapshot = this.reactionSnapshot, baseId = externalId.split(':')[0], value: ReactionValue = kind === 'likes' ? 1 : -1;
          this.invalidateReactionSnapshot();
          if (snapshot?.key === key) {
            if (action === 'add-multiple') snapshot.values.set(baseId, value);
            else if (snapshot.values.get(baseId) === value) snapshot.values.delete(baseId);
            this.reactionSnapshot = snapshot;
          }
          this.catalog.invalidate();
        } catch {
          throw new Error('Не удалось сохранить реакцию в Яндекс Музыке');
        }
      },
    };
  }

  /** A complete snapshot is required so a failed list never becomes a false neutral reaction. */
  async readReactions(): Promise<Map<string, ReactionValue>> {
    const session = this.reactionSession();
    if (!session) throw new Error('Подключите Яндекс Музыку для чтения реакций');
    const cached = this.reactionSnapshot;
    if (cached && cached.key === session.key && cached.expiresAt > Date.now()) return new Map(cached.values);
    const reading = this.reactionRead;
    if (reading && reading.key === session.key) return new Map(await reading.promise);
    const token = this.token()!;
    const version = this.reactionSnapshotVersion;
    const promise = (async () => {
      try {
        const uid = await session.account();
        if (!session.current()) throw new Error('Подключение изменилось');
        const lists = await Promise.all((['likes', 'dislikes'] as const).map(async (kind) => {
          const result = await this.call<{ library?: { tracks?: { id?: unknown }[] } }>('GET', `/users/${uid}/${kind}/tracks`, undefined, token);
          if (!result?.library || !Array.isArray(result.library.tracks)) throw new Error('Некорректный список реакций');
          return result.library.tracks;
        }));
        if (!session.current() || version !== this.reactionSnapshotVersion) throw new Error('Реакции изменились');
        const values = new Map<string, ReactionValue>();
        lists.forEach((tracks, index) => {
          for (const track of tracks) {
            const id = String(track?.id ?? '');
            if (isYandexTrackId(id)) values.set(id.split(':')[0], index === 0 ? 1 : -1);
          }
        });
        this.reactionSnapshot = { key: session.key, expiresAt: Date.now() + 120_000, values };
        return values;
      } catch {
        throw new Error('Не удалось получить реакции Яндекс Музыки');
      }
    })();
    this.reactionRead = { key: session.key, promise };
    try { return new Map(await promise); }
    finally { if (this.reactionRead?.promise === promise) this.reactionRead = null; }
  }

  private async call<T>(method: 'GET' | 'POST', p: string, body?: unknown, token = this.token(), form = false): Promise<T> {
    if (!token) throw new Error('нужен токен');
    const r = await httpJson<{ result: T; error?: { name: string; message: string } }>(`${this.base}${p}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `OAuth ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      },
      body: body ? (form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body)) : undefined,
    });
    if (r.status === 401 || r.status === 403) throw new Error('токен не принят');
    if (!r.body || r.body.error || r.status >= 400) throw new Error(`Яндекс Музыка не выполнила запрос (HTTP ${r.status})`);
    return r.body.result;
  }

  async info(force = false): Promise<ProviderInfo> {
    return this.cache.get(force, async () => {
      const token = this.token();
      if (!token) return makeInfo(PARTS, 'needs_credentials', 'Подключите аккаунт: поиск, лайки и подготовка доступных полных треков для AutoMix');
      try {
        const st = await this.call<{ account: { uid: number; login?: string; displayName?: string } }>('GET', '/account/status', undefined, token);
        return makeInfo(PARTS, 'connected', 'Аккаунт подключён. Добавляйте треки из поиска, лайков или по ссылке; доступ к аудио проверяется отдельно для каждого трека.', {
          hasSecret: true,
          account: st.account.displayName || st.account.login || String(st.account.uid),
        });
      } catch (e) {
        return makeInfo(PARTS, 'error', `Не удалось подключиться: ${(e as Error).message}`, { hasSecret: true });
      }
    });
  }

  async connect(_c: Record<string, string>, secret: Record<string, string>): Promise<void> {
    let token = (secret.token ?? '').trim().replace(/^OAuth\s+/i, '');
    if (/^https?:\/\//i.test(token)) {
      try {
        const u = new URL(token);
        token = new URLSearchParams(u.hash.slice(1)).get('access_token') ?? u.searchParams.get('access_token') ?? '';
      } catch { token = ''; }
    }
    if (!token) token = this.token() ?? '';
    if (!token) throw new Error('Вставьте токен');
    if (token.length > 8192 || /\s|[\r\n]/.test(token)) throw new Error('Некорректный формат токена');
    await this.call('GET', '/account/status', undefined, token);
    this.store.save(this.id, {}, { token }, true);
    this.cache.reset();
    this.catalog.clear();
    this.resetReactionConnection();
  }

  async disconnect(): Promise<void> {
    this.store.clear(this.id);
    this.cache.reset();
    this.catalog.clear();
    this.resetReactionConnection();
  }

  private matcher(): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of this.lib.all()) if (t.status === 'ok') m.set(this.matchKey(t.artist, t.title), t.id);
    return m;
  }

  private matchKey(artist: string, title: string): string {
    // Preserve Live/Remix/version words: they identify different recordings.
    return normKey(artist, '') + title.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  private item(t: YTrack, m: Map<string, string>): YandexWaveItem {
    const external = this.external(t);
    const artist = external.artist;
    const albumId = t.albums?.[0]?.id;
    const yandexId = albumId ? `${t.id}:${albumId}` : String(t.id);
    const remote = this.lib.tracksBySource(this.id, yandexId).find((r) => r.provider === this.id);
    const matched = m.get(this.matchKey(artist, external.title));
    const local = matched ? this.lib.get(matched) : null;
    const matchingDuration = local && external.duration > 0 && Math.abs(local.duration - external.duration) <= Math.max(1, external.duration * 0.02);
    return { yandexId, title: external.title, artist, trackId: remote?.id ?? (matchingDuration ? matched! : null) };
  }

  /** Prepare only a small playable batch, never the whole recommendation catalog. */
  private async prepareWave(items: YandexWaveItem[], count = 2): Promise<YandexWaveItem[]> {
    let ready = items.filter((item) => item.trackId).length;
    let attempts = 0, cursor = 0;
    const pending = items.filter((item) => !item.trackId);
    while (ready < count && attempts < count + 1 && cursor < pending.length) {
      // Two downloads at most; reserve room for both before dispatching.
      const size = Math.min(2, count - ready, count + 1 - attempts, pending.length - cursor);
      const batch = pending.slice(cursor, cursor + size);
      cursor += size;
      attempts += size;
      await Promise.all(batch.map(async (item) => {
        try {
          item.trackId = await this.importTrack({ externalId: item.yandexId, title: item.title, artist: item.artist,
            album: '', duration: 0, coverUrl: null, pageUrl: null, license: null, playable: true });
          ready++;
        } catch (e) { item.error = (e as Error).message; }
      }));
    }
    return items;
  }

  /** «Моя волна» Яндекса, сопоставленная с вашей медиатекой. */
  async wave(sessionId?: string | null, queue: string[] = [], options?: { count?: number; exclude?: string[]; seeds?: string[] }): Promise<{ sessionId: string; batchId: string | null; items: YandexWaveItem[] }> {
    const m = this.matcher();
    const count = Math.max(1, Math.min(4, Math.trunc(options?.count ?? 2)));
    const excluded = new Set((options?.exclude ?? []).map((id) => id.split(':')[0]));
    const prepare = (sequence: { track: YTrack }[]) => {
      const seen = new Set<string>();
      const items = sequence.slice(0, 100).map((s) => this.item(s.track, m)).filter((item) => {
        const id = item.yandexId.split(':')[0];
        if (seen.has(id) || excluded.has(id) || this.localReactionFor?.(item.yandexId) === -1) return false;
        seen.add(id);
        return true;
      });
      return this.prepareWave(items, count);
    };
    if (sessionId) {
      const r = await this.call<{ sequence?: { track: YTrack }[]; batchId?: string; unknownSession?: boolean }>('POST', `/rotor/session/${encodeURIComponent(sessionId)}/tracks`, { queue });
      if (!r.unknownSession) return { sessionId, batchId: r.batchId ?? null, items: await prepare(r.sequence ?? []) };
      // Sessions expire server-side; preserve exclusions when opening a replacement.
    }
    const r = await this.call<{ radioSessionId: string; batchId?: string; sequence: { track: YTrack }[] }>('POST', '/rotor/session/new', {
      seeds: ['user:onyourwave', ...(options?.seeds ?? [])],
      includeTracksInResponse: true,
      ...(queue.length ? { queue } : {}),
    });
    return { sessionId: r.radioSessionId, batchId: r.batchId ?? null, items: await prepare(r.sequence ?? []) };
  }

  private waveSettingsCache?: { at: number; groups: YandexWaveSetting[] };

  /** Labels and serialized seeds belong to the provider, never approximate local moods. */
  async waveSettings(): Promise<{ groups: YandexWaveSetting[] }> {
    if (this.waveSettingsCache && Date.now() - this.waveSettingsCache.at < 300_000) return { groups: this.waveSettingsCache.groups };
    const r = await this.call<{ settingRestrictions?: Record<string, { name?: string; possibleValues?: { name?: string; serializedSeed?: string; unspecified?: boolean }[] }> }>(
      'GET', '/rotor/wave/settings?seeds=user%3Aonyourwave');
    const groups = Object.entries(r.settingRestrictions ?? {}).flatMap(([id, group]) => {
      const values = (group.possibleValues ?? []).flatMap((v) =>
        typeof v.name === 'string' && typeof v.serializedSeed === 'string' && /^setting[A-Za-z]+:[a-zA-Z0-9_-]{1,80}$/.test(v.serializedSeed)
          ? [{ name: v.name.slice(0, 120), seed: v.serializedSeed }] : []);
      return values.length ? [{ id, name: group.name || id, values }] : [];
    });
    this.waveSettingsCache = { at: Date.now(), groups };
    return { groups };
  }

  async feedback(sessionId: string, batchId: string | null, event: { type: 'trackStarted' | 'trackFinished' | 'skip'; trackId: string; totalPlayedSeconds?: number }): Promise<void> {
    await this.call('POST', `/rotor/session/${encodeURIComponent(sessionId)}/feedback`, {
      event: { ...event, timestamp: new Date().toISOString() },
      batchId: batchId ?? undefined,
    });
  }

  async likes(): Promise<YandexWaveItem[]> {
    const st = await this.call<{ account: { uid: number } }>('GET', '/account/status');
    const lib = await this.call<{ library: { tracks: { id: string; albumId?: string }[] } }>('GET', `/users/${st.account.uid}/likes/tracks`);
    const ids = lib.library.tracks.slice(0, 300).map((t) => (t.albumId ? `${t.id}:${t.albumId}` : t.id));
    if (!ids.length) return [];
    const details = await this.call<YTrack[]>('POST', '/tracks', { 'track-ids': ids.join(',') }, this.token(), true);
    const m = this.matcher();
    const byId = new Map(details.map((t) => [String(t.id), t]));
    return ids.flatMap((id) => { const t = byId.get(id.split(':')[0]); return t ? [this.item(t, m)] : []; });
  }

  /** The likes endpoint returns the library snapshot, not a 60-track recommendation page. */
  async likeIds(): Promise<{ key: string; ids: string[] }> {
    const session = this.reactionSession();
    if (!session) throw new Error('Подключите Яндекс Музыку');
    const uid = await session.account();
    const result = await this.call<{ library?: { tracks?: { id: string | number; albumId?: string | number }[] } }>('GET', `/users/${uid}/likes/tracks`);
    if (!session.current()) throw new Error('Подключение Яндекса изменилось');
    const tracks = result.library?.tracks;
    if (!Array.isArray(tracks)) throw new Error('Яндекс не вернул список любимых треков');
    if (tracks.length > 50000) throw new Error('В коллекции больше 50 000 записей. Импорт не начат, список не обрезан.');
    const ids = tracks.map((t) => this.checkedId(t.albumId ? `${t.id}:${t.albumId}` : String(t.id)));
    return { key: session.key, ids: [...new Set(ids)] };
  }

  private checkedId(value: string): string {
    if (!isYandexTrackId(value)) throw new Error('Некорректный ID трека Яндекса');
    return value;
  }

  /** Confirm catalog identity and edition without importing or downloading audio. */
  async verifyReactionId(value: string): Promise<string> {
    try {
      const id = this.checkedId(value);
      const session = this.reactionSession();
      if (!session) throw new Error('Нет подключения');
      const [track] = await this.call<YTrack[]>('POST', '/tracks', { 'track-ids': id }, this.token(), true);
      if (!session.current() || !track || String(track.id).split(':')[0].toLowerCase() !== id.split(':')[0].toLowerCase()) throw new Error('Трек не подтверждён');
      return this.checkedId(this.external(track, id.split(':')[1]).externalId);
    } catch {
      throw new Error('Не удалось подтвердить трек Яндекс Музыки');
    }
  }

  private external(t: YTrack, requestedAlbumId?: string): ExternalTrack {
    const album = requestedAlbumId ? t.albums?.find((candidate) => String(candidate.id) === requestedAlbumId) : t.albums?.[0];
    if (requestedAlbumId && !album) throw new Error('Яндекс не подтвердил выбранное издание альбома');
    const baseId = String(t.id).split(':')[0];
    const externalId = album?.id ? `${baseId}:${album.id}` : String(t.id);
    let coverUrl: string | null = null;
    const coverUri = album?.coverUri ?? t.coverUri;
    if (coverUri) {
      try { coverUrl = validateYandexMediaUrl(`https://${coverUri.replace(/^https?:\/\//, '').replace('%%', '400x400')}`, this.base).href; } catch { /* optional cover */ }
    }
    return { externalId, title: `${t.title}${t.version ? ` (${t.version})` : ''}`, artist: t.artists?.map((a) => a.name).join(', ') ?? '',
      album: `${album?.title ?? ''}${album?.version ? ` (${album.version})` : ''}`, duration: (t.durationMs ?? 0) / 1000, coverUrl,
      pageUrl: `https://music.yandex.ru/track/${String(t.id).split(':')[0]}`, license: null,
      playable: t.available !== false || t.availableForPremiumUsers === true };
  }

  async search(query: string): Promise<ExternalTrack[]> {
    const text = query.trim().slice(0, 500);
    let id = isYandexTrackId(text) ? text : null;
    if (/^https?:\/\//i.test(text)) {
      let url: URL;
      try { url = new URL(text); } catch { throw new Error('Некорректная ссылка Яндекс Музыки'); }
      if (!/^music\.yandex\.(ru|com|kz|by|uz)$/.test(url.hostname)) throw new Error('Нужна ссылка на трек Яндекс Музыки');
      id = /\/track\/([^/]+)/.exec(url.pathname)?.[1] ?? null;
      if (id && !isYandexTrackId(id)) id = null;
      if (!id) throw new Error('Вставьте ссылку на отдельный трек Яндекс Музыки');
    }
    if (id) return (await this.call<YTrack[]>('POST', '/tracks', { 'track-ids': this.checkedId(id) }, this.token(), true)).map((t) => this.external(t));
    const r = await this.call<{ tracks?: { results?: YTrack[] } }>('GET', `/search?${new URLSearchParams({ text, type: 'track', page: '0', 'no-correct': 'true' })}`);
    return (r.tracks?.results ?? []).map((t) => this.external(t));
  }

  async featured(): Promise<ExternalTrack[]> {
    const st = await this.call<{ account: { uid: number } }>('GET', '/account/status');
    const r = await this.call<{ library: { tracks: { id: string; albumId?: string }[] } }>('GET', `/users/${st.account.uid}/likes/tracks`);
    const ids = r.library.tracks.slice(0, 60).map((t) => this.checkedId(t.albumId ? `${t.id}:${t.albumId}` : String(t.id)));
    if (!ids.length) return [];
    const details = await this.call<YTrack[]>('POST', '/tracks', { 'track-ids': ids.join(',') }, this.token(), true);
    const byId = new Map(details.map((t) => [String(t.id), t]));
    return ids.flatMap((id) => { const t = byId.get(id.split(':')[0]); return t ? [this.external(t, id.split(':')[1])] : []; });
  }

  importTrack(t: ExternalTrack): Promise<string> {
    const id = this.checkedId(String(t.externalId));
    const pending = this.imports.get(id);
    if (pending) return pending;
    const job = this.importOne(id).finally(() => this.imports.delete(id));
    this.imports.set(id, job);
    return job;
  }

  private async importOne(id: string): Promise<string> {
    const found = this.lib.tracksBySource(this.id, id).find((t) => t.provider === this.id);
    if (found) return found.id;
    // Trust server-side metadata, not the title/duration/URLs supplied by a browser.
    const [track] = await this.call<YTrack[]>('POST', '/tracks', { 'track-ids': id }, this.token(), true);
    if (!track) throw new Error('Трек Яндекса не найден');
    const requestedAlbumId = id.split(':')[1];
    const album = requestedAlbumId ? track.albums?.find((candidate) => String(candidate.id) === requestedAlbumId) : track.albums?.[0];
    const ext = this.external(track, requestedAlbumId);
    if (!ext.playable || !(ext.duration > 0)) throw new Error('Этот трек недоступен вашему аккаунту');
    const canonicalId = this.checkedId(ext.externalId);
    const canonical = this.lib.tracksBySource(this.id, canonicalId).find((t) => t.provider === this.id);
    if (canonical) return canonical.id;
    const media = await this.audio.prepare(canonicalId, ext.duration);
    const cover = ext.coverUrl ? await this.audio.cover(ext.coverUrl) : null;
    const coverId = cover ? await this.lib.saveCover(cover.data, cover.type) : null;
    return this.lib.addRemote({ provider: this.id, externalId: canonicalId, title: ext.title, artist: ext.artist, album: ext.album,
      duration: media.probe.duration, year: album?.year ?? null, genre: album?.genre ?? '',
      trackNo: album?.trackPosition?.index ?? null, discNo: album?.trackPosition?.volume ?? null,
      coverId,
      meta: { pageUrl: ext.pageUrl, suffix: 'mp3', audioHash: media.hash, bitrate: media.bitrate,
        catalogArtists: (track.artists ?? []).filter((artist) => artist.id !== undefined && /^\d+$/.test(String(artist.id))).map((artist) => ({ id: String(artist.id), name: artist.name })),
        catalogAlbumId: album?.id ? String(album.id) : null },
      content: { hash: media.hash, size: media.size, probe: media.probe } }).id;
  }

  async fetchAudio(src: SourceRow): Promise<string> {
    const track = this.lib.get(src.track_id);
    const meta = JSON.parse(src.meta || '{}') as { audioHash?: string };
    if (!track || !/^[a-f\d]{64}$/.test(track.content_hash)) throw new Error('Аудио Яндекса ещё не проверено. Добавьте трек заново.');
    if (meta.audioHash && meta.audioHash !== track.content_hash) throw new Error('Версия аудио Яндекса не совпадает с сохранённым анализом');
    return (await this.audio.prepare(this.checkedId(String(src.external_id)), track.duration, track.content_hash)).file;
  }
}
