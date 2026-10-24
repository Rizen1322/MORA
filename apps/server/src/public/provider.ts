import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { FfmpegTools } from '../ffmpeg.ts';
import { q } from '../db.ts';
import type { Db } from '../db.ts';
import { sha256File, type Library, type SourceRow } from '../library.ts';
import { makeInfo } from '../providers/base.ts';
import type { Capabilities, ExternalTrack, Provider, ProviderInfo } from '../providers/types.ts';
import { rank, versionLabels, type VersionLabel } from './match.ts';
import { searchSoundCloud } from './soundcloud.ts';
import { radioCandidates } from './radio-candidates.ts';
import { searchYtm, type YtmItem } from './ytmusic.ts';
import { ResolverError, type Priority, type YtDlp } from './ytdlp.ts';
import { SharedPreparation } from './shared-preparation.ts';
import { growingAudioInput, type GrowingAudio } from './growing-audio.ts';

/** Where a result was found. Audio of ytmusic and youtube results is the same YouTube recording. */
export type PublicSource = 'ytmusic' | 'youtube' | 'soundcloud';
export type AudioProvider = 'youtube' | 'soundcloud';

export interface PublicTrack extends ExternalTrack {
  source: PublicSource;
  audioProvider: AudioProvider;
  kind: 'song' | 'video' | 'track';
  explicit: boolean;
  uploader: string;
  labels: VersionLabel[];
  artistId: string | null;
  albumId: string | null;
}

export const PUBLIC_CAPS: Capabilities = { search: true, library: false, playlists: false, recommendations: true, playback: true, seek: true, pcm: true, analysis: true, mixing: true, caching: 'persistent' };

const SOURCE_NAMES: Record<PublicSource, string> = { ytmusic: 'YouTube Music', youtube: 'YouTube', soundcloud: 'SoundCloud' };
const COVER_HOSTS = [/^i\d?\.ytimg\.com$/, /^(lh|yt)\d\.googleusercontent\.com$/, /^yt\d\.ggpht\.com$/, /^i\d?\.sndcdn\.com$/];

export const audioProviderOf = (s: PublicSource): AudioProvider => (s === 'soundcloud' ? 'soundcloud' : 'youtube');
export const validExternalId = (p: AudioProvider, id: string): boolean => (p === 'youtube' ? /^[\w-]{11}$/.test(id) : /^\d{1,20}$/.test(id));
export const canonicalUrl = (p: AudioProvider, id: string): string =>
  p === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : `https://api.soundcloud.com/tracks/${id}`;

/** Bounded LRU with expiry for search responses and recently seen results. */
class Lru<V> {
  private map = new Map<string, { at: number; v: V }>();
  constructor(private max: number, private ttlMs: number) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e || Date.now() - e.at > this.ttlMs) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V): void {
    this.map.delete(k); this.map.set(k, { at: Date.now(), v });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export class PublicMusic {
  private searches = new Lru<PublicTrack[]>(120, 10 * 60_000);
  /** Server-side record of results it handed out: prepare() never trusts client metadata. */
  private seen = new Lru<PublicTrack>(3000, 6 * 3600_000);
  private preparations = new SharedPreparation<string>();
  private searchJobs = new SharedPreparation<PublicTrack[]>();
  /** Who still waits for each running transfer; aborts it once all have left. */
  private transferListeners = new SharedPreparation<string>();
  private covers = new Map<string, Promise<string | null>>();
  private coverMisses = new Lru<boolean>(1000, 60_000);
  private transfers = new Map<string, GrowingAudio & { pcmKey: string; finalHash?: string; abort: AbortController }>();
  private stopped = false;

  async stop() {
    this.stopped = true;
    const active = [...this.transfers.values()].filter((t) => !t.done);
    for (const transfer of active) transfer.abort.abort();
    await Promise.allSettled([...active.map((t) => t.result), ...this.covers.values()]);
  }

  constructor(private readonly db: Db, private readonly lib: Library, private readonly ff: FfmpegTools, private readonly cfg: AppConfig, readonly ytdlp: YtDlp) {}

  private fromYtm(x: YtmItem, source: PublicSource): PublicTrack {
    return {
      externalId: x.videoId, title: x.title, artist: x.artist, album: x.album, duration: x.duration, coverUrl: x.thumbnail,
      pageUrl: source === 'ytmusic' ? `https://music.youtube.com/watch?v=${x.videoId}` : `https://www.youtube.com/watch?v=${x.videoId}`,
      license: null, playable: true, source, audioProvider: 'youtube', kind: x.kind, explicit: x.explicit, uploader: x.artist,
      labels: versionLabels(x.title, x.explicit), artistId: x.artistId, albumId: x.albumId,
    };
  }

  rememberYtm(items: YtmItem[]): PublicTrack[] {
    const tracks = items.map((x) => this.fromYtm(x, 'ytmusic'));
    for (const t of tracks) this.seen.set(`youtube:${t.externalId}`, t);
    return tracks;
  }

  rememberSoundCloud(items: Record<string, unknown>[]): PublicTrack[] {
    const tracks = items.map(x => this.fromYtdlp(x, 'soundcloud')).filter((x): x is PublicTrack => !!x);
    for (const t of tracks) this.seen.set(`soundcloud:${t.externalId}`, t);
    return tracks;
  }

  private fromYtdlp(e: Record<string, unknown>, source: PublicSource): PublicTrack | null {
    const p = audioProviderOf(source);
    const rawId = String(e.id ?? '');
    const id = p === 'soundcloud' ? (/(\d{1,20})$/.exec(decodeURIComponent(String(e.url ?? rawId)))?.[1] ?? '') : rawId;
    if (!validExternalId(p, id)) return null;
    const title = String(e.title ?? '').trim();
    const duration = Number(e.duration ?? 0) || 0;
    if (!title || e.live_status === 'is_live' || (duration && (duration < 30 || duration > 3 * 3600))) return null;
    const uploader = String(e.uploader ?? e.channel ?? '').trim();
    const artists = Array.isArray(e.artists) ? e.artists.filter((x): x is string => typeof x === 'string').join(', ') : '';
    const thumbs = Array.isArray(e.thumbnails) ? (e.thumbnails as { url?: string }[]) : [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1].url ?? null : (typeof e.thumbnail === 'string' ? e.thumbnail : null);
    return {
      externalId: id, title, artist: String(e.artist ?? e.creator ?? (artists || uploader)).replace(/\s*-\s*Topic$/i, '') || 'Неизвестный исполнитель', album: String(e.album ?? ''), duration,
      coverUrl: thumb && /^https:\/\//.test(thumb) ? thumb : p === 'youtube' ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
      pageUrl: typeof e.webpage_url === 'string' ? e.webpage_url : p === 'youtube' ? canonicalUrl(p, id) : null,
      license: null, playable: true, source, audioProvider: p, kind: source === 'ytmusic' ? 'song' : p === 'youtube' ? 'video' : 'track', explicit: false, uploader,
      labels: versionLabels(title), artistId: p === 'soundcloud' && /^\d{1,20}$/.test(String(e.artist_id ?? ''))
        && /^[\w-]{1,100}$/.test(String(e.artist_permalink ?? '')) ? String(e.artist_id) : null, albumId: null,
    };
  }

  /** One source at a time, so the client shows each as soon as it is ready. */
  async search(source: PublicSource, query: string, signal?: AbortSignal): Promise<PublicTrack[]> {
    const qn = query.trim().slice(0, 200);
    if (!qn) return [];
    const key = `${source}:${qn.toLowerCase()}`;
    const cached = this.searches.get(key);
    if (cached) return cached;
    return this.searchJobs.run(key, { signal }, async (workerSignal) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new ResolverError('Источник не ответил вовремя', 'timeout')), 15000);
      const shared = AbortSignal.any([workerSignal, deadline.signal]);
      try {
        let items: PublicTrack[];
        if (source === 'ytmusic') {
          try { items = (await searchYtm(qn, 'song', shared)).map((x) => this.fromYtm(x, 'ytmusic')); }
          catch (e) {
            if (shared.aborted) throw e;
            items = (await this.ytdlp.searchMusic(qn, 15, shared)).map((x) => this.fromYtdlp(x, 'ytmusic')).filter((x): x is PublicTrack => !!x);
          }
        } else if (source === 'youtube') {
          try { items = (await searchYtm(qn, 'video', shared)).map((x) => this.fromYtm(x, 'youtube')); }
          catch (e) { if (shared.aborted) throw e; items = (await this.ytdlp.search('ytsearch', qn, 15, shared)).map((x) => this.fromYtdlp(x, 'youtube')).filter((x): x is PublicTrack => !!x); }
        } else {
          let found: Record<string, unknown>[];
          try { found = await searchSoundCloud(qn, 15, shared); }
          catch (error) { if (shared.aborted) throw error; found = await this.ytdlp.search('scsearch', qn, 15, shared); }
          items = found.map((x) => this.fromYtdlp(x, 'soundcloud')).filter((x): x is PublicTrack => !!x);
        }
        shared.throwIfAborted();
        const ranked = rank(qn, items);
        for (const t of ranked) this.seen.set(`${t.audioProvider}:${t.externalId}`, t);
        this.searches.set(key, ranked);
        return ranked;
      } finally { clearTimeout(timer); }
    });
  }

  /** Only a server-known result may start bounded metadata preparation; no library rows or audio. */
  warmup(p: AudioProvider, id: string, signal?: AbortSignal): Promise<boolean> {
    if (!validExternalId(p, id) || !this.seen.get(`${p}:${id}`)) return Promise.resolve(false);
    return this.ytdlp.warmMetadata(canonicalUrl(p, id), signal);
  }

  async radio(videoId: string, signal?: AbortSignal): Promise<PublicTrack[]> {
    const seed = this.seen.get(`youtube:${videoId}`);
    const candidates = await radioCandidates(videoId, signal, seed ? {
      seed,
      resolve: async (query, signal) => (await this.search('ytmusic', query, signal)).map((t): YtmItem => ({
        videoId: t.externalId, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album, albumId: t.albumId,
        duration: t.duration, thumbnail: t.coverUrl, explicit: t.explicit, kind: t.kind === 'song' ? 'song' : 'video',
      })),
    } : undefined);
    const items = candidates.map((x) => this.fromYtm(x, x.kind === 'video' ? 'youtube' : 'ytmusic'));
    for (const t of items) this.seen.set(`youtube:${t.externalId}`, t);
    return items;
  }

  /** Library rows already bound to these recordings (provider + external id). */
  known(provider: AudioProvider, ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = q(this.db, `SELECT external_id, track_id FROM track_sources WHERE provider = ? AND kind = 'remote' AND external_id IN (${ids.map(() => '?').join(',')})`).all(provider, ...ids) as { external_id: string; track_id: string }[];
    return new Map(rows.map((r) => [r.external_id, r.track_id]));
  }

  private dir(p: AudioProvider): string { return path.join(this.cfg.dataDir, 'remote', p); }

  /** A search result can enter the existing PCM engine while its streamable file is arriving. */
  prepareProgressive(p: AudioProvider, externalId: string): Promise<string> {
    if (this.stopped) return Promise.reject(new ResolverError('Приложение завершает работу', 'cancelled'));
    if (!validExternalId(p, externalId)) return Promise.reject(new ResolverError('Некорректный ID записи', 'failed'));
    const existing = this.known(p, [externalId]).get(externalId);
    if (existing) return Promise.resolve(existing);
    const hint = this.seen.get(`${p}:${externalId}`);
    if (!hint || !(hint.duration > 1)) return this.prepare(p, externalId);
    const track = this.lib.addRemote({ provider: p, externalId, title: hint.title, artist: hint.artist, album: hint.album, duration: hint.duration, saved: false,
      meta: { pageUrl: hint.pageUrl, canonicalUrl: canonicalUrl(p, externalId), metadataSource: hint.source, uploader: hint.uploader, explicit: hint.explicit, labels: hint.labels, artistId: hint.artistId, albumId: hint.albumId, coverUrl: hint.coverUrl } });
    void this.ensureCover(track.id);
    return Promise.resolve(track.id);
  }

  pcmKey(trackId: string, contentHash: string): string {
    const transfer = this.transfers.get(trackId);
    return transfer && (!transfer.done || transfer.finalHash === contentHash) ? transfer.pcmKey : contentHash.replace(/[^a-zA-Z0-9]/g, '_');
  }

  /** With a signal, the decode is one more listener of the transfer: when it leaves and nobody
   * else listens (offline download, analysis), the download stops too. */
  async playbackInput(trackId: string, signal?: AbortSignal) {
    const src = this.lib.sources(trackId).find((s) => s.kind === 'remote' && ['youtube', 'soundcloud'].includes(s.provider));
    if (!src) return this.lib.resolveMediaPath(trackId, signal);
    const ready = this.cachedAudio(src);
    if (ready) return ready;
    this.fetchAudio(src, signal).catch(() => {});
    const transfer = this.transfers.get(trackId);
    return transfer ? growingAudioInput(transfer, signal) : this.lib.resolveMediaPath(trackId, signal);
  }

  /** Look ahead only over audio already on disk; never starts a transfer. */
  cachedAudioPath(trackId:string):string|null {
    const src=this.lib.sources(trackId).find(s=>s.kind==='remote'&&['youtube','soundcloud'].includes(s.provider));
    try{return src?this.cachedAudio(src):null;}catch{return null;}
  }

  private cachedAudio(src: SourceRow): string | null {
    const meta = JSON.parse(src.meta || '{}') as { audioHash?: string; ext?: string };
    if (!/^[a-f0-9]{64}$/.test(meta.audioHash ?? '') || !/^\.[a-z0-9]{1,10}$/.test(meta.ext ?? '')) return null;
    const file = path.join(this.dir(src.provider as AudioProvider), `${meta.audioHash}${meta.ext}`);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Makes a recording playable by our engine: downloads its audio once (singleflight),
   * verifies it with ffprobe and publishes it atomically. Returns a technical track
   * id: not "saved" to the collection until the listener says so.
   */
  prepare(p: AudioProvider, externalId: string, priority: Priority = 0, opts: { onProgress?: (f: number) => void; signal?: AbortSignal } = {}): Promise<string> {
    if (this.stopped) return Promise.reject(new ResolverError('Приложение завершает работу', 'cancelled'));
    if (opts.signal?.aborted) return Promise.reject(new ResolverError('Отменено', 'cancelled'));
    if (!validExternalId(p, externalId)) return Promise.reject(new ResolverError('Некорректный ID записи', 'failed'));
    const existing = this.known(p, [externalId]).get(externalId);
    if (existing) return Promise.resolve(existing);
    const key = `${p}:${externalId}`;
    return this.preparations.run(key, opts, (signal, onProgress) => this.download(p, externalId, priority, { signal, onProgress }).then(async ({ hash, size, probe, info, ext }) => {
      const hint = this.seen.get(key);
      const cover = await this.fetchCover(hint?.coverUrl ?? (typeof info.thumbnail === 'string' ? info.thumbnail : null));
      const coverId = cover ? await this.lib.saveCover(cover.data, cover.type) : null;
      signal.throwIfAborted();
      const title = String(hint?.title ?? info.track ?? info.title ?? 'Без названия');
      const artist = String(hint?.artist ?? info.artist ?? info.uploader ?? '').replace(/\s*-\s*Topic$/i, '');
      return this.lib.addRemote({
        provider: p, externalId, title, artist, album: hint?.album ?? String(info.album ?? ''), duration: probe.duration, coverId, saved: false,
        meta: {
          pageUrl: hint?.pageUrl ?? (typeof info.webpage_url === 'string' ? info.webpage_url : canonicalUrl(p, externalId)),
          canonicalUrl: canonicalUrl(p, externalId), metadataSource: hint?.source ?? p, uploader: hint?.uploader ?? String(info.uploader ?? ''),
          explicit: hint?.explicit ?? false, labels: hint?.labels ?? versionLabels(title), artistId: hint?.artistId ?? null, albumId: hint?.albumId ?? null,
          coverUrl: hint?.coverUrl ?? (typeof info.thumbnail === 'string' ? info.thumbnail : null),
          audioHash: hash, ext, format: { codec: info.acodec ?? probe.codec, abr: info.abr ?? null, asr: info.asr ?? probe.sampleRate },
        },
        content: { hash, size, probe },
      }).id;
    }));
  }

  private async download(p: AudioProvider, externalId: string, priority: Priority, opts: { onProgress?: (f: number) => void; signal?: AbortSignal } = {}, staging = path.join(this.cfg.dataDir, 'remote', '.staging', crypto.randomUUID())) {
    try {
      const { file, info } = await this.ytdlp.download(canonicalUrl(p, externalId), staging, { priority, ...opts });
      const probe = await this.ff.probe(file);
      opts.signal?.throwIfAborted();
      if (!probe.hasAudio || !(probe.duration > 1)) throw new ResolverError('Источник отдал файл без звука', 'failed');
      const { hash, size } = await sha256File(file);
      const ext = path.extname(file).toLowerCase() || '.audio';
      await fsp.mkdir(this.dir(p), { recursive: true });
      const target = path.join(this.dir(p), `${hash}${ext}`);
      if (!fs.existsSync(target)) await fsp.rename(file, target);
      return { file: target, hash, size, probe, info, ext };
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Audio file of a stored recording; downloads again if the cache dropped it.
   * A caller with a signal may leave; the transfer stops only when every caller has left
   * (callers without a signal, such as the player, keep it running).
   */
  async fetchAudio(src: SourceRow, signal?: AbortSignal): Promise<string> {
    if (this.stopped) throw new ResolverError('Приложение завершает работу', 'cancelled');
    const p = src.provider as AudioProvider;
    const id = String(src.external_id ?? '');
    if (!validExternalId(p, id)) throw new Error('Некорректная ссылка на запись');
    const meta = JSON.parse(src.meta || '{}') as { audioHash?: string; ext?: string };
    const track = this.lib.get(src.track_id);
    const ready = this.cachedAudio(src);
    if (ready) return ready;
    const running = this.transfers.get(src.track_id);
    if (running && !running.done) return this.listen(src.track_id, running, signal);
    const staging = path.join(this.cfg.dataDir, 'remote', '.staging', crypto.randomUUID());
    const transfer: GrowingAudio & { pcmKey: string; finalHash?: string; abort: AbortController } = { staging, done: false, error: null, result: Promise.resolve(''), abort: new AbortController(), pcmKey: (track?.content_hash ?? `${p}_${id}`).replace(/[^a-zA-Z0-9]/g, '_') };
    this.transfers.set(src.track_id, transfer);
    // Completed aliases are bounded; active transfers cannot be evicted.
    if (this.transfers.size > 256) for (const [key, value] of this.transfers) { if (this.transfers.size <= 256) break; if (value.done && key !== src.track_id) this.transfers.delete(key); }
    transfer.result = this.download(p, id, 0, { signal: transfer.abort.signal }, staging).then((fresh) => {
    transfer.finalHash = fresh.hash;
    if (track && fresh.hash !== track.content_hash) {
      // A different file: the old analysis and stems belong to the old hash and stay unused.
      this.lib.rebindContent(track.id, fresh.hash, fresh.size, fresh.probe);
    }
    q(this.db, 'UPDATE track_sources SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, coverUrl: (meta as { coverUrl?: string }).coverUrl ?? fresh.info.thumbnail, audioHash: fresh.hash, ext: fresh.ext }), src.id);
    return fresh.file;
    }).catch((error) => { transfer.error = error as Error; throw error; }).finally(() => { transfer.done = true; });
    transfer.result.catch(() => {});
    return this.listen(src.track_id, transfer, signal);
  }

  private listen(trackId: string, transfer: { result: Promise<string>; abort: AbortController }, signal?: AbortSignal): Promise<string> {
    return this.transferListeners.run(trackId, { signal }, (left) => {
      left.addEventListener('abort', () => transfer.abort.abort(), { once: true });
      return transfer.result;
    });
  }

  /** Repairs old/imported rows on demand; fetching an image never downloads the audio. */
  ensureCover(trackId: string): Promise<string | null> {
    const track = this.lib.get(trackId);
    if (track?.cover_id) return Promise.resolve(this.lib.coverPath(track.cover_id));
    if (!track || this.coverMisses.get(trackId)) return Promise.resolve(null);
    const existing = this.covers.get(trackId);
    if (existing) return existing;
    const job = this.repairCover(trackId).catch(() => null).then((file) => {
      if (!file) this.coverMisses.set(trackId, true);
      return file;
    }).finally(() => this.covers.delete(trackId));
    this.covers.set(trackId, job);
    return job;
  }

  private async repairCover(trackId: string): Promise<string | null> {
    const src = this.lib.sources(trackId).find((s) => s.kind === 'remote' && ['youtube', 'soundcloud'].includes(s.provider));
    if (!src?.external_id) return null;
    const p = src.provider as AudioProvider;
    if (!validExternalId(p, src.external_id)) return null;
    const meta = JSON.parse(src.meta || '{}') as { coverUrl?: string };
    let cover = await this.fetchCover(this.seen.get(`${p}:${src.external_id}`)?.coverUrl ?? meta.coverUrl ?? null);
    if (!cover && p === 'youtube') cover = await this.fetchCover(`https://i.ytimg.com/vi/${src.external_id}/hqdefault.jpg`);
    if (!cover && p === 'soundcloud') {
      const info = await this.ytdlp.metadata(canonicalUrl(p, src.external_id));
      cover = await this.fetchCover(typeof info.thumbnail === 'string' ? info.thumbnail : null);
    }
    if (!cover) return null;
    const id = await this.lib.saveCover(cover.data, cover.type);
    this.lib.setCover(trackId, id);
    return this.lib.coverPath(id);
  }

  private async fetchCover(url: string | null): Promise<{ data: Buffer; type: string } | null> {
    if (!url) return null;
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !COVER_HOSTS.some((re) => re.test(u.hostname))) return null;
    try {
      const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? '';
      if (!/^image\/(jpeg|png|webp)/.test(type)) return null;
      const limit = 3 * 1024 * 1024;
      if (!res.body || Number(res.headers.get('content-length') ?? 0) > limit) { await res.body?.cancel(); return null; }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limit) { return null; }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      return data.length > 200 ? { data, type } : null;
    } catch { return null; }
  }
}

/** Registry entry so the rest of the app (mixing policy, remote fetch, sources page) sees the source. */
export class PublicProvider implements Provider {
  constructor(readonly id: AudioProvider, private readonly music: PublicMusic) {}
  capabilities(): Capabilities { return PUBLIC_CAPS; }
  async info(): Promise<ProviderInfo> {
    const ok = this.music.ytdlp.available;
    return makeInfo({
      id: this.id, name: this.id === 'youtube' ? 'YouTube и YouTube Music' : 'SoundCloud', kind: 'unofficial', official: false, caps: PUBLIC_CAPS,
      notes: [
        'Без аккаунта: публичные записи. Часть записей может быть недоступна в вашей стране или требовать вход — тогда показывается причина.',
        'Звук скачивается в исходном формате источника без перекодирования и играет через движок AutoMix.',
        'Неофициальная интеграция через yt-dlp. Условия сервиса ограничивают скачивание и переработку записей; используйте для личного прослушивания.',
        ...(this.id === 'soundcloud' ? ['Условия официального API SoundCloud запрещают смешивать и разделять записи; это приложение API не использует, но ограничения сервиса стоит учитывать.'] : []),
      ],
      docs: this.id === 'youtube' ? ['https://github.com/yt-dlp/yt-dlp', 'https://www.youtube.com/t/terms'] : ['https://github.com/yt-dlp/yt-dlp', 'https://soundcloud.com/terms-of-use'],
    }, ok ? 'connected' : 'unavailable', ok ? 'Работает без аккаунта' : 'Компонент для онлайн-источников не найден');
  }
  async search(query: string): Promise<ExternalTrack[]> { return this.music.search(this.id === 'youtube' ? 'ytmusic' : 'soundcloud', query); }
  importTrack(t: ExternalTrack): Promise<string> { return this.music.prepare(this.id, String(t.externalId), 2); }
  fetchAudio(src: SourceRow, signal?: AbortSignal): Promise<string> { return this.music.fetchAudio(src, signal); }
}

export { SOURCE_NAMES };
