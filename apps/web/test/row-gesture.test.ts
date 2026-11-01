import { describe, expect, it } from 'vitest';
import { ROW_COMMIT, rowAction, rowOffset } from '../src/lib/row-gesture.ts';

describe('iPhone row swipe', () => {
  it('follows the finger, then resists past the limit', () => {
    expect(rowOffset(60)).toBe(60);
    expect(rowOffset(-110)).toBe(-110);
    expect(rowOffset(210)).toBeCloseTo(155);
    expect(rowOffset(-210)).toBeCloseTo(-155);
  });
  it('commits only past the threshold: right plays next, left queues', () => {
    expect(rowAction(ROW_COMMIT - 1)).toBeNull();
    expect(rowAction(-(ROW_COMMIT - 1))).toBeNull();
    expect(rowAction(rowOffset(140))).toBe('next');
    expect(rowAction(rowOffset(-140))).toBe('queue');
  });
});
