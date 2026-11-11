import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { kvGet, kvSet, q, tx } from '../db.ts';
import { duplicateValues, matchesSmartRules, validateSmartRules } from '../smart-playlists.ts';

export function registerSmartLibraryRoutes(app: FastifyInstance, { db, lib, cfg, events }: Services): void {
  app.get('/api/smart-playlists', async () => ({ playlists: q(db, 'SELECT id,name,rules,created_at AS createdAt FROM smart_playlists ORDER BY created_at').all().map(row => ({ ...row, rules: JSON.parse(row.rules as string) })) }));
  app.get<{ Params: { id: string } }>('/api/smart-playlists/:id', async (req, reply) => {
    const row = q(db, 'SELECT id,name,rules FROM smart_playlists WHERE id=?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Плейлист не найден' });
    const rules = validateSmartRules(JSON.parse(row.rules as string));
    return { ...row, rules, tracks: lib.listDTO().filter(track => matchesSmartRules(track, rules)).map(track => track.id) };
  });
  app.post<{ Body: { id?: string; name?: string; rules?: unknown } }>('/api/smart-playlists', async (req, reply) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
      if (!name) throw Error('Введите название');
      const rules = validateSmartRules(req.body?.rules);
      const id = req.body.id ?? crypto.randomUUID();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error('Неверный плейлист');
      q(db, 'INSERT INTO smart_playlists(id,name,rules,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,rules=excluded.rules').run(id, name, JSON.stringify(rules), Date.now());
      return { id };
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>('/api/smart-playlists/:id', async req => { q(db, 'DELETE FROM smart_playlists WHERE id=?').run(req.params.id); return { ok: true }; });
  app.get('/api/library/duplicates', async () => ({ groups: (q(db, 'SELECT content_hash AS hash,COUNT(*) AS count FROM tracks WHERE length(content_hash)=64 GROUP BY content_hash HAVING COUNT(*)>1').all() as { hash: string; count: number }[])
    .filter(group => /^[a-f0-9]{64}$/.test(group.hash)).map(group => ({ ...group, tracks: lib.byHash(group.hash).map(track => lib.trackDTO(track.id)) })) }));
  app.post<{ Body: { hash?: string } }>('/api/library/duplicates/merge', async (req, reply) => {
    const hash = req.body?.hash;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return reply.code(400).send({ error: 'Неверный хеш' });
    const rows = lib.byHash(hash);
    if (rows.length < 2) return reply.code(409).send({ error: 'Дубликаты уже объединены' });
    const merged = duplicateValues(rows.map(track => ({ ...track, reaction: lib.trackDTO(track.id)!.reaction })));
    const removed = rows.filter(track => track.id !== merged.keep).map(track => track.id);
    const mapping = Object.fromEntries(removed.map(id => [id, merged.keep]));
    const bindings = rows.flatMap(track => { const row = q(db, 'SELECT asset_id FROM track_bindings WHERE track_id=?').get(track.id); return row ? [String(row.asset_id)] : []; });
    if (new Set(bindings).size > 1) return reply.code(409).send({ error: 'У треков выбраны разные версии. Сначала сбросьте привязки версий.' });
    const sources = rows.flatMap(track => lib.sources(track.id));
    const managed = sources.filter(source => source.kind === 'managed' && source.path && fs.existsSync(source.path));
    const keptSource = managed.find(source => source.track_id === merged.keep) ?? managed[0];
    const discarded = sources.filter(source => source.path && removed.includes(source.track_id) && source.kind === 'managed' && source.id !== keptSource?.id && source.path !== keptSource?.path);
    tx(db, () => {
      for (const id of removed) {
        q(db, 'UPDATE playlist_tracks SET track_id=? WHERE track_id=?').run(merged.keep, id);
        q(db, 'UPDATE plays SET track_id=? WHERE track_id=?').run(merged.keep, id);
        q(db, 'UPDATE yandex_reaction_sync SET track_id=? WHERE track_id=?').run(merged.keep, id);
        q(db, 'UPDATE track_bindings SET asset_id=? WHERE asset_id=?').run(merged.keep, id);
        q(db, "UPDATE track_sources SET track_id=? WHERE track_id=? AND (kind<>'managed' OR id=?)").run(merged.keep, id, keptSource?.id ?? -1);
      }
      q(db, 'DELETE FROM track_bindings WHERE track_id=asset_id').run();
      if (bindings[0] && !rows.some(track => track.id === bindings[0])) q(db, 'INSERT OR IGNORE INTO track_bindings(track_id,asset_id,chosen_at) VALUES(?,?,?)').run(merged.keep, bindings[0], Date.now());
      q(db, 'UPDATE tracks SET play_count=?,skip_count=?,last_played_at=?,saved=?,pinned=? WHERE id=?').run(merged.playCount, merged.skipCount, merged.lastPlayedAt, Math.max(...rows.map(t => t.saved)), Math.max(...rows.map(t => t.pinned)), merged.keep);
      if (merged.reaction) q(db, 'INSERT INTO reactions(track_id,value,updated_at) VALUES(?,?,?) ON CONFLICT(track_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(merged.keep, merged.reaction, Date.now());
      const queue = kvGet<{ items?: { trackId: string }[]; originalOrder?: { trackId: string }[] } | null>(db, 'queue', null);
      if (queue) { for (const entry of [...(queue.items ?? []), ...(queue.originalOrder ?? [])]) entry.trackId = mapping[entry.trackId] ?? entry.trackId; kvSet(db, 'queue', queue); }
      for (const id of removed) q(db, 'DELETE FROM tracks WHERE id=?').run(id);
    });
    const root = await fsp.realpath(path.join(cfg.dataDir, 'library')).catch(() => path.resolve(cfg.dataDir, 'library'));
    let filesRemoved = 0;
    const cleanupWarnings: string[] = [];
    for (const source of discarded) {
      const file = await fsp.realpath(source.path!).catch(() => '');
      if (file.startsWith(root + path.sep) && !q(db, 'SELECT 1 FROM track_sources WHERE path=?').get(source.path!)) {
        try { await fsp.rm(source.path!, { force: true }); filesRemoved++; } catch { cleanupWarnings.push('Не удалось удалить лишнюю копию собственного файла'); }
      }
    }
    events.emit({ type: 'library', reason: 'merged' }); events.emit({ type: 'playlists' });
    return { keep: merged.keep, mapping, filesRemoved, cleanupWarnings };
  });
  app.get('/api/library/statistics', async () => {
    const since = Date.now() - 30 * 86400000;
    const totals = q(db, 'SELECT COUNT(*) AS plays,COALESCE(SUM(played_ms),0) AS playedMs FROM plays WHERE started_at>=?').get(since);
    const topTracks = q(db, 'SELECT t.id,t.title,t.artist,COUNT(*) AS plays FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.started_at>=? GROUP BY t.id ORDER BY plays DESC,t.id LIMIT 10').all(since);
    const topArtists = q(db, 'SELECT t.artist,COUNT(*) AS plays FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.started_at>=? GROUP BY t.artist ORDER BY plays DESC,t.artist LIMIT 10').all(since);
    const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const days = q(db, 'SELECT started_at AS at FROM plays WHERE started_at>=? ORDER BY started_at DESC').all(since).map(row => dayKey(new Date(Number(row.at))));
    const unique = new Set(days); let longestStreak = 0, streak = 0;
    const today = new Date();
    for (let i = 29; i >= 0; i--) { const day = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)); streak = unique.has(day) ? streak + 1 : 0; longestStreak = Math.max(longestStreak, streak); }
    return { ...totals, topTracks, topArtists, longestStreak };
  });
}
