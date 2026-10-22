import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Library, SourceRow } from '../library.ts';
import { ProviderStore, StatusCache, makeInfo, type InfoParts } from './base.ts';
import { downloadTo, httpJson, type Capabilities, type ExternalTrack, type Provider, type ProviderInfo } from './types.ts';

const CAPS: Capabilities = {
  search: true,
  library: true,
  playlists: false,
  recommendations: false,
  playback: true,
  seek: true,
  pcm: true,
  analysis: true,
  mixing: true,
  caching: 'persistent',
};

const PARTS: InfoParts = {
  id: 'subsonic',
  name: 'Navidrome / Subsonic',
  kind: 'self-hosted',
  official: true,
  caps: CAPS,
  notes: [
    'Ваш собственный музыкальный сервер: поиск, импорт и полный AutoMix, как для локальных файлов.',
    'Пароль хранится только в локальной базе backend и не передаётся в браузер. В запросах используется токен md5(пароль + соль) по спецификации Subsonic.',
    'Аудио загружается с вашего сервера в локальный кэш при первом воспроизведении.',
  ],
  docs: ['https://www.navidrome.org/docs/developers/subsonic-api/', 'http://www.subsonic.org/pages/api.jsp'],
  fields: [
    { key: 'url', label: 'Адрес сервера', type: 'url', secret: false, placeholder: 'http://192.168.1.10:4533' },
    { key: 'username', label: 'Пользователь', type: 'text', secret: false },
    { key: 'password', label: 'Пароль', type: 'password', secret: true },
  ],
};

interface SubsonicSong {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  suffix?: string;
  coverArt?: string;
  track?: number;
  year?: number;
  genre?: string;
}

export class SubsonicProvider implements Provider {
  readonly id = 'subsonic';
  private cache = new StatusCache();
  constructor(
    private readonly store: ProviderStore,
    private readonly cfg: AppConfig,
    private readonly lib: Library,
  ) {}

  capabilities(): Capabilities {
    return CAPS;
  }

  private creds(): { url: string; username: string; password: string } | null {
    const s = this.store.load(this.id);
    if (!s.config.url || !s.config.username || !s.secret.password) return null;
    return { url: s.config.url.replace(/\/+$/, ''), username: s.config.username, password: s.secret.password };
  }

  /** Builds an authenticated API URL. Never log the result. */
  private url(method: string, params: Record<string, string> = {}, c = this.creds()): string {
    if (!c) throw new Error('Subsonic не подключён');
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(c.password + salt).digest('hex');
    const sp = new URLSearchParams({ u: c.username, t: token, s: salt, v: '1.16.1', c: 'AutoMix', f: 'json', ...params });
    return `${c.url}/rest/${method}?${sp.toString()}`;
  }

  private async call<T>(method: string, params: Record<string, string> = {}, c = this.creds()): Promise<T> {
    const r = await httpJson<{ 'subsonic-response': T & { status: string; error?: { code: number; message: string } } }>(this.url(method, params, c));
    const body = r.body?.['subsonic-response'];
    if (!body) throw new Error(`сервер ответил ${r.status} без ответа Subsonic`);
    if (body.status !== 'ok') throw new Error(body.error?.message ?? 'ошибка Subsonic');
    return body;
  }

  async info(force = false): Promise<ProviderInfo> {
    return this.cache.get(force, async () => {
      const s = this.store.load(this.id);
      const base = { config: { url: s.config.url ?? '', username: s.config.username ?? '' }, hasSecret: !!s.secret.password };
      const c = this.creds();
      if (!c) return makeInfo(PARTS, 'needs_credentials', 'Требуется подключение: укажите адрес сервера, логин и пароль', base);
      try {
        await this.call('ping', {}, c);
        return makeInfo(PARTS, 'connected', `Подключено к ${new URL(c.url).host}`, { ...base, account: c.username });
      } catch (e) {
        return makeInfo(PARTS, 'error', `Сервер недоступен: ${(e as Error).message}`, base);
      }
    });
  }

  async connect(config: Record<string, string>, secret: Record<string, string>): Promise<void> {
    const prev = this.store.load(this.id);
    const c = {
      url: (config.url ?? '').trim().replace(/\/+$/, ''),
      username: (config.username ?? '').trim(),
      password: secret.password || prev.secret.password || '',
    };
    if (!/^https?:\/\//.test(c.url)) throw new Error('Адрес должен начинаться с http:// или https://');
    if (!c.username || !c.password) throw new Error('Укажите пользователя и пароль');
    await this.call('ping', {}, c);
    this.store.save(this.id, { url: c.url, username: c.username }, { password: c.password }, true);
    this.cache.reset();
  }

  async disconnect(): Promise<void> {
    this.store.clear(this.id);
    this.cache.reset();
  }

  private toExternal(s: SubsonicSong): ExternalTrack {
    return {
      externalId: s.id,
      title: s.title,
      artist: s.artist ?? '',
      album: s.album ?? '',
      duration: s.duration ?? 0,
      coverUrl: s.coverArt ? `/api/providers/subsonic/cover/${encodeURIComponent(s.coverArt)}` : null,
      pageUrl: null,
      license: null,
      playable: true,
    };
  }

  async search(query: string): Promise<ExternalTrack[]> {
    const r = await this.call<{ searchResult3?: { song?: SubsonicSong[] } }>('search3', { query, songCount: '40', albumCount: '0', artistCount: '0' });
    return (r.searchResult3?.song ?? []).map((s) => this.toExternal(s));
  }

  async featured(): Promise<ExternalTrack[]> {
    const r = await this.call<{ randomSongs?: { song?: SubsonicSong[] } }>('getRandomSongs', { size: '30' });
    return (r.randomSongs?.song ?? []).map((s) => this.toExternal(s));
  }

  async coverStream(coverArt: string): Promise<Response> {
    return fetch(this.url('getCoverArt', { id: coverArt, size: '600' }), { signal: AbortSignal.timeout(15000) });
  }

  async importTrack(t: ExternalTrack): Promise<string> {
    const r = await this.call<{ song?: SubsonicSong }>('getSong', { id: t.externalId });
    const s = r.song ?? { id: t.externalId, title: t.title, artist: t.artist, album: t.album, duration: t.duration };
    let coverId: string | null = null;
    if (s.coverArt) {
      try {
        const res = await this.coverStream(s.coverArt);
        if (res.ok) coverId = await this.lib.saveCover(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? undefined);
      } catch {
        coverId = null;
      }
    }
    const row = this.lib.addRemote({
      provider: this.id,
      externalId: s.id,
      title: s.title,
      artist: s.artist ?? '',
      album: s.album ?? '',
      duration: s.duration ?? 0,
      trackNo: s.track ?? null,
      year: s.year ?? null,
      genre: s.genre ?? '',
      coverId,
      meta: { suffix: s.suffix ?? 'bin' },
    });
    return row.id;
  }

  async fetchAudio(src: SourceRow): Promise<string> {
    const meta = JSON.parse(src.meta || '{}') as { suffix?: string };
    const safeId = String(src.external_id).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(this.cfg.dataDir, 'remote', 'subsonic', `${safeId}.${(meta.suffix ?? 'bin').replace(/[^a-z0-9]/gi, '')}`);
    if (fs.existsSync(file)) return file;
    await downloadTo(this.url('download', { id: String(src.external_id) }), file);
    return file;
  }
}
