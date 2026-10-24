import type { NativeMix, NativeMixConfig, NativeMixState, NativeMixTrack } from '../../../web/src/lib/native-mix.ts';
export interface NativeMixPort {
  nativeMixBegin(): Promise<{ id: string }>;
  nativeMixAppend(o: { id: string; track: number; offset: number; base64: string }): Promise<void>;
  nativeMixStart(o: { id: string; config: NativeMixConfig }): Promise<NativeMixState>;
  nativeMixUpdate(o: { id: string; from: number; tracks: NativeMixTrack[] }): Promise<NativeMixState>;
  nativeMixStop(): Promise<void>;
  nativeMixState(): Promise<NativeMixState>;
  nativeMixCommand(o: { action: string; seekTime?: number }): Promise<NativeMixState>;
}
type Artwork = NonNullable<NativeMixTrack['artwork']>;
export async function prepareNativeMixArtwork(tracks: NativeMixTrack[], load?: (url: string) => Promise<Artwork | undefined>): Promise<NativeMixTrack[]> {
  return Promise.all(tracks.map(async track => {
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
}
export function createNativeMix(port: NativeMixPort, hooks: { prepare(): Promise<void>; restore(): void;
  artwork?: (url: string) => Promise<Artwork | undefined> }): NativeMix {
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  let id: string | null = null, playing = false;
  const release = async () => { id = null; playing = false; await port.nativeMixStop(); hooks.restore(); };
  const session = async () => {
    if (id) return id;
    try {
      await hooks.prepare();
      id = (await port.nativeMixBegin()).id;
      return id;
    } catch (error) { await release(); throw error; }
  };
  return {
    upload: (file, offset, bytes, signal) => serialize(async () => {
      signal?.throwIfAborted();
      const data = new Uint8Array(bytes);
      let text = '';
      for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
      await port.nativeMixAppend({ id: await session(), track: file, offset, base64: btoa(text) });
    }),
    start: (config, signal) => serialize(async () => {
      signal?.throwIfAborted();
      const current = await session();
      try {
        const tracks = await prepareNativeMixArtwork(config.tracks, hooks.artwork);
        signal?.throwIfAborted();
        const state = await port.nativeMixStart({ id: current, config: { ...config, tracks } });
        playing = true;
        return state;
      } catch (error) {
        // A failed replacement keeps the queue already playing natively.
        if (!playing) await release();
        throw error;
      }
    }),
    update: (from, tracks) => serialize(async () => {
      if (!id) throw new Error('Native playback is not active');
      return port.nativeMixUpdate({ id, from, tracks: await prepareNativeMixArtwork(tracks, hooks.artwork) });
    }),
    stop: () => serialize(release),
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
