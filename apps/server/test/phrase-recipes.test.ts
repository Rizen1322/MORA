import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compilePhraseMix, type PhraseMixRecipe, type TrackAnalysis, type TransitionPlan } from '@automix/core';
import { createApp } from '../src/app.ts';
import { nativeSources } from '../src/native-sources.ts';

describe('playlist phrase recipe API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-phrase-recipes-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  let items: number[];
  const recipe: PhraseMixRecipe = { version: 1, preset: 'bass_swap', timing: { unit: 'seconds', seconds: 6 }, aExit: 100, bEntry: 12, bDelay: 1, handoff: 3 };
  const context = (from = 0, to = 1, playlistId = 'p') => ({ playlistId, fromItemId: items[from], toItemId: items[to] });
  const query = (obj: object) => new URLSearchParams(Object.entries(obj).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const plan = async (ctx?: object, from = 'a', to = 'b'): Promise<TransitionPlan> => {
    const response = await a.app.inject(`/api/automix/plan?${query({ from, to, ...ctx })}`);
    expect(response.statusCode).toBe(200);
    return response.json().plan;
  };
  const save = (draft: unknown = recipe, ctx = context()) => a.app.inject({ method: 'PUT', url: '/api/automix/recipe', payload: { ...ctx, recipe: draft } });
  const read = (ctx = context()) => a.app.inject(`/api/automix/recipe?${query(ctx)}`);

  beforeAll(async () => { a = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false }); });
  beforeEach(() => {
    const db = a.services.db;
    db.prepare('DELETE FROM playlists').run();
    db.prepare('DELETE FROM tracks').run();
    db.prepare('DELETE FROM transition_cache').run();
    for (const id of ['a', 'b', 'c']) db.prepare('INSERT INTO tracks(id, content_hash, title, duration, provider, added_at, updated_at) VALUES (?, ?, ?, 180, ?, 1, 1)').run(id, `hash-${id}`, id, 'local');
    for (const id of ['p', 'q']) db.prepare('INSERT INTO playlists(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, id);
    items = ['a', 'b', 'a', 'b', 'c'].map((track, pos) => Number(db.prepare('INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?, ?, ?, 1)').run('p', track, pos).lastInsertRowid));
  });
  afterAll(async () => {
    await a?.close();
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('mora-phrase-recipes-')) throw new Error('unexpected cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('applies saved intent to exactly one ordered occurrence edge and keeps automatic planning intact', async () => {
    const automatic = await plan();
    const saved = await save();
    expect(saved.statusCode).toBe(200);
    expect(saved.json().recipe.audioHashes).toEqual({ a: 'hash-a', b: 'hash-b' });
    expect((await read()).json()).toMatchObject({ stale: false, recipe });
    const contextual = await plan(context());
    expect(contextual).toMatchObject({ aExit: 100, bEntry: 12, duration: 6, bDelay: 1, swapAt: 3, method: 'phrase_cut', debug: { recipeContext: context(), phraseMix: { manual: true } } });
    expect(contextual.automation).toEqual(saved.json().plan.automation);
    expect(await plan()).toEqual(automatic);
    expect(await plan(context(2, 3))).toEqual(automatic);
    expect(await plan(context(0, 1, 'q'))).toMatchObject({ method: automatic.method, aExit: automatic.aExit });
    expect((await read(context(0, 1, 'q'))).statusCode).toBe(409);
    expect(await plan(context(), 'b', 'a')).not.toHaveProperty('debug.phraseMix');
  });

  it('ignores recipes after reorder and rejects a save for a nonadjacent edge', async () => {
    expect((await save()).statusCode).toBe(200);
    const automatic = await plan();
    a.services.db.prepare('UPDATE playlist_tracks SET position = 1 WHERE id = ?').run(items[4]);
    a.services.db.prepare('UPDATE playlist_tracks SET position = 2 WHERE id = ?').run(items[1]);
    const fallback = await plan(context());
    expect(fallback.automation).toEqual(automatic.automation);
    expect(fallback.debug.phraseMix).toBeUndefined();
    expect(fallback.debug.recipeFallback).toBeTruthy();
    expect((await save()).statusCode).toBe(409);
  });

  it('marks replaced recordings stale and never applies their old source-time cues', async () => {
    expect((await save()).statusCode).toBe(200);
    a.services.db.prepare('UPDATE tracks SET content_hash = ? WHERE id = ?').run('new-hash', 'a');
    expect((await read()).json()).toMatchObject({ recipe: null, stale: true, audioHashes: { a: 'new-hash', b: 'hash-b' } });
    expect((await plan(context())).debug.phraseMix).toBeUndefined();
    expect((await save()).statusCode).toBe(200);
    expect((await read()).json().recipe.audioHashes.a).toBe('new-hash');
  });

  it('binds to the actual recording behind a track wrapper', async () => {
    expect((await save()).statusCode).toBe(200);
    a.services.db.prepare('INSERT INTO track_bindings(track_id, asset_id, chosen_at) VALUES (?, ?, 1)').run('a', 'c');
    expect((await read()).json()).toMatchObject({ recipe: null, stale: true, audioHashes: { a: 'hash-c', b: 'hash-b' } });
    expect((await plan(context())).debug.phraseMix).toBeUndefined();
  });

  it('validates malformed curves, timing, bounds and contexts without replacing a saved recipe', async () => {
    expect((await save()).statusCode).toBe(200);
    for (const draft of [null, {}, { ...recipe, version: 2 }, { ...recipe, preset: 'unknown' }, { ...recipe, timing: { unit: 'bars', bars: 8 } }, { ...recipe, aExit: 179 }, { ...recipe, bEntry: 179 }, { ...recipe, handoff: 0.5 }, { ...recipe, curves: [{ deck: 'A', lane: 'gain', points: [[0, 1], [0, 0]] }] }]) {
      expect((await save(draft)).statusCode).toBe(400);
      expect((await read()).json()).toMatchObject({ recipe, stale: false });
    }
    for (const ctx of [{ playlistId: 'p' }, { ...context(), toItemId: items[0] }, { ...context(), fromItemId: 1.5 }]) {
      const response = await a.app.inject({ method: 'PUT', url: '/api/automix/recipe', payload: { ...ctx, recipe } });
      expect(response.statusCode).toBe(400);
    }
  });

  it('deletes intent and restores the automatic contextual plan', async () => {
    const automatic = await plan(context());
    expect((await save()).statusCode).toBe(200);
    const response = await a.app.inject({ method: 'DELETE', url: `/api/automix/recipe?${query(context())}` });
    expect(response.statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ recipe: null, stale: false });
    expect(await plan(context())).toEqual(automatic);
  });

  it('falls back safely if stored intent becomes invalid', async () => {
    const automatic = await plan();
    expect((await save()).statusCode).toBe(200);
    a.services.db.prepare('UPDATE transition_recipes SET recipe = ?').run(JSON.stringify({ ...recipe, handoff: 70 }));
    const fallback = await plan(context());
    expect(fallback.automation).toEqual(automatic.automation);
    expect(fallback.debug.phraseMix).toBeUndefined();
    expect(fallback.debug.recipeFallback).toBeTruthy();
  });

  it('denies editing for providers without processing permission', async () => {
    expect((await save()).statusCode).toBe(200);
    a.services.db.prepare('UPDATE tracks SET provider = ? WHERE id = ?').run('restricted-test', 'b');
    expect((await save()).statusCode).toBe(409);
    // Existing intent cannot bypass a later restriction either.
    expect((await plan(context())).debug.phraseMix).toBeUndefined();
    const preview = await a.app.inject({ method: 'POST', url: '/api/automix/phrase-plan', payload: { from: 'a', to: 'b', recipe } });
    expect(preview.statusCode).toBe(409);
  });

  it('previews the compiled draft without saving it or modifying automatic plans', async () => {
    const automatic = await plan();
    const response = await a.app.inject({ method: 'POST', url: '/api/automix/phrase-plan', payload: { from: 'a', to: 'b', recipe } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cached: false, plan: JSON.parse(JSON.stringify(compilePhraseMix(automatic, recipe))) });
    expect((await read()).json()).toMatchObject({ recipe: null, stale: false });
    expect(await plan()).toEqual(automatic);
  });
  it('hands the original queue identity to native planning when another recording is bound', async () => {
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats);
    const sources = vi.spyOn(a.services.lib, 'sources').mockImplementation(id => [{ kind: 'managed', path: '/data/' + id + '.mp3' } as any]);
    try {
      a.services.lib.bind('a', 'c');
      expect((await save()).statusCode).toBe(200);
      const manifest = await nativeSources(a.services, [{ trackId: 'b', entryId: 'entry-b', fromEntryId: 'entry-a', file: 10, transitionContext: context() }], 'a');
      expect(manifest.items[0].phraseTransition?.fromTrackId).toBe('a');
      expect(manifest.items[0].phraseTransition?.fromEntryId).toBe('entry-a');
      expect(manifest.items[0].phraseTransition?.recipe.audioHashes).toEqual({ a: 'hash-c', b: 'hash-b' });
      const oldClient = await nativeSources(a.services, [{ trackId: 'b', entryId: 'entry-b', file: 10, transitionContext: context() }], 'a');
      expect(oldClient.items[0].phraseTransition).toBeUndefined();
    } finally { sources.mockRestore(); stat.mockRestore(); }
  });

  it('rejects an old draft after the selected recording changes without replacing the saved recipe', async () => {
    const hashes = (await read()).json().audioHashes;
    expect(hashes).toEqual({ a: 'hash-a', b: 'hash-b' });
    expect((await save({ ...recipe, audioHashes: hashes })).statusCode).toBe(200);
    a.services.lib.bind('a', 'c');
    expect((await save({ ...recipe, audioHashes: hashes })).statusCode).toBe(409);
    expect((await read()).json()).toMatchObject({ recipe: null, stale: true, audioHashes: { a: 'hash-c', b: 'hash-b' } });
    const preview = await a.app.inject({ method: 'POST', url: '/api/automix/phrase-plan', payload: { from: 'a', to: 'b', recipe: { ...recipe, audioHashes: hashes } } });
    expect(preview.statusCode).toBe(409);
    a.services.lib.bind('a', null);
    expect((await read()).json()).toMatchObject({ recipe, stale: false });
  });

  it('rejects a plan, preview or save when a recording changes while planning yields', async () => {
    for (const request of [
      () => a.app.inject('/api/automix/plan?from=a&to=b'),
      () => a.app.inject({ method: 'POST', url: '/api/automix/phrase-plan', payload: { from: 'a', to: 'b', recipe } }),
      () => a.app.inject({ method: 'POST', url: '/api/automix/preview', payload: { from: 'a', to: 'b', recipe } }),
      () => save(),
    ]) {
      a.services.lib.bind('a', null);
      const original = a.services.automix.planChecked.bind(a.services.automix);
      const spy = vi.spyOn(a.services.automix, 'planChecked').mockImplementation(async (...args) => {
        const result = await original(...args);
        a.services.lib.bind('a', 'c');
        return result;
      });
      try { expect((await request()).statusCode).toBe(409); }
      finally { spy.mockRestore(); }
    }
  });

  it('freezes bar duration across reanalysis and refuses to trust a client supplied value', async () => {
    const automatic = await plan();
    const planner = vi.spyOn(a.services.automix, 'planChecked').mockResolvedValue({ plan: automatic, cached: false, pending: [] });
    const grid = { duration: 180, beat: { stable: true, confidence: 0.9, downbeatConfidence: 0.9, period: 0.5,
      bpm: 120, beats: Array.from({ length: 360 }, (_, i) => i / 2), downbeats: Array.from({ length: 90 }, (_, i) => i * 2) } } as TrackAnalysis;
    let current = grid;
    const analysis = vi.spyOn(a.services.analysis, 'get').mockImplementation(() => current);
    try {
      const response = await save({ ...recipe, timing: { unit: 'bars', bars: 4, resolvedDuration: 30 } });
      expect(response.statusCode).toBe(200);
      const saved = response.json().recipe;
      expect(saved.timing.resolvedDuration).toBeCloseTo(8);
      const before = response.json().plan;
      current = { ...grid, beat: { ...grid.beat!, stable: false, period: 0.7 } };
      const after = await plan(context());
      expect(after.duration).toBe(before.duration);
      expect(after.automation).toEqual(before.automation);
      expect((await save({ ...saved, handoff: 4 })).statusCode).toBe(200);
      expect((await read()).json().recipe.timing).toEqual(saved.timing);
      expect((await save({ ...saved, timing: { unit: 'bars', bars: 4, resolvedDuration: 65 } })).statusCode).toBe(400);
      expect((await save({ ...saved, timing: { unit: 'bars', bars: 8, resolvedDuration: 8 } })).statusCode).toBe(400);
    } finally { analysis.mockRestore(); planner.mockRestore(); }
  });
});
