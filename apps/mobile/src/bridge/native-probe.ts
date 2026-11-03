import type { NativeProbe, NativeProbeState } from '../../../web/src/lib/playback-trace.ts';

export interface NativeProbePort {
  nativeProbeStart(): Promise<NativeProbeState>;
  nativeProbeStop(): Promise<void>;
  nativeProbeState(): Promise<NativeProbeState>;
  nativeProbeCommand(o: { action: MediaSessionAction; seekTime?: number }): Promise<NativeProbeState>;
}
export function createNativeProbe(port: NativeProbePort, hooks: { prepare(): Promise<void>; restore(): void }): NativeProbe {
  let queue = Promise.resolve();
  let active = false;
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.then(() => {}, () => {});
    return next;
  };
  return {
    start: () => serialize(async () => {
      if (active) return port.nativeProbeState();
      try { await hooks.prepare(); const state = await port.nativeProbeStart(); active = state.active; return state; }
      catch (error) {
        // If native ownership cannot be released, keep WebKit muted until Stop succeeds.
        await port.nativeProbeStop(); active = false; hooks.restore(); throw error;
      }
    }),
    stop: () => serialize(async () => { await port.nativeProbeStop(); active = false; hooks.restore(); }),
    state: () => port.nativeProbeState(),
    command: (action, seekTime) => port.nativeProbeCommand({ action, seekTime }),
  };
}
