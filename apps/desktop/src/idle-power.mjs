// Library-wide (background) analysis may run only while the computer is idle and on mains power.
// The backend decides with the listener's setting; the current and next tracks are analyzed regardless.

/** No keyboard or mouse input for this long counts as idle. */
export const IDLE_SECONDS = 120;
// getSystemIdleTime has no event: poll it
const POLL_MS = 30_000;
const EVENTS = ['on-ac', 'on-battery', 'resume', 'lock-screen', 'unlock-screen'];

/** { idle, onBattery } from Electron's powerMonitor. */
export function powerState(pm, idleSeconds = IDLE_SECONDS) {
  return { idle: pm.getSystemIdleTime() >= idleSeconds, onBattery: pm.isOnBatteryPower() };
}

/** Sends the state now and on every change; `resend()` repeats it to a restarted backend. */
export function watchPower(pm, send, { pollMs = POLL_MS, idleSeconds = IDLE_SECONDS } = {}) {
  let last = '';
  const check = () => {
    let s;
    try { s = powerState(pm, idleSeconds); } catch { return; }
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    send(s);
  };
  for (const e of EVENTS) pm.on(e, check);
  const timer = setInterval(check, pollMs);
  timer.unref?.();
  check();
  return {
    resend() { last = ''; check(); },
    stop() { clearInterval(timer); for (const e of EVENTS) pm.removeListener(e, check); },
  };
}
