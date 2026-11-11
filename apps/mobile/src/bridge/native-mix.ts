import type { NativeMix, NativeMixConfig, NativeMixState, NativeMixTrack, NativeQueueEntry, NativeSourceConfig, NativeMixSettings } from '../../../web/src/lib/native-mix.ts';
import type { NativePreparationManifest } from '@automix/core/native-preparation.ts';
export interface NativeMixPort {
  nativePrepareStart?(o: { id: string; item: NativePreparationManifest['items'][number]; config: NativeSourceConfig }): Promise<NativeMixState>;
  nativeMixBegin(): Promise<{ id: string; hasQueue?: boolean }>;
  nativeMixAppend(o: { id: string; track: number; offset: number; base64: string }): Promise<void>;
  nativeMixStart(o: { id: string; config: NativeMixConfig }): Promise<NativeMixState>;
  nativeMixUpdate(o: { id: string; from: number; tracks: NativeMixTrack[] }): Promise<NativeMixState>;
  nativeMixSettings(o: NativeMixSettings): Promise<NativeMixState>;
  nativeMixStop(): Promise<void>;
  nativeMixState(): Promise<NativeMixState>;
  nativeMixCommand(o: { action: string; seekTime?: number }): Promise<NativeMixState>;
  nativeSourceReserve?(o: { id: string; count: number }): Promise<{ keys: number[] }>;
  nativeSourceAppend?(o: { id: string; key: number; offset: number; base64: string }): Promise<void>;
  nativeSourceFromDownload?(o: { id: string; key: number; trackId: string }): Promise<{ found: boolean }>;
  nativePrepareQueue?(o: { id: string; manifest: NativePreparationManifest }): Promise<NativeMixState>;
  /** Swift computes band levels only while this is on. */
  nativeLevels?(o: { on: boolean }): Promise<void>;
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
  sources?: (entries: (NativeQueueEntry & { file: number })[], previousId: string, signal?: AbortSignal) => Promise<Omit<NativePreparationManifest, 'from'>>;
  sourceFile?: (trackId: string, start: number, signal?: AbortSignal) => Promise<Response>;
  artwork?: (url: string) => Promise<Artwork | undefined> }): NativeMix {
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const next = queue.then(work); queue = next.then(() => {}, () => {}); return next;
  };
  let id: string | null = null, playing = false;
  let pendingStart: NativeSourceConfig | undefined;
  const assets = new Map<string, number>();
  const release = async () => { id = null; playing = false; assets.clear(); await port.nativeMixStop(); hooks.restore(); };
  const session = async () => {
    if (id) return id;
    try {
      await hooks.prepare();
      const owner = await port.nativeMixBegin();
      id = owner.id; playing ||= owner.hasQueue === true;
      return id;
    } catch (error) { await release(); throw error; }
  };
  const sourceManifest = async (entries: NativeQueueEntry[], previousId: string, signal?: AbortSignal) => {
    if (!id || !hooks.sources || !port.nativeSourceReserve || !port.nativeSourceAppend) throw Error('Нативная подготовка очереди недоступна');
    const { keys } = await port.nativeSourceReserve({ id, count: entries.length });
    if (!Array.isArray(keys) || keys.length !== entries.length || new Set(keys).size !== keys.length
      || keys.some(key => !Number.isSafeInteger(key) || key < 0 || key >= 500000)) throw Error('Некорректные файлы нативной очереди');
    signal?.throwIfAborted();
    const manifest = await hooks.sources(entries.map((entry, i) => ({ ...entry, file: keys[i] })), previousId, signal);
    // Unavailable entries are dropped by the server: items are an in-order subset of entries, matched by entryId.
    const at = new Map(entries.map((entry, i) => [entry.entryId, i]));
    let last = -1;
    if (!Array.isArray(manifest.items) || manifest.items.length > entries.length || manifest.items.some(item => {
      const i = at.get(item.entryId);
      if (i === undefined || i <= last || item.trackId !== entries[i].trackId || item.file !== keys[i]) return true;
      last = i; return false;
    })) throw Error('Изменилась запись для воспроизведения');
    for (const item of manifest.items) {
      signal?.throwIfAborted();
      if (item.source.kind !== 'upload') continue;
      const trackId = item.source.trackId;
      let key = assets.get(trackId);
      if (key === undefined) {
        key = item.file;
        if (port.nativeSourceFromDownload && (await port.nativeSourceFromDownload({ id, key, trackId })).found) {
          assets.set(trackId, key);
          item.source = { kind: 'local', file: key };
          continue;
        }
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
    return manifest;
  };
  // MoraAudio's overloaded addListener cannot join NativeMixPort's type; the Capacitor proxy has it at runtime.
  const addListener = (port as { addListener?: (ev: 'levels', fn: (e: { rms: number; bands: number[] }) => void) => Promise<{ remove(): Promise<void> }> }).addListener?.bind(port);
  const levelListeners = new Set<(e: { rms: number; bands: number[] }) => void>();
  let levelHandle: Promise<{ remove(): Promise<void> }> | undefined;
  return {
    ...(addListener && port.nativeLevels ? {
      // One plugin listener serves all subscribers; Swift computes nothing while none is subscribed.
      onLevels: (cb: (e: { rms: number; bands: number[] }) => void) => {
        levelListeners.add(cb);
        if (!levelHandle) {
          levelHandle = addListener!('levels', e => levelListeners.forEach(fn => fn(e)));
          void port.nativeLevels!({ on: true }).catch(() => {});
        }
        return () => {
          if (!levelListeners.delete(cb) || levelListeners.size) return;
          const handle = levelHandle; levelHandle = undefined;
          void port.nativeLevels!({ on: false }).catch(() => {});
          void handle?.then(h => h.remove()).catch(() => {});
        };
      },
    } : {}),
    ...(port.nativePrepareStart && hooks.sources && port.nativeSourceReserve && port.nativeSourceAppend ? {
      startSource: (entry: NativeQueueEntry, config: NativeSourceConfig, signal?: AbortSignal) => {
        const intent = { ...config }; pendingStart = intent;
        return serialize(async () => {
          const cancel = () => { if (id) void port.nativeMixStop().catch(() => {}); };
          let acquired = false;
          try {
            signal?.throwIfAborted();
            signal?.addEventListener('abort', cancel, { once: true });
            const current = await session();
            acquired = true;
            signal?.throwIfAborted();
            const manifest = await sourceManifest([entry], entry.trackId, signal);
            const item = manifest.items[0];
            if (!item || item.entryId !== entry.entryId || item.trackId !== entry.trackId) throw Error('Изменилась запись для воспроизведения');
            const state = await port.nativePrepareStart!({ id: current, item, config: intent });
            signal?.throwIfAborted();
            assets.clear(); playing = true;
            return state;
          } catch (error) {
            if (acquired && (!playing || signal?.aborted)) await release();
            throw error;
          } finally {
            signal?.removeEventListener('abort', cancel);
            if (pendingStart === intent) pendingStart = undefined;
          }
        });
      },
    } : {}),
    prepareQueue: (from, entries, previousId, loopEntries = [], signal, replaceFuture = false) => serialize(async () => {
      signal?.throwIfAborted();
      if (!hooks.sources || !port.nativeSourceReserve || !port.nativeSourceAppend || !port.nativePrepareQueue) throw Error('Нативная подготовка очереди недоступна');
      if (!id) {
        if (!(await port.nativeMixState()).active) throw Error('Нативное воспроизведение не запущено');
        await session(); // Rebind the existing owner after WebContent reload; begin is idempotent.
      }
      if (!id) throw Error('Нативная сессия недоступна');
      const entryKey = (entry: NativeQueueEntry) => entry.entryId;
      const unique = [...new Map([...entries, ...loopEntries].map(e => [entryKey(e), e])).values()];
      if (unique.length > 10000) throw Error('В очереди больше 10000 треков');
      const items = new Map<string, NativePreparationManifest['items'][number]>();
      let state: NativeMixState | undefined;
      let metadataBytes = 0;
      // shortcut: local sources retain the native 512 MiB upload budget; use shared native storage for larger offline handoffs.
      // Give native the next two songs before resolving/copying the rest of a large likes list.
      for (let offset = 0; offset < Math.max(1, unique.length);) {
        const batch = unique.slice(offset, offset + (offset === 0 ? 2 : 32));
        const before = new Set(assets.keys());
        let manifest: Awaited<ReturnType<typeof sourceManifest>>;
        try { manifest = await sourceManifest(batch, previousId, signal); }
        catch (error) { for (const key of assets.keys()) if (!before.has(key)) assets.delete(key); throw error; }
        signal?.throwIfAborted();
        for (const item of manifest.items) {
          // Keep the original whole-manifest metadata budget across source batches.
          const size = item.analysis ? JSON.stringify(item.analysis).length : 0;
          if (metadataBytes + size <= 2 * 1024 * 1024) metadataBytes += size;
          else item.analysis = null;
          const cover = item.artwork?.base64.length ?? 0;
          if (metadataBytes + cover <= 4 * 1024 * 1024) metadataBytes += cover;
          else delete item.artwork;
          items.set(item.entryId, item);
        }
        state = await port.nativePrepareQueue({ id, manifest: { ...manifest, from, replaceFuture,
          retainedSources: offset + batch.length < unique.length ? [...assets.values()] : [],
          items: entries.flatMap(e => items.get(entryKey(e)) ?? []), loopItems: loopEntries.flatMap(e => items.get(entryKey(e)) ?? []) } });
        offset += Math.max(1, batch.length);
      }
      const dropped = unique.filter(e => !items.has(entryKey(e))).map(entryKey);
      const kept = new Set([...items.values()].flatMap(item => item.source.kind === 'local' ? [item.source.file] : []));
      for (const [trackId, key] of assets) if (!kept.has(key)) assets.delete(trackId);
      return dropped.length ? { ...state!, dropped } : state!;
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
    settings: async (values) => { if (pendingStart) Object.assign(pendingStart, values); if (id) await port.nativeMixSettings(values); },
    stop: () => serialize(release),
    state: () => port.nativeMixState(),
    async command(action, seekTime) {
      if (pendingStart && (action === 'pause' || action === 'play')) pendingStart.paused = action === 'pause';
      if (action === 'seekforward' || action === 'seekbackward') {
        const s = await port.nativeMixState();
        return port.nativeMixCommand({ action: 'seekto', seekTime: s.position + (action === 'seekforward' ? 10 : -10) });
      }
      return port.nativeMixCommand({ action, seekTime });
    },
  };
}
