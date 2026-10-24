import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openSecret, sealSecret } from '../src/providers/base.ts';

describe('local API guard for the desktop shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-guard-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0, accessToken: 'launch-token' }, { startWorkers: false });
  });
  afterAll(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const get = (headers: Record<string, string>) => app.app.inject({ method: 'GET', url: '/api/health', headers });

  it('requires the launch token and accepts it only as a header or the cookie', async () => {
    expect((await get({ host: '127.0.0.1:5000' })).statusCode).toBe(401);
    expect((await get({ host: '127.0.0.1:5000', 'x-access-token': 'wrong' })).statusCode).toBe(401);
    expect((await get({ host: '127.0.0.1:5000', 'x-access-token': 'launch-token' })).statusCode).toBe(200);
  });

  it('rejects rebound host names and cross-origin pages even with the token', async () => {
    const token = { 'x-access-token': 'launch-token' };
    expect((await get({ ...token, host: 'evil.example:5000' })).statusCode).toBe(421);
    expect((await get({ ...token, host: '127.0.0.1:5000', origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await get({ ...token, host: '127.0.0.1:5000', origin: 'http://127.0.0.1:6000' })).statusCode).toBe(403);
    expect((await get({ ...token, host: '127.0.0.1:5000', origin: 'null' })).statusCode).toBe(403);
    expect((await get({ ...token, host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000' })).statusCode).toBe(200);
  });
});

describe('sealed provider secrets', () => {
  it('round-trips with the key, refuses other keys and leaves plain values readable', () => {
    const key = crypto.randomBytes(32);
    const sealed = sealSecret('{"token":"abc"}', key);
    expect(sealed.startsWith('enc1:')).toBe(true);
    expect(sealed).not.toContain('abc');
    expect(openSecret(sealed, key)).toBe('{"token":"abc"}');
    expect(openSecret(sealed, crypto.randomBytes(32))).toBeNull();
    expect(openSecret(sealed, null)).toBeNull();
    expect(openSecret('{"token":"abc"}', key)).toBe('{"token":"abc"}');
    expect(sealSecret('plain', null)).toBe('plain');
  });
});

describe('shutdown', () => {
  it('closes promptly while a client keeps the event stream open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-close-'));
    const a = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0 }, { startWorkers: false });
    await a.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = a.app.server.address() as { port: number };
    const ctl = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctl.signal });
    await stream.body!.getReader().read();
    const t0 = performance.now();
    const closed = await Promise.race([a.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    ctl.abort();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(closed).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
