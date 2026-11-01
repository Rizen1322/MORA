import { describe, expect, it, vi } from 'vitest';
import { presentNativePlayer } from '../src/lib/native-player.ts';
import type { NativePlaybackControls } from '../src/lib/playback-trace.ts';

const controls = (presentPlayer?: NativePlaybackControls['presentPlayer'], mixActive = true): NativePlaybackControls =>
  ({ route: 'webkit', mixActive, presentPlayer, setRoute: async () => {} });
const settle = () => new Promise(r => setTimeout(r, 0));

describe('native full player hand-off', () => {
  it('keeps the web player without native playback or the plugin method', () => {
    const present = vi.fn(async () => ({ action: 'close' as const }));
    expect(presentNativePlayer(undefined, vi.fn())).toBe(false);
    expect(presentNativePlayer(controls(undefined), vi.fn())).toBe(false);
    expect(presentNativePlayer(controls(present, false), vi.fn())).toBe(false);
    expect(present).not.toHaveBeenCalled();
  });
  it('opens the web player only after «Ещё» or a native failure', async () => {
    for (const [present, opened] of [
      [async () => ({ action: 'close' as const }), 0],
      [async () => ({ action: 'more' as const }), 1],
      [async () => { throw Error('UNIMPLEMENTED'); }, 1],
      [() => { throw Error('sync'); }, 1],
    ] as const) {
      const showWeb = vi.fn();
      expect(presentNativePlayer(controls(present), showWeb)).toBe(true);
      expect(showWeb).not.toHaveBeenCalled();
      await settle();
      expect(showWeb).toHaveBeenCalledTimes(opened);
    }
  });
});
