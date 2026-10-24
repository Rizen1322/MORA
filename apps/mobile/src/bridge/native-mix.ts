import type { NativeMix, NativeMixConfig, NativeMixState } from '../../../web/src/lib/native-mix.ts';
export interface NativeMixPort {
  nativeMixBegin(): Promise<{ id: string }>;
  nativeMixAppend(o: { id: string; track: number; offset: number; base64: string }): Promise<void>;
  nativeMixStart(o: { id: string; config: NativeMixConfig }): Promise<NativeMixState>;
  nativeMixStop(): Promise<void>;
  nativeMixState(): Promise<NativeMixState>;
  nativeMixCommand(o: { action: string; seekTime?: number }): Promise<NativeMixState>;
}
export function createNativeMix(port: NativeMixPort, hooks: { prepare(): Promise<void>; restore(): void }): NativeMix {
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  return {
    start: prepare => serialize(async () => {
      try {
        await hooks.prepare();
        const { id } = await port.nativeMixBegin();
        const config = await prepare(async (track, offset, bytes) => {
          const data = new Uint8Array(bytes);
          let text = '';
          for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
          await port.nativeMixAppend({ id, track, offset, base64: btoa(text) });
        });
        return await port.nativeMixStart({ id, config });
      } catch (error) {
        await port.nativeMixStop(); hooks.restore(); throw error;
      }
    }),
    stop: () => serialize(async () => { await port.nativeMixStop(); hooks.restore(); }),
    state: () => port.nativeMixState(),
    async command(action, seekTime) {
      if (action === 'seekforward' || action === 'seekbackward') {
        const s = await port.nativeMixState();
        return port.nativeMixCommand({ action: 'seekto', seekTime: s.position + (action === 'seekforward' ? 10 : -10) });
      }
      return port.nativeMixCommand({ action, seekTime });
    },
  };
}
