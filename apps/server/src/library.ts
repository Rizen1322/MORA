import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { ANALYZER_VERSION, type ReactionSync } from '@automix/core';
import type { AppConfig } from './config.ts';
import { q, tx, type Db } from './db.ts';
import type { EventHub } from './events.ts';
import type { FfmpegTools, ProbeResult } from './ffmpeg.ts';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.alac', '.aif', '.aiff', '.wma', '.wv', '.ape', '.mka', '.webm']);

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface TrackRow {
  id: string;
  content_hash: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string;
  duration: number;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
  bitrate: number | null;
  size: number | null;
  cover_id: string | null;
  provider: string;
  status: string;
  error: string | null;
  added_at: number;
  updated_at: number;
  play_count: number;
  skip_count: number;
  last_played_at: number | null;
  saved: number;
  pinned: number;
}

export interface SourceRow {
  id: number;
  track_id: string;
  provider: string;
  kind: 'managed' | 'linked' | 'remote';
  path: string | null;
  external_id: string | null;
  meta: string;
  size: number | null;
  mtime: number | null;
}

export interface AnalysisSummary {
  status: 'none' | 'pending' | 'running' | 'done' | 'error';
  bpm?: number | null;
  camelot?: string;
  keyName?: string;
  energy?: number;
  rhythm?: number;
  lufs?: number;
  truePeak?: number;
  error?: string;
}

export interface TrackDTO {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string;
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  bitrate: number | null;
  coverUrl: string | null;
  provider: string;
  sourceKind: string;
  sourceUrl: string | null;
  status: string;
  error: string | null;
  addedAt: number;
  playCount: number;
  skipCount: number;
  lastPlayedAt: number | null;
  reaction: number;
  likedAt?: number;
  reactionSync?: ReactionSync;
  analysis: AnalysisSummary;
  mixingAllowed: boolean;
  catalogArtists?: { id: string; name: string }[];
  catalogAlbumId?: string | null;
  /** In the listener's collection (false for a search result that was only played). */
  saved: boolean;
  pinned: boolean;
  /** Public sources: where the metadata came from and what the source itself declares. */
  origin?: { metadataSource: string; uploader: string; explicit: boolean; labels: { tag: string; origin: 'source' | 'title' }[]; artistId: string | null; albumId: string | null };
  /** The listener chose another recording for this track: what actually plays. */
  binding?: { assetId: string; provider: string; title: string; artist: string; origin?: TrackDTO['origin'] };
}

export function sha256File(file: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(file)
      .on('data', (c: string | Buffer) => {
        size += c.length;
        h.update(c);
      })
      .on('error', reject)
      .on('end', () => resolve({ hash: h.digest('hex'), size }));
  });
}

function parseFilename(name: string): { title: string; artist: string } {
  const base = path.basename(name, path.extname(name)).replace(/_/g, ' ').trim();
  const m = /^(?:\d{1,3}[\s.\-_]+)?(.+?)\s+[-–]\s+(.+)$/.exec(base);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base.replace(/^\d{1,3}[\s.\-_]+/, '') || base };
}

export class Library {
  /** provider id -> is mixing allowed (set by the provider registry). */
  mixingPolicy = new Map<string, boolean>([['local', true]]);
  remoteFetcher: ((src: SourceRow, signal?: AbortSignal) => Promise<string>) | null = null;
  onTrackAdded: ((t: TrackRow) => void) | null = null;
  reactionSyncFor: ((trackId: string) => ReactionSync) | null = null;
  displayReactionFor: ((trackId: string, local: number) => number) | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly ff: FfmpegTools,
    private readonly events: EventHub,
  ) {}

  get(id: string): TrackRow | null {
    return (q(this.db, 'SELECT * FROM tracks WHERE id = ?').get(id) as unknown as TrackRow) ?? null;
  }

  byHash(hash: string): TrackRow[] {
    return q(this.db, 'SELECT * FROM tracks WHERE content_hash = ?').all(hash) as unknown as TrackRow[];
  }

  sources(trackId: string): SourceRow[] {
    return q(this.db, 'SELECT * FROM track_sources WHERE track_id = ? ORDER BY id').all(trackId) as unknown as SourceRow[];
  }

  all(): TrackRow[] {
    return q(this.db, 'SELECT * FROM tracks ORDER BY added_at DESC, title').all() as unknown as TrackRow[];
  }

  /** Imports one local file. `kind` managed copies (moves) it into the library, linked keeps it in place. */
  async importFile(file: string, originalName: string, kind: 'managed' | 'linked'): Promise<{ track: TrackRow; duplicate: boolean }> {
    const stat = await fsp.stat(file);
    if (stat.size === 0) throw new ImportError('Пустой файл', 'empty');
    const ext = path.extname(originalName).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) throw new ImportError(`Формат ${ext || 'без расширения'} не поддерживается`, 'format');
    const { hash, size } = await sha256File(file);
    const existing = this.byHash(hash).find((t) => t.provider === 'local');
    if (existing) {
      if (kind === 'linked') {
        q(this.db, 'INSERT OR IGNORE INTO track_sources(track_id, provider, kind, path, size, mtime) VALUES (?, ?, ?, ?, ?, ?)').run(
          existing.id,
          'local',
          'linked',
          file,
          size,
          Math.round(stat.mtimeMs),
        );
      } else {
        await fsp.rm(file, { force: true });
      }
      if (existing.status === 'missing') this.setStatus(existing.id, 'ok', null);
      return { track: this.get(existing.id)!, duplicate: true };
    }

    let probe;
    try {
      probe = await this.ff.probe(file);
    } catch {
      throw new ImportError('Файл повреждён или не распознан декодером', 'corrupt');
    }
    if (!probe.hasAudio || !(probe.duration > 0.2)) throw new ImportError('В файле нет аудиодорожки или он слишком короткий', 'no-audio');

    const meta = await parseFile(file, { duration: false, skipCovers: false }).catch(() => null);
    const c = meta?.common;
    const fromName = parseFilename(originalName);
    let coverId: string | null = null;
    const pic = c?.picture?.[0];
    if (pic?.data?.length) coverId = await this.saveCover(Buffer.from(pic.data), pic.format);

    let finalPath = file;
    if (kind === 'managed') {
      const dir = path.join(this.cfg.dataDir, 'library', hash.slice(0, 2));
      await fsp.mkdir(dir, { recursive: true });
      finalPath = path.join(dir, `${hash}${ext}`);
      await moveFile(file, finalPath);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    tx(this.db, () => {
      q(
        this.db,
        `INSERT INTO tracks(id, content_hash, title, artist, album, album_artist, track_no, disc_no, year, genre, duration, sample_rate, channels, codec, bitrate, size, cover_id, provider, status, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'ok', ?, ?)`,
      ).run(
        id,
        hash,
        (c?.title || fromName.title).slice(0, 300),
        (c?.artist || c?.albumartist || fromName.artist).slice(0, 300),
        (c?.album ?? '').slice(0, 300),
        (c?.albumartist ?? '').slice(0, 300),
        c?.track?.no ?? null,
        c?.disk?.no ?? null,
        c?.year ?? null,
        (c?.genre?.[0] ?? '').slice(0, 100),
        probe.duration,
        probe.sampleRate,
        probe.channels,
        probe.codec,
        probe.bitrate,
        size,
        coverId,
        now,
        now,
      );
      q(this.db, 'INSERT INTO track_sources(track_id, provider, kind, path, size, mtime) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        'local',
        kind,
        finalPath,
        size,
        Math.round(stat.mtimeMs),
      );
    });
    const row = this.get(id)!;
    this.onTrackAdded?.(row);
    this.events.emit({ type: 'library', reason: 'added', trackId: id });
    return { track: row, duplicate: false };
  }

  /** Adds a track from a remote provider (audio is fetched lazily). */
  addRemote(input: {
    provider: string;
    externalId: string;
    title: string;
    artist: string;
    album?: string;
    duration: number;
    trackNo?: number | null;
    discNo?: number | null;
    year?: number | null;
    genre?: string;
    coverId?: string | null;
    meta: Record<string, unknown>;
    /** Optional verified media, available before analysis and stem queues start. */
    content?: { hash: string; size: number; probe: ProbeResult };
    /** false: created only to play a search result; hidden from the collection until saved. */
    saved?: boolean;
  }): TrackRow {
    const found = q(this.db, "SELECT track_id FROM track_sources WHERE provider = ? AND kind = 'remote' AND external_id = ?").get(input.provider, input.externalId) as
      | { track_id: string }
      | undefined;
    if (found) return this.get(found.track_id)!;
    const id = crypto.randomUUID();
    const now = Date.now();
    tx(this.db, () => {
      q(
        this.db,
        `INSERT INTO tracks(id, content_hash, title, artist, album, album_artist, track_no, disc_no, year, genre, duration, cover_id, provider, status, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
      ).run(
        id,
        input.content?.hash ?? `remote:${input.provider}:${input.externalId}`,
        input.title.slice(0, 300),
        input.artist.slice(0, 300),
        (input.album ?? '').slice(0, 300),
        input.trackNo ?? null,
        input.discNo ?? null,
        input.year ?? null,
        (input.genre ?? '').slice(0, 100),
        input.duration,
        input.coverId ?? null,
        input.provider,
        now,
        now,
      );
      q(this.db, "INSERT INTO track_sources(track_id, provider, kind, external_id, meta) VALUES (?, ?, 'remote', ?, ?)").run(
        id,
        input.provider,
        input.externalId,
        JSON.stringify(input.meta),
      );
      if (input.content) {
        const { probe, size } = input.content;
        q(this.db, 'UPDATE tracks SET size = ?, sample_rate = ?, channels = ?, codec = ?, bitrate = ? WHERE id = ?')
          .run(size, probe.sampleRate, probe.channels, probe.codec, probe.bitrate, id);
      }
      if (input.saved === false) q(this.db, 'UPDATE tracks SET saved = 0 WHERE id = ?').run(id);
    });
    const row = this.get(id)!;
    this.onTrackAdded?.(row);
    this.events.emit({ type: 'library', reason: 'added', trackId: id });
    return row;
  }

  async saveCover(data: Buffer, format?: string): Promise<string> {
    const h = crypto.createHash('sha1').update(data).digest('hex');
    const ext = format?.includes('png') ? '.png' : format?.includes('webp') ? '.webp' : '.jpg';
    const id = `${h}${ext}`;
    const file = path.join(this.cfg.dataDir, 'covers', id);
    if (!fs.existsSync(file)) await fsp.writeFile(file, data);
    return id;
  }

  setCover(id: string, coverId: string): void {
    q(this.db, 'UPDATE tracks SET cover_id = ?, updated_at = ? WHERE id = ? AND cover_id IS NULL').run(coverId, Date.now(), id);
    this.events.emit({ type: 'library', reason: 'cover', trackId: id });
    this.events.emit({ type: 'playlists' });
  }

  coverPath(coverId: string): string | null {
    if (!/^[a-f0-9]{40}\.(jpg|png|webp)$/.test(coverId)) return null;
    const f = path.join(this.cfg.dataDir, 'covers', coverId);
    return fs.existsSync(f) ? f : null;
  }

  /** The recording that actually plays for a track: its chosen alternative, or itself. */
  mediaId(id: string): string {
    const r = q(this.db, 'SELECT asset_id FROM track_bindings WHERE track_id = ?').get(id) as { asset_id: string } | undefined;
    return r && r.asset_id !== id && this.get(r.asset_id) ? r.asset_id : id;
  }

  media(id: string): TrackRow | null {
    return this.get(this.mediaId(id));
  }

  /** Plays another recording for this track; null restores the original. Likes and playlists stay on the track. */
  bind(trackId: string, assetId: string | null): void {
    if (assetId && assetId !== trackId) q(this.db, 'INSERT INTO track_bindings(track_id, asset_id, chosen_at) VALUES (?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET asset_id = excluded.asset_id, chosen_at = excluded.chosen_at').run(trackId, assetId, Date.now());
    else q(this.db, 'DELETE FROM track_bindings WHERE track_id = ?').run(trackId);
    this.events.emit({ type: 'library', reason: 'binding', trackId });
  }

  /** Explicit offline download: cache eviction never removes its audio. */
  setPinned(id: string, pinned: boolean): void {
    q(this.db, 'UPDATE tracks SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id);
    this.events.emit({ type: 'library', reason: 'pinned', trackId: id });
  }

  /** Adds a played search result to the collection (or removes it from there). */
  setSaved(id: string, saved: boolean): void {
    q(this.db, 'UPDATE tracks SET saved = ?, updated_at = ? WHERE id = ?').run(saved ? 1 : 0, Date.now(), id);
    this.events.emit({ type: 'library', reason: 'saved', trackId: id });
  }

  /**
   * The source now serves different audio bytes for the same recording link.
   * Analysis, stems and plans are keyed by content hash, so the new hash simply
   * starts fresh; nothing computed for the old file is attached to the new one.
   */
  rebindContent(id: string, hash: string, size: number, probe: ProbeResult): void {
    q(this.db, 'UPDATE tracks SET content_hash = ?, size = ?, duration = ?, sample_rate = ?, channels = ?, codec = ?, bitrate = ?, updated_at = ? WHERE id = ?')
      .run(hash, size, probe.duration, probe.sampleRate, probe.channels, probe.codec, probe.bitrate, Date.now(), id);
    const row = this.get(id);
    if (row) this.onTrackAdded?.(row);
    this.events.emit({ type: 'library', reason: 'content', trackId: id });
  }

  setStatus(id: string, status: string, error: string | null): void {
    q(this.db, 'UPDATE tracks SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, Date.now(), id);
  }

  /** Path of a decodable local file for the track; fetches remote audio if needed. */
  async resolveMediaPath(trackId: string, signal?: AbortSignal): Promise<string> {
    const srcs = this.sources(trackId);
    for (const s of srcs) {
      if ((s.kind === 'managed' || s.kind === 'linked') && s.path && fs.existsSync(s.path)) return s.path;
    }
    const remote = srcs.find((s) => s.kind === 'remote');
    if (remote) {
      if (!this.remoteFetcher) throw new Error('Источник недоступен');
      const file = await this.remoteFetcher(remote, signal);
      // Last use for cache eviction (least recently played goes first).
      const now = new Date();
      fs.utimes(file, now, now, () => {});
      // content hash for remote audio is known only after download
      const t = this.get(trackId);
      if (t && t.content_hash.startsWith('remote:')) {
        const { hash, size } = await sha256File(file);
        q(this.db, 'UPDATE tracks SET content_hash = ?, size = ?, updated_at = ? WHERE id = ?').run(hash, size, Date.now(), trackId);
      }
      return file;
    }
    this.setStatus(trackId, 'missing', 'Файл не найден: переместите его обратно или импортируйте заново');
    this.events.emit({ type: 'library', reason: 'missing', trackId });
    throw new ImportError('Файл трека не найден на диске', 'missing');
  }

  /** Checks that local files still exist. Returns counts. */
  async verifySources(): Promise<{ ok: number; missing: number }> {
    let ok = 0;
    let missing = 0;
    for (const t of this.all()) {
      if (t.provider !== 'local') continue;
      const has = this.sources(t.id).some((s) => s.path && fs.existsSync(s.path));
      if (has) {
        ok++;
        if (t.status === 'missing') this.setStatus(t.id, 'ok', null);
      } else {
        missing++;
        if (t.status !== 'missing') this.setStatus(t.id, 'missing', 'Файл не найден: переместите его обратно или импортируйте заново');
      }
    }
    return { ok, missing };
  }

  async deleteTrack(id: string): Promise<void> {
    const t = this.get(id);
    if (!t) return;
    const srcs = this.sources(id);
    q(this.db, 'DELETE FROM tracks WHERE id = ?').run(id);
    // the app's own managed copy is removed; files linked in place are never touched
    for (const s of srcs) {
      if (s.kind === 'managed' && s.path && this.byHash(t.content_hash).length === 0) await fsp.rm(s.path, { force: true });
    }
    this.events.emit({ type: 'library', reason: 'deleted', trackId: id });
  }

  updateMeta(id: string, patch: Partial<Pick<TrackRow, 'title' | 'artist' | 'album' | 'genre'>>): TrackRow | null {
    const t = this.get(id);
    if (!t) return null;
    const next = { title: patch.title ?? t.title, artist: patch.artist ?? t.artist, album: patch.album ?? t.album, genre: patch.genre ?? t.genre };
    q(this.db, 'UPDATE tracks SET title = ?, artist = ?, album = ?, genre = ?, updated_at = ? WHERE id = ?').run(
      next.title.slice(0, 300),
      next.artist.slice(0, 300),
      next.album.slice(0, 300),
      next.genre.slice(0, 100),
      Date.now(),
      id,
    );
    this.events.emit({ type: 'library', reason: 'updated', trackId: id });
    return this.get(id);
  }

  dto(t: TrackRow, reaction: number, analysis: AnalysisSummary, src: SourceRow | undefined = this.sources(t.id)[0]): TrackDTO {
    let sourceUrl: string | null = null;
    let catalog: Pick<TrackDTO, 'catalogArtists' | 'catalogAlbumId'> = {};
    let origin: TrackDTO['origin'];
    if (src?.kind === 'remote') {
      try {
        const m = JSON.parse(src.meta || '{}');
        sourceUrl = typeof m.pageUrl === 'string' ? m.pageUrl : null;
        if (typeof m.metadataSource === 'string') {
          origin = {
            metadataSource: m.metadataSource, uploader: typeof m.uploader === 'string' ? m.uploader : '', explicit: m.explicit === true,
            labels: Array.isArray(m.labels) ? m.labels.filter((l: { tag?: unknown; origin?: unknown }) => l && typeof l.tag === 'string' && (l.origin === 'source' || l.origin === 'title')).slice(0, 12) : [],
            artistId: typeof m.artistId === 'string' ? m.artistId : null, albumId: typeof m.albumId === 'string' ? m.albumId : null,
          };
        }
        if (t.provider === 'yandex') {
          catalog = {
            catalogArtists: Array.isArray(m.catalogArtists) ? m.catalogArtists.filter((a: { id?: unknown; name?: unknown }) => a && typeof a.id === 'string' && /^\d+$/.test(a.id) && typeof a.name === 'string').slice(0, 20) : [],
            catalogAlbumId: typeof m.catalogAlbumId === 'string' && /^\d+$/.test(m.catalogAlbumId) ? m.catalogAlbumId : null,
          };
        }
      } catch {
        sourceUrl = null;
      }
    }
    return {
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumArtist: t.album_artist,
      trackNo: t.track_no,
      discNo: t.disc_no,
      year: t.year,
      genre: t.genre,
      duration: t.duration,
      codec: t.codec,
      sampleRate: t.sample_rate,
      bitrate: t.bitrate,
      coverUrl: t.cover_id ? `/api/covers/${t.cover_id}` : src?.kind === 'remote' && ['youtube', 'soundcloud'].includes(src.provider) ? `/api/tracks/${t.id}/cover` : null,
      provider: t.provider,
      sourceKind: src?.kind ?? 'none',
      sourceUrl,
      status: t.status,
      error: t.error,
      addedAt: t.added_at,
      playCount: t.play_count,
      skipCount: t.skip_count,
      lastPlayedAt: t.last_played_at,
      // Only Yandex tracks carry a remote reaction; skipping the hook keeps lists free of per-track queries.
      reaction: (t.provider === 'yandex' ? this.displayReactionFor?.(t.id, reaction) : undefined) ?? reaction,
      ...(t.provider === 'yandex' && this.reactionSyncFor ? { reactionSync: this.reactionSyncFor(t.id) } : {}),
      analysis,
      mixingAllowed: this.mixingPolicy.get(t.provider) ?? false,
      ...catalog,
      saved: t.saved !== 0,
      pinned: t.pinned === 1,
      ...(origin ? { origin } : {}),
    };
  }

  /** One track as in listDTO, without reading the whole library. */
  trackDTO(id: string): TrackDTO | undefined {
    const t = this.get(id);
    return t ? this.listDTO([t])[0] : undefined;
  }

  /** All tracks (or the given rows) as DTOs; related tables are read in bulk, not per track. */
  listDTO(only?: TrackRow[]): TrackDTO[] {
    const rows = only ?? this.all();
    // A short list reads only its own rows; the whole library reads each table once.
    const ids = only ? rows.map((t) => t.id) : null;
    const where = (column: string) => (ids ? ` WHERE ${column} IN (${ids.map(() => '?').join(',')})` : '');
    const reactions = new Map(
      (q(this.db, `SELECT track_id, value, updated_at FROM reactions${where('track_id')}`).all(...(ids ?? [])) as { track_id: string; value: number; updated_at: number }[]).map((r) => [r.track_id, r]),
    );
    const byId = new Map(rows.map((t) => [t.id, t]));
    const bindings = new Map((q(this.db, `SELECT track_id, asset_id FROM track_bindings${where('track_id')}`).all(...(ids ?? [])) as { track_id: string; asset_id: string }[]).map((r) => [r.track_id, r.asset_id]));
    if (ids) for (const assetId of bindings.values()) if (!byId.has(assetId)) { const asset = this.get(assetId); if (asset) byId.set(assetId, asset); }
    const sources = new Map<string, SourceRow>();
    const sourceIds = ids ? [...byId.keys()] : null;
    for (const s of q(this.db, `SELECT * FROM track_sources${sourceIds ? ` WHERE track_id IN (${sourceIds.map(() => '?').join(',')})` : ''} ORDER BY id`).all(...(sourceIds ?? [])) as unknown as SourceRow[]) {
      if (!sources.has(s.track_id)) sources.set(s.track_id, s);
    }
    const hashes = ids ? [...new Set([...byId.values()].map((t) => t.content_hash))] : null;
    const an = new Map(
      (
        q(this.db, `SELECT content_hash, status, summary, error FROM analysis WHERE version = ?${hashes ? ` AND content_hash IN (${hashes.map(() => '?').join(',')})` : ''}`).all(ANALYZER_VERSION, ...(hashes ?? [])) as {
          content_hash: string;
          status: string;
          summary: string | null;
          error: string | null;
        }[]
      ).map((r) => [r.content_hash, r]),
    );
    return rows.map((t) => {
      const asset = bindings.has(t.id) ? byId.get(bindings.get(t.id)!) : undefined;
      const a = an.get((asset ?? t).content_hash);
      let summary: AnalysisSummary = { status: 'none' };
      if (a) {
        summary = { status: a.status as AnalysisSummary['status'] };
        if (a.summary) {
          const { features: _f, ...rest } = JSON.parse(a.summary);
          Object.assign(summary, rest);
        }
        if (a.error) summary.error = a.error;
      }
      const reaction = reactions.get(t.id);
      const dto = this.dto(t, reaction?.value ?? 0, summary, sources.get(t.id));
      if (reaction?.value === 1) dto.likedAt = reaction.updated_at;
      if (!asset) return dto;
      // Timeline facts follow the recording that plays; identity stays with the track.
      return { ...dto, duration: asset.duration, codec: asset.codec, sampleRate: asset.sample_rate, bitrate: asset.bitrate,
        binding: { assetId: asset.id, provider: asset.provider, title: asset.title, artist: asset.artist, origin: this.dto(asset, 0, summary, sources.get(asset.id)).origin } };
    });
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

/** Recursively lists audio files below a directory. */
export async function listAudioFiles(dir: string, limit = 50000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(p);
      if (out.length >= limit) return;
    }
  };
  await walk(dir);
  return out.sort();
}
