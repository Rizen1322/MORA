import { Worker } from 'node:worker_threads';
import { ANALYZER_VERSION, type TrackAnalysis } from '@automix/core';
import type { AppConfig } from './config.ts';
import { q, type Db } from './db.ts';
import type { EventHub } from './events.ts';
import type { Library, TrackRow } from './library.ts';

interface QueueItem {
  hash: string;
  trackId: string;
  priority: number;
  seq: number;
}

interface Running {
  item: QueueItem;
  worker: PoolWorker;
  jobId: number;
  /** Settles once the media is resolved and the job handed to the worker (or dropped). */
  prep?: Promise<void>;
  progress: number;
  started: number;
  /** Cancelled before the job reached the worker (audio still being fetched). */
  abort: AbortController;
}

interface PoolWorker {
  w: Worker;
  busy: boolean;
  /** Job id to cancel, read by the worker inside its synchronous analysis where messages cannot arrive. */
  cancel: Int32Array;
}

export const PRIORITY = { background: 1, imported: 5, wave: 50, next: 90, current: 100 } as const;

/**
 * Background analysis queue. Results are keyed by file content hash and
 * analyzer version, so renaming or re-importing a file never re-analyzes it,
 * and a new analyzer version re-analyzes everything automatically.
 */
/** Longer recordings are analyzed only when they are about to play (memory, see ensure()). */
const MAX_AUTO_SECONDS = 3 * 3600;
const LONG_SECONDS = 20 * 60;

export class AnalysisService {
  vocalActivityFor: ((hash: string) => TrackAnalysis['vocalActivity']) | null = null;
  private queue = new Map<string, QueueItem>();
  private running = new Map<string, Running>();
  private pool: PoolWorker[] = [];
  private seq = 0;
  private jobSeq = 0;
  private memo = new Map<string, TrackAnalysis>();
  private readonly memoLimit = 64;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly lib: Library,
    private readonly events: EventHub,
  ) {}

  start(): void {
    const n = Math.max(1, this.cfg.analysisWorkers);
    for (let i = 0; i < n; i++) this.pool.push(this.spawn());
    // anything that was running when the app stopped goes back to the queue
    q(this.db, "UPDATE analysis SET status = 'pending' WHERE status = 'running' AND version = ?").run(ANALYZER_VERSION);
    this.prune();
    for (const t of this.lib.all()) this.ensure(t, PRIORITY.background);
  }

  /** Keeps per track the current analysis and the newest other finished one (comparison tools read it).
   * Older versions were dead weight: 93 % of a long-used library database, rewritten whole on iPhone. */
  private prune(hash?: string): void {
    const keep = "SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY content_hash ORDER BY updated_at DESC) AS n FROM analysis WHERE version <> ? AND status = 'done') WHERE n = 1";
    const removed = hash
      ? q(this.db, `DELETE FROM analysis WHERE content_hash = ? AND version <> ? AND rowid NOT IN (${keep})`).run(hash, ANALYZER_VERSION, ANALYZER_VERSION).changes
      : q(this.db, `DELETE FROM analysis WHERE version <> ? AND rowid NOT IN (${keep})`).run(ANALYZER_VERSION, ANALYZER_VERSION).changes;
    if (hash || !removed) return;
    // a large one-time cleanup: give the space back (a later per-track prune reuses its free pages)
    const pages = q(this.db, 'PRAGMA page_count').get() as { page_count: number }, free = q(this.db, 'PRAGMA freelist_count').get() as { freelist_count: number };
    if (free.freelist_count > pages.page_count / 4) this.db.exec('VACUUM');
  }

  private spawn(): PoolWorker {
    // The desktop bundle ships a prebuilt worker instead of the tsx bootstrap.
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const w = new Worker(process.env.AUTOMIX_ANALYSIS_WORKER || new URL('./analysisWorkerBoot.mjs', import.meta.url), { workerData: { cancel } });
    const pw: PoolWorker = { w, busy: false, cancel };
    w.on('message', (m: { jobId: number; type: string; progress?: number; analysis?: TrackAnalysis; error?: string }) => this.onMessage(pw, m));
    w.on('error', (err) => {
      for (const [hash, r] of this.running) {
        if (r.worker === pw) this.finish(hash, 'error', null, `сбой анализатора: ${err.message}`);
      }
      const idx = this.pool.indexOf(pw);
      if (idx >= 0 && !this.stopped) this.pool[idx] = this.spawn();
      this.pump();
    });
    return pw;
  }

  private isLong(trackId: string): boolean {
    return (this.lib.get(trackId)?.duration ?? 0) > LONG_SECONDS;
  }

  /** Queues analysis for a track unless it is already done for this analyzer version. */
  ensure(t: TrackRow, priority: number): void {
    if (t.content_hash.startsWith('remote:') && t.provider !== 'local') {
      // remote audio is analyzed once it was fetched for playback
      if (priority < PRIORITY.wave) return;
    }
    if (!this.lib.mixingPolicy.get(t.provider)) return;
    if (this.cfg.backgroundAnalysis === false && priority < PRIORITY.wave) return;
    // the analyzer keeps the whole mono PCM (~1.6 GiB for 3 h): only on request for such recordings
    if (t.duration > MAX_AUTO_SECONDS && priority < PRIORITY.next) return;
    if (t.status === 'missing' || t.status === 'error') return;
    const row = q(this.db, 'SELECT status FROM analysis WHERE content_hash = ? AND version = ?').get(t.content_hash, ANALYZER_VERSION) as
      | { status: string }
      | undefined;
    if (row?.status === 'done' || (row?.status === 'error' && priority < PRIORITY.next)) return;
    const running = this.running.get(t.content_hash);
    if (running) return;
    const prev = this.queue.get(t.content_hash);
    if (prev) {
      prev.priority = Math.max(prev.priority, priority);
    } else {
      this.queue.set(t.content_hash, { hash: t.content_hash, trackId: t.id, priority, seq: this.seq++ });
      q(
        this.db,
        "INSERT INTO analysis(content_hash, version, status, updated_at) VALUES (?, ?, 'pending', ?) ON CONFLICT(content_hash, version) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at",
      ).run(t.content_hash, ANALYZER_VERSION, Date.now());
    }
    this.pump();
  }

  prioritize(trackIds: string[], priority: number): void {
    for (const id of trackIds) {
      const t = this.lib.get(id);
      if (t) this.ensure(t, priority);
    }
  }

  /** Drops both stored and in-memory results, including dependent pair plans. */
  reanalyze(t: TrackRow): void {
    if (this.running.has(t.content_hash)) return;
    this.memo.delete(t.content_hash);
    q(this.db, 'DELETE FROM analysis WHERE content_hash = ?').run(t.content_hash);
    q(this.db, 'DELETE FROM transition_cache WHERE from_hash = ? OR to_hash = ?').run(t.content_hash, t.content_hash);
    this.ensure(t, PRIORITY.next);
  }

  /** Cancels a queued or running job (e.g. the track was deleted). */
  cancel(hash: string): void {
    this.queue.delete(hash);
    const r = this.running.get(hash);
    if (!r) return;
    r.abort.abort();
    Atomics.store(r.worker.cancel, 0, r.jobId);
    r.worker.w.postMessage({ type: 'cancel', jobId: r.jobId });
  }

  /** Demotes queued work that is no longer relevant (queue changed). Running jobs finish. */
  demote(keepTrackIds: Set<string>): void {
    for (const item of this.queue.values()) {
      if (!keepTrackIds.has(item.trackId) && item.priority >= PRIORITY.wave) item.priority = PRIORITY.imported;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    for (const pw of this.pool) {
      if (pw.busy) continue;
      // two long recordings at once would hold two full mono PCMs: they wait for each other
      const longRunning = [...this.running.values()].some((r) => this.isLong(r.item.trackId));
      const next = [...this.queue.values()].filter((q) => !longRunning || !this.isLong(q.trackId))
        .sort((a, b) => b.priority - a.priority || a.seq - b.seq)[0];
      if (!next) return;
      this.queue.delete(next.hash);
      pw.busy = true;
      const jobId = ++this.jobSeq;
      const r: Running = { item: next, worker: pw, jobId, progress: 0, started: Date.now(), abort: new AbortController() };
      this.running.set(next.hash, r);
      q(this.db, "UPDATE analysis SET status = 'running', updated_at = ? WHERE content_hash = ? AND version = ?").run(Date.now(), next.hash, ANALYZER_VERSION);
      this.events.emit({ type: 'analysis', trackId: next.trackId, hash: next.hash, status: 'running', progress: 0 });
      const t = this.lib.get(next.trackId);
      r.prep = this.lib
        .resolveMediaPath(next.trackId, r.abort.signal)
        .then((input) => {
          if (this.stopped) return; // stop() owns the shutdown; the database may be closing
          if (r.abort.signal.aborted) {
            pw.busy = false;
            this.cancelled(r.item.hash, r);
            this.pump();
            return;
          }
          // remote tracks get their real content hash after download
          const fresh = this.lib.get(next.trackId);
          if (fresh && fresh.content_hash !== next.hash) {
            // Another id resolved to the same audio: join its analysis instead of overwriting its slot.
            const owner = this.running.get(fresh.content_hash);
            const done = q(this.db, "SELECT 1 FROM analysis WHERE content_hash = ? AND version = ? AND status = 'done'").get(fresh.content_hash, ANALYZER_VERSION);
            if ((owner && owner !== r) || done) {
              if (this.running.get(next.hash) === r) this.running.delete(next.hash);
              q(this.db, 'DELETE FROM analysis WHERE content_hash = ? AND version = ?').run(next.hash, ANALYZER_VERSION);
              pw.busy = false;
              this.pump();
              return;
            }
            this.queue.delete(fresh.content_hash);
            this.running.delete(next.hash);
            this.running.set(fresh.content_hash, r);
            r.item = { ...next, hash: fresh.content_hash };
            q(this.db, "INSERT OR REPLACE INTO analysis(content_hash, version, status, updated_at) VALUES (?, ?, 'running', ?)").run(fresh.content_hash, ANALYZER_VERSION, Date.now());
          }
          pw.w.postMessage({ type: 'job', jobId, input, duration: t?.duration ?? 300, ffmpeg: this.cfg.ffmpeg });
        })
        .catch((e) => {
          pw.busy = false;
          if (this.stopped) return;
          if (r.abort.signal.aborted) this.cancelled(r.item.hash, r);
          else this.finish(r.item.hash, 'error', null, (e as Error).message);
          this.pump();
        });
    }
  }

  private onMessage(pw: PoolWorker, m: { jobId: number; type: string; progress?: number; analysis?: TrackAnalysis; error?: string }): void {
    const entry = [...this.running.entries()].find(([, r]) => r.jobId === m.jobId);
    if (!entry) return;
    const [hash, r] = entry;
    if (m.type === 'progress') {
      r.progress = m.progress ?? 0;
      this.events.emit({ type: 'analysis', trackId: r.item.trackId, hash, status: 'running', progress: r.progress });
      return;
    }
    pw.busy = false;
    if (m.type === 'done' && m.analysis) this.finish(hash, 'done', m.analysis, null);
    else if (m.type === 'cancelled') this.cancelled(hash, r);
    else this.finish(hash, 'error', null, m.error ?? 'неизвестная ошибка');
    this.pump();
  }

  private cancelled(hash: string, r: Running): void {
    this.running.delete(hash);
    q(this.db, 'DELETE FROM analysis WHERE content_hash = ? AND version = ?').run(hash, ANALYZER_VERSION);
    this.events.emit({ type: 'analysis', trackId: r.item.trackId, hash, status: 'cancelled' });
  }

  private finish(hash: string, status: 'done' | 'error', a: TrackAnalysis | null, error: string | null): void {
    const r = this.running.get(hash);
    this.running.delete(hash);
    const summary = a
      ? JSON.stringify({
          bpm: a.beat?.bpm ?? null,
          camelot: a.key.camelot,
          keyName: a.key.name,
          energy: Math.round(a.features.energy * 100) / 100,
          rhythm: Math.round(a.rhythmStrength * 100) / 100,
          lufs: Math.round(a.loudness.integratedLufs * 10) / 10,
          truePeak: Math.round(a.loudness.truePeakDb * 10) / 10,
          features: a.features,
        })
      : null;
    q(
      this.db,
      `INSERT INTO analysis(content_hash, version, status, data, summary, error, elapsed_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, version) DO UPDATE SET status = excluded.status, data = excluded.data, summary = excluded.summary, error = excluded.error, elapsed_ms = excluded.elapsed_ms, updated_at = excluded.updated_at`,
    ).run(hash, ANALYZER_VERSION, status, a ? JSON.stringify(a) : null, summary, error, r ? Date.now() - r.started : null, Date.now());
    if (a) { this.remember(hash, a); this.prune(hash); }
    if (status === 'error' && r) {
      const t = this.lib.get(r.item.trackId);
      if (t && /декод|ffmpeg|Invalid|звука|corrupt/i.test(error ?? '')) this.lib.setStatus(t.id, 'error', `Файл не удалось прочитать: ${error}`);
    }
    this.events.emit({ type: 'analysis', trackId: r?.item.trackId ?? null, hash, status, error: error ?? undefined });
  }

  get(hash: string): TrackAnalysis | null {
    const m = this.memo.get(hash);
    if (m) { this.remember(hash, m); return this.enriched(hash,m); }
    const row = q(this.db, "SELECT data FROM analysis WHERE content_hash = ? AND version = ? AND status = 'done'").get(hash, ANALYZER_VERSION) as
      | { data: string }
      | undefined;
    if (!row?.data) return null;
    const a = JSON.parse(row.data) as TrackAnalysis;
    this.remember(hash, a);
    return this.enriched(hash,a);
  }

  private remember(hash: string, analysis: TrackAnalysis): void {
    this.memo.delete(hash);
    this.memo.set(hash, analysis);
    while (this.memo.size > this.memoLimit) this.memo.delete(this.memo.keys().next().value!);
  }

  private enriched(hash: string, a: TrackAnalysis): TrackAnalysis {
    const vocalActivity=this.vocalActivityFor?.(hash);
    return vocalActivity?{...a,vocalActivity}:a;
  }

  statusOf(hash: string): { status: string; progress?: number; error?: string | null } {
    const r = this.running.get(hash);
    if (r) return { status: 'running', progress: r.progress };
    if (this.queue.has(hash)) return { status: 'pending' };
    const row = q(this.db, 'SELECT status, error FROM analysis WHERE content_hash = ? AND version = ?').get(hash, ANALYZER_VERSION) as
      | { status: string; error: string | null }
      | undefined;
    return row ? { status: row.status, error: row.error } : { status: 'none' };
  }

  stats(): { queued: number; running: number; workers: number } {
    return { queued: this.queue.size, running: this.running.size, workers: this.pool.length };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.memo.clear();
    const running = [...this.running.values()];
    for (const r of running) {
      r.abort.abort();
      Atomics.store(r.worker.cancel, 0, r.jobId);
      r.worker.w.postMessage({ type: 'cancel', jobId: r.jobId });
    }
    // Wait for media resolution to settle before the caller closes the database; a source that
    // ignores the abort (shortcut: Yandex downloads do) gets 3 s, its late callback then does nothing.
    await Promise.race([Promise.all(running.map((r) => r.prep)), new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all(this.pool.map((p) => p.w.terminate()));
  }
}
