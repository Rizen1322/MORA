import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { kvGet, kvSet } from '../db.ts';
import { findLyrics, sidecarLyrics, type Lyrics, type TimedLyricLine } from '../lyrics.ts';

const NONE_TTL = 24 * 3600_000;

/** Lyrics per recording (content hash): a chosen alternative version has its own timing and offset. */
export function registerLyricsRoutes(app: FastifyInstance, s: Services): void {
  const { lib, db } = s;
  const dir = path.join(s.cfg.dataDir, 'cache', 'lyrics');
  const pending = new Map<string, Promise<Lyrics>>();
  const present = (lyrics: Lyrics, hash: string, offsetMs: number) => {
    const wordLines: TimedLyricLine[] | null = s.stems.wordLyrics(hash);
    return { ...lyrics, ...(wordLines?.length ? { wordLines } : {}), offsetMs };
  };

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/tracks/:id/lyrics', async (req, reply) => {
    const t = lib.get(req.params.id);
    const media = lib.media(req.params.id);
    if (!t || !media) return reply.code(404).send({ error: 'трек не найден' });
    const key = media.content_hash.replace(/[^a-zA-Z0-9]/g, '_');
    const file = path.join(dir, `${key}.json`);
    const offsetMs = kvGet<number>(db, `lyricsOffset:${key}`, 0);
    if (req.query.refresh !== '1' && fs.existsSync(file)) {
      try {
        const c = JSON.parse(await fsp.readFile(file, 'utf8')) as { at: number; lyrics: Lyrics };
        if (c.lyrics.status !== 'none' || Date.now() - c.at < NONE_TTL) return present(c.lyrics, media.content_hash, offsetMs);
      } catch { /* rebuilt below */ }
    }
    // Ready local words must not wait behind a cold/offline LRCLIB lookup.
    const wordLines=s.stems.wordLyrics(media.content_hash);
    if(wordLines?.length)return {status:'synced',source:null,lines:wordLines.map(({t,text})=>({t,text})),
      plain:wordLines.map(l=>l.text).join('\n'),wordLines,offsetMs};
    const lookup = async (): Promise<Lyrics> => {
      let lyrics: Lyrics | null = null;
      for (const src of lib.sources(media.id)) {
        if ((src.kind === 'linked' || src.kind === 'managed') && src.path) lyrics = await sidecarLyrics(src.path).catch(() => null);
        if (lyrics) break;
      }
      lyrics ??= await findLyrics({ title: t.title, artist: t.artist, album: t.album, duration: media.duration });
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ at: Date.now(), lyrics }));
      await fsp.rename(tmp, file);
      return lyrics;
    };
    // Full-screen and sidebar panels may request the same recording together.
    // Share both lookup and cache write, avoiding duplicate requests/temp-file races.
    let job = pending.get(key);
    if (!job) {
      job = lookup().finally(() => pending.delete(key));
      pending.set(key, job);
    }
    let lyrics: Lyrics;
    try { lyrics = await job; }
    catch (e) {
      req.log.warn({ err: e }, 'Lyrics lookup failed');
      return reply.code(502).send({ error: (e as Error).name === 'TimeoutError' ? 'Сервис текстов не ответил. Попробуйте чуть позже.' : 'Сервис текстов временно недоступен. Попробуйте чуть позже.', kind: 'network' });
    }
    return present(lyrics, media.content_hash, offsetMs);
  });

  app.put<{ Params: { id: string }; Body: { offsetMs?: number } }>('/api/tracks/:id/lyrics/offset', async (req, reply) => {
    const media = lib.media(req.params.id);
    const ms = Number(req.body?.offsetMs);
    if (!media) return reply.code(404).send({ error: 'трек не найден' });
    if (!Number.isFinite(ms) || Math.abs(ms) > 30000) return reply.code(400).send({ error: 'сдвиг вне диапазона ±30 с' });
    kvSet(db, `lyricsOffset:${media.content_hash.replace(/[^a-zA-Z0-9]/g, '_')}`, Math.round(ms));
    return { ok: true };
  });
}
