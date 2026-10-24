import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { analyzePcm } from '@automix/core';
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

  it('replans after every rating change and reuses plans of the same statistics', () => {
    const { plan } = service.plan('a', 'b');
    const id = service.log({ plan, outcome: {} });
    expect(service.rate(id, 'bad', 'резко')).toBe(true);
    const stats = service.ratingStats()!;
    expect(stats.features[`method:${plan.method}`]).toEqual({ good: 0, bad: 1 });
    expect(Object.keys(stats.features).some((f) => f.startsWith('bpm:'))).toBe(false);
    // the tempo gap of a pair without a beat lock is read from the stored analysis summaries
    for (const [hash, bpm] of [['a', 120], ['b', 130]] as const)
      db.prepare("INSERT INTO analysis(content_hash, version, status, summary, updated_at) VALUES (?, 'old', 'done', ?, 1)").run(hash, JSON.stringify({ bpm }));
    (service as unknown as { feedback: null }).feedback = null;
    expect(service.ratingStats()!.features[`bpm:${plan.method}:8-12`]).toEqual({ good: 0, bad: 1 });
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
});
