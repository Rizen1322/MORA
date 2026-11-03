import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Library, SourceRow } from '../library.ts';
import { StatusCache, makeInfo, type InfoParts } from './base.ts';
import { downloadTo, httpJson, type Capabilities, type ExternalTrack, type Provider, type ProviderInfo } from './types.ts';

const CAPS: Capabilities = {
  search: true,
  library: false,
  playlists: false,
  recommendations: false,
  playback: true,
  seek: true,
  pcm: true,
  // terms of use could not be verified (HTTP 403), so no analysis and no overlap
  analysis: false,
  mixing: false,
  caching: 'session',
};

const PARTS: InfoParts = {
  id: 'audius',
  name: 'Audius',
  kind: 'catalog',
  official: true,
  caps: CAPS,
  notes: [
    'Публичный REST API: поиск и полные треки. Ключ AUDIUS_API_KEY необязателен (повышает лимиты).',
    'Анализ и смешивание выключены, пока условия использования API не проверены вручную: доступно только воспроизведение без наложения.',
  ],
  docs: ['https://docs.audius.co/api/', 'https://docs.audius.co/developers/introduction/overview'],
};

interface ATrack {
  id: string;
  title: string;
  user: { name: string; handle: string };
  duration: number;
  artwork?: { '480x480'?: string };
  permalink?: string;
  is_streamable?: boolean;
}

export class AudiusProvider implements Provider {
  readonly id = 'audius';
  private cache = new StatusCache(5 * 60000);
  private readonly base = 'https://api.audius.co/v1';
  constructor(
    private readonly cfg: AppConfig,
    private readonly lib: Library,
  ) {}

  capabilities(): Capabilities {
    return CAPS;
  }

  private headers(): Record<string, string> {
    return this.cfg.audiusApiKey ? { 'x-api-key': this.cfg.audiusApiKey } : {};
  }

  private async api<T>(p: string, params: Record<string, string> = {}): Promise<T> {
    const sp = new URLSearchParams({ app_name: 'AutoMix', ...params });
    const r = await httpJson<{ data: T }>(`${this.base}${p}?${sp}`, { headers: this.headers() });
    if (r.status === 403) throw new Error('сервер отклонил запрос (HTTP 403)');
    if (!r.body) throw new Error(`HTTP ${r.status}`);
    return r.body.data;
  }

  async info(force = false): Promise<ProviderInfo> {
    return this.cache.get(force, async () => {
      try {
        await this.api('/tracks/trending', { limit: '1' });
        return makeInfo(PARTS, 'connected', 'Доступно только воспроизведение (без AutoMix)');
      } catch (e) {
        return makeInfo(PARTS, 'unavailable', `Недоступно с этого компьютера: ${(e as Error).message}`);
      }
    });
  }

  private toExternal(t: ATrack): ExternalTrack {
    return {
      externalId: t.id,
      title: t.title,
      artist: t.user?.name ?? '',
      album: '',
      duration: t.duration,
      coverUrl: t.artwork?.['480x480'] ?? null,
      pageUrl: t.permalink ? `https://audius.co${t.permalink}` : null,
      license: null,
      playable: t.is_streamable !== false,
    };
  }

  async search(query: string): Promise<ExternalTrack[]> {
    return (await this.api<ATrack[]>('/tracks/search', { query })).map((t) => this.toExternal(t));
  }

  async featured(): Promise<ExternalTrack[]> {
    return (await this.api<ATrack[]>('/tracks/trending', { limit: '30' })).map((t) => this.toExternal(t));
  }

  async importTrack(t: ExternalTrack): Promise<string> {
    return this.lib.addRemote({
      provider: this.id,
      externalId: t.externalId,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      meta: { pageUrl: t.pageUrl },
    }).id;
  }

  async fetchAudio(src: SourceRow): Promise<string> {
    const file = path.join(this.cfg.dataDir, 'session-cache', 'audius', `${String(src.external_id).replace(/[^A-Za-z0-9]/g, '')}.mp3`);
    if (fs.existsSync(file)) return file;
    const sp = new URLSearchParams({ app_name: 'AutoMix' });
    await downloadTo(`${this.base}/tracks/${encodeURIComponent(String(src.external_id))}/stream?${sp}`, file);
    return file;
  }
  async nativeSource(src: SourceRow): Promise<import('@automix/core/native-preparation.ts').NativeMediaSource> {
    return { kind: 'direct', url: `${this.base}/tracks/${encodeURIComponent(String(src.external_id))}/stream?app_name=AutoMix` };
  }
}
