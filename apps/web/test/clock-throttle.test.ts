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

it('drops clock ticks while hidden but still passes real changes', () => {
  vi.useFakeTimers();
  const base = { status: 'playing', index: 0, queue: [], position: 0, transition: null } as unknown as PlayerSnapshot;
  let latest = base, hidden = false;
  const seen: PlayerSnapshot[] = [];
  const tick = throttleClock((s) => seen.push(s), () => latest, 200, () => hidden);
  tick(latest);
  hidden = true;
  for (let i = 1; i <= 20; i++) { vi.advanceTimersByTime(250); tick(latest = { ...latest, position: i / 4 }); }
  expect(seen).toHaveLength(1);
  tick(latest = { ...latest, index: 1 });
  expect(seen.at(-1)?.index).toBe(1);
});

it('with no interval (desktop) passes every visible tick and drops hidden clock ticks', () => {
  vi.useFakeTimers();
  const base = { status: 'playing', index: 0, queue: [], position: 0, transition: null } as unknown as PlayerSnapshot;
  let latest = base, hidden = false;
  const seen: PlayerSnapshot[] = [];
  const tick = throttleClock((s) => seen.push(s), () => latest, 0, () => hidden);
  for (let i = 0; i < 5; i++) tick(latest = { ...latest, position: i / 20 });
  expect(seen.map((s) => s.position)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
  hidden = true;
  for (let i = 1; i <= 8; i++) { vi.advanceTimersByTime(250); tick(latest = { ...latest, position: 1 + i / 4 }); }
  expect(seen).toHaveLength(5);
  vi.runAllTimers();
  expect(seen).toHaveLength(5);
});
