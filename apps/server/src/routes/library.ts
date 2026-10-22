import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { q, tx } from '../db.ts';
import { ImportError, listAudioFiles } from '../library.ts';
import type { ReactionValue } from '@automix/core';

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

export function registerLibraryRoutes(app: FastifyInstance, s: Services): void {
  const { lib, db, events, analysis } = s;

  app.get('/api/library', async () => ({ tracks: lib.listDTO() }));

  // Preserve provider order after concurrent batch imports, without sending any remote reactions.
  app.post<{ Body: { trackIds?: unknown } }>('/api/library/favorites/order', async (req, reply) => {
    const ids = req.body?.trackIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((id) => typeof id !== 'string' || id.length > 100) || new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'Некорректный порядок любимых треков' });
    if (ids.some((id) => lib.get(id)?.provider === 'yandex')) {
      try { await s.providers.yandex.readReactions(); } catch { /* Local likes remain available offline. */ }
    }
    const liked = new Set(lib.listDTO().filter((t) => t.reaction > 0).map((t) => t.id));
    if (ids.some((id) => !liked.has(id))) return reply.code(400).send({ error: 'В списке есть трек без отметки «Нравится»' });
    const now = Date.now();
    tx(db, () => ids.forEach((id, index) => q(db, 'INSERT INTO reactions(track_id, value, updated_at) VALUES (?, 1, ?) ON CONFLICT(track_id) DO UPDATE SET updated_at = excluded.updated_at').run(id, now - index)));
    events.emit({ type: 'library', reason: 'favorites-order' });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/tracks/:id', async (req, reply) => {
    const t = lib.get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    return lib.trackDTO(t.id);
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; artist?: string; album?: string; genre?: string } }>('/api/tracks/:id', async (req, reply) => {
    const b = req.body ?? {};
    const t = lib.updateMeta(req.params.id, {
      title: typeof b.title === 'string' ? b.title.trim() || undefined : undefined,
      artist: typeof b.artist === 'string' ? b.artist.trim() : undefined,
      album: typeof b.album === 'string' ? b.album.trim() : undefined,
      genre: typeof b.genre === 'string' ? b.genre.trim() : undefined,
    });
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/tracks/:id', async (req) => {
    const t = lib.get(req.params.id);
    if (t) analysis.cancel(t.content_hash);
    await lib.deleteTrack(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/covers/:id', async (req, reply) => {
    const f = lib.coverPath(req.params.id);
    if (!f) return reply.code(404).send({ error: 'нет обложки' });
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    const ext = path.extname(f);
    reply.type(ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(f));
  });

  /** Streams one file into the managed library. Body is the raw file. */
  app.post<{ Querystring: { name?: string } }>('/api/import/upload', async (req, reply) => {
    const name = path.basename(String(req.query.name ?? 'track')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 200);
    const tmp = path.join(s.cfg.dataDir, 'incoming', `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD) cb(new Error('файл больше 2 ГБ'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req.body as Readable, limiter, fs.createWriteStream(tmp));
      const r = await lib.importFile(tmp, name, 'managed');
      return { trackId: r.track.id, duplicate: r.duplicate, title: r.track.title };
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      const code = e instanceof ImportError ? 422 : 500;
      return reply.code(code).send({ error: (e as Error).message, code: e instanceof ImportError ? e.code : 'internal' });
    }
  });

  /** Indexes a folder on this computer in place (files are not copied). */
  app.post<{ Body: { path?: string } }>('/api/import/folder', async (req, reply) => {
    const dir = String(req.body?.path ?? '').trim();
    if (!dir || !path.isAbsolute(dir)) return reply.code(400).send({ error: 'Укажите полный путь к папке' });
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return reply.code(400).send({ error: 'Папка не найдена' });
    const files = await listAudioFiles(dir);
    const jobId = crypto.randomUUID();
    void (async () => {
      let done = 0;
      let errors = 0;
      for (const f of files) {
        try {
          const known = q(db, "SELECT 1 FROM track_sources WHERE kind = 'linked' AND path = ?").get(f);
          if (!known) await lib.importFile(f, path.basename(f), 'linked');
        } catch {
          errors++;
        }
        done++;
        if (done % 5 === 0 || done === files.length) events.emit({ type: 'import', jobId, done, total: files.length, current: path.basename(f), errors, finished: done === files.length });
      }
      if (!files.length) events.emit({ type: 'import', jobId, done: 0, total: 0, errors: 0, finished: true });
    })();
    return { jobId, total: files.length };
  });

  app.post('/api/library/verify', async () => lib.verifySources());

  app.post<{ Params: { id: string }; Body: { value: number } }>('/api/tracks/:id/reaction', async (req, reply) => {
    const t = lib.get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    const raw = req.body?.value;
    if (typeof raw !== 'number' || ![-1, 0, 1].includes(raw)) return reply.code(400).send({ error: 'Оценка должна быть -1, 0 или 1' });
    const v = raw as ReactionValue;
    const queued = tx(db, () => {
      if (v === 0) q(db, 'DELETE FROM reactions WHERE track_id = ?').run(t.id);
      else q(db, 'INSERT INTO reactions(track_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(t.id, v, Date.now());
      return s.yandexReactions.enqueue(t.id, v);
    });
    // Liking a played search result keeps it: it joins the collection.
    if (v === 1 && t.saved === 0) lib.setSaved(t.id, true);
    events.emit({ type: 'library', reason: 'reaction', trackId: t.id });
    return { ok: true, value: v, sync: queued.status === 'local' ? queued : await s.yandexReactions.settle(t.id) };
  });

  // ---------------------------------------------------------------- playlists

  app.get('/api/playlists', async () => {
    const rows = q(
      db,
      `SELECT p.*, COUNT(pt.id) AS count, (SELECT t.cover_id FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.playlist_id = p.id AND t.cover_id IS NOT NULL ORDER BY x.position LIMIT 1) AS cover,
       (SELECT t.id FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.playlist_id = p.id AND t.provider IN ('youtube', 'soundcloud') ORDER BY x.position LIMIT 1) AS cover_track
       FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id GROUP BY p.id ORDER BY p.updated_at DESC`,
    ).all() as { id: string; name: string; description: string; created_at: number; updated_at: number; count: number; cover: string | null; cover_track: string | null }[];
    return {
      playlists: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at, count: r.count, coverUrl: r.cover ? `/api/covers/${r.cover}` : r.cover_track ? `/api/tracks/${r.cover_track}/cover` : null })),
    };
  });

  app.post<{ Body: { name?: string; trackIds?: string[] } }>('/api/playlists', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 120);
    if (!name) return reply.code(400).send({ error: 'Введите название' });
    const id = crypto.randomUUID();
    const now = Date.now();
    tx(db, () => {
      q(db, 'INSERT INTO playlists(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
      (req.body?.trackIds ?? []).forEach((tid, i) => {
        if (lib.get(tid)) q(db, 'INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)').run(id, tid, i, now);
      });
    });
    events.emit({ type: 'playlists' });
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/playlists/:id', async (req, reply) => {
    const p = q(db, 'SELECT * FROM playlists WHERE id = ?').get(req.params.id) as { id: string; name: string; description: string; created_at: number; updated_at: number } | undefined;
    if (!p) return reply.code(404).send({ error: 'плейлист не найден' });
    const entries = q(db, 'SELECT id, track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id').all(p.id) as {
      id: number;
      track_id: string;
      position: number;
      added_at: number;
    }[];
    return { id: p.id, name: p.name, description: p.description, createdAt: p.created_at, updatedAt: p.updated_at, entries: entries.map((e) => ({ entryId: e.id, trackId: e.track_id, addedAt: e.added_at })) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>('/api/playlists/:id', async (req, reply) => {
    const p = q(db, 'SELECT * FROM playlists WHERE id = ?').get(req.params.id) as { name: string; description: string } | undefined;
    if (!p) return reply.code(404).send({ error: 'плейлист не найден' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : p.name;
    if (!name) return reply.code(400).send({ error: 'Название не может быть пустым' });
    const desc = req.body?.description !== undefined ? String(req.body.description).slice(0, 500) : p.description;
    q(db, 'UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, desc, Date.now(), req.params.id);
    events.emit({ type: 'playlists' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', async (req) => {
    q(db, 'DELETE FROM playlists WHERE id = ?').run(req.params.id);
    events.emit({ type: 'playlists' });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { trackIds: string[] } }>('/api/playlists/:id/tracks', async (req, reply) => {
    const p = q(db, 'SELECT id FROM playlists WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'плейлист не найден' });
    const max = (q(db, 'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?').get(req.params.id) as { m: number }).m;
    const now = Date.now();
    let added = 0;
    tx(db, () => {
      for (const tid of req.body?.trackIds ?? []) {
        if (!lib.get(tid)) continue;
        q(db, 'INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)').run(req.params.id, tid, max + 1 + added, now);
        added++;
      }
      q(db, 'UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, req.params.id);
    });
    events.emit({ type: 'playlists' });
    return { added };
  });

  app.delete<{ Params: { id: string; entryId: string } }>('/api/playlists/:id/tracks/:entryId', async (req) => {
    q(db, 'DELETE FROM playlist_tracks WHERE playlist_id = ? AND id = ?').run(req.params.id, Number(req.params.entryId));
    q(db, 'UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    events.emit({ type: 'playlists' });
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { entryIds: number[] } }>('/api/playlists/:id/order', async (req, reply) => {
    const ids = (req.body?.entryIds ?? []).map(Number);
    const existing = (q(db, 'SELECT id FROM playlist_tracks WHERE playlist_id = ?').all(req.params.id) as { id: number }[]).map((r) => r.id);
    const existingSet = new Set(existing);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((i) => existingSet.has(i))) return reply.code(400).send({ error: 'список не совпадает с плейлистом' });
    tx(db, () => {
      ids.forEach((eid, pos) => q(db, 'UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?').run(pos, eid, req.params.id));
      q(db, 'UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    });
    events.emit({ type: 'playlists' });
    return { ok: true };
  });
}
