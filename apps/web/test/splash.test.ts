import { describe, expect, it } from 'vitest';
import { skyAt, T } from '../src/lib/splash.ts';

describe('launch splash timeline', () => {
  it('fits the 5–7 s brief, beats in order', () => {
    expect(T.end).toBeGreaterThanOrEqual(5);
    expect(T.end).toBeLessThanOrEqual(7);
    expect(T.bloom < T.hold && T.hold < T.flash && T.flash < T.fade && T.fade < T.end).toBe(true);
  });

  it('starts golden and ends on the app background, so the handoff has no colour jump', () => {
    const [top, mid] = skyAt(0);
    expect(mid[0]).toBeGreaterThan(200);
    expect(top.map(Math.round)).not.toEqual([5, 13, 10]);
    const [endTop, endMid] = skyAt(T.end);
    expect(endTop.map(Math.round)).toEqual([5, 13, 10]); // --bg #050d0a
    expect(endMid.map(Math.round)).toEqual([5, 13, 10]);
  });
});
