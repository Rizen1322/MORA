import { describe, expect, it } from 'vitest';
import { swipeDirection } from '../src/lib/swipe.ts';

describe('swipeDirection', () => {
  it('reads quick, long, single-axis moves', () => {
    expect(swipeDirection(-80, 10, 200)).toBe('left');
    expect(swipeDirection(90, -20, 300)).toBe('right');
    expect(swipeDirection(5, -120, 250)).toBe('up');
    expect(swipeDirection(-10, 100, 250)).toBe('down');
  });

  it('ignores taps, slow drags and diagonals', () => {
    expect(swipeDirection(20, 5, 100)).toBeNull();
    expect(swipeDirection(-200, 0, 900)).toBeNull();
    expect(swipeDirection(70, 60, 200)).toBeNull();
  });
});
