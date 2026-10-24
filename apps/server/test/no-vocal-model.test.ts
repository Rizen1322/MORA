import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-no-vocals-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it('ships no vocal model: reports it absent and keeps the stem switch from disabling other DJ techniques', async () => {
  // a bundled pack in the old place is ignored now
  fs.mkdirSync(path.join(dir, 'vocal'), { recursive: true });
  const prev = process.env.STEMS_PYTHON;
  delete process.env.STEMS_PYTHON;
  try {
    expect(loadConfig({ dataDir: path.join(dir, 'cfg') }).stemsPython).toBeNull();
  } finally { if (prev !== undefined) process.env.STEMS_PYTHON = prev; }
  const data = path.join(dir, 'data');
  const first = await createApp({ dataDir: data, accessToken: null, stemsPython: null }, { startWorkers: false });
  const health = (await first.app.inject('/api/health')).json();
  expect(health.stems.available).toBe(false);
  expect(health.stems.runtime).toBeNull();
  const settings = (await first.app.inject('/api/settings')).json();
  const off = await first.app.inject({ method: 'PUT', url: '/api/settings', payload: { ...settings, automix: { ...settings.automix, stemMixing: false } } });
  expect(off.statusCode, off.body).toBe(200);
  await first.close();
  // an older installation saved "off": without a model it would only switch off phrasing, loops and master tempo
  const again = await createApp({ dataDir: data, accessToken: null, stemsPython: null }, { startWorkers: false });
  try {
    expect((await again.app.inject('/api/settings')).json().automix.stemMixing).toBe(true);
  } finally { await again.close(); }
});
