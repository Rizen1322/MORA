import { afterEach, expect, it, vi } from 'vitest';
import type { PlayerSnapshot } from '../src/audio/controller.ts';
import { throttleClock } from '../src/lib/clockThrottle.ts';

afterEach(() => vi.useRealTimers());

it('thins clock ticks, delivers the last one, and passes real changes at once', () => {
  vi.useFakeTimers();
  const base = { status: 'playing', index: 0, queue: [], position: 0, transition: null } as unknown as PlayerSnapshot;
  let latest = base;
  const seen: PlayerSnapshot[] = [];
  const tick = throttleClock((s) => seen.push(s), () => latest, 200);
  tick(latest);
  for (let i = 1; i <= 4; i++) tick(latest = { ...latest, position: i / 20 });
  expect(seen.map((s) => s.position)).toEqual([0]);
  tick(latest = { ...latest, status: 'paused' });
  expect(seen.at(-1)?.status).toBe('paused');
  tick(latest = { ...latest, position: 1 });
  vi.advanceTimersByTime(200);
  expect(seen.at(-1)?.position).toBe(1);
  tick(latest = { ...latest, position: 1.05, transition: { active: true } as PlayerSnapshot['transition'] });
  expect(seen.at(-1)?.position).toBe(1.05);
});
