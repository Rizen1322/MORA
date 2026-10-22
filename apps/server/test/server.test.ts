import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';

const ROOT = path.resolve(__dirname, '../../..');
const LIB = path.join(ROOT, 'examples/library');
const BROKEN = path.join(ROOT, 'examples/broken');
const haveDemo = fs.existsSync(LIB) && fs.readdirSync(LIB).length >= 5;

type App = Awaited<ReturnType<typeof createApp>>;

async function upload(a: App, file: string) {
  return a.app.inject({
    method: 'POST',
    url: `/api/import/upload?name=${encodeURIComponent(path.basename(file))}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: fs.readFileSync(file),
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 90000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe.skipIf(!haveDemo)('server end to end (demo library)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-test-'));
  let a: App;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    a = await createApp({ dataDir, analysisWorkers: 2, port: 0 });
  });
  afterAll(async () => {
    await a?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('imports files with metadata and covers, deduplicates by content', async () => {
    const files = fs.readdirSync(LIB).filter((f) => !f.includes('Заставка'));
    for (const f of files) {
      const r = await upload(a, path.join(LIB, f));
      expect(r.statusCode, r.body).toBe(200);
      ids[f] = r.json().trackId;
    }
    const dup = await upload(a, path.join(LIB, files[0]));
    expect(dup.json().duplicate).toBe(true);
    const lib = (await a.app.inject('/api/library')).json().tracks;
    expect(lib).toHaveLength(files.length);
    const t = lib.find((x: { title: string }) => x.title === 'Северный свет');
    expect(t.artist).toBe('Ночная Смена');
    expect(t.album).toBe('Огни трассы');
    expect(t.trackNo).toBe(1);
    expect(t.coverUrl).toMatch(/^\/api\/covers\//);
    const cover = await a.app.inject(t.coverUrl);
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toMatch(/image/);
  });

  it('rejects broken, empty and unsupported files with clear errors', async () => {
    const bad = await upload(a, path.join(BROKEN, 'повреждённый.mp3'));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatch(/повреждён|аудио/);
    const empty = await upload(a, path.join(BROKEN, 'пустой.flac'));
    expect(empty.statusCode).toBe(422);
    const txt = await a.app.inject({ method: 'POST', url: '/api/import/upload?name=notes.txt', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('hello') });
    expect(txt.statusCode).toBe(422);
    expect(txt.json().error).toMatch(/не поддерживается/);
  });

  it('analyzes tracks in the background and stores results by content hash', async () => {
    const lib = await waitFor(async () => {
      const l = (await a.app.inject('/api/library')).json().tracks as { title: string; analysis: { status: string; bpm: number | null; camelot: string } }[];
      return l.every((t) => t.analysis.status === 'done' || t.analysis.status === 'error') ? l : null;
    }, 240000);
    const house = lib.find((t) => t.title === 'Северный свет')!;
    expect(Math.abs((house.analysis.bpm ?? 0) - 124)).toBeLessThan(0.5);
    const dnb = lib.find((t) => t.title === 'Рассвет на 174')!;
    expect(Math.abs((dnb.analysis.bpm ?? 0) - 174)).toBeLessThan(1);
    const amb = lib.find((t) => t.title === 'Пыль и свет')!;
    expect(amb.analysis.bpm).toBeNull();
  });

  it('plans and caches AutoMix transitions', async () => {
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string; title: string }[];
    const id = (t: string) => lib.find((x) => x.title === t)!.id;
    const r1 = (await a.app.inject(`/api/automix/plan?from=${id('Северный свет')}&to=${id('Kinetic Garden')}`)).json();
    expect(r1.plan.method).toBe('beatmatch_blend');
    expect(r1.cached).toBe(false);
    const r2 = (await a.app.inject(`/api/automix/plan?from=${id('Северный свет')}&to=${id('Kinetic Garden')}`)).json();
    expect(r2.cached).toBe(true);
    expect(r2.plan.id).toBe(r1.plan.id);
    // consecutive album tracks -> gapless
    const g = (await a.app.inject(`/api/automix/plan?from=${id('Северный свет')}&to=${id('Тёплый асфальт')}`)).json();
    expect(g.plan.method).toBe('gapless');
    // ambient -> crossfade
    const c = (await a.app.inject(`/api/automix/plan?from=${id('Пыль и свет')}&to=${id('Неон')}`)).json();
    expect(['crossfade', 'gapless']).toContain(c.plan.method);
    // log + read back
    await a.app.inject({ method: 'POST', url: '/api/automix/log', payload: { plan: r1.plan, outcome: { ok: true } } });
    const log = (await a.app.inject('/api/automix/log')).json();
    expect(log.items[0].planId).toBe(r1.plan.id);
    // voice readiness at execution is stored with the outcome (Python is off here: unavailable, no masks)
    expect(log.items[0].outcome).toMatchObject({ ok: true, stems: { A: { status: 'unavailable' }, B: { status: 'unavailable' }, masks: { A: false, B: false } } });
  });

  it('stores, validates and clears a listener rating on a logged transition', async () => {
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string; title: string }[];
    const id = (t: string) => lib.find((x) => x.title === t)!.id;
    const { plan } = (await a.app.inject(`/api/automix/plan?from=${id('Северный свет')}&to=${id('Kinetic Garden')}`)).json();
    const logged = (await a.app.inject({ method: 'POST', url: '/api/automix/log', payload: { plan, outcome: {} } })).json();
    expect(logged.id).toBeGreaterThan(0);
    const rate = (payload: unknown, logId: unknown = logged.id) => a.app.inject({ method: 'POST', url: `/api/automix/log/${logId}/rating`, payload: payload as object });
    const row = async () => ((await a.app.inject('/api/automix/log')).json().items as { id: number; rating: string | null; ratingReason: string | null }[]).find((r) => r.id === logged.id)!;
    expect(await row()).toMatchObject({ rating: null, ratingReason: null });
    expect((await rate({ rating: 'bad', reason: 'голоса наложились' })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ rating: 'bad', ratingReason: 'голоса наложились' });
    expect((await rate({ rating: 'meh' })).statusCode).toBe(400);
    expect((await rate({ rating: 'bad', reason: 'не из списка' })).statusCode).toBe(400);
    expect((await rate({ rating: 'good', reason: 'резко' })).statusCode).toBe(400);
    expect((await rate({ rating: 'good' }, 'x')).statusCode).toBe(400);
    expect((await rate({ rating: 'good' }, 999999)).statusCode).toBe(404);
    expect(await row()).toMatchObject({ rating: 'bad', ratingReason: 'голоса наложились' });
    expect((await rate({ rating: 'good' })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ rating: 'good', ratingReason: null });
    expect((await rate({ rating: null })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ rating: null, ratingReason: null });
  });

  it('adds rating columns to a transition log created by an older version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-olddb-'));
    const old = new DatabaseSync(path.join(dir, 'automix.sqlite'));
    old.exec("CREATE TABLE transition_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, from_track TEXT, to_track TEXT, method TEXT, executed_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT '{}', plan TEXT NOT NULL)");
    old.exec("INSERT INTO transition_log(plan_id, executed_at, plan) VALUES ('p', 1, '{}')");
    old.close();
    const db = openDb(dir);
    const cols = (db.prepare('PRAGMA table_info(transition_log)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['rating', 'rating_reason', 'rated_at']));
    expect(db.prepare('SELECT plan_id, rating FROM transition_log').get()).toMatchObject({ plan_id: 'p', rating: null });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves PCM progressively for playback', async () => {
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string; title: string; duration: number }[];
    const t = lib.find((x) => x.title === 'Неон')!;
    const prep = await a.app.inject({ method: 'POST', url: `/api/tracks/${t.id}/prepare`, payload: { sampleRate: 48000, role: 'current' } });
    expect(prep.statusCode).toBe(200);
    expect(Math.abs(prep.json().totalFrames - t.duration * 48000)).toBeLessThan(48000);
    const r = await a.app.inject(`/api/tracks/${t.id}/pcm?sr=48000&start=96000&frames=32768`);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(32768 * 4);
    const last = await a.app.inject(`/api/tracks/${t.id}/pcm?sr=48000&start=${Math.floor(t.duration * 48000) - 1000}&frames=32768`);
    expect(last.statusCode).toBe(200);
    expect(last.rawPayload.length).toBeLessThan(32768 * 4);
    const bad = await a.app.inject(`/api/tracks/${t.id}/pcm?sr=12345&start=0&frames=10`);
    expect(bad.statusCode).toBe(400);
  });

  it('invalidates in-memory analysis and cached pairs when reanalysis is requested', async () => {
    const tracks = (await a.app.inject('/api/library')).json().tracks as { id: string; title: string }[];
    const from = tracks.find((t) => t.title === 'Северный свет')!.id;
    const to = tracks.find((t) => t.title === 'Kinetic Garden')!.id;
    const url = `/api/automix/plan?from=${from}&to=${to}`;
    await a.app.inject(url);
    expect((await a.app.inject(url)).json().cached).toBe(true);
    expect((await a.app.inject(`/api/tracks/${to}/analysis`)).json().analysis).not.toBeNull();
    await a.app.inject({ method: 'POST', url: `/api/tracks/${to}/analyze` });
    expect((await a.app.inject(`/api/tracks/${to}/analysis`)).json().analysis).toBeNull();
    const waiting = (await a.app.inject(url)).json();
    expect(waiting.cached).toBe(false);
    expect(waiting.pending).toContain(to);
    await waitFor(async () => (await a.app.inject(`/api/tracks/${to}/analysis`)).json().status === 'done', 60000);
    expect((await a.app.inject(url)).json().cached).toBe(false);
    expect((await a.app.inject(url)).json().cached).toBe(true);
  });

  it('persists smart entry controls and bounds the amount of skipped intro', async () => {
    const settings = (await a.app.inject('/api/settings')).json();
    const saved = (await a.app.inject({ method: 'PUT', url: '/api/settings', payload: {
      automix: { ...settings.automix, entryMode: 'preserve', maxEntrySkipSeconds: 999, loopBridges: false },
    } })).json();
    expect(saved.automix.entryMode).toBe('preserve');
    expect(saved.automix.maxEntrySkipSeconds).toBe(75);
      expect(saved.automix.loopBridges).toBe(false);
      expect((await a.app.inject('/api/settings')).json().automix.loopBridges).toBe(false);
    expect((await a.app.inject('/api/settings')).json().automix.entryMode).toBe('preserve');
    await a.app.inject({ method: 'PUT', url: '/api/settings', payload: settings });
  });

  it('reactions, history, playlists and queue persist', async () => {
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string }[];
    const [t1, t2, t3] = lib;
    expect((await a.app.inject({ method: 'POST', url: `/api/tracks/${t1.id}/reaction`, payload: { value: 1 } })).statusCode).toBe(200);
    await a.app.inject({ method: 'POST', url: `/api/tracks/${t2.id}/reaction`, payload: { value: -1 } });
    const play = (await a.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: t3.id, context: 'wave' } })).json();
    await a.app.inject({ method: 'PATCH', url: `/api/plays/${play.id}`, payload: { playedMs: 8000, endReason: 'skip' } });
    const pl = (await a.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Вечер', trackIds: [t1.id, t2.id] } })).json();
    await a.app.inject({ method: 'POST', url: `/api/playlists/${pl.id}/tracks`, payload: { trackIds: [t3.id] } });
    await a.app.inject({ method: 'PATCH', url: `/api/playlists/${pl.id}`, payload: { name: 'Поздний вечер' } });
    const detail = (await a.app.inject(`/api/playlists/${pl.id}`)).json();
    expect(detail.name).toBe('Поздний вечер');
    expect(detail.entries.map((e: { trackId: string }) => e.trackId)).toEqual([t1.id, t2.id, t3.id]);
    const reversed = [...detail.entries].reverse().map((e: { entryId: number }) => e.entryId);
    const duplicate = await a.app.inject({ method: 'PUT', url: `/api/playlists/${pl.id}/order`, payload: { entryIds: [reversed[0], reversed[0], reversed[0]] } });
    expect(duplicate.statusCode).toBe(400);
    expect((await a.app.inject(`/api/playlists/${pl.id}`)).json().entries).toEqual(detail.entries);
    await a.app.inject({ method: 'PUT', url: `/api/playlists/${pl.id}/order`, payload: { entryIds: reversed } });
    await a.app.inject({ method: 'DELETE', url: `/api/playlists/${pl.id}/tracks/${detail.entries[1].entryId}` });
    await a.app.inject({ method: 'PUT', url: '/api/queue', payload: { items: [{ entryId: 'e1', trackId: t1.id }], index: 0, position: 12.5 } });

    // restart the server on the same data directory
    await a.close();
    a = await createApp({ dataDir, analysisWorkers: 1, port: 0 });
    const lib2 = (await a.app.inject('/api/library')).json().tracks as { id: string; reaction: number; skipCount: number; analysis: { status: string } }[];
    expect(lib2.find((x) => x.id === t1.id)!.reaction).toBe(1);
    expect(lib2.find((x) => x.id === t2.id)!.reaction).toBe(-1);
    expect(lib2.find((x) => x.id === t3.id)!.skipCount).toBe(1);
    expect(lib2.every((x) => x.analysis.status === 'done' || x.analysis.status === 'error')).toBe(true);
    const d2 = (await a.app.inject(`/api/playlists/${pl.id}`)).json();
    expect(d2.entries.map((e: { trackId: string }) => e.trackId)).toEqual([t3.id, t1.id]);
    expect((await a.app.inject('/api/queue')).json().position).toBe(12.5);
    const hist = (await a.app.inject('/api/history')).json();
    expect(hist.items[0].endReason).toBe('skip');
  });

  it('Моя волна excludes dislikes and explains picks', async () => {
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string; reaction: number }[];
    const disliked = lib.find((t) => t.reaction === -1)!.id;
    for (let i = 0; i < 5; i++) {
      const r = (await a.app.inject({ method: 'POST', url: '/api/wave/next', payload: { currentId: null, session: [], count: 4 } })).json();
      expect(r.picks.length).toBeGreaterThan(0);
      for (const p of r.picks) {
        expect(p.id).not.toBe(disliked);
        expect(p.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports honest provider states without credentials', async () => {
    const r = (await a.app.inject('/api/providers')).json().providers as { id: string; status: string; capabilities: { mixing: boolean } }[];
    const by = (id: string) => r.find((p) => p.id === id)!;
    expect(by('local').status).toBe('connected');
    expect(by('subsonic').status).toBe('needs_credentials');
    expect(by('jamendo').status).toBe('needs_credentials');
    expect(by('yandex').status).toBe('needs_credentials');
    // Public sources need no account: working when the resolver is installed, otherwise reported as unavailable.
    for (const id of ['youtube', 'soundcloud']) expect(['connected', 'unavailable']).toContain(by(id).status);
    expect(by('youtube').capabilities.mixing).toBe(true);
    expect(by('spotify').capabilities.mixing).toBe(false);
    expect(by('yandex').capabilities.mixing).toBe(true);
  });

  it('marks missing linked files and keeps the rest playable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-linked-'));
    const src = path.join(LIB, fs.readdirSync(LIB).find((f) => f.includes('Заставка'))!);
    const linked = path.join(tmpDir, 'Заставка.mp3');
    fs.copyFileSync(src, linked);
    const job = (await a.app.inject({ method: 'POST', url: '/api/import/folder', payload: { path: tmpDir } })).json();
    expect(job.total).toBe(1);
    const t = await waitFor(async () => ((await a.app.inject('/api/library')).json().tracks as { id: string; title: string }[]).find((x) => x.title === 'Заставка'));
    // Import publishes metadata before the analysis worker releases the source.
    await waitFor(async () => (await a.app.inject(`/api/tracks/${t.id}`)).json().analysis.status === 'done');
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const v = (await a.app.inject({ method: 'POST', url: '/api/library/verify' })).json();
    expect(v.missing).toBe(1);
    const after = ((await a.app.inject('/api/library')).json().tracks as { id: string; status: string }[]).find((x) => x.id === t.id)!;
    expect(after.status).toBe('missing');
    const pcm = await a.app.inject({ method: 'POST', url: `/api/tracks/${t.id}/prepare`, payload: { sampleRate: 48000 } });
    expect(pcm.statusCode).toBe(410);
  });
});
