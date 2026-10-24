import type { DecodeArgs, DecodedPlanes, DecodeResult, FetchArgs, FetchResult, FromWorker, ToWorker } from '../shared/protocol.ts';

/** Calls into the page: native HTTP and audio decoding only exist there. */
let next = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function post(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

export function onRpcResult(msg: Extract<ToWorker, { t: 'rpc-res' }>): void {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.value);
  else p.reject(new Error(msg.error));
}

function call<T>(op: 'fetch' | 'decode', args: FetchArgs | DecodeArgs, transfer: Transferable[], signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const id = next++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      post({ t: 'rpc-abort', id });
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v as T); },
      reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
    });
    post({ t: 'rpc', id, op, args } as FromWorker, transfer);
  });
}

export function nativeFetchRaw(args: FetchArgs, signal?: AbortSignal): Promise<FetchResult> {
  return call<FetchResult>('fetch', args, args.body instanceof ArrayBuffer ? [args.body] : [], signal);
}

export async function decodeAudio(args: DecodeArgs, signal?: AbortSignal): Promise<DecodeResult> {
  const r = await decodePlanes(args, signal);
  return { pcm: interleave(r.planes.map((p) => new Float32Array(p)), args.format), sourceRate: r.sourceRate, duration: r.duration };
}

/** The page's channel planes as they are: the analyzer reads L/R itself, an interleaved copy only costs memory. */
export function decodePlanes(args: DecodeArgs, signal?: AbortSignal): Promise<DecodedPlanes> {
  return call<DecodedPlanes>('decode', args, [args.bytes], signal);
}

/** Channel planes → interleaved f32le or s16le, as ffmpeg writes it. */
export function interleave(planes: Float32Array[], format: 'f32le' | 's16le'): ArrayBuffer {
  const ch = planes.length, n = planes[0]?.length ?? 0;
  if (format === 'f32le') {
    const out = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) { const p = planes[c]; for (let i = 0; i < n; i++) out[i * ch + c] = p[i]; }
    return out.buffer;
  }
  const out = new Int16Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const p = planes[c];
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, p[i])); out[i * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  }
  return out.buffer;
}

const plainHeaders = (h: HeadersInit | undefined): Record<string, string> => {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h } as Record<string, string>;
};

/**
 * fetch() for the server code: goes out through the page (CapacitorHttp on iOS,
 * the dev proxy in a browser), so third-party sites need no CORS.
 */
export async function outboundFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let url: string, method = init.method ?? 'GET', headers = plainHeaders(init.headers), body: string | ArrayBuffer | null = null;
  if (input instanceof Request) {
    url = input.url;
    method = init.method ?? input.method;
    // A Request drops "forbidden" headers like User-Agent; youtubei.js passes the real ones in init.
    headers = { ...plainHeaders(input.headers), ...plainHeaders(init.headers) };
    if (init.body === undefined && !['GET', 'HEAD'].includes(input.method)) body = await input.clone().arrayBuffer();
  } else url = String(input);
  const b = init.body;
  if (b != null) {
    if (typeof b === 'string') body = b;
    else if (b instanceof ArrayBuffer) body = b.slice(0);
    else if (ArrayBuffer.isView(b)) body = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    else if (b instanceof URLSearchParams) { body = b.toString(); headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'; }
    else if (b instanceof Blob) body = await b.arrayBuffer();
    else body = String(b);
  }
  const r = await nativeFetchRaw({ url, method, headers, body }, init.signal ?? undefined);
  const noBody = r.status === 204 || r.status === 304 || method === 'HEAD';
  const res = new Response(noBody ? null : r.body, { status: r.status, headers: r.headers });
  Object.defineProperty(res, 'url', { value: r.url || url });
  return res;
}
