import { expect, it } from 'vitest';
import { planJSON } from '../src/native-preparation-core.ts';
import { creativePair } from '../../../packages/core/test/creative-fixtures.ts';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from '../../../packages/core/src/plan/creative.ts';
import { creativeFinalists } from '../../../packages/core/src/plan/creative-selection.ts';
import { planToArmed } from '../../../packages/core/src/engine/arm.ts';

it('makes every retained recipe available to native preparation without vocal stems', () => {
  for (const { id } of CREATIVE_TRANSITION_STYLES) {
    const c = creativePair(id), base = planCreativeTransition(c.from, c.to, c.settings, id)!;
    let reached = false;
    for (let i = 0; i < 180 && !reached; i++) {
      const selected = creativeFinalists([base], { ...c.from, id: `A${i}` }, c.to, c.settings, null)[0];
      if ((selected.debug.creative as { style: string })?.style === id && selected !== base) reached = true;
    }
    expect(reached, id).toBe(true);
    expect(base.vocalA || base.vocalB || base.voiceEcho, id).toBeFalsy();
    const armed = planToArmed(base, 48000, 'A', 'B');
    if (id === 'slowing-echo') { expect(armed.echoDelayPointsFrames!.length).toBeGreaterThan(2); expect(armed.echoClearFrame).toBeGreaterThan(armed.swapFrame); }
  }
});

it('selects the new recipes through the actual native planJSON entry point', () => {
  const c = creativePair('echo-adaptive');
  let selected = false;
  for (let i = 0; i < 8 && !selected; i++) {
    const result = JSON.parse(planJSON(JSON.stringify({ a: { ...c.from, id: `A${i}` }, b: c.to, settings: c.settings, sampleRate: 48000 })));
    expect(result.transition.planId).toBe(result.plan.id);
    selected = !!result.plan.debug.creativeSelection;
  }
  expect(selected).toBe(true);
  const result = JSON.parse(planJSON(JSON.stringify({ a: c.from, b: c.to, settings: { ...c.settings, entryMode: 'preserve' }, sampleRate: 48000 })));
  expect(result.plan.debug.creativeSelection).toBeUndefined();
});
