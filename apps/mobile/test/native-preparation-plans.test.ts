import { describe, expect, it } from 'vitest';
import { planJSON } from '../src/native-preparation-core.ts';
import { DEFAULT_AUTOMIX_SETTINGS } from '../../../packages/core/src/types.ts';

const input = {
  a: { id: 'a', entryId: 'a-first', duration: 180, mixingAllowed: true, analysis: null },
  b: { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, sampleRate: 48000,
  settings: DEFAULT_AUTOMIX_SETTINGS,
};
const recipe = { version: 1, preset: 'bass_swap', timing: { unit: 'seconds', seconds: 8 },
  aExit: 170, bEntry: 1, bDelay: 0, handoff: 4 };

describe('native queue phrase recipes', () => {
  it('compiles a saved scenario into the same native automation contract', () => {
    const result = JSON.parse(planJSON(JSON.stringify({ ...input, phraseTransition: { fromTrackId: 'a', fromEntryId: 'a-first', recipe } })));
    expect(result.plan.debug.phraseMix.preset).toBe('bass_swap');
    expect(result.plan.aExit).toBe(170);
    expect(result.transition.triggerFrame).toBe(170 * 48000);
    expect(result.transition.durationFrames).toBe(8 * 48000);
    expect(result.transition.lanes.length).toBeGreaterThan(4);
  });
  it('does not reuse an edge after a failed or changed preceding track', () => {
    const result = JSON.parse(planJSON(JSON.stringify({ ...input, phraseTransition: { fromTrackId: 'another', fromEntryId: 'a-first', recipe } })));
    expect(result.plan.debug.phraseMix).toBeUndefined();
  });
  it('does not reuse a recipe after skipping a different occurrence of the same track', () => {
    const edge = { fromTrackId: 'a', fromEntryId: 'a-second', recipe };
    const result = JSON.parse(planJSON(JSON.stringify({ ...input, phraseTransition: edge })));
    expect(result.plan.debug.phraseMix).toBeUndefined();
    expect(result.transition.durationFrames).toBeGreaterThan(0);
  });
  it('falls back safely for legacy or missing occurrence IDs', () => {
    for (const request of [
      { ...input, phraseTransition: { fromTrackId: 'a', recipe } },
      { ...input, a: { ...input.a, entryId: '' }, phraseTransition: { fromTrackId: 'a', fromEntryId: '', recipe } },
      { ...input, a: { ...input.a, entryId: undefined }, phraseTransition: { fromTrackId: 'a', fromEntryId: 'a-first', recipe } },
    ]) expect(JSON.parse(planJSON(JSON.stringify(request))).plan.debug.phraseMix).toBeUndefined();
  });
  it('keeps a valid automatic plan when the saved timing no longer fits', () => {
    const result = JSON.parse(planJSON(JSON.stringify({ ...input, phraseTransition: { fromTrackId: 'a', fromEntryId: 'a-first', recipe: { ...recipe, handoff: 100 } } })));
    expect(result.plan.debug.phraseMix).toBeUndefined();
    expect(result.transition.durationFrames).toBeGreaterThan(0);
  });
  it('respects disabled AutoMix even when an edge has an explicit recipe', () => {
    const result = JSON.parse(planJSON(JSON.stringify({ ...input, settings: { ...input.settings, enabled: false }, phraseTransition: { fromTrackId: 'a', fromEntryId: 'a-first', recipe } })));
    expect(result.plan.debug.phraseMix).toBeUndefined();
    expect(result.plan.duration).toBe(0);
  });
});
