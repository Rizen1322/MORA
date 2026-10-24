import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import { kvGet, kvSet, q, type Db } from '../db.ts';
import type { EventHub } from '../events.ts';
import type { Library } from '../library.ts';
import { validExternalId, type AudioProvider, type PublicMusic } from './provider.ts';
import { ResolverError } from './ytdlp.ts';

/**
 * Offline downloads. A finished download pins the track: cache eviction never
 * deletes its audio. Downloads and AutoMix preparation are separate: a track is
 * offline as soon as its file is verified, even while analysis/stems still run.
 * Jobs survive a restart; a network failure waits and retries with backoff.
 */

export type JobState = 'queued' | 'downloading' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled';
export interface DownloadJob {
  id: string;
  key: string;
  provider: AudioProvider | null;
  externalId: string | null;
  trackId: string | null;
  title: string;
  state: JobState;
  progress: number;
  error: string | null;
  attempts: number;
  retryAt: number;
  createdAt: number;
}

const CONCURRENCY = 2;
const CACHE_DIRS = ['youtube', 'soundcloud', 'yandex'];

export class Downloads {
  private jobs = new Map<string, DownloadJob>();
  private running = new Map<string, AbortController>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastEmit = new Map<string, number>();
  private stopped = false;
  private active = new Set<Promise<void>>();
  private eviction: Promise<number> | null = null;
  private evictionLimit = Infinity;

  constructor(private readonly db: Db, private readonly lib: Library, private readonly music: PublicMusic, private readonly events: EventHub, private readonly cfg: AppConfig) {
    for (const j of kvGet<DownloadJob[]>(db, 'downloads.jobs', [])) {
      if (!j?.id) continue;
      this.jobs.set(j.id, { ...j, state: j.state === 'downloading' ? 'queued' : j.state, progress: j.state === 'done' ? 1 : 0 });
    }
  }

  start(): void {
    this.stopped = false;
    this.timers.push(setInterval(() => this.pump(), 15_000));
    this.timers.push(setInterval(() => void this.evict().catch(() => {}), 10 * 60_000));
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const j of this.jobs.values()) if (j.state === 'downloading') Object.assign(j, { state: 'queued', progress: 0 });
    this.save();
    for (const c of this.running.values()) c.abort();
    await Promise.allSettled([...this.active]);
  }

  get cacheLimitBytes(): number { return kvGet<number>(this.db, 'downloads.cacheLimitMb', 512) * 1024 * 1024; }
  setCacheLimitMb(mb: number): void { kvSet(this.db, 'downloads.cacheLimitMb', Math.max(256, Math.min(1 << 20, Math.round(mb)))); void this.evict().catch(() => {}); }

  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private save(): void {
    const keep = this.list().filter((j) => j.state !== 'done').concat(this.list().filter((j) => j.state === 'done').slice(0, 100));
    kvSet(this.db, 'downloads.jobs', keep);
  }

  private emit(j: DownloadJob, force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(j.id) ?? 0) < 250) return;
    this.lastEmit.set(j.id, now);
    this.events.emit({ type: 'download', job: { id: j.id, key: j.key, title: j.title, state: j.state, progress: j.progress, error: j.error, trackId: j.trackId } });
  }

  private set(j: DownloadJob, patch: Partial<DownloadJob>): void {
    Object.assign(j, patch);
    this.emit(j, patch.state !== undefined);
    if (patch.state !== undefined) this.save();
  }

  /** Adds a download; asking twice for the same recording returns the same job. */
  add(input: { trackId?: string; provider?: string; externalId?: string; title?: string }): DownloadJob {
    let provider: AudioProvider | null = null, externalId: string | null = null, trackId: string | null = null, title = input.title?.slice(0, 200) ?? '';
    if (input.trackId) {
      const t = this.lib.get(input.trackId);
      if (!t) throw new ResolverError('Трек не найден', 'failed');
      trackId = t.id;
      title = t.title;
      const src = this.lib.sources(this.lib.mediaId(t.id)).find((s) => s.kind === 'remote');
      if (src && (src.provider === 'youtube' || src.provider === 'soundcloud')) { provider = src.provider; externalId = src.external_id; }
    } else {
      if (input.provider !== 'youtube' && input.provider !== 'soundcloud') throw new ResolverError('Неизвестный источник', 'failed');
      if (!validExternalId(input.provider, String(input.externalId ?? ''))) throw new ResolverError('Некорректный ID записи', 'failed');
      provider = input.provider; externalId = String(input.externalId);
      trackId = this.music.known(provider, [externalId]).get(externalId) ?? null;
    }
    const key = provider && externalId ? `${provider}:${externalId}` : `track:${trackId}`;
    const existing = [...this.jobs.values()].find((j) => j.key === key && j.state !== 'cancelled' && j.state !== 'failed');
    if (existing) return existing;
    const job: DownloadJob = { id: crypto.randomUUID(), key, provider, externalId, trackId, title, state: 'queued', progress: 0, error: null, attempts: 0, retryAt: 0, createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.save();
    this.emit(job, true);
    this.pump();
    return job;
  }

  pause(id: string): void {
    const j = this.jobs.get(id);
    if (!j || j.state === 'done') return;
    this.running.get(id)?.abort();
    this.set(j, { state: 'paused', progress: 0 });
  }

  resume(id: string): void {
    const j = this.jobs.get(id);
    if (!j || !['paused', 'failed', 'cancelled', 'waiting'].includes(j.state)) return;
    this.set(j, { state: 'queued', error: null, retryAt: 0 });
    this.pump();
  }

  cancel(id: string): void {
    const j = this.jobs.get(id);
    if (!j || j.state === 'done') return;
    this.running.get(id)?.abort();
    this.set(j, { state: 'cancelled', progress: 0 });
  }

  /** Removes the offline copy flag; the audio stays as ordinary cache until evicted. */
  unpin(trackId: string): void {
    this.lib.setPinned(trackId, false);
    for (const j of this.jobs.values()) if (j.trackId === trackId && j.state === 'done') this.jobs.delete(j.id);
    this.save();
    void this.evict().catch(() => {});
  }

  private pump(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const j of this.jobs.values()) if (j.state === 'waiting' && j.retryAt <= now) j.state = 'queued';
    // Resume may arrive before the aborted attempt has finished unwinding.
    // Its slot belongs to that attempt until finally releases it.
    const ready = this.list().reverse().filter((j) => j.state === 'queued' && !this.running.has(j.id));
    while (this.running.size < CONCURRENCY && ready.length) {
      const task = this.run(ready.shift()!);
      this.active.add(task);
      void task.finally(() => this.active.delete(task));
    }
  }

  private async run(j: DownloadJob): Promise<void> {
    const ctl = new AbortController();
    this.running.set(j.id, ctl);
    this.set(j, { state: 'downloading', progress: 0, attempts: j.attempts + 1 });
    try {
      let trackId = j.trackId;
      if (j.provider && j.externalId && (!trackId || !this.lib.get(trackId))) {
        trackId = await this.music.prepare(j.provider, j.externalId, 3, { signal: ctl.signal, onProgress: (f) => { if (!ctl.signal.aborted) this.set(j, { progress: f * 0.97 }); } });
      }
      if (!trackId) throw new ResolverError('Трек не найден', 'failed');
      // Fetches remote audio if the cache dropped it; local files are already offline.
      await this.lib.resolveMediaPath(this.lib.mediaId(trackId), ctl.signal);
      if (ctl.signal.aborted) return;
      this.lib.setPinned(trackId, true);
      this.lib.setSaved(trackId, true);
      const t = this.lib.get(trackId);
      this.set(j, { state: 'done', progress: 1, trackId, title: t?.title ?? j.title, error: null });
    } catch (e) {
      if (ctl.signal.aborted || j.state === 'paused' || j.state === 'cancelled') return;
      const kind = e instanceof ResolverError ? e.kind : 'failed';
      const message = (e as Error).message;
      // Network trouble waits for the connection; a removed or private recording does not.
      if ((kind === 'timeout' || /fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(message)) && j.attempts < 8) {
        this.set(j, { state: 'waiting', error: 'Нет подключения — повторим автоматически', retryAt: Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** (j.attempts - 1)) });
      } else {
        this.set(j, { state: 'failed', error: message });
      }
    } finally {
      this.running.delete(j.id);
      this.pump();
    }
  }

  /** Bytes in the audio cache vs. pinned downloads, and free disk space. */
  async usage(): Promise<{ cacheBytes: number; pinnedBytes: number; limitBytes: number; freeBytes: number | null }> {
    const pinned = this.protectedHashes(new Set());
    let cacheBytes = 0, pinnedBytes = 0;
    for (const f of await this.files()) {
      if (pinned.has(f.hash)) pinnedBytes += f.size; else cacheBytes += f.size;
    }
    let freeBytes: number | null = null;
    try { const st = await fsp.statfs(this.cfg.dataDir); freeBytes = st.bavail * st.bsize; } catch { /* not supported */ }
    return { cacheBytes, pinnedBytes, limitBytes: this.cacheLimitBytes, freeBytes };
  }

  private async files(): Promise<{ file: string; hash: string; size: number; mtime: number }[]> {
    const out: { file: string; hash: string; size: number; mtime: number }[] = [];
    for (const d of CACHE_DIRS) {
      const dir = path.join(this.cfg.dataDir, 'remote', d);
      let names: string[] = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const n of names) {
        const m = /^([a-f\d]{64})\.\w+$/.exec(n);
        if (!m) continue;
        try { const st = await fsp.stat(path.join(dir, n)); out.push({ file: path.join(dir, n), hash: m[1], size: st.size, mtime: st.mtimeMs }); } catch { /* removed meanwhile */ }
      }
    }
    return out;
  }

  /** Pinned tracks, recordings bound to them, and anything used in the last two hours (current/next). */
  private protectedHashes(recent: Set<string>): Set<string> {
    const rows = q(this.db, `SELECT content_hash FROM tracks WHERE pinned = 1
      UNION SELECT a.content_hash FROM track_bindings b JOIN tracks t ON t.id = b.track_id JOIN tracks a ON a.id = b.asset_id WHERE t.pinned = 1`).all() as { content_hash: string }[];
    return new Set([...rows.map((r) => r.content_hash), ...recent]);
  }

  /** Least recently used cache files go first; pinned audio is never removed. */
  evict(limit = this.cacheLimitBytes): Promise<number> {
    this.evictionLimit = Math.min(this.evictionLimit, limit);
    if (!this.eviction) this.eviction = this.drainEviction().finally(() => { this.eviction = null; });
    return this.eviction;
  }

  private async drainEviction(): Promise<number> {
    let removed = 0;
    do {
      const limit = this.evictionLimit;
      this.evictionLimit = Infinity;
      removed += await this.evictFiles(limit);
    } while (this.evictionLimit < Infinity);
    return removed;
  }

  private async evictFiles(limit: number): Promise<number> {
    const files = await this.files();
    const recent = new Set(files.filter((f) => Date.now() - f.mtime < 2 * 3600_000).map((f) => f.hash));
    const keep = this.protectedHashes(recent);
    const candidates = files.filter((f) => !keep.has(f.hash)).sort((a, b) => a.mtime - b.mtime);
    // Recent unpinned audio also occupies the budget, even while protected.
    const offline = this.protectedHashes(new Set());
    const pinnedNow = q(this.db, `SELECT 1 FROM tracks WHERE pinned = 1 AND content_hash = ?
      UNION SELECT 1 FROM track_bindings b JOIN tracks t ON t.id = b.track_id
      JOIN tracks a ON a.id = b.asset_id WHERE t.pinned = 1 AND a.content_hash = ? LIMIT 1`);
    let total = files.filter(f => !offline.has(f.hash)).reduce((n, f) => n + f.size, 0), removed = 0;
    for (const f of candidates) {
      if (total <= limit) break;
      // A download may have been pinned while the previous unlink was pending.
      if (pinnedNow.get(f.hash, f.hash)) continue;
      try { await fsp.rm(f.file, { force: true }); total -= f.size; removed++; } catch { /* in use: next time */ }
    }
    return removed;
  }

  /** "Очистить кэш": every unpinned cached recording, except those playing now. */
  async clearCache(): Promise<number> { return this.evict(0); }
}

