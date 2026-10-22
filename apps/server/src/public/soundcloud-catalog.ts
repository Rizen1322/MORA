import { SharedPreparation } from './shared-preparation.ts';
import { getSoundCloudArtist, type SoundCloudArtist } from './soundcloud.ts';

export class SoundCloudCatalogError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function validSoundCloudArtistId(id: string): boolean { return /^\d{1,20}$/.test(id); }

/** Public artist pages are cached briefly and share in-flight profile requests. */
export class SoundCloudCatalog {
  private cache = new Map<string, { until: number; data: SoundCloudArtist }>();
  private jobs = new SharedPreparation<SoundCloudArtist>();

  async get(id: string, signal?: AbortSignal): Promise<SoundCloudArtist> {
    if (!validSoundCloudArtistId(id)) throw new SoundCloudCatalogError('Некорректный ID исполнителя', 400);
    if (signal?.aborted) throw new Error('Отменено');
    const cached = this.cache.get(id);
    if (cached && cached.until > Date.now()) { this.cache.delete(id); this.cache.set(id, cached); return cached.data; }
    return this.jobs.run(id, { signal }, async (abort) => {
      let data: SoundCloudArtist;
      try { data = await getSoundCloudArtist(id, abort); }
      catch (error) {
        const message = (error as Error).message;
        throw new SoundCloudCatalogError(message, message.includes('не подтверждён') ? 404 : 502);
      }
      if (!data.title) throw new SoundCloudCatalogError('Имя исполнителя SoundCloud не найдено', 404);
      this.cache.delete(id); this.cache.set(id, { until: Date.now() + 5 * 60_000, data });
      while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      return data;
    });
  }
}
