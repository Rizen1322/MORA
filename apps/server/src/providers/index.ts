import type { AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Library, SourceRow } from '../library.ts';
import { AudiusProvider } from './audius.ts';
import { ProviderStore } from './base.ts';
import { JamendoProvider } from './jamendo.ts';
import { LocalProvider, spotify } from './static.ts';
import { PublicProvider, type PublicMusic } from '../public/provider.ts';
import { SubsonicProvider } from './subsonic.ts';
import type { Capabilities, Provider, ProviderInfo } from './types.ts';
import { YandexProvider } from './yandex.ts';

export class ProviderRegistry {
  readonly store: ProviderStore;
  readonly subsonic: SubsonicProvider;
  readonly jamendo: JamendoProvider;
  readonly audius: AudiusProvider;
  readonly yandex: YandexProvider;
  readonly list: Provider[];

  constructor(db: Db, cfg: AppConfig, lib: Library, publicMusic: PublicMusic) {
    this.store = new ProviderStore(db);
    this.subsonic = new SubsonicProvider(this.store, cfg, lib);
    this.jamendo = new JamendoProvider(this.store, cfg, lib);
    this.audius = new AudiusProvider(cfg, lib);
    this.yandex = new YandexProvider(this.store, lib, cfg);
    const local = new LocalProvider(() => {
      const all = lib.all().filter((t) => t.provider === 'local');
      return { tracks: all.length, missing: all.filter((t) => t.status === 'missing').length };
    });
    this.list = [local, new PublicProvider('youtube', publicMusic), new PublicProvider('soundcloud', publicMusic), this.yandex, this.subsonic, this.jamendo, this.audius, spotify()];
    // analysis and mixing are allowed per provider, not per stream URL
    for (const p of this.list) lib.mixingPolicy.set(p.id, p.capabilities().mixing && p.capabilities().analysis);
    lib.remoteFetcher = (src: SourceRow, signal?: AbortSignal) => this.fetchAudio(src, signal);
  }

  get(id: string): Provider | undefined {
    return this.list.find((p) => p.id === id);
  }

  caps(id: string): Capabilities | null {
    return this.get(id)?.capabilities() ?? null;
  }

  async infos(force = false): Promise<ProviderInfo[]> {
    return Promise.all(this.list.map((p) => p.info(force)));
  }

  private fetchAudio(src: SourceRow, signal?: AbortSignal): Promise<string> {
    const p = this.get(src.provider);
    if (!p?.fetchAudio) throw new Error('источник не поддерживает воспроизведение');
    return p.fetchAudio(src, signal);
  }
}

export type { ProviderInfo, Capabilities } from './types.ts';
