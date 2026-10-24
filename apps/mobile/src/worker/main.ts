import initSqlJs from 'sql.js';
import type { ToWorker } from '../shared/protocol.ts';
import { initFs, promises as fsp, settled } from './opfs-fs.ts';
import { provideSqlite, flushAll } from './shims/sqlite.ts';
import type { MiniFastify } from './shims/fastify.ts';
import { post, onRpcResult, outboundFetch } from './rpc.ts';
import { process } from './globals.ts';
import { registerNativeSources } from 'mora-server/native-sources';

/**
 * The in-app server: apps/server's createApp() running in a dedicated worker on
 * OPFS + sql.js, answering the page's /api requests over postMessage.
 */

const DATA = '/data';
const DB_FILE = `${DATA}/automix.sqlite`;

// Third-party sites go through native HTTP. The app's own bundled files (sql.js wasm) stay on the
// WebView fetch: native HTTP cannot load the capacitor:// scheme ("URL не поддерживается").
const bundledFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), self.location.href);
  return url.origin === self.location.origin ? bundledFetch(input, init) : outboundFetch(input, init);
}) as typeof fetch;

let app: MiniFastify | null = null;
let services: unknown = null;
declare const __MORA_DEV__: boolean;
const early: Extract<ToWorker, { t: 'req' }>[] = [];
let gotSecretKey!: (key: string | null) => void;
const secretKey = new Promise<string | null>((r) => (gotSecretKey = r));

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case 'req':
      if (app) void app.dispatch(m, post);
      else early.push(m);
      break;
    case 'abort': app?.abort(m.id); break;
    case 'rpc-res': onRpcResult(m); break;
    // dev builds only: inspect the running server from the page console (window.moraDebug)
    case 'debug' as never: {
      const d = m as unknown as { id: number; code: string };
      if (!__MORA_DEV__) break;
      Promise.resolve().then(() => new Function('s', d.code)(services)).then((v) => self.postMessage({ t: 'debug-res', id: d.id, v: JSON.parse(JSON.stringify(v ?? null)) }), (e) => self.postMessage({ t: 'debug-res', id: d.id, v: String(e) }));
      break;
    }
    case 'power': process.env.MORA_POWER_SAVER = m.saver ? '1' : ''; break;
    case 'secret-key': gotSecretKey(m.key); break;
    case 'lifecycle':
      if (m.state === 'background') {
        void flushAll().then(settled);
        // the player stores its queue position right after hiding: that save must reach disk too
        setTimeout(() => void flushAll().then(settled), 1000);
      }
      break;
  }
};

async function boot(): Promise<void> {
  await initFs();
  const SQL = await initSqlJs({ locateFile: (f: string) => new URL(f, self.location.href).href });
  let image: Uint8Array | null = null;
  try { image = await fsp.readFile(DB_FILE) as Uint8Array; } catch { image = null; }
  if (!image) {
    // a save interrupted between write and rename leaves only the temp image
    try { image = await fsp.readFile(`${DB_FILE}.saving`) as Uint8Array; } catch { image = null; }
  }
  provideSqlite(SQL, DB_FILE, image);
  // Provider tokens are sealed with the Keychain key, like the desktop's DPAPI key (read once by
  // providers/base.ts, which then removes it from the environment).
  const key = await secretKey;
  if (key) process.env.AUTOMIX_SECRET_KEY = key;
  const { createApp } = await import('mora-server/app');
  const { app: a, services: svc } = await createApp({
    dataDir: DATA,
    host: '127.0.0.1',
    port: 0,
    accessToken: null,
    webDist: '/app/web',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    stemsPython: null,
    stemsModels: null,
    ytdlp: 'in-app',
    ytdlpJsRuntime: null,
    ytdlpRuntimeIsElectron: false,
    analysisWorkers: 1,
    backgroundAnalysis: false,
    pcmCacheBytes: 384 * 1024 * 1024,
    // 16-bit with 6 dB of headroom: half the flash writes of float for every decoded track
    pcmCacheFormat: 's16le',
    stemsCacheBytes: 0,
  });
  // Static cover colours avoid continuously repainting the phone while playing.
  // Explicit graphics/motion preferences remain available in Settings.
  const { kvGet, kvSet } = await import('mora-server/db');
  const db = svc.db;
  const saved = kvGet<{ ui?: Record<string, unknown> }>(db, 'settings', {});
  if (!saved.ui?.graphics || !saved.ui?.motion) kvSet(db, 'settings', { ...saved, ui: { ...saved.ui, graphics: saved.ui?.graphics ?? 'canvas', motion: saved.ui?.motion ?? 'reduced' } });
  app = a as unknown as MiniFastify;
  services = svc;
  registerNativeSources(app, svc);
  post({ t: 'ready' });
  for (const m of early.splice(0)) void app.dispatch(m, post);
}

boot().catch((e) => {
  console.error('[server] boot', e);
  post({ t: 'boot-error', error: String((e as Error)?.stack ?? e) });
});
