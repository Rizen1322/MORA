import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-preview-'));
let app: Awaited<ReturnType<typeof createApp>>;
const ids: string[] = [];

beforeAll(async () => {
  const cfg = loadConfig();
  app = await createApp({ dataDir: path.join(dir, 'data'), accessToken: null, stemsPython: null }, { startWorkers: false });
  for (const [name, hz] of [['a', 220], ['b', 330]] as const) {
    const file = path.join(dir, `${name}.wav`);
    execFileSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=40:sample_rate=44100`, '-ac', '2', file], { windowsHide: true });
    const r = await app.app.inject({ method: 'POST', url: `/api/import/upload?name=${name}.wav`, headers: { 'content-type': 'application/octet-stream' }, payload: fs.readFileSync(file) });
    expect(r.statusCode, r.body).toBe(200);
    ids.push(r.json().trackId);
  }
});
afterAll(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

it('renders the planned blend as a playable WAV with both songs in it', async () => {
  const r = await app.app.inject(`/api/automix/preview?from=${ids[0]}&to=${ids[1]}&sr=44100`);
  expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
  expect(r.headers['content-type']).toBe('audio/wav');
  const wav = r.rawPayload;
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(44100);
  const frames = (wav.length - 44) / 4;
  expect(frames).toBeGreaterThan(44100 * 5);
  // audible from start to end: the outgoing tone before, the incoming one after
  const rms = (from: number, n: number) => { let s = 0; for (let i = 0; i < n; i++) { const v = wav.readInt16LE(44 + (from + i) * 4) / 32768; s += v * v; } return Math.sqrt(s / n); };
  expect(rms(0, 4410)).toBeGreaterThan(0.01);
  expect(rms(frames - 4410, 4410)).toBeGreaterThan(0.01);
  expect(Number(r.headers['x-transition-start'])).toBeGreaterThan(0);
});

it('refuses a request without both tracks', async () => {
  expect((await app.app.inject(`/api/automix/preview?from=${ids[0]}`)).statusCode).toBe(400);
});
