import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, type TransitionPlan } from '@automix/core';
import { createApp } from '../src/app.ts';
import { kvGet, kvSet, q } from '../src/db.ts';

type App = Awaited<ReturnType<typeof createApp>>;

describe('manual AutoMix API and settings', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-requested-'));
  let a: App;

  beforeAll(async () => {
    a = await createApp({ dataDir, port: 0, analysisWorkers: 1 }, { startWorkers: false });
    // No audio files or workers are needed to test the API and missing-analysis path.
    for (const [id, provider] of [['a', 'local'], ['b', 'local'], ['restricted', 'spotify']]) {
      q(a.services.db, 'INSERT INTO tracks(id, content_hash, title, duration, provider, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, `test-${id}`, id, 180, provider, Date.now(), Date.now());
    }
  });

  beforeEach(() => {
    kvSet(a.services.db, 'settings', { version: 2, automix: { ...DEFAULT_AUTOMIX_SETTINGS } });
  });

  afterAll(async () => {
    await a?.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-requested-')) {
      throw new Error('test cleanup target is outside the temporary workspace');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const request = (body: Record<string, unknown>) => a.app.inject({ method: 'POST', url: '/api/automix/mix-now', payload: body });

  it('starts a short transition at the submitted fractional playback position without analysis', async () => {
    const response = await request({ from: 'a', to: 'b', position: 55.25 });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json().plan as TransitionPlan;
    expect(plan.method).toBe('fallback_crossfade');
    expect(plan.aExit).toBeGreaterThanOrEqual(55.25);
    expect(plan.aExit).toBeLessThan(55.6);
    expect(plan.duration).toBeGreaterThan(1);
    expect(plan.duration).toBeLessThanOrEqual(8);
    expect(plan.debug.requested).toBe(true);
    expect(plan.fromTrackId).toBe('a');
    expect(plan.toTrackId).toBe('b');
  });

  it.each([-1, '55.25', 'Infinity', null, undefined, {}, true])('rejects invalid playback position %j instead of starting at zero', async (position) => {
    const response = await request({ from: 'a', to: 'b', position });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().plan).toBeUndefined();
  });

  it.each([
    {},
    { from: '', to: 'b', position: 0 },
    { from: '   ', to: 'b', position: 0 },
    { from: 'a', to: '', position: 0 },
    { from: ['a'], to: 'b', position: 0 },
    { from: 'a', to: 42, position: 0 },
  ])('rejects missing or malformed track IDs %j', async (body) => {
    const response = await request(body);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().plan).toBeUndefined();
  });

  it('returns 404 for a well-formed request containing an unknown track', async () => {
    const response = await request({ from: 'a', to: 'not-in-library', position: 0 });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/трек не найден/);
  });

  it('rejects a missing body and numeric overflow in JSON', async () => {
    const missing = await a.app.inject({ method: 'POST', url: '/api/automix/mix-now' });
    expect(missing.statusCode).toBe(400);
    const overflow = await a.app.inject({
      method: 'POST', url: '/api/automix/mix-now', headers: { 'content-type': 'application/json' },
      payload: '{"from":"a","to":"b","position":1e999}',
    });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json().plan).toBeUndefined();
  });

  it('defaults musical Next on for older saved settings', async () => {
    const { mixOnNext: _oldMissingField, ...legacy } = DEFAULT_AUTOMIX_SETTINGS;
    kvSet(a.services.db, 'settings', { version: 2, automix: { ...legacy, maxBlendSeconds: 27 } });
    const saved = (await a.app.inject('/api/settings')).json();
    expect(saved.automix.mixOnNext).toBe(true);
    expect(saved.automix.maxBlendSeconds).toBe(27);
  });

  it('persists explicit musical Next opt-out across unrelated settings updates and uses a fast switch', async () => {
    const saved = await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { mixOnNext: false } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().automix.mixOnNext).toBe(false);
    await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { maxBlendSeconds: 27 } } });
    expect((await a.app.inject('/api/settings')).json().automix.mixOnNext).toBe(false);
    expect(kvGet<{ automix: { mixOnNext: boolean } } | null>(a.services.db, 'settings', null)?.automix.mixOnNext).toBe(false);
    const response = await request({ from: 'a', to: 'b', position: 55.25 });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan.method).toBe('skip_fade');
    expect(response.json().plan.aExit).toBe(55.25);
    expect(response.json().plan.duration).toBeLessThan(1);
  });

  it.each([['restricted', 'b'], ['a', 'restricted']])('does not overlap, stretch or equalize a restricted provider: %s → %s', async (from, to) => {
    const response = await request({ from, to, position: 55.25 });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json().plan as TransitionPlan;
    expect(plan.method).toBe('gapless');
    expect(plan.duration).toBe(0);
    expect(plan.aExit).toBeGreaterThanOrEqual(55.25);
    expect(plan.aExit).toBeLessThan(55.6);
    expect(plan.tempoA?.every(([, rate]) => rate === 1) ?? true).toBe(true);
    expect(plan.tempoB.every(([, rate]) => rate === 1)).toBe(true);
    expect(plan.echo).toBeUndefined();
    expect(plan.automation.every((lane) => lane.lane === 'gain')).toBe(true);
    expect(plan.gainA).toBe(0);
    expect(plan.gainB).toBe(0);
    expect(plan.debug.processingAllowed).toBe(false);
  });
});
