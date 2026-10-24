import type { PlayerSnapshot } from '../audio/controller.ts';

const CLOCK = new Set<string>(['position', 'ratio', 'limiterDb', 'transition']);

/** True when only the playback clock moved: no field the listener acts on changed, and no blend is audible. */
export function clockOnly(prev: PlayerSnapshot, next: PlayerSnapshot): boolean {
  const a = prev.transition, b = next.transition;
  if (b?.active || a?.active !== b?.active || a?.planId !== b?.planId || a?.fallback !== b?.fallback) return false;
  return (Object.keys(next) as (keyof PlayerSnapshot)[]).every((k) => CLOCK.has(k) || prev[k] === next[k]);
}

/**
 * Passes player snapshots on, but clock-only ticks at most every `ms` (the latest one always
 * arrives, via a trailing call). Real changes go through at once. While `hidden()` (locked screen,
 * app in the background) clock-only ticks are dropped: the caller pushes the latest state on return.
 */
export function throttleClock(push: (s: PlayerSnapshot) => void, latest: () => PlayerSnapshot, ms: number, hidden: () => boolean = () => false) {
  let prev: PlayerSnapshot | null = null, at = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const send = (s: PlayerSnapshot) => {
    if (trailing) { clearTimeout(trailing); trailing = null; }
    prev = s; at = performance.now();
    push(s);
  };
  return (s: PlayerSnapshot) => {
    if (prev && hidden() && clockOnly(prev, s)) return;
    if (!prev || performance.now() - at >= ms || !clockOnly(prev, s)) return send(s);
    trailing ??= setTimeout(() => send(latest()), ms - (performance.now() - at));
  };
}
