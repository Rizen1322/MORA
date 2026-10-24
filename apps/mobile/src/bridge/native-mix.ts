import type { NativeMix, NativeMixConfig, NativeMixState } from '../../../web/src/lib/native-mix.ts';
export interface NativeMixPort {
  nativeMixBegin(): Promise<{ id: string }>;
  nativeMixAppend(o: { id: string; track: number; offset: number; base64: string }): Promise<void>;
  nativeMixStart(o: { id: string; config: NativeMixConfig }): Promise<NativeMixState>;
  nativeMixStop(): Promise<void>;
  nativeMixState(): Promise<NativeMixState>;
  nativeMixCommand(o: { action: string; seekTime?: number }): Promise<NativeMixState>;
}
type Artwork = NonNullable<NativeMixConfig['tracks'][number]['artwork']>;
export async function prepareNativeMixArtwork(config: NativeMixConfig, load?: (url: string) => Promise<Artwork | undefined>): Promise<NativeMixConfig> {
  const tracks = await Promise.all(config.tracks.map(async track => {
    const { coverUrl, artwork: _old, ...metadata } = track;
    let artwork: Artwork | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (coverUrl && load) artwork = await Promise.race([load(coverUrl), new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 8000);
      })]);
    } catch { /* Optional artwork must not prevent playback. */ }
    finally { if (timer) clearTimeout(timer); }
    if (!artwork || artwork.base64.length > 2800000 || !/^image\/(jpeg|png|webp)$/i.test(artwork.mime)) return metadata;
    return { ...metadata, artwork };
  }));
  return { ...config, tracks };
}
export function createNativeMix(port: NativeMixPort, hooks: { prepare(): Promise<void>; restore(): void;
  artwork?: (url: string) => Promise<Artwork | undefined> }): NativeMix {
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  return {
    start: (prepare, signal) => serialize(async () => {
      signal?.throwIfAborted();
      try {
        await hooks.prepare();
        const { id } = await port.nativeMixBegin();
        const config = await prepare(async (track, offset, bytes) => {
          const data = new Uint8Array(bytes);
          let text = '';
          for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
          await port.nativeMixAppend({ id, track, offset, base64: btoa(text) });
        });
        signal?.throwIfAborted();
        const nativeConfig = await prepareNativeMixArtwork(config, hooks.artwork);
        signal?.throwIfAborted();
        return await port.nativeMixStart({ id, config: nativeConfig });
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
