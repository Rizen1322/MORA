import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzePcm, renderTransitionOffline, DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '@automix/core';
import { ReviewedTransitions, reviewedPlanHash, reviewedSettings, type ReviewedTransitionEntry } from '../src/reviewed-transitions.ts';
import { AutoMixService } from '../src/automix.ts';
import { openDb, kvSet } from '../src/db.ts';
import type { Library, TrackRow } from '../src/library.ts';
import type { AnalysisService } from '../src/analysis.ts';

describe('exact locally reviewed transitions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-reviewed-'));
  const file = path.join(dir, 'reviewed-transitions.json'), store = new ReviewedTransitions(file), db = openDb(dir);
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS }, fromHash = 'a'.repeat(64), toHash = 'b'.repeat(64);
  const analysis = { ...analyzePcm(new Float32Array(44100), new Float32Array(44100)), duration: 60, audibleStart: 0, audibleEnd: 60 } as TrackAnalysis;
  const a = { id: 'a', duration: 60, analysis, mixingAllowed: true } as PlannerTrack, b = { ...a, id: 'b' };
  const plan = (): TransitionPlan => ({ id: 'review-source', version: 'historical', fromTrackId: 'old-a', toTrackId: 'old-b',
    method: 'beatmatch_blend', aExit: 20, bEntry: 2, duration: 8, swapAt: 4, gap: 0, tempoB: [[0, 1]],
    gainA: 0, gainB: 0, confidence: .8, reasons: [], automation: [
      { deck: 'A', lane: 'gain', points: [[0, 1], [8, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [4, 1], [8, 1]] }],
    loopA: { start: 22, end: 24, until: 28, crossfade: .006 }, debug: { humanScenario: { auditionOnly: true } } });
  const entry = (p = plan()): ReviewedTransitionEntry => ({ id: 'approved-a-b', fromHash, toHash, settings: reviewedSettings(settings),
    plan: p, planSha256: reviewedPlanHash(p), evidence: { reviewId: 'listening', variantId: 'tested-plan', manifestSha256: 'c'.repeat(64), rating: 'good' } });
  const write = (entries = [entry()]) => fs.writeFileSync(file, JSON.stringify({ schema: 'mora-reviewed-transitions-1', entries }));
  beforeEach(() => { write(); kvSet(db, 'settings', { version: 2, automix: settings }); });
  afterAll(() => {
    db.close();
    const absolute = path.resolve(dir);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('mora-reviewed-')) throw Error('Unsafe cleanup path');
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  it('uses the exact approved geometry and rebinds IDs without changing the saved object', () => {
    const before = fs.readFileSync(file, 'utf8'), p = store.resolve(a, b, fromHash, toHash, settings)!;
    expect(p.fromTrackId).toBe('a'); expect(p.toTrackId).toBe('b'); expect(p.loopA).toEqual(plan().loopA);
    expect(p.automation).toEqual(plan().automation); expect(p.debug.reviewedTransition).toMatchObject({ rating: 'good', sourcePlanVersion: 'historical' });
    p.automation[0].points[0][1] = 0;
    expect(store.resolve(a, b, fromHash, toHash, settings)!.automation[0].points[0][1]).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  it('does not generalize to another recording or reverse direction and honors changed settings', () => {
    expect(store.resolve(a, b, 'd'.repeat(64), toHash, settings)).toBeNull();
    expect(store.resolve(b, a, toHash, fromHash, settings)).toBeNull();
    for (const changed of [{ enabled: false }, { stemMixing: false }, { loopBridges: false }, { maxBlendSeconds: 16 }, { loudnessTarget: -20 }, { entryMode: 'preserve' as const }])
      expect(store.resolve(a, b, fromHash, toHash, { ...settings, ...changed })).toBeNull();
    expect(store.resolve({ ...a, mixingAllowed: false }, b, fromHash, toHash, settings)).toBeNull();
    expect(store.resolve({ ...a, analysis: null }, b, fromHash, toHash, settings)).toBeNull();
    expect(store.resolve({ ...a, album: 'same', albumArtist: 'same' }, { ...b, album: 'same', albumArtist: 'same' }, fromHash, toHash, settings)).toBeNull();
  });
  it('keeps the rendered audio identical to the approved plan', () => {
    const selected = store.resolve(a, b, fromHash, toHash, settings)!;
    const sr = 8000, L = Float32Array.from({ length: sr * 60 }, (_, i) => .1 * Math.sin(i * .17) + .03 * Math.sin(i * .027));
    const pcm = { L, R: L, sampleRate: sr };
    const before = renderTransitionOffline(pcm, pcm, plan(), 2, 2), after = renderTransitionOffline(pcm, pcm, selected, 2, 2);
    expect(before.metrics.underruns).toBe(0); expect(after.metrics.underruns).toBe(0);
    expect(after.L).toEqual(before.L); expect(after.R).toEqual(before.R);
  });
  it('rejects damaged, duplicate, out-of-range and unreviewed plans instead of breaking playback', () => {
    fs.writeFileSync(file, '{'); expect(store.resolve(a, b, fromHash, toHash, settings)).toBeNull();
    write([entry(), entry()]); expect(store.resolve(a, b, fromHash, toHash, settings)).toBeNull();
    const e = entry(); e.plan.aExit = 58; write([e]); expect(store.resolve(a, b, fromHash, toHash, settings)).toBeNull();
    for (const mutate of [(p: TransitionPlan) => { p.aExit = 58; }, (p: TransitionPlan) => { p.loopA!.until = 59; },
      (p: TransitionPlan) => { p.automation[0].points = [[0, 1], [4, NaN]]; }, (p: TransitionPlan) => { p.vocalA = [[0, 0]]; }]) {
      const p = plan(); mutate(p); write([entry(p)]); expect(store.resolve(a, b, fromHash, toHash, settings)).toBeNull();
    }
    const bad = entry(); bad.evidence.rating = 'bad' as 'good'; write([bad]); expect(store.resolve(a, b, fromHash, toHash, settings)).toBeNull();
  });
  it('honors removal immediately, even if a normal cached plan already exists', async () => {
    const library = { get: (id: string) => ({ id, duration: 60, content_hash: id === 'a' ? fromHash : toHash,
      provider: 'local', album: '', artist: '', album_artist: '', track_no: null, disc_no: null } as TrackRow), mixingPolicy: new Map([['local', true]]) } as unknown as Library;
    const analysisService = { get: () => analysis, prioritize: vi.fn() } as unknown as AnalysisService;
    const service = new AutoMixService(db, library, analysisService, store);
    fs.unlinkSync(file);
    // Seed the ordinary cache, then add a reviewed plan. Cache must not hide it.
    service.plan('a', 'b');
    write();
    const read = vi.fn(); const selected = await service.planChecked('a', 'b', read);
    expect(selected.plan.debug.reviewedTransition).toBeDefined(); expect(read).not.toHaveBeenCalled();
    expect(service.skip('a', 'b', 20).debug.reviewedTransition).toBeUndefined();
    expect(service.requested('a', 'b', 20).debug.reviewedTransition).toBeUndefined();
    const altered = service.log({ plan: { ...selected.plan, aExit: selected.plan.aExit + 1 }, outcome: {} });
    service.rate(altered, 'bad', null);
    const late = service.log({ plan: selected.plan, outcome: { late: true } });
    service.rate(late, 'bad', null);
    expect(service.plan('a', 'b').plan.debug.reviewedTransition).toBeDefined();
    const log = service.log({ plan: selected.plan, outcome: {} });
    service.rate(log, 'bad', null);
    expect(service.plan('a', 'b').plan.debug.reviewedTransition).toBeUndefined();
    service.rate(log, 'good', null);
    expect(service.plan('a', 'b').plan.debug.reviewedTransition).toBeDefined();
    fs.unlinkSync(file);
    // The rating changes the ordinary planner cache key, but not the removed preference.
    expect(service.plan('a', 'b').plan.debug.reviewedTransition).toBeUndefined();
  });
});
