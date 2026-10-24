import crypto from 'node:crypto';
import { kvGet, kvSet, q, tx, type Db } from '../db.ts';
import type { EventHub } from '../events.ts';
import type { Library } from '../library.ts';
import { fetchCollection, parseCollectionFile, type Collection, type CollectionItem } from './collections.ts';
import { matchConfidence, normalize, versionLabels } from './match.ts';
import { canonicalUrl, type PublicMusic, type PublicTrack } from './provider.ts';
import type { YtDlp } from './ytdlp.ts';

/**
 * Collection import: metadata first, then a match per item, then a preview
 * report, and only after the listener confirms, a playlist. Order and repeats
 * are kept; uncertain and missing items stay visible with their position so
 * they can be resolved by hand. Jobs survive restarts; creating twice updates
 * the same playlist instead of making copies.
 */

export interface Candidate { provider: 'youtube' | 'soundcloud'; externalId: string; title: string; artist: string; duration: number; coverUrl: string | null; labels: { tag: string; origin: 'source' | 'title' }[] }
export interface ImportRow extends CollectionItem {
  status: 'pending' | 'matched' | 'uncertain' | 'missing';
  confidence: number;
  /** "source" = the collection pointed at the recording; "user" = picked by hand. */
  how?: 'auto' | 'source' | 'user';
  candidate?: Candidate;
  trackId?: string | null;
  /** playlist_tracks.id of this row's entry; survives manual reordering. */
  entryId?: number;
}
export interface ImportJob {
  id: string;
  key: string;
  name: string;
  source: Collection['source'];
  cover: string | null;
  total: number | null;
  complete: boolean;
  note?: string;
  state: 'matching' | 'ready' | 'creating' | 'done' | 'failed';
  error: string | null;
  rows: ImportRow[];
  playlistId: string | null;
  createdAt: number;
}

const MATCHED = 0.8;
const UNCERTAIN = 0.55;
const KEEP_JOBS = 20;

export class Imports {
  private jobs = new Map<string, ImportJob>();
  private running = new Set<string>();
  /** One search per distinct song across all imports in this session. */
  private searchCache = new Map<string, Promise<PublicTrack[]>>();

  constructor(private readonly db: Db, private readonly lib: Library, private readonly music: PublicMusic, private readonly ytdlp: YtDlp, private readonly events: EventHub) {
    for (const j of kvGet<ImportJob[]>(db, 'imports.jobs', [])) if (j?.id) this.jobs.set(j.id, j);
  }

  start(): void { for (const j of this.jobs.values()) if (j.state === 'matching') void this.match(j); }

  list(): Omit<ImportJob, 'rows'>[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(({ rows, ...rest }) => ({ ...rest, counts: counts(rows) } as Omit<ImportJob, 'rows'>));
  }
  get(id: string): ImportJob | undefined { return this.jobs.get(id); }

  private save(): void {
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    // Memory keeps what disk keeps: the 20 newest reports, plus any still matching.
    for (const old of jobs.slice(KEEP_JOBS)) if (!this.running.has(old.id)) this.jobs.delete(old.id);
    kvSet(this.db, 'imports.jobs', jobs.slice(0, KEEP_JOBS));
  }
  private progress(j: ImportJob): void {
    const done = j.rows.filter((r) => r.status !== 'pending').length;
    this.events.emit({ type: 'import', jobId: j.id, done, total: j.rows.length, errors: j.rows.filter((r) => r.status === 'missing').length, finished: j.state !== 'matching' });
  }

  /** Same link or same file returns the existing job (no duplicate imports). */
  async fromUrl(url: string): Promise<ImportJob> {
    const key = `url:${url.trim()}`;
    const existing = [...this.jobs.values()].find((j) => j.key === key && j.state !== 'failed');
    if (existing) return existing;
    return this.create(key, await fetchCollection(url, this.ytdlp));
  }

  fromFile(name: string, text: string): ImportJob {
    const key = `file:${crypto.createHash('sha1').update(text).digest('hex')}`;
    const existing = [...this.jobs.values()].find((j) => j.key === key && j.state !== 'failed');
    return existing ?? this.create(key, parseCollectionFile(name, text));
  }

  private create(key: string, c: Collection): ImportJob {
    const job: ImportJob = {
      id: crypto.randomUUID(), key, name: c.name.slice(0, 200), source: c.source, cover: c.cover, total: c.total, complete: c.complete, note: c.note,
      state: 'matching', error: null, rows: c.items.slice(0, 5000).map((i) => ({ ...i, status: 'pending', confidence: 0 })), playlistId: null, createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.save();
    void this.match(job);
    return job;
  }

  private search(item: CollectionItem): Promise<PublicTrack[]> {
    const k = normalize(`${item.artist} ${item.title}`);
    let p = this.searchCache.get(k);
    if (!p) {
      p = this.music.search('ytmusic', `${item.artist} ${item.title}`.trim()).then(async (r) => r.length ? r : this.music.search('youtube', `${item.artist} ${item.title}`.trim()));
      p.catch(() => this.searchCache.delete(k));
      this.searchCache.set(k, p);
    }
    return p;
  }

  private async matchRow(row: ImportRow): Promise<void> {
    if (row.source) {
      row.status = 'matched'; row.confidence = 1; row.how = 'source';
      row.candidate = { provider: row.source.provider, externalId: row.source.externalId, title: row.title, artist: row.artist, duration: row.duration ?? 0, coverUrl: null, labels: versionLabels(row.title) };
      return;
    }
    const results = await this.search(row);
    const scored = results.slice(0, 10).map((r) => ({ r, s: matchConfidence(row, { title: r.title, artist: r.artist, duration: r.duration, labels: r.labels, kind: r.kind }) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (!best || best.s < UNCERTAIN) { row.status = 'missing'; row.confidence = best?.s ?? 0; return; }
    row.status = best.s >= MATCHED ? 'matched' : 'uncertain';
    row.confidence = Math.round(best.s * 100) / 100;
    row.how = 'auto';
    row.candidate = { provider: best.r.audioProvider, externalId: best.r.externalId, title: best.r.title, artist: best.r.artist, duration: best.r.duration, coverUrl: best.r.coverUrl, labels: best.r.labels };
  }

  private async match(j: ImportJob): Promise<void> {
    if (this.running.has(j.id)) return;
    this.running.add(j.id);
    try {
      let next = 0, since = 0;
      const worker = async () => {
        while (next < j.rows.length) {
          const row = j.rows[next++];
          if (row.status !== 'pending') continue;
          try { await this.matchRow(row); } catch { row.status = 'missing'; row.confidence = 0; }
          if (++since % 10 === 0) { this.save(); this.progress(j); }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      j.state = j.playlistId ? 'done' : 'ready';
    } catch (e) {
      j.state = 'failed'; j.error = (e as Error).message;
    } finally {
      this.running.delete(j.id);
      // Search results are shared only between imports matching at the same time.
      if (!this.running.size) this.searchCache.clear();
      this.save();
      this.progress(j);
    }
  }

  /** Listener's own choice for one position (resolves uncertain/missing rows). */
  resolve(id: string, position: number, choice: { trackId: string } | Candidate | null): ImportJob {
    const j = this.jobs.get(id);
    const row = j?.rows.find((r) => r.position === position);
    if (!j || !row) throw new Error('Позиция импорта не найдена');
    if (choice === null) {
      row.status = 'missing'; row.candidate = undefined; row.trackId = null;
      if (j.playlistId && row.entryId !== undefined) q(this.db, 'DELETE FROM playlist_tracks WHERE playlist_id = ? AND id = ?').run(j.playlistId, row.entryId);
      row.entryId = undefined;
    }
    else if ('trackId' in choice) { if (!this.lib.get(choice.trackId)) throw new Error('Трек не найден'); row.status = 'matched'; row.how = 'user'; row.trackId = choice.trackId; row.confidence = 1; }
    else { row.status = 'matched'; row.how = 'user'; row.candidate = choice; row.trackId = null; row.confidence = 1; }
    if (j.playlistId && row.status === 'matched') this.place(j, row);
    this.save();
    return j;
  }

  private trackFor(row: ImportRow): string | null {
    if (row.trackId && this.lib.get(row.trackId)) return row.trackId;
    const c = row.candidate;
    if (!c) return null;
    const known = this.music.known(c.provider, [c.externalId]).get(c.externalId);
    if (known) { this.lib.setSaved(known, true); return known; }
    // No download yet: the audio is fetched when the track first plays (or when downloaded).
    return this.lib.addRemote({
      provider: c.provider, externalId: c.externalId, title: c.title, artist: c.artist, duration: c.duration || row.duration || 0,
      meta: { pageUrl: canonicalUrl(c.provider, c.externalId), canonicalUrl: canonicalUrl(c.provider, c.externalId), coverUrl: c.coverUrl, metadataSource: 'import', uploader: c.artist, explicit: c.labels.some((l) => l.tag === 'explicit' && l.origin === 'source'), labels: c.labels, artistId: null, albumId: null },
    }).id;
  }

  /** Inserts one row at its original position, never twice. */
  private place(j: ImportJob, row: ImportRow): void {
    const trackId = this.trackFor(row);
    if (!trackId || !j.playlistId) return;
    row.trackId = trackId;
    const pos = row.position * 10;
    // Jobs saved before entryId existed still find their entry by the original position.
    const entry = (row.entryId !== undefined
      ? q(this.db, 'SELECT id FROM playlist_tracks WHERE playlist_id = ? AND id = ?').get(j.playlistId, row.entryId)
      : q(this.db, 'SELECT id FROM playlist_tracks WHERE playlist_id = ? AND position = ?').get(j.playlistId, pos)) as { id: number } | undefined;
    if (entry) {
      q(this.db, 'UPDATE playlist_tracks SET track_id = ? WHERE id = ?').run(trackId, entry.id);
      row.entryId = entry.id;
    } else {
      row.entryId = Number(q(this.db, 'INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)').run(j.playlistId, trackId, pos, Date.now()).lastInsertRowid);
    }
  }

  /** Creates the playlist once; later calls fill in rows resolved since. */
  createPlaylist(id: string, includeUncertain: boolean): ImportJob {
    const j = this.jobs.get(id);
    if (!j) throw new Error('Импорт не найден');
    if (j.state === 'matching') throw new Error('Сопоставление ещё идёт');
    j.state = 'creating';
    tx(this.db, () => {
      if (!j.playlistId || !q(this.db, 'SELECT 1 FROM playlists WHERE id = ?').get(j.playlistId)) {
        j.playlistId = crypto.randomUUID();
        const now = Date.now();
        q(this.db, 'INSERT INTO playlists(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(j.playlistId, j.name, `Импорт: ${j.source}`, now, now);
      }
      for (const row of j.rows) if (row.status === 'matched' || (includeUncertain && row.status === 'uncertain')) this.place(j, row);
      q(this.db, 'UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), j.playlistId);
    });
    j.state = 'done';
    this.save();
    this.events.emit({ type: 'playlists' });
    return j;
  }

  remove(id: string): void { this.jobs.delete(id); this.save(); }
}

export function counts(rows: ImportRow[]): { matched: number; uncertain: number; missing: number; pending: number } {
  const c = { matched: 0, uncertain: 0, missing: 0, pending: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}
