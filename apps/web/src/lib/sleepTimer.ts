import { create } from 'zustand';
import { controller } from '../store/app.ts';

/**
 * Sleep timer: a wall-clock deadline (so sleep/wake is handled: past the
 * deadline on wake means pause at once), the end of the current track (also
 * when AutoMix starts blending into the next one) or the end of the queue.
 * A soft fade, then Pause; the saved volume is restored but never raised.
 */
export type SleepMode = { kind: 'time'; until: number } | { kind: 'track'; entryId: string } | { kind: 'queue' };
export const useSleep = create<{ mode: SleepMode | null }>(() => ({ mode: null }));

const FADE_S = 8;
let fading = false;
/** When the blend into the next song began: the fade runs from there instead of cutting it. */
let blendFrom = 0;

function finish(): void {
  controller.pause();
  // Let the engine's own pause ramp finish before the fade gain returns to 1.
  setTimeout(() => controller.setFade(1), 300);
  fading = false;
  blendFrom = 0;
  useSleep.setState({ mode: null });
}

export function setSleep(mode: SleepMode | null): void {
  fading = false;
  blendFrom = 0;
  controller.setFade(1);
  useSleep.setState({ mode });
}

export const sleepMinutes = (min: number) => setSleep({ kind: 'time', until: Date.now() + min * 60_000 });
export const sleepEndOfTrack = () => { const e = controller.state.queue[controller.state.index]; if (e) setSleep({ kind: 'track', entryId: e.entryId }); };

/** Seconds left, or null when the mode has no fixed time. */
export function sleepLeft(mode: SleepMode | null): number | null {
  if (!mode) return null;
  const st = controller.state;
  if (mode.kind === 'time') return Math.max(0, (mode.until - Date.now()) / 1000);
  if (mode.kind === 'track') return st.queue[st.index]?.entryId === mode.entryId ? Math.max(0, st.duration - st.position) : 0;
  return null;
}

setInterval(() => {
  const mode = useSleep.getState().mode;
  const st = controller.state;
  if (!mode) return;
  if (st.status !== 'playing' && st.status !== 'buffering') { if (fading) { controller.setFade(1); fading = false; } return; }
  let left: number;
  if (mode.kind === 'time') left = (mode.until - Date.now()) / 1000;
  else if (mode.kind === 'track') {
    const cur = st.queue[st.index];
    // The blend into the next song counts as the end of this one.
    if (cur?.entryId !== mode.entryId || st.transition?.active) {
      blendFrom ||= Date.now();
      left = FADE_S - (Date.now() - blendFrom) / 1000;
    } else left = st.duration - st.position;
  } else {
    const last = st.index >= st.queue.length - 1;
    left = last ? st.duration - st.position : Infinity;
  }
  if (left <= 0.3) { finish(); return; }
  if (left <= FADE_S) { fading = true; controller.setFade(Math.max(0, left / FADE_S)); }
}, 250);
