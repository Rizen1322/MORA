import type { PlayContext } from '../audio/controller.ts';
import { controller, trackOf } from '../store/app.ts';
import { resumeStationOnline } from './radio.ts';

/**
 * The wave keeps playing without a network. Offline — the iPhone reports no network path, the browser says so,
 * or a song has waited for the network too long — «Моя волна», Yandex's wave and the online radio go on with
 * songs stored on this device, picked by the same wave settings (mood, diversity: the local wave picker).
 * When the network is back, the interrupted station takes over again from the next song by itself.
 */

/** A network song waiting this long means the network is too weak to count on. */
export const WEAK_MS = 12_000;
/** How long a weak network is treated as none before the online station is tried again. */
export const WEAK_HOLD_MS = 60_000;
const STATIONS = ['wave', 'yandex-wave', 'online-radio'];

let reported = false;
let weakUntil = 0, stuckSince = 0;
/** The station the offline wave stands in for, and the context it plays under. */
let held: { from: PlayContext; as: PlayContext } | null = null;

/** Plays without the network: a downloaded online song or a file of the library. */
export const playableOffline = (id: string) => {
  const t = trackOf(id);
  return !!t && t.status === 'ok' && (!!t.pinned || t.sourceKind !== 'remote');
};
export const offlineNow = () => reported || globalThis.navigator?.onLine === false || Date.now() < weakUntil;
/** The station the offline wave stands in for: the Home switch keeps showing it. */
export const heldStation = () => (held && controller.state.context === held.as ? held.from : null);

/** The iPhone's own network monitor (NativeShell.swift, NWPathMonitor). */
export function setNetworkOffline(offline: boolean): void {
  reported = offline;
  if (!offline) weakUntil = 0;
  check();
}

/** Starting Yandex's wave or the radio without a network: the device's wave now, the requested station later. */
export async function startOffline(kind: 'yandex' | 'online'): Promise<void> {
  controller.setOfflineOnly(true);
  await controller.startWave('own');
  const as = controller.state.context;
  if (as?.type === 'wave') held = { from: kind === 'yandex' ? { type: 'yandex-wave', label: 'Моя волна Яндекса' } : { type: 'online-radio', label: 'Онлайн-радио · Моя волна' }, as };
}

export function check(now = Date.now()): void {
  const s = controller.state, ctx = s.context, entry = s.queue[s.index];
  const station = !!ctx && STATIONS.includes(ctx.type);
  const stuck = station && (s.status === 'buffering' || s.status === 'loading') && !!entry && !playableOffline(entry.trackId);
  if (!stuck) stuckSince = 0;
  else if (!stuckSince) stuckSince = now;
  else if (now - stuckSince > WEAK_MS) { weakUntil = now + WEAK_HOLD_MS; stuckSince = 0; }
  const offline = reported || globalThis.navigator?.onLine === false || now < weakUntil;
  controller.setOfflineOnly(offline);
  if (held && ctx !== held.as) held = null; // the listener chose something else meanwhile
  if (offline) {
    if (held || !ctx || !station) return;
    const upcoming = s.queue.slice(s.index + 1);
    // The device's own wave only needs its next picks from the device; nothing queued has to go.
    if (ctx.type === 'wave' && upcoming.every((e) => playableOffline(e.trackId))) { if (stuck) void controller.nextTrack(); return; }
    const as: PlayContext = { type: 'wave', label: 'Моя волна · без сети' };
    held = { from: ctx, as };
    controller.continueAs(as, upcoming.filter((e) => playableOffline(e.trackId)).map((e) => e.trackId), 'wave', true);
    if (stuck) void controller.nextTrack();
    return;
  }
  if (!held) return;
  const { from } = held;
  held = null;
  if (from.type === 'online-radio') resumeStationOnline(from.label);
  else controller.continueAs(from, [], from.type === 'yandex-wave' ? 'yandex' : 'wave', true);
}

let watching = false;
export function watchNetwork(): void {
  if (watching) return;
  watching = true;
  controller.subscribe(() => check());
  globalThis.addEventListener?.('online', () => check());
  globalThis.addEventListener?.('offline', () => check());
  // A stuck song produces no further events: look again while it waits.
  setInterval(() => { if (controller.state.status === 'buffering' || controller.state.status === 'loading' || held) check(); }, 3000);
}
