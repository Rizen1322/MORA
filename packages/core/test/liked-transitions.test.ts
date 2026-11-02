import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planFinalists, planTransition } from '../src/plan/planner.ts';
import type { RatingStats } from '../src/plan/feedback.ts';
import type { AutoMixSettings, PlannerTrack, TrackAnalysis, TransitionPlan } from '../src/types.ts';

// Hard constraint: every transition the listener liked keeps a byte-identical plan.
// Built by tools/build-liked-fixture.ts from the real analyses of those pairs.
type Side = { id: string; duration: number; mixingAllowed: boolean; analysis: string };
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/liked-transitions.json', import.meta.url), 'utf8')) as {
  settings: AutoMixSettings; feedback: RatingStats; analyses: Record<string, TrackAnalysis>;
  cases: { id: string; label: string; from: Side; to: Side; plans: Record<string, { plan: TransitionPlan; finalists: TransitionPlan[] }>; playedFeedback?: RatingStats }[];
};

describe('liked transitions keep their plans', () => {
  it('has the liked pairs', () => expect(fixture.cases.length).toBeGreaterThanOrEqual(13));
  for (const c of fixture.cases) for (const [name, expected] of Object.entries(c.plans)) {
    it(`${c.id} ${name}: ${c.label}`, () => {
      // 'desktop-played': the exact plan the desktop app played, with the ratings it had then
      const desktop = name.startsWith('desktop'), fb = name === 'desktop-played' ? c.playedFeedback! : name.endsWith('ratings') ? fixture.feedback : null;
      if (name === 'desktop-played') {
        const a = { id: c.from.id, duration: c.from.duration, mixingAllowed: true, analysis: { ...fixture.analyses[c.from.analysis], vocalActivity: undefined } };
        const b = { id: c.to.id, duration: c.to.duration, mixingAllowed: true, analysis: { ...fixture.analyses[c.to.analysis], vocalActivity: undefined } };
        expect(JSON.stringify(planFinalists(a, b, fixture.settings, fb))).toBe(JSON.stringify(expected.finalists));
        expect(JSON.stringify(expected.finalists[0])).toBe(JSON.stringify(expected.plan));
        return;
      }
      const track = (s: Side): PlannerTrack => {
        const an = fixture.analyses[s.analysis];
        return { id: s.id, duration: s.duration, mixingAllowed: s.mixingAllowed, analysis: desktop ? { ...an, vocalActivity: undefined } : an };
      };
      const a = track(c.from), b = track(c.to);
      expect(JSON.stringify(planTransition(a, b, fixture.settings, undefined, fb))).toBe(JSON.stringify(expected.plan));
      expect(JSON.stringify(planFinalists(a, b, fixture.settings, fb))).toBe(JSON.stringify(expected.finalists));
    });
  }
});
