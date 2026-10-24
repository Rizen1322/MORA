import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from '../config.ts';
import type { Library, SourceRow } from '../library.ts';
import { ProviderStore, StatusCache, makeInfo, type InfoParts } from './base.ts';
import { downloadTo, httpJson, type Capabilities, type ExternalTrack, type Provider, type ProviderInfo } from './types.ts';

const CAPS: Capabilities = {
  search: true,
  library: false,
  playlists: false,
  recommendations: false,
  playback: true,
  seek: true,
  pcm: true,
  analysis: true,
  mixing: true,
  caching: 'session',
};

const PARTS: InfoParts = {
  id: 'jamendo',
  name: 'Jamendo',
  kind: 'catalog',
  official: true,
  caps: CAPS,
  notes: [
    'Официальный API, музыка под лицензиями Creative Commons. Бесплатно только для некоммерческого использования.',
    'AutoMix включён для персонального прослушивания; у каждого трека показываются автор, лицензия и ссылка на страницу.',
    'Условия запрещают офлайн-доступ: аудио кэшируется только до перезапуска приложения.',
  ],
  docs: ['https://developer.jamendo.com/v3.0/docs', 'https://devportal.jamendo.com/api_terms_of_use'],
  fields: [{ key: 'clientId', label: 'Client ID', type: 'password', secret: true, help: 'Создайте приложение на devportal.jamendo.com' }],
};

interface JTrack {
  id: string;
  name: string;
  artist_name: string;
  album_name: string;
  duration: number;
  image: string;
  audio: string;
  shareurl: string;
  license_ccurl: string;
  audiodownload_allowed?: boolean;
}

export class JamendoProvider implements Provider {
  readonly id = 'jamendo';
  private cache = new StatusCache();
  constructor(
    private readonly store: ProviderStore,
    private readonly cfg: AppConfig,
    private readonly lib: Library,
  ) {}

  capabilities(): Capabilities {
    return CAPS;
  }

  private clientId(): string | null {
    return this.store.load(this.id).secret.clientId || this.cfg.jamendoClientId;
  }

  private async api(pathname: string, params: Record<string, string>, clientId = this.clientId()): Promise<JTrack[]> {
    if (!clientId) throw new Error('нужен client_id');
    const sp = new URLSearchParams({ client_id: clientId, format: 'json', ...params });
    const r = await httpJson<{ headers: { status: string; error_message?: string; code: number }; results: JTrack[] }>(`https://api.jamendo.com/v3.0/${pathname}/?${sp}`);
    if (!r.body) throw new Error(`Jamendo ответил ${r.status}`);
    if (r.body.headers.status !== 'success') throw new Error(r.body.headers.error_message || `ошибка ${r.body.headers.code}`);
    return r.body.results;
  }

  async info(force = false): Promise<ProviderInfo> {
    return this.cache.get(force, async () => {
      const id = this.clientId();
      const extra = { hasSecret: !!id };
      if (!id) return makeInfo(PARTS, 'needs_credentials', 'Требуется client_id разработчика Jamendo', extra);
      try {
        await this.api('tracks', { limit: '1' }, id);
        return makeInfo(PARTS, 'connected', 'Подключено: поиск и воспроизведение треков Creative Commons', extra);
      } catch (e) {
        return makeInfo(PARTS, 'error', `Не удалось проверить ключ: ${(e as Error).message}`, extra);
      }
    });
  }

  async connect(_config: Record<string, string>, secret: Record<string, string>): Promise<void> {
    const id = (secret.clientId ?? '').trim();
    if (!id) throw new Error('Укажите client_id');
    await this.api('tracks', { limit: '1' }, id);
    this.store.save(this.id, {}, { clientId: id }, true);
    this.cache.reset();
  }

  async disconnect(): Promise<void> {
    this.store.clear(this.id);
    this.cache.reset();
  }

  private toExternal(t: JTrack): ExternalTrack {
    return {
      externalId: t.id,
      title: t.name,
      artist: t.artist_name,
      album: t.album_name,
      duration: t.duration,
      coverUrl: t.image || null,
      pageUrl: t.shareurl || null,
      license: t.license_ccurl || null,
      playable: !!t.audio,
    };
  }

  async search(query: string): Promise<ExternalTrack[]> {
    return (await this.api('tracks', { search: query, limit: '30', audioformat: 'mp32', include: 'musicinfo' })).map((t) => this.toExternal(t));
  }

  async featured(): Promise<ExternalTrack[]> {
    return (await this.api('tracks', { order: 'popularity_week', limit: '30', audioformat: 'mp32' })).map((t) => this.toExternal(t));
  }

  async importTrack(t: ExternalTrack): Promise<string> {
    const [full] = await this.api('tracks', { id: t.externalId, audioformat: 'mp32' });
    if (!full?.audio) throw new Error('трек недоступен для воспроизведения');
    let coverId: string | null = null;
    if (full.image) {
      try {
        const res = await fetch(full.image, { signal: AbortSignal.timeout(15000) });
        if (res.ok) coverId = await this.lib.saveCover(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? undefined);
      } catch {
        coverId = null;
      }
    }
    return this.lib.addRemote({
      provider: this.id,
      externalId: full.id,
      title: full.name,
      artist: full.artist_name,
      album: full.album_name,
      duration: full.duration,
      coverId,
      meta: { pageUrl: full.shareurl, license: full.license_ccurl },
    }).id;
  }

  async fetchAudio(src: SourceRow): Promise<string> {
    // session-only cache, wiped on restart (terms: no offline access)
    const file = path.join(this.cfg.dataDir, 'session-cache', 'jamendo', `${String(src.external_id).replace(/\D/g, '')}.mp3`);
    if (fs.existsSync(file)) return file;
    const [full] = await this.api('tracks', { id: String(src.external_id), audioformat: 'mp32' });
    if (!full?.audio) throw new Error('трек больше недоступен на Jamendo');
    await downloadTo(full.audio, file);
    return file;
  }
  async nativeSource(src: SourceRow): Promise<import('@automix/core/native-preparation.ts').NativeMediaSource> {
    const [full] = await this.api('tracks', { id: String(src.external_id), audioformat: 'mp32' });
    if (!full?.audio) throw new Error('Трек недоступен на Jamendo');
    return { kind: 'direct', url: full.audio, ext: '.mp3' };
  }
}
