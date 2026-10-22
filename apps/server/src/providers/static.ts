import { makeInfo, type InfoParts } from './base.ts';
import { NO_CAPS, type Capabilities, type Provider, type ProviderInfo } from './types.ts';

const LOCAL_CAPS: Capabilities = {
  search: true,
  library: true,
  playlists: true,
  recommendations: true,
  playback: true,
  seek: true,
  pcm: true,
  analysis: true,
  mixing: true,
  caching: 'persistent',
};

/** Local files: always available, no account. */
export class LocalProvider implements Provider {
  readonly id = 'local';
  constructor(private readonly count: () => { tracks: number; missing: number }) {}
  capabilities(): Capabilities {
    return LOCAL_CAPS;
  }
  async info(): Promise<ProviderInfo> {
    const c = this.count();
    const parts: InfoParts = {
      id: 'local',
      name: 'Мои файлы',
      kind: 'local',
      official: true,
      caps: LOCAL_CAPS,
      notes: [
        'Работает без интернета, ключей и аккаунтов.',
        'Перетащите файлы или папку в окно приложения либо укажите папку на диске.',
        'Импортированные копии хранятся в папке data/library; файлы, добавленные по пути, остаются на месте.',
      ],
      docs: [],
    };
    return makeInfo(parts, 'connected', c.missing ? `${c.tracks} треков, ${c.missing} файлов не найдено` : `${c.tracks} треков`);
  }
}

/** Providers we deliberately do not connect, with the reason shown in the UI. */
export class RestrictedProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly name: string,
    private readonly statusText: string,
    private readonly notes: string[],
    private readonly docs: string[],
    private readonly caps: Partial<Capabilities> = {},
  ) {}
  capabilities(): Capabilities {
    return { ...NO_CAPS, ...this.caps };
  }
  async info(): Promise<ProviderInfo> {
    return makeInfo(
      { id: this.id, name: this.name, kind: 'restricted', official: true, caps: this.capabilities(), notes: this.notes, docs: this.docs },
      'not_supported',
      this.statusText,
    );
  }
}

export function spotify(): RestrictedProvider {
  return new RestrictedProvider(
    'spotify',
    'Spotify',
    'Не подключается: политика разработчиков запрещает смешивание',
    [
      'Пункт III.7: запрещено сводить, смешивать или накладывать контент Spotify на другой звук.',
      'Пункт III.13: запрещено анализировать контент Spotify.',
      'Web Playback SDK не даёт PCM, поэтому DJ-движок не может с ним работать.',
    ],
    ['https://developer.spotify.com/policy'],
    { search: true },
  );
}
