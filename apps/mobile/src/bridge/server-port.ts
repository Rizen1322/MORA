import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FromWorker, ToWorker } from '../shared/protocol.ts';

/**
 * Where the page's /api requests go: the server worker in this WebView, or apps/server in the
 * app process (ios/App/App/NativeServer.swift) once the library has moved there. Both speak the
 * worker protocol of ../shared/protocol.ts.
 */
export interface ServerPort {
  post(m: ToWorker, transfer?: Transferable[]): void;
  listen(onMessage: (m: FromWorker) => void, onError: (text: string) => void): void;
}

export function workerPort(): ServerPort {
  const w = new Worker(new URL('./server-worker.js', document.baseURI));
  return {
    post: (m, transfer = []) => w.postMessage(m, transfer),
    listen: (onMessage, onError) => { w.onmessage = (e) => onMessage(e.data); w.onerror = (e) => onError(e.message); },
  };
}

interface NativeServer {
  serverStatus(): Promise<{ ready: boolean }>;
  serverImportReset(): Promise<void>;
  serverImport(o: { path: string; offset: number; data: string }): Promise<void>;
  serverImportDone(): Promise<void>;
  serverStart(): Promise<void>;
  serverSend(o: { message: unknown }): Promise<void>;
  addListener(ev: 'server', fn: (m: unknown) => void): Promise<PluginListenerHandle>;
}
const Native = registerPlugin<NativeServer>('MoraAudio');

// Capacitor messages are JSON: binary parts travel as {"$b64": …} (NativeServerPlugin.swift).
const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
async function encode(v: unknown): Promise<unknown> {
  if (v instanceof ArrayBuffer) return { $b64: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof Blob) return { $b64: b64(new Uint8Array(await v.arrayBuffer())) };
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await encode(x)])));
  return v;
}
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$b64 === 'string' && Object.keys(o).length === 1) {
      const s = atob(o.$b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out.buffer;
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

/**
 * The app-process server, after moving the library out of OPFS on first use. null when that move
 * failed: OPFS is untouched, so the worker can go on with it. Once moved, there is no way back to the
 * worker (its copy would be stale): a failing start is an error.
 */
export async function nativePort(progress: (text: string | null) => void): Promise<ServerPort | null> {
  if (!(await Native.serverStatus()).ready) {
    try { await importFromOpfs(progress); } catch (e) { console.warn('[server] перенос медиатеки не удался, остаётся WebView', e); return null; }
  }
  const early: FromWorker[] = [];
  // until the page listens, messages wait (the server may answer before listen() is called)
  let onMessage: (m: FromWorker) => void = (m) => early.push(m);
  let onError: (text: string) => void = (text) => console.error('[server]', text);
  await Native.addListener('server', (m) => {
    const msg = decode(m) as FromWorker;
    if (msg.t === 'boot-error') onError(msg.error);
    else onMessage(msg);
  });
  await Native.serverStart();
  // Bodies may need an async read (Blob); a chain keeps messages in the order they were posted.
  let chain = Promise.resolve();
  return {
    post: (m) => { chain = chain.then(async () => Native.serverSend({ message: await encode(m) })).catch((e) => console.warn('[server]', e)); },
    listen: (m, e) => { onMessage = m; onError = e; for (const x of early.splice(0)) m(x); },
  };
}

const CHUNK = 4 << 20;
/**
 * Copies the worker's files from OPFS to the app (once). The decoded-PCM caches are left behind; the
 * originals stay in OPFS. Anything that fails leaves the app on the worker, with nothing changed.
 */
async function importFromOpfs(progress: (text: string | null) => void): Promise<void> {
  await Native.serverImportReset();
  let root: FileSystemDirectoryHandle | null = null;
  try { root = await (await navigator.storage.getDirectory()).getDirectoryHandle('mora'); } catch { root = null; }
  const files: { path: string; file: File }[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, at: string): Promise<void> => {
    for await (const [name, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      const path = `${at}/${name}`;
      // decoded PCM is found by scanning its folder (server pcmCache.ts) and the session cache is wiped at start: neither is library data
      if (h.kind === 'directory') { if (path !== '/data/cache/pcm' && path !== '/data/session-cache') await walk(h as FileSystemDirectoryHandle, path); }
      else files.push({ path, file: await (h as FileSystemFileHandle).getFile() });
    }
  };
  if (root) await walk(root, '');
  // A save interrupted between write and rename (worker/shims/sqlite.ts) leaves only the temp image.
  const db = '/data/automix.sqlite';
  const saving = files.find((f) => f.path === `${db}.saving`);
  if (saving && !files.some((f) => f.path === db)) saving.path = db;
  const copy = files.filter((f) => !f.path.endsWith('.saving'));
  const total = copy.reduce((n, f) => n + f.file.size, 0);
  let done = 0;
  try {
    for (const { path, file } of copy) {
      for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK) {
        const part = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
        await Native.serverImport({ path, offset, data: b64(part) });
        done += part.byteLength;
        if (total > CHUNK) progress(`Переносим медиатеку в приложение… ${Math.floor((done / total) * 100)}%`);
        if (!file.size) break;
      }
    }
    await Native.serverImportDone();
  } finally { progress(null); }
}
