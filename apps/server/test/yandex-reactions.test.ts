import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { kvSet, q } from '../src/db.ts';

type App = Awaited<ReturnType<typeof createApp>>;
type SeenRequest = { path: string; method: string; body: string; authorization: string | undefined };
const TOKEN = 'reaction-fixture-oauth-not-a-real-account';
const HASH = 'a'.repeat(64);
const OUTBOX = 'yandex_reaction_sync';

async function until(check: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!check()) throw new Error(message);
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { entered, waiting, enter, release, used: false };
}

describe('Yandex reaction synchronization through local API fixtures', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-yandex-reactions-'));
  const oldApiBase = process.env.YANDEX_API_BASE;
  const seen: SeenRequest[] = [], liked = new Set<string>(), disliked = new Set<string>();
  let fixture: Server, base: string, a: App, dataDir: string;
  let trackId: string, localId: string, otherId: string, unverifiedId: string;
  let caseNumber = 0, remoteRevision = 0, activeMutations = 0, maximumActive = 0;
  let failing = false, appClosed = true, gate: ReturnType<typeof barrier> | undefined;
  const json = (res: ServerResponse, result: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
  };
  const mutations = () => seen.filter((request) => /^\/users\/42\/(likes|dislikes)\/tracks\//.test(request.path));
  const operations = () => mutations().map((request) => request.path.replace('/users/42/', ''));
  const localValue = (id = trackId) => (q(a.services.db, 'SELECT value FROM reactions WHERE track_id=?').get(id) as { value: number } | undefined)?.value ?? 0;
  const react = (value: unknown, id = trackId) => a.app.inject({ method: 'POST', url: `/api/tracks/${id}/reaction`, payload: { value } });
  const summary = () => a.app.inject('/api/providers/yandex/reactions/sync');
  const create = () => createApp({ dataDir, stemsPython: null, accessToken: null, port: 0, analysisWorkers: 1 }, { startWorkers: false });
  const outbox = () => q(a.services.db, `SELECT * FROM ${OUTBOX} WHERE track_id=?`).get(trackId) as { attempts: number; next_attempt_at: number; value: number; status: string; error: string | null } | undefined;
  const seed = (provider: string, externalId: string, verified = true) => a.services.lib.addRemote({
    provider, externalId, title: `Fixture ${externalId}`, artist: 'Fixture Artist', duration: 3,
    meta: verified ? { audioHash: HASH } : {},
    ...(verified ? { content: { hash: HASH, size: 1000, probe: { duration: 3, codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, hasAudio: true } } } : {}),
  }).id;
  const countTracks = () => (q(a.services.db, 'SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const url = new URL(req.url ?? '/', base);
    seen.push({ path: url.pathname, method: req.method ?? 'GET', body, authorization: req.headers.authorization });
    if (req.headers.authorization !== `OAuth ${TOKEN}`) return json(res, null, 401);
    if (url.pathname === '/account/status') return json(res, { account: { uid: 42, displayName: 'Reaction Fixture' } });
    if (url.pathname === '/tracks' && req.method === 'POST') {
      const ids = new URLSearchParams(body).get('track-ids')?.split(',') ?? [];
      return json(res, ids.map((id) => ({ id: id.split(':')[0], title: `Fixture ${id}`, artists: [{ id: 7, name: 'Fixture Artist' }],
        albums: [{ id: Number(id.split(':')[1] ?? 10), title: 'Fixture Album' }], durationMs: 3000, available: true })));
    }
    const mutation = /^\/users\/42\/(likes|dislikes)\/tracks\/(add-multiple|remove)$/.exec(url.pathname);
    if (!mutation || req.method !== 'POST') return json(res, null, 404);
    activeMutations++; maximumActive = Math.max(maximumActive, activeMutations);
    try {
      if (gate && !gate.used) { gate.used = true; gate.enter(); await gate.waiting; }
      if (failing) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { name: 'PrivateFixtureFailure', message: `${TOKEN} ${base}/private?access_token=${TOKEN}` } }));
        return;
      }
      const ids = new URLSearchParams(body).get('track-ids')?.split(',') ?? [];
      const collection = mutation[1] === 'likes' ? liked : disliked;
      for (const id of ids) if (mutation[2] === 'add-multiple') collection.add(id); else collection.delete(id);
      json(res, { revision: ++remoteRevision });
    } finally { activeMutations--; }
  }

  beforeAll(async () => {
    fixture = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('reaction fixture did not bind a TCP port');
    base = `http://127.0.0.1:${address.port}`; process.env.YANDEX_API_BASE = base;
  });
  beforeEach(async () => {
    seen.length = 0; liked.clear(); disliked.clear(); failing = false; gate = undefined;
    remoteRevision = 0; activeMutations = 0; maximumActive = 0;
    dataDir = path.join(rootDir, `case-${++caseNumber}`);
    a = await create(); appClosed = false;
    a.services.providers.store.save('yandex', {}, { token: TOKEN }, true);
    trackId = seed('yandex', '100:10');
    localId = seed('local', 'fixture-local');
    q(a.services.db, "UPDATE track_sources SET kind='managed' WHERE track_id=?").run(localId);
    otherId = seed('audius', 'fixture-other');
    unverifiedId = seed('yandex', '999:10', false);
  });
  afterEach(async () => {
    gate?.release();
    if (a && !appClosed) { await a.close(); appClosed = true; }
  });
  afterAll(async () => {
    if (fixture) {
      const closed = new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
      fixture.closeAllConnections(); await closed;
    }
    if (oldApiBase === undefined) delete process.env.YANDEX_API_BASE; else process.env.YANDEX_API_BASE = oldApiBase;
    const resolved = path.resolve(rootDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-yandex-reactions-')) throw new Error('unsafe reaction fixture cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('removes the opposite remote reaction before adding a like, preserving the canonical track ID', async () => {
    disliked.add('100:10');
    const response = await react(1);
    expect(response.statusCode, response.body).toBe(200);
    await a.services.yandexReactions.flush(true);
    expect(response.json()).toMatchObject({ value: 1 });
    expect(localValue()).toBe(1);
    expect(operations()).toEqual(['dislikes/tracks/remove', 'likes/tracks/add-multiple']);
    expect(liked.has('100:10')).toBe(true); expect(disliked.has('100:10')).toBe(false);
    for (const request of mutations()) {
      expect(request.method).toBe('POST');
      expect(new URLSearchParams(request.body).get('track-ids')).toBe('100:10');
      expect(request.authorization).toBe(`OAuth ${TOKEN}`);
    }
    const dto = await a.app.inject(`/api/tracks/${trackId}`);
    expect(dto.json()).toMatchObject({ reaction: 1, reactionSync: { status: 'synced' } });
    const status = await summary();
    expect(status.json()).toMatchObject({ synced: 1, items: [{ trackId, value: 1, sync: { status: 'synced' } }] });
    expect(response.body + dto.body + status.body).not.toContain(TOKEN);
  });

  it('removes a like before adding a dislike', async () => {
    liked.add('100:10');
    const response = await react(-1);
    expect(response.statusCode, response.body).toBe(200);
    await a.services.yandexReactions.flush(true);
    expect(operations()).toEqual(['likes/tracks/remove', 'dislikes/tracks/add-multiple']);
    expect(localValue()).toBe(-1);
    expect(liked.has('100:10')).toBe(false); expect(disliked.has('100:10')).toBe(true);
  });

  it('clears both remote lists and removes the local reaction', async () => {
    liked.add('100:10'); disliked.add('100:10');
    const response = await react(0);
    expect(response.statusCode, response.body).toBe(200);
    await a.services.yandexReactions.flush(true);
    expect(operations().sort()).toEqual(['dislikes/tracks/remove', 'likes/tracks/remove']);
    expect(localValue()).toBe(0);
    expect(liked.has('100:10')).toBe(false); expect(disliked.has('100:10')).toBe(false);
    expect(a.services.yandexReactions.status(trackId)).toMatchObject({ status: 'synced' });
  });

  it('keeps local files, other providers, and unverified Yandex placeholders local', async () => {
    for (const id of [localId, otherId, unverifiedId]) {
      const response = await react(1, id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ value: 1, sync: { status: 'local' } });
      expect(localValue(id)).toBe(1);
    }
    await a.services.yandexReactions.flush(true);
    expect(seen).toEqual([]);
    expect((await summary()).json()).toMatchObject({ pending: 0, error: 0, synced: 0, items: [] });
  });

  it('reacts to an unimported catalog song without audio and carries that choice into a later import', async () => {
    const before = countTracks();
    const response = await a.app.inject({ method: 'POST', url: '/api/catalog/yandex/tracks/101:10/reaction', payload: { value: 1 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ value: 1 });
    await a.services.yandexReactions.flush(true);
    expect(countTracks()).toBe(before);
    expect(liked.has('101:10')).toBe(true);
    expect(seen.some((request) => /download-info|get-mp3|\/audio\//.test(request.path))).toBe(false);
    const metadata = seen.filter((request) => request.path === '/tracks');
    expect(metadata).toHaveLength(1);
    expect(new URLSearchParams(metadata[0].body).get('track-ids')).toBe('101:10');
    expect((await summary()).json()).toMatchObject({ items: [{ externalId: '101:10', trackId: null, value: 1, sync: { status: 'synced' } }] });
    const imported = seed('yandex', '101:10');
    const dto = await a.app.inject(`/api/tracks/${imported}`);
    expect(dto.json()).toMatchObject({ reaction: 1, reactionSync: { status: 'synced' } });
    expect(localValue(imported)).toBe(1);
    expect((await summary()).json()).toMatchObject({ items: [{ externalId: '101:10', trackId: imported, value: 1 }] });
  });

  it.each(['101%3Ftoken%3Devil', '101%3A10%3A20'])('rejects invalid catalog reaction ID %s before any API call', async (id) => {
    const response = await a.app.inject({ method: 'POST', url: `/api/catalog/yandex/tracks/${id}/reaction`, payload: { value: 1 } });
    expect(response.statusCode, response.body).toBe(400);
    expect(seen).toEqual([]);
    expect((await summary()).json()).toMatchObject({ pending: 0, error: 0, synced: 0, items: [] });
  });

  it.each([2, -2, 0.5, '1', null, true, {}])('rejects invalid reaction value %j without changing local or remote state', async (value) => {
    const response = await react(value);
    expect(response.statusCode, response.body).toBe(400);
    expect(localValue()).toBe(0); expect(seen).toEqual([]);
    expect(outbox()).toBeUndefined();
  });

  it('preserves the local choice after a remote error and exposes only sanitized retry state', async () => {
    failing = true;
    const response = await react(1);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ value: 1 });
    expect(localValue()).toBe(1);
    expect(a.services.yandexReactions.status(trackId)).toMatchObject({ status: 'error', error: expect.any(String) });
    const row = outbox()!;
    expect(row).toMatchObject({ value: 1, attempts: 1, status: 'error' });
    expect(row.next_attempt_at).toBeGreaterThan(Date.now());
    expect(row.next_attempt_at).toBeLessThanOrEqual(Date.now() + 1500);
    const dto = await a.app.inject(`/api/tracks/${trackId}`), status = await summary();
    expect(dto.json()).toMatchObject({ reaction: 1, reactionSync: { status: 'error' } });
    expect(status.json()).toMatchObject({ error: 1, items: [{ trackId, value: 1, sync: { status: 'error' } }] });
    for (const secret of [TOKEN, base, 'access_token', 'PrivateFixtureFailure']) expect(response.body + dto.body + status.body + row.error).not.toContain(secret);
    expect(mutations()).toHaveLength(1);
    await a.services.yandexReactions.flush();
    expect(mutations()).toHaveLength(1);
  });

  it('serializes rapid like, dislike, and clear so the last choice wins remotely and locally', async () => {
    gate = barrier();
    const first = react(1);
    await until(() => gate!.used, 'first remote mutation never reached its barrier');
    const second = react(-1);
    await until(() => localValue() === -1, 'dislike was not recorded while the previous request was active');
    const last = react(0);
    await until(() => localValue() === 0, 'clear was not recorded while the previous request was active');
    expect(maximumActive).toBe(1); expect(activeMutations).toBe(1);
    gate.release();
    const responses = await Promise.all([first, second, last]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    await a.services.yandexReactions.flush(true);
    expect(localValue()).toBe(0);
    expect(liked.has('100:10')).toBe(false); expect(disliked.has('100:10')).toBe(false);
    expect(maximumActive).toBe(1);
    expect(a.services.yandexReactions.status(trackId)).toMatchObject({ status: 'synced' });
    expect(outbox()?.value).toBe(0);
  });

  it('persists failed changes across an app restart and retries them without changing the local choice', async () => {
    failing = true;
    expect((await react(-1)).statusCode).toBe(200);
    expect(outbox()).toMatchObject({ value: -1, status: 'error', attempts: 1 });
    await a.close(); appClosed = true;
    failing = false;
    a = await create(); appClosed = false;
    expect(localValue()).toBe(-1);
    await a.services.yandexReactions.flush(true);
    expect(a.services.yandexReactions.status(trackId)).toMatchObject({ status: 'synced' });
    expect(localValue()).toBe(-1);
    expect(liked.has('100:10')).toBe(false); expect(disliked.has('100:10')).toBe(true);
    expect((await summary()).json()).toMatchObject({ pending: 0, error: 0, synced: 1 });
  });

  it('keeps a disconnected choice pending and sends it automatically after connecting', async () => {
    a.services.providers.store.clear('yandex');
    const response = await react(1);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ value: 1, sync: { status: 'pending' } });
    expect(localValue()).toBe(1); expect(seen).toEqual([]);
    const connected = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: TOKEN } } });
    expect(connected.statusCode, connected.body).toBe(200);
    await until(() => a.services.yandexReactions.status(trackId).status === 'synced', 'connecting did not retry the pending reaction');
    expect(liked.has('100:10')).toBe(true);
    expect((await summary()).json()).toMatchObject({ pending: 0, error: 0, synced: 1 });
  });

  it('bounds automatic retries and allows connecting to resume a paused failed change', async () => {
    failing = true;
    expect((await react(1)).statusCode).toBe(200);
    for (let attempt = 0; attempt < 6 && outbox()!.attempts < 6; attempt++) await a.services.yandexReactions.flush(true);
    expect(outbox()).toMatchObject({ attempts: 6, status: 'error', value: 1 });
    const requests = mutations().length;
    await a.services.yandexReactions.flush(); await a.services.yandexReactions.flush(true);
    expect(mutations()).toHaveLength(requests);
    expect(localValue()).toBe(1);
    failing = false;
    const connected = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: TOKEN } } });
    expect(connected.statusCode, connected.body).toBe(200);
    await until(() => a.services.yandexReactions.status(trackId).status === 'synced', 'connecting did not resume the paused reaction');
    expect(liked.has('100:10')).toBe(true);
    expect(localValue()).toBe(1);
  });

  it('integration switches round-trip through the settings API', async () => {
    const saved = await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { yandex: { syncLikes: false, waveFeedback: false } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().yandex).toEqual({ syncLikes: false, syncDislikes: true, importLikes: true, waveFeedback: false });
    expect((await a.app.inject('/api/settings')).json().yandex).toEqual({ syncLikes: false, syncDislikes: true, importLikes: true, waveFeedback: false });
  });

  it('a like with likes sync off stays local: kept, never sent', async () => {
    kvSet(a.services.db, 'settings', { yandex: { syncLikes: false }, version: 2 });
    const response = await react(1);
    expect(response.json()).toMatchObject({ value: 1, sync: { status: 'local' } });
    expect(localValue()).toBe(1);
    expect(outbox()).toMatchObject({ value: 1, status: 'synced' });
    await a.services.yandexReactions.flush(true);
    expect(seen.filter((r) => r.path !== '/account/status')).toEqual([]);
    expect(liked.has('100:10')).toBe(false);
  });

  it('a dislike with dislikes sync off stays local', async () => {
    kvSet(a.services.db, 'settings', { yandex: { syncDislikes: false }, version: 2 });
    const response = await react(-1);
    expect(response.json()).toMatchObject({ value: -1, sync: { status: 'local' } });
    expect(localValue()).toBe(-1);
    await a.services.yandexReactions.flush(true);
    expect(mutations()).toEqual([]);
  });

  it('a like with dislikes sync off never touches the remote dislike list', async () => {
    disliked.add('100:10');
    kvSet(a.services.db, 'settings', { yandex: { syncDislikes: false }, version: 2 });
    await react(1);
    await a.services.yandexReactions.flush(true);
    expect(operations()).toEqual(['likes/tracks/add-multiple']);
    expect(liked.has('100:10')).toBe(true);
    expect(disliked.has('100:10')).toBe(true);
    // Removing the like cleans only the managed likes list.
    await react(0);
    await a.services.yandexReactions.flush(true);
    expect(operations()).toEqual(['likes/tracks/add-multiple', 'likes/tracks/remove']);
    expect(liked.has('100:10')).toBe(false);
    expect(disliked.has('100:10')).toBe(true);
  });

  it('a change queued before its switch was turned off waits instead of sending', async () => {
    // Keep the queue frozen until the switch is off, so no background flush wins the race.
    await a.services.yandexReactions.stop();
    const response = await react(1);
    expect(response.statusCode, response.body).toBe(200);
    kvSet(a.services.db, 'settings', { yandex: { syncLikes: false }, version: 2 });
    a.services.yandexReactions.start();
    await a.services.yandexReactions.flush(true);
    expect(mutations()).toEqual([]);
    expect(outbox()).toMatchObject({ status: 'pending', value: 1 });
    expect(outbox()!.error).toContain('Синхронизация лайков');
    kvSet(a.services.db, 'settings', { yandex: { syncLikes: true }, version: 2 });
    a.services.yandexReactions.connectionChanged();
    await until(() => a.services.yandexReactions.status(trackId).status === 'synced', 're-enabling did not send the queued like');
    expect(liked.has('100:10')).toBe(true);
  });

  it('wave feedback off answers ok without contacting Yandex', async () => {
    const event = { type: 'skip', trackId: '100:10' } as const;
    kvSet(a.services.db, 'settings', { yandex: { waveFeedback: false }, version: 2 });
    const off = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/feedback', payload: { sessionId: 'radio-', batchId: null, event } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ ok: true });
    expect(seen.filter((r) => r.path.startsWith('/rotor/'))).toEqual([]);
    kvSet(a.services.db, 'settings', { yandex: { waveFeedback: true }, version: 2 });
    const on = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/feedback', payload: { sessionId: 'radio-', batchId: null, event } });
    expect(on.statusCode, on.body).toBe(502);
    expect(seen.some((r) => r.path.startsWith('/rotor/'))).toBe(true);
  });
});
