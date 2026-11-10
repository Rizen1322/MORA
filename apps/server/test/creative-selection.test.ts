import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { creativeFinalists } from '../src/creative-selection.ts';
import { creativePair } from '../../../packages/core/test/creative-fixtures.ts';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition, type TransitionPlan } from '@automix/core';
import { AutoMixService } from '../src/automix.ts';
import { openDb } from '../src/db.ts';
import type { Library, TrackRow } from '../src/library.ts';
import type { AnalysisService } from '../src/analysis.ts';

it('selects every retained recipe only for measured compatible pairs and keeps the baseline', () => {
  for (const { id } of CREATIVE_TRANSITION_STYLES) {
    const c = creativePair(id), seen = new Set<string>();
    const baseline = { ...planCreativeTransition(c.from, c.to, c.settings, id)!, id: 'ordinary', debug: { processingAllowed: true } };
    let unchanged = false;
    for (let i = 0; i < 180; i++) {
      const a = { ...c.from, id: `A${i}` }, result = creativeFinalists([baseline], a, c.to, c.settings, null);
      if (result[0] === baseline) unchanged = true;
      else {
        expect(result[1]).toBe(baseline);
        expect(result[0].vocalA || result[0].vocalB || result[0].voiceEcho).toBeFalsy();
        expect(result[0].debug.renderCheck).toMatchObject({ skipped: 'pcm-not-ready' });
        seen.add((result[0].debug.creative as { style: string }).style);
      }
    }
    expect(unchanged, id).toBe(true); expect(seen.has(id), id).toBe(true);
  }
});

it('preserves album joins, reviewed plans, disabled mixing, preserved intros and unavailable analyses', () => {
  const c = creativePair('echo-adaptive'), p = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
  for (const base of [{ ...p, method: 'gapless' }, { ...p, debug: { processingAllowed: false } },
    { ...p, debug: { reviewedTransition: {} } }] as TransitionPlan[]) {
    const plans = [base]; expect(creativeFinalists(plans, c.from, c.to, c.settings, null)).toBe(plans);
  }
  for (const settings of [{ ...c.settings, enabled: false }, { ...c.settings, djPhrasing: false }, { ...c.settings, entryMode: 'preserve' as const }, { ...c.settings, style: 'smooth' as const }]) {
    const plans = [p]; expect(creativeFinalists(plans, c.from, c.to, settings, null)).toBe(plans);
  }
  const plans = [p]; expect(creativeFinalists(plans, { ...c.from, analysis: null }, c.to, c.settings, null)).toBe(plans);
});

it('uses the recipes in desktop planning and rechecks a cached unchecked recipe once PCM is requested', async () => {
  vi.stubEnv('AUTOMIX_DESKTOP', '1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-recipes-')), db = openDb(dir);
  try {
    const c = creativePair('echo-adaptive');
    const library = { get: (id: string) => ({ id, duration: c.from.duration, content_hash: id, provider: 'local', album: '', artist: '', album_artist: '', track_no: null, disc_no: null } as TrackRow), mixingPolicy: new Map([['local', true]]) } as unknown as Library;
    const service = new AutoMixService(db, library, { get: (hash: string) => hash === 'B' ? c.to.analysis : c.from.analysis, prioritize: vi.fn() } as unknown as AnalysisService);
    let from = '', result;
    for (let i = 0; i < 12; i++) {
      from = `A${i}`; result = service.plan(from, 'B');
      if (result.plan.debug.creativeSelection) break;
    }
    expect(result!.plan.debug.creativeSelection).toBeDefined();
    expect(service.plan(from, 'B').cached).toBe(true);
    const read = vi.fn(async () => null);
    const checked = await service.planChecked(from, 'B', read);
    expect(read).toHaveBeenCalled(); expect(checked.plan.id).toBe(result!.plan.id);
    await service.preplan('A99', 'B');
    expect(service.plan('A99', 'B').cached).toBe(true);
  } finally {
    db.close(); vi.unstubAllEnvs();
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('mora-recipes-')) throw Error('Unexpected cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
