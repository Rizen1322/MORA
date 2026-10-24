import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { IDLE_SECONDS, watchPower } from '../src/idle-power.mjs';

afterEach(() => { vi.useRealTimers(); });

function monitor() {
  const pm = Object.assign(new EventEmitter(), { idle: 0, battery: false,
    getSystemIdleTime() { return pm.idle; }, isOnBatteryPower() { return pm.battery; } });
  return pm;
}

it('reports idle and mains power changes to the backend, once per change', () => {
  vi.useFakeTimers();
  const pm = monitor(), sent: unknown[] = [];
  const watch = watchPower(pm, (s: unknown) => sent.push(s), { pollMs: 1000 });
  expect(sent).toEqual([{ idle: false, onBattery: false }]);
  vi.advanceTimersByTime(3000);
  expect(sent).toHaveLength(1);
  // idle time has no event: the poll notices it
  pm.idle = IDLE_SECONDS;
  vi.advanceTimersByTime(1000);
  expect(sent.at(-1)).toEqual({ idle: true, onBattery: false });
  // unplugging is reported at once
  pm.battery = true; pm.emit('on-battery');
  expect(sent.at(-1)).toEqual({ idle: true, onBattery: true });
  expect(sent).toHaveLength(3);
  // a restarted backend gets the current state again
  watch.resend();
  expect(sent).toHaveLength(4);
  watch.stop();
  pm.battery = false; pm.emit('on-ac'); vi.advanceTimersByTime(5000);
  expect(sent).toHaveLength(4);
});
