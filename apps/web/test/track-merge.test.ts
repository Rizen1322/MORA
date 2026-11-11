import { expect, it, vi } from 'vitest';
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
import { PlayerController } from '../src/audio/controller.ts';

it('keeps queue entry identity and playback position while redirecting merged tracks', () => {
  const player = new PlayerController(() => undefined, () => {});
  player.state = { ...player.state, queue: [{ entryId: 'entry', trackId: 'old', origin: 'user' }], index: 0, position: 12 };
  const slot = { trackId: 'old' };
  (player as any).slots = [slot, null];
  (player as any).nativeFiles.set('old', { file: 42, frames: 100 });
  player.remapTracks({ old: 'kept' });
  expect(player.state.queue[0]).toMatchObject({ entryId: 'entry', trackId: 'kept' });
  expect(player.state.position).toBe(12);
  expect(slot.trackId).toBe('kept');
  expect((player as any).nativeFiles.get('kept')).toEqual({ file: 42, frames: 100 });
});
