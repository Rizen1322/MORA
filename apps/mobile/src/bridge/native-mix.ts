import type { NativeMix, NativeMixConfig, NativeMixState, NativeMixTrack } from '../../../web/src/lib/native-mix.ts';
import type { NativePreparationManifest } from '@automix/core/native-preparation.ts';
export interface NativeMixPort {
  nativeMixBegin(): Promise<{ id: string }>;
  nativeMixAppend(o: { id: string; track: number; offset: number; base64: string }): Promise<void>;
  nativeMixStart(o: { id: string; config: NativeMixConfig }): Promise<NativeMixState>;
  nativeMixUpdate(o: { id: string; from: number; tracks: NativeMixTrack[] }): Promise<NativeMixState>;
  nativeMixSettings(o: Pick<NativeMixConfig, 'tone' | 'preDb' | 'playback' | 'volume'>): Promise<NativeMixState>;
  nativeMixStop(): Promise<void>;
  nativeMixState(): Promise<NativeMixState>;
  nativeMixCommand(o: { action: string; seekTime?: number }): Promise<NativeMixState>;
  nativeSourceReserve?(o: { id: string; count: number }): Promise<{ keys: number[] }>;
  nativeSourceAppend?(o: { id: string; key: number; offset: number; base64: string }): Promise<void>;
  nativePrepareQueue?(o: { id: string; manifest: NativePreparationManifest }): Promise<NativeMixState>;
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
  sources?: (entries: { trackId: string; entryId: string; file: number }[], previousId: string, signal?: AbortSignal) => Promise<Omit<NativePreparationManifest, 'from'>>;
  sourceFile?: (trackId: string, start: number, signal?: AbortSignal) => Promise<Response>;
  artwork?: (url: string) => Promise<Artwork | undefined> }): NativeMix {
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  let id: string | null = null, playing = false;
  const assets = new Map<string, number>();
  const release = async () => { id = null; playing = false; assets.clear(); await port.nativeMixStop(); hooks.restore(); };
  const session = async () => {
    if (id) return id;
    try {
      await hooks.prepare();
      id = (await port.nativeMixBegin()).id;
      return id;
    } catch (error) { await release(); throw error; }
  };
  return {
    prepareQueue: (from, entries, previousId, loopEntries = [], signal) => serialize(async () => {
      signal?.throwIfAborted();
      if (!id || !hooks.sources || !port.nativeSourceReserve || !port.nativeSourceAppend || !port.nativePrepareQueue) throw Error('Нативная подготовка очереди недоступна');
      const unique = [...new Map([...entries, ...loopEntries].map(e => [e.entryId, e])).values()];
      const { keys } = await port.nativeSourceReserve({ id, count: unique.length });
      signal?.throwIfAborted();
      const manifest = await hooks.sources(unique.map((entry, i) => ({ ...entry, file: keys[i] })), previousId, signal);
      for (const item of manifest.items) {
        signal?.throwIfAborted();
        if (item.source.kind !== 'upload') continue;
        const trackId = item.source.trackId;
        let key = assets.get(trackId);
        if (key === undefined) {
          key = item.file;
          if (!hooks.sourceFile) throw Error('Передача локального файла недоступна');
          let at = 0;
          for (;;) {
            signal?.throwIfAborted();
            const response = await hooks.sourceFile(trackId, at, signal);
            if (!response.ok) throw Error('Не удалось передать локальный файл');
            const total = Number(response.headers.get('X-Native-Length'));
            if (!Number.isSafeInteger(total) || total <= 0 || total > 128 * 1024 * 1024) throw Error('Неподдерживаемый размер локального файла');
            const bytes = new Uint8Array(await response.arrayBuffer());
            signal?.throwIfAborted();
            if (!bytes.length || bytes.length > 262144 || at + bytes.length > total) throw Error('Неполный локальный файл');
            let text = '';
            for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
            await port.nativeSourceAppend({ id, key, offset: at, base64: btoa(text) }); at += bytes.length;
            if (at === total) break;
          }
          assets.set(trackId, key);
        }
        item.source = { kind: 'local', file: key };
      }
      signal?.throwIfAborted();
      const items = new Map(manifest.items.map(item => [item.entryId, item]));
      const state = await port.nativePrepareQueue({ id, manifest: { ...manifest, from,
        items: entries.map(e => items.get(e.entryId)!), loopItems: loopEntries.map(e => items.get(e.entryId)!) } });
      const kept = new Set(manifest.items.flatMap(item => item.source.kind === 'local' ? [item.source.file] : []));
      for (const [trackId, key] of assets) if (!kept.has(key)) assets.delete(trackId);
      return state;
    }),
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
        assets.clear();
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
    settings: async (values) => { if (id) await port.nativeMixSettings(values); },
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
