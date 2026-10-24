import type { DecodeArgs, DecodedPlanes, FetchArgs, FetchResult, FromWorker, ToWorker } from '../shared/protocol.ts';
import { isNative, nativeRequest, secretKey, setupNative } from './native.ts';

/**
 * Loaded before the web app. Starts the in-app server worker and routes every
 * /api request of apps/web to it: fetch, XMLHttpRequest (uploads), EventSource
 * and media/image src attributes. The worker in turn uses this page for audio
 * decoding and native HTTP.
 */

const worker = new Worker(new URL('./server-worker.js', document.baseURI));
let nextId = 1;

interface Pending {
  head: (status: number, headers: Record<string, string>) => void;
  chunk: (data: ArrayBuffer | string) => void;
  end: () => void;
  fail: (error: string) => void;
}
const pending = new Map<number, Pending>();
const rpcAborts = new Map<number, AbortController>();

let readyResolve!: () => void;
const ready = new Promise<void>((r) => (readyResolve = r));

const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
// the worker waits for it before opening the library
void secretKey().then((key) => send({ t: 'secret-key', key }));

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.t) {
    case 'ready': readyResolve(); break;
    case 'boot-error': showBootError(m.error); break;
    case 'head': pending.get(m.id)?.head(m.status, m.headers); break;
    case 'chunk': pending.get(m.id)?.chunk(m.data); break;
    case 'end': pending.get(m.id)?.end(); pending.delete(m.id); break;
    case 'fail': pending.get(m.id)?.fail(m.error); pending.delete(m.id); break;
    case 'rpc': void serveRpc(m); break;
    case 'rpc-abort': rpcAborts.get(m.id)?.abort(); rpcAborts.delete(m.id); break;
  }
};
worker.onerror = (e) => showBootError(e.message);

declare const __MORA_DEV__: boolean;
if (__MORA_DEV__) {
  let n = 0;
  const waits = new Map<number, (v: unknown) => void>();
  worker.addEventListener('message', (e) => { const d = e.data as { t: string; id: number; v: unknown }; if (d.t === 'debug-res') { waits.get(d.id)?.(d.v); waits.delete(d.id); } });
  (window as unknown as { moraDebug: (code: string) => Promise<unknown> }).moraDebug = (code) => new Promise((r) => { const id = ++n; waits.set(id, r); worker.postMessage({ t: 'debug', id, code }); });
}

function showBootError(text: string): void {
  console.error('[mora] server', text);
  const el = document.createElement('pre');
  el.className = 'mora-boot-error';
  el.textContent = `Не удалось запустить медиатеку:\n${text}`;
  document.body.append(el);
}

// ---------------------------------------------------------------- /api requests

const isApi = (url: string): boolean => {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/');
  } catch { return false; }
};
const pathOf = (url: string): string => { const u = new URL(url, location.href); return u.pathname + u.search; };

async function bodyOf(b: BodyInit | null | undefined): Promise<string | ArrayBuffer | Blob | null> {
  if (b == null) return null;
  if (typeof b === 'string' || b instanceof Blob || b instanceof ArrayBuffer) return b;
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  if (b instanceof URLSearchParams) return b.toString();
  return new Response(b).arrayBuffer();
}

/** One request to the worker, answered as a streaming Response. */
async function apiFetch(url: string, init: RequestInit = {}, headersIn: Headers = new Headers(init.headers)): Promise<Response> {
  await ready;
  const id = nextId++;
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  headersIn.forEach((v, k) => (headers[k] = v));
  const body = await bodyOf(init.body);
  return new Promise<Response>((resolve, reject) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let settled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => { controller = c; },
      cancel: () => { send({ t: 'abort', id }); pending.delete(id); },
    });
    const onAbort = () => {
      send({ t: 'abort', id });
      pending.delete(id);
      const err = signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      if (!settled) { settled = true; reject(err); } else { try { controller.error(err); } catch { /* closed */ } }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      head: (status, h) => {
        settled = true;
        const noBody = status === 204 || status === 304 || init.method === 'HEAD';
        resolve(new Response(noBody ? null : stream, { status, headers: h }));
      },
      chunk: (d) => { try { controller.enqueue(typeof d === 'string' ? enc.encode(d) : new Uint8Array(d)); } catch { /* reader left */ } },
      end: () => { signal?.removeEventListener('abort', onAbort); try { controller.close(); } catch { /* closed */ } },
      fail: (error) => {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) { settled = true; reject(new TypeError(`Failed to fetch: ${error}`)); } else { try { controller.error(new Error(error)); } catch { /* closed */ } }
      },
    });
    send({ t: 'req', id, method: (init.method ?? 'GET').toUpperCase(), url: pathOf(url), headers, body }, body instanceof ArrayBuffer ? [body] : []);
  });
}

const pageFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!isApi(url)) return pageFetch(input, init);
  if (input instanceof Request) {
    return apiFetch(url, { method: input.method, body: ['GET', 'HEAD'].includes(input.method) ? null : await input.arrayBuffer(), signal: input.signal, ...init }, new Headers(init?.headers ?? input.headers));
  }
  return apiFetch(url, init);
};

// XMLHttpRequest: apps/web uploads files with it (progress events).
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
const xhrAbort = XMLHttpRequest.prototype.abort;
type XhrState = { method: string; url: string; headers: Headers; abort?: AbortController; status: number; text: string; state: number };
const xhrs = new WeakMap<XMLHttpRequest, XhrState>();
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  if (isApi(String(url))) { xhrs.set(this, { method, url: String(url), headers: new Headers(), status: 0, text: '', state: 1 }); return; }
  xhrs.delete(this);
  return (xhrOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, k: string, v: string) {
  const s = xhrs.get(this);
  if (s) { s.headers.set(k, v); return; }
  return xhrSetHeader.call(this, k, v);
};
XMLHttpRequest.prototype.abort = function (this: XMLHttpRequest) {
  const s = xhrs.get(this);
  if (s) { s.abort?.abort(); return; }
  return xhrAbort.call(this);
};
for (const prop of ['status', 'responseText', 'readyState', 'response'] as const) {
  const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop)!;
  Object.defineProperty(XMLHttpRequest.prototype, prop, {
    configurable: true,
    get(this: XMLHttpRequest) {
      const s = xhrs.get(this);
      if (!s) return desc.get!.call(this);
      return prop === 'status' ? s.status : prop === 'readyState' ? s.state : s.text;
    },
  });
}
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const s = xhrs.get(this);
  if (!s) return xhrSend.call(this, body);
  s.abort = new AbortController();
  const fire = (type: string, target: EventTarget = this, init?: ProgressEventInit) => {
    const ev = new ProgressEvent(type, init);
    target.dispatchEvent(ev);
    const h = (target as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof h === 'function') h.call(target, ev);
  };
  const size = body instanceof Blob ? body.size : 0;
  void apiFetch(s.url, { method: s.method, body: body as BodyInit, signal: s.abort.signal }, s.headers)
    .then(async (res) => {
      // the copy into the worker is the upload: report it as complete
      if (size) fire('progress', this.upload, { lengthComputable: true, loaded: size, total: size });
      s.status = res.status;
      s.text = await res.text();
      s.state = 4;
      fire('readystatechange');
      fire('load');
      fire('loadend');
    })
    .catch((e) => {
      s.state = 4;
      fire('readystatechange');
      fire((e as Error).name === 'AbortError' ? 'abort' : 'error');
      fire('loadend');
    });
};

// EventSource for /api/events (server-sent events).
const NativeEventSource = window.EventSource;
class ApiEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly withCredentials = false;
  private ctl = new AbortController();
  constructor(readonly url: string) {
    super();
    void this.connect();
  }
  private emit(e: Event): void {
    this.dispatchEvent(e);
    const h = (this as unknown as Record<string, unknown>)[`on${e.type}`];
    if (typeof h === 'function') h.call(this, e);
  }
  private async connect(): Promise<void> {
    try {
      const res = await apiFetch(this.url, { signal: this.ctl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.readyState = 1;
      this.emit(new Event('open'));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (data) this.emit(new MessageEvent('message', { data }));
        }
      }
      throw new Error('closed');
    } catch {
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.emit(new Event('error'));
      setTimeout(() => { if (this.readyState !== 2) void this.connect(); }, 1500);
    }
  }
  close(): void {
    this.readyState = 2;
    this.ctl.abort();
  }
}
window.EventSource = function (url: string | URL, init?: EventSourceInit) {
  return isApi(String(url)) ? new ApiEventSource(String(url)) : new NativeEventSource(url, init);
} as unknown as typeof EventSource;

// <img src="/api/covers/…">, <audio src="/api/tracks/…/audio">: load through the worker as blob: URLs.
const blobUrls = new Map<string, Promise<string>>();
const MAX_BLOBS = 400;
function blobUrlFor(url: string): Promise<string> {
  const key = pathOf(url);
  let p = blobUrls.get(key);
  if (p) { blobUrls.delete(key); blobUrls.set(key, p); return p; }
  p = apiFetch(key).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  });
  p.catch(() => blobUrls.delete(key));
  blobUrls.set(key, p);
  while (blobUrls.size > MAX_BLOBS) {
    const [old, op] = blobUrls.entries().next().value!;
    blobUrls.delete(old);
    void op.then((u) => setTimeout(() => URL.revokeObjectURL(u), 30_000), () => {});
  }
  return p;
}

const wanted = new WeakMap<Element, string>();
function assignSrc(el: Element, value: string, set: (v: string) => void): void {
  wanted.set(el, value);
  blobUrlFor(value).then(
    (u) => { if (wanted.get(el) === value) set(u); },
    () => { if (wanted.get(el) === value) el.dispatchEvent(new Event('error')); },
  );
}
for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
  const desc = Object.getOwnPropertyDescriptor(proto, 'src')!;
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get(this: Element) { return wanted.get(this) ?? desc.get!.call(this); },
    set(this: Element, v: string) {
      const s = String(v);
      if (!isApi(s)) { wanted.delete(this); desc.set!.call(this, s); return; }
      assignSrc(this, s, (u) => desc.set!.call(this, u));
    },
  });
}
const setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
  if (name.toLowerCase() === 'src' && (this instanceof HTMLImageElement || this instanceof HTMLMediaElement || this instanceof HTMLSourceElement) && isApi(String(value))) {
    assignSrc(this, String(value), (u) => setAttr.call(this, 'src', u));
    return;
  }
  return setAttr.call(this, name, value);
};

// ---------------------------------------------------------------- services for the worker

async function serveRpc(m: Extract<FromWorker, { t: 'rpc' }>): Promise<void> {
  const ctl = new AbortController();
  rpcAborts.set(m.id, ctl);
  try {
    if (m.op === 'fetch') {
      const r = await outbound(m.args, ctl.signal);
      send({ t: 'rpc-res', id: m.id, ok: true, value: r }, [r.body]);
    } else {
      const r = await decode(m.args);
      send({ t: 'rpc-res', id: m.id, ok: true, value: r }, r.planes);
    }
  } catch (e) {
    send({ t: 'rpc-res', id: m.id, ok: false, error: (e as Error)?.message ?? String(e) });
  } finally { rpcAborts.delete(m.id); }
}

/** Third-party HTTP without CORS: native networking in the app, the dev server's proxy in a browser. */
async function outbound(a: FetchArgs, signal: AbortSignal): Promise<FetchResult> {
  if (isNative()) return nativeRequest(a, signal);
  const res = await pageFetch(`/__proxy?url=${encodeURIComponent(a.url)}`, {
    method: a.method,
    headers: { 'x-fwd-headers': JSON.stringify(a.headers) },
    body: a.body ?? undefined,
    signal,
  });
  if (res.status === 599) throw new Error(await res.text());
  return {
    status: Number(res.headers.get('x-fwd-status') ?? res.status),
    url: decodeURI(res.headers.get('x-fwd-url') ?? a.url),
    headers: JSON.parse(decodeURI(res.headers.get('x-fwd-headers') ?? '{}')),
    body: await res.arrayBuffer(),
  };
}

/** Whole-file decode with WebAudio; decoding into an OfflineAudioContext also resamples.
 * Only block copies here: the per-sample interleave runs in the worker, not on the UI thread. */
async function decode(a: DecodeArgs): Promise<DecodedPlanes> {
  const ctx = new OfflineAudioContext(a.channels, 1, a.sampleRate);
  const buf = await ctx.decodeAudioData(a.bytes);
  const planes = Array.from({ length: a.channels }, (_, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).slice().buffer);
  return { planes, sourceRate: buf.sampleRate, duration: buf.duration };
}

// ---------------------------------------------------------------- lifecycle

document.addEventListener('visibilitychange', () => {
  send({ t: 'lifecycle', state: document.hidden ? 'background' : 'foreground' });
});
window.addEventListener('pagehide', () => send({ t: 'lifecycle', state: 'background' }));

// iOS 17+: a playback session keeps WebAudio running with the screen locked (WebKit 261554).
const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
if (session) { try { session.type = 'playback'; } catch { /* older WebKit */ } }

void navigator.storage?.persist?.().catch(() => false);

document.documentElement.classList.add('mora-mobile');
if (isNative()) document.documentElement.classList.add('mora-native');
setupNative(apiFetch, (saver) => send({ t: 'power', saver }));
