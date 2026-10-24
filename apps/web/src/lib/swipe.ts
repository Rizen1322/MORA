import { useMemo, useRef } from 'react';

export type SwipeDir = 'left' | 'right' | 'up' | 'down';
type Handlers = Partial<Record<SwipeDir, () => void>>;

/** A finished touch counts as a swipe when it is long, quick and clearly along one axis. */
export function swipeDirection(dx: number, dy: number, ms: number): SwipeDir | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ms > 700 || Math.max(ax, ay) < 48) return null;
  if (ax > ay * 1.5) return dx < 0 ? 'left' : 'right';
  if (ay > ax * 1.5) return dy < 0 ? 'up' : 'down';
  return null;
}

/**
 * Touch swipes on one element. `pick` runs when the finger lands and returns the swipes
 * allowed for this touch (e.g. "down" only while a list is scrolled to the top).
 * Touch events, not pointer events: WebKit cancels pointers once it starts scrolling.
 * A recognized swipe swallows the click it would otherwise end in.
 */
export function useSwipe(pick: () => Handlers) {
  const pickRef = useRef(pick);
  pickRef.current = pick;
  return useMemo(() => {
    let start: { x: number; y: number; t: number; on: Handlers } | null = null;
    let swallowUntil = 0;
    return {
      onTouchStart: (e: React.TouchEvent) => {
        const p = e.touches[0];
        start = e.touches.length === 1 ? { x: p.clientX, y: p.clientY, t: e.timeStamp, on: pickRef.current() } : null;
      },
      onTouchEnd: (e: React.TouchEvent) => {
        const s = start, p = e.changedTouches[0];
        start = null;
        if (!s || !p) return;
        const dir = swipeDirection(p.clientX - s.x, p.clientY - s.y, e.timeStamp - s.t);
        const run = dir ? s.on[dir] : undefined;
        if (!run) return;
        swallowUntil = performance.now() + 400;
        run();
      },
      onTouchCancel: () => { start = null; },
      onClickCapture: (e: React.MouseEvent) => {
        if (performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); swallowUntil = 0; }
      },
    };
  }, []);
}
