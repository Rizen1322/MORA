import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { kvGet, kvSet, q, tx } from '../db.ts';
import { canonicalUrl, validExternalId } from '../public/provider.ts';
import { isYandexTrackId } from '../providers/yandex-audio.ts';

interface BackupTrack { key: string; hash: string | null; title: string; artist: string; album: string; duration: number; source?: { provider: 'youtube' | 'soundcloud' | 'yandex'; externalId: string } }
interface Backup { format: 'mora-playlists'; version: 1; origin: string; createdAt: string; tracks: BackupTrack[]; playlists: { key: string; name: string; description: string; tracks: string[] }[] }

function validate(value: unknown): Backup {
  const b = value as Backup;
  const string = (v: unknown, max = 500) => typeof v === 'string' && v.length <= max;
  if (!b || b.format !== 'mora-playlists' || b.version !== 1 || !string(b.origin, 80) || !b.origin || !Array.isArray(b.tracks) || b.tracks.length > 10000 || !Array.isArray(b.playlists) || b.playlists.length > 1000) throw new Error('Это не поддерживаемая резервная копия MORA');
  const keys = new Set<string>();
  for (const t of b.tracks) {
    if (!t || !string(t.key, 100) || !t.key || keys.has(t.key) || !string(t.title) || !string(t.artist) || !string(t.album) || !Number.isFinite(t.duration) || t.duration < 0 || t.duration > 86400 || (t.hash !== null && (typeof t.hash !== 'string' || !/^[a-f0-9]{64}$/.test(t.hash)))) throw new Error('Повреждён список треков');
    keys.add(t.key);
    if (t.source && (!['youtube', 'soundcloud', 'yandex'].includes(t.source.provider) || typeof t.source.externalId !== 'string' || !(t.source.provider === 'yandex' ? isYandexTrackId(t.source.externalId) : validExternalId(t.source.provider, t.source.externalId)))) throw new Error('Некорректный источник трека');
  }
  const lists = new Set<string>(); let entries = 0;
  for (const p of b.playlists) {
    if (!p || !string(p.key, 100) || lists.has(p.key) || !string(p.name, 120) || !p.name.trim() || !string(p.description, 4000) || !Array.isArray(p.tracks) || p.tracks.some((k) => typeof k !== 'string' || !keys.has(k)) || (entries += p.tracks.length) > 50000) throw new Error('Повреждён список плейлистов');
    lists.add(p.key);
  }
  return b;
}

/** Metadata only: never exports provider secrets, machine paths, history or media bytes. */
export function registerBackupRoutes(app: FastifyInstance, { db, lib, events }: Services): void {
  app.get<{ Querystring: { playlist?: string } }>('/api/backup/playlists', async (req, reply) => {
    let origin = kvGet<string | null>(db, 'backup.origin', null);
    if (!origin) { origin = crypto.randomUUID(); kvSet(db, 'backup.origin', origin); }
    const rows = q(db, 'SELECT id, name, description FROM playlists ORDER BY created_at').all() as { id: string; name: string; description: string }[];
    const selected = req.query.playlist ? rows.filter((p) => p.id === req.query.playlist) : rows;
    if (req.query.playlist && !selected.length) return reply.code(404).send({ error: 'Плейлист не найден' });
    const tracks = new Map<string, BackupTrack>();
    const playlists = selected.map((p) => {
      const entries = q(db, 'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id').all(p.id) as { track_id: string }[];
      for (const { track_id } of entries) {
        if (tracks.has(track_id)) continue;
        const t = lib.get(track_id)!;
        const s = lib.sources(t.id).find((s) => s.kind === 'remote' && ['youtube', 'soundcloud', 'yandex'].includes(s.provider));
        tracks.set(t.id, { key: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, hash: /^[a-f0-9]{64}$/.test(t.content_hash) ? t.content_hash : null,
          ...(s?.external_id ? { source: { provider: s.provider as 'youtube' | 'soundcloud' | 'yandex', externalId: s.external_id } } : {}) });
      }
      return { key: p.id, name: p.name, description: p.description, tracks: entries.map((e) => e.track_id) };
    });
    const backup: Backup = { format: 'mora-playlists', version: 1, origin, createdAt: new Date().toISOString(), tracks: [...tracks.values()], playlists };
    return reply.header('Content-Disposition', 'attachment; filename="MORA-playlists.json"').header('Cache-Control', 'no-store').send(backup);
  });

  app.post<{ Body: unknown }>('/api/backup/playlists/restore', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    let b: Backup;
    try { b = validate(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    let missingFiles = 0;
    const result = tx(db, () => {
      const ids = new Map<string, string>();
      for (const t of b.tracks) {
        let id: string | undefined;
        if (t.source) id = (q(db, "SELECT track_id AS id FROM track_sources WHERE provider = ? AND kind = 'remote' AND external_id = ? LIMIT 1").get(t.source.provider, t.source.externalId) as { id: string } | undefined)?.id;
        // Match local bytes only; different remote recordings may have identical encodings.
        if (!id && !t.source && t.hash) id = (q(db, "SELECT id FROM tracks WHERE content_hash = ? AND provider = 'local' LIMIT 1").get(t.hash) as { id: string } | undefined)?.id;
        const restoredKey = `backup.track.${crypto.createHash('sha256').update(`${b.origin}/${t.key}`).digest('hex')}`;
        if (!id) {
          const previous = kvGet<string | null>(db, restoredKey, null);
          if (previous && lib.get(previous)) id = previous;
        }
        if (!id) {
          id = crypto.randomUUID(); const now = Date.now();
          q(db, 'INSERT INTO tracks(id, content_hash, title, artist, album, duration, provider, status, added_at, updated_at, saved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
            id, t.source ? `remote:${t.source.provider}:${t.source.externalId}` : t.hash ?? `missing:${id}`, t.title, t.artist, t.album, t.duration, t.source?.provider ?? 'local', t.source ? 'ok' : 'missing', now, now);
          if (t.source) {
            const pageUrl = t.source.provider === 'yandex' ? `https://music.yandex.ru/track/${t.source.externalId.split(':')[0]}` : canonicalUrl(t.source.provider, t.source.externalId);
            q(db, "INSERT INTO track_sources(track_id, provider, kind, external_id, meta) VALUES (?, ?, 'remote', ?, ?)").run(id, t.source.provider, t.source.externalId, JSON.stringify({ pageUrl, canonicalUrl: pageUrl, metadataSource: 'backup' }));
          }
          kvSet(db, restoredKey, id);
        }
        if (lib.get(id)?.status === 'missing') missingFiles++;
        ids.set(t.key, id);
      }
      for (const p of b.playlists) {
        const key = `backup.playlist.${crypto.createHash('sha256').update(`${b.origin}/${p.key}`).digest('hex')}`;
        let id = kvGet<string | null>(db, key, null);
        const now = Date.now();
        if (!id || !q(db, 'SELECT id FROM playlists WHERE id = ?').get(id)) {
          id = crypto.randomUUID();
          q(db, 'INSERT INTO playlists(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, p.name, p.description, now, now);
          kvSet(db, key, id);
        } else {
          q(db, 'UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(p.name, p.description, now, id);
          q(db, 'DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
        }
        p.tracks.forEach((track, position) => q(db, 'INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)').run(id, ids.get(track)!, position, now));
      }
      return { playlists: b.playlists.length, tracks: b.tracks.length, missingFiles };
    });
    events.emit({ type: 'library', reason: 'backup' }); events.emit({ type: 'playlists' });
    return result;
  });
}
