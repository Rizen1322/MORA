import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { analyzePcm, type TrackAnalysis } from '@automix/core';
import { AutoMixService } from '../src/automix.ts';
import { openDb } from '../src/db.ts';
import type { Library, TrackRow } from '../src/library.ts';
import type { AnalysisService } from '../src/analysis.ts';

describe('listener ratings feed the planner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-ratings-'));
  const db = openDb(dir);
  afterAll(() => {
    db.close();
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-ratings-')) throw new Error('unexpected cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const analysis = analyzePcm(new Float32Array(44100), new Float32Array(44100));
  const library = { get: (id: string) => ({ id, duration: 1, content_hash: id, provider: 'local', album: '', artist: '', album_artist: '', track_no: null, disc_no: null } as TrackRow), mixingPolicy: new Map([['local', true]]) } as unknown as Library;
  const service = new AutoMixService(db, library, { get: () => analysis, prioritize: vi.fn() } as unknown as AnalysisService);

  it('has no statistics and keeps cached plans without ratings', () => {
    const { plan } = service.plan('a', 'b');
    expect(service.ratingStats()).toBeNull();
    expect(service.plan('a', 'b').cached).toBe(true);
    // an executed but unrated transition changes nothing
    service.log({ plan, outcome: {} });
    expect(service.ratingStats()).toBeNull();
    expect(service.plan('a', 'b').cached).toBe(true);
    expect(plan.debug.ratingFeedback).toBeUndefined();
  });

  it('ignores old separated vocal metadata on desktop without mutating the analysis cache', () => {
    const cached = { ...analysis, vocalActivity: { model: 'legacy', rate: 1, values: [1] } } as unknown as TrackAnalysis;
    const desktopService = new AutoMixService(db, library, { get: () => cached } as unknown as AnalysisService);
    const plannerTrack = (desktopService as unknown as { plannerTrack(t: TrackRow): { analysis: TrackAnalysis } }).plannerTrack.bind(desktopService);
    const previous = process.env.AUTOMIX_DESKTOP;
    try {
      process.env.AUTOMIX_DESKTOP = '1';
      expect(plannerTrack(library.get('a')!).analysis.vocalActivity).toBeUndefined();
      expect(cached.vocalActivity).toBeDefined();
      delete process.env.AUTOMIX_DESKTOP;
      expect(plannerTrack(library.get('a')!).analysis.vocalActivity).toBe(cached.vocalActivity);
    } finally { if (previous === undefined) delete process.env.AUTOMIX_DESKTOP; else process.env.AUTOMIX_DESKTOP = previous; }
  });

  it('replans after every rating change and reuses plans of the same statistics', () => {
    const { plan } = service.plan('a', 'b');
    const id = service.log({ plan, outcome: {} });
    expect(service.rate(id, 'bad', null)).toBe(true);
    const stats = service.ratingStats()!;
    expect(stats.features[`method:${plan.method}`]).toEqual({ good: 0, bad: 1 });
    expect(Object.keys(stats.features).some((f) => f.startsWith('bpm:'))).toBe(false);
    // New logs preserve execution measurements even if later analysis changes.
    for (const [hash, bpm] of [['a', 120], ['b', 130]] as const)
      db.prepare("INSERT INTO analysis(content_hash, version, status, summary, updated_at) VALUES (?, 'old', 'done', ?, 1)").run(hash, JSON.stringify({ bpm }));
    (service as unknown as { feedback: null }).feedback = null;
    expect(service.ratingStats()!.features[`bpm:${plan.method}:8-12`]).toBeUndefined();
    expect(service.plan('a', 'b').cached).toBe(false);
    expect(service.plan('a', 'b').cached).toBe(true);
    expect(service.rate(id, 'good', null)).toBe(true);
    expect(service.ratingStats()!.version).not.toBe(stats.version);
    expect(service.plan('a', 'b').cached).toBe(false);
    // clearing the only rating returns to the unrated statistics (and their cached plan)
    expect(service.rate(id, null, null)).toBe(true);
    expect(service.ratingStats()).toBeNull();
    expect(service.plan('a', 'b').cached).toBe(true);
  });

  it('invalidates on reason edits even when rated_at is unchanged', () => {
    const { plan } = service.plan('a', 'b');
    const id = service.log({ plan, outcome: { stems: { masks: { A: false, B: false } } } });
    service.rate(id, 'bad', 'голоса наложились');
    const before = service.ratingStats()!;
    expect(before.reasons!['голоса наложились']!['vocals:none']).toEqual({ good: 0, bad: 1 });
    db.prepare('UPDATE transition_log SET rating_reason = ? WHERE id = ?').run('резко', id);
    const after = service.ratingStats()!;
    expect(after.version).not.toBe(before.version);
    expect(after.reasons!['голоса наложились']).toBeUndefined();
    expect(after.features[`method:${plan.method}`]).toBeUndefined();
    service.rate(id, null, null);
  });

  it('reads historical reasons and tolerates unavailable or damaged analysis', () => {
    const { plan } = service.plan('a', 'b');
    const id = service.log({ plan, outcome: {} });
    db.prepare('UPDATE transition_log SET outcome = ?, rating = ?, rating_reason = ? WHERE id = ?').run('{}', 'bad', 'сбился ритм', id);
    const stats = service.ratingStats()!;
    expect(stats.reasons!['сбился ритм']![`bpm:${plan.method}:8-12`]).toEqual({ good: 0, bad: 1 });
    db.prepare('UPDATE analysis SET summary = ?').run('broken-json');
    (service as unknown as { feedback: null }).feedback = null;
    expect(() => service.ratingStats()).not.toThrow();
    service.rate(id, null, null);
  });
});
