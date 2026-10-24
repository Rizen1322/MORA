import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { Readable } from 'readable-stream';
import type { FromWorker, ToWorker } from '../../shared/protocol.ts';

/**
 * The part of Fastify the server routes use, without sockets: requests arrive as
 * worker messages, replies go back as head/chunk/end messages.
 */

type Handler = (req: Req, reply: Reply) => unknown;
type Hook = (req: Req, reply: Reply) => Promise<unknown> | unknown;
interface Route { method: string; parts: string[]; handler: Handler }

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 421: 'Misdirected Request', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

class RawRequest extends EventEmitter {
  destroyed = false;
}

class RawResponse extends EventEmitter {
  writableEnded = false;
  writableLength = 0;
  destroyed = false;
  headersSent = false;
  constructor(private reply: Reply) { super(); }
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.reply.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.reply.header(k, v);
    this.reply.flushHead();
    return this;
  }
  write(chunk: string | Uint8Array): boolean {
    if (this.destroyed || this.writableEnded) return false;
    this.reply.flushHead();
    this.reply.chunk(chunk);
    return true;
  }
  end(chunk?: string | Uint8Array): void {
    if (this.writableEnded) return;
    if (chunk !== undefined) this.write(chunk);
    this.reply.flushHead();
    this.writableEnded = true;
    this.reply.finish();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.writableEnded) { this.writableEnded = true; this.reply.finish(); }
  }
}

export class Req {
  raw = new RawRequest();
  log = { warn: (...a: unknown[]) => console.warn(...a), info() {}, error: (...a: unknown[]) => console.error(...a), debug() {} };
  params: Record<string, string> = {};
  constructor(readonly method: string, readonly url: string, readonly headers: Record<string, string>, readonly query: Record<string, string>, public body: unknown) {}
}

export class Reply {
  statusCode = 200;
  sent = false;
  private headers: Record<string, string> = {};
  private headSent = false;
  private ended = false;
  raw: RawResponse;
  constructor(private id: number, private post: (m: FromWorker, t?: Transferable[]) => void, private onSendHooks: Hook[], private req: Req) {
    this.raw = new RawResponse(this);
  }
  code(n: number): this { this.statusCode = n; return this; }
  status(n: number): this { return this.code(n); }
  header(k: string, v: string | number): this { this.headers[k.toLowerCase()] = String(v); return this; }
  headers_(): Record<string, string> { return this.headers; }
  getHeader(k: string): string | undefined { return this.headers[k.toLowerCase()]; }
  type(t: string): this { return this.header('content-type', t); }
  flushHead(): void {
    if (this.headSent) return;
    this.headSent = true;
    this.raw.headersSent = true;
    this.post({ t: 'head', id: this.id, status: this.statusCode, headers: this.headers });
  }
  chunk(c: string | Uint8Array): void {
    if (this.ended) return;
    if (typeof c === 'string') { this.post({ t: 'chunk', id: this.id, data: c }); return; }
    const copy = c.slice().buffer as ArrayBuffer;
    this.post({ t: 'chunk', id: this.id, data: copy }, [copy]);
  }
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.post({ t: 'end', id: this.id });
    this.raw.emit('finish');
    this.raw.emit('close');
  }
  /** Client went away: what a closed socket looks like to the routes. */
  abort(): void {
    this.ended = true;
    this.raw.destroyed = true;
    this.req.raw.destroyed = true;
    this.req.raw.emit('close');
    this.raw.emit('close');
  }
  send(payload?: unknown): this {
    if (this.sent) return this;
    this.sent = true;
    void this.deliver(payload);
    return this;
  }
  private async deliver(payload: unknown): Promise<void> {
    for (const h of this.onSendHooks) await h(this.req, this);
    if (payload instanceof Readable || (payload && typeof (payload as Readable).pipe === 'function' && typeof (payload as Readable).on === 'function')) {
      const s = payload as Readable;
      this.headers['content-type'] ??= 'application/octet-stream';
      this.flushHead();
      s.on('data', (c: Uint8Array | string) => this.chunk(c));
      s.once('end', () => this.finish());
      s.once('error', (e: Error) => { if (!this.ended) { this.ended = true; this.post({ t: 'fail', id: this.id, error: e.message }); } });
      this.raw.once('close', () => { if (!s.destroyed) s.destroy(); });
      return;
    }
    let body: string | Uint8Array | null = null;
    if (payload == null) body = null;
    else if (typeof payload === 'string') { body = payload; this.headers['content-type'] ??= 'text/plain; charset=utf-8'; }
    else if (payload instanceof Uint8Array) { body = payload; this.headers['content-type'] ??= 'application/octet-stream'; }
    else if (payload instanceof ArrayBuffer) { body = new Uint8Array(payload); this.headers['content-type'] ??= 'application/octet-stream'; }
    else { body = JSON.stringify(payload); this.headers['content-type'] ??= 'application/json; charset=utf-8'; }
    this.flushHead();
    if (body !== null && (typeof body === 'string' ? body.length : body.byteLength)) this.chunk(body);
    this.finish();
  }
  sendError(e: Error & { statusCode?: number; status?: number }): void {
    const status = e.statusCode ?? e.status ?? 500;
    this.statusCode = status >= 400 && status < 600 ? status : 500;
    if (this.statusCode >= 500) console.error('[server]', e);
    this.send({ statusCode: this.statusCode, error: STATUS_TEXT[this.statusCode] ?? 'Error', message: e.message });
  }
}

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean);
}

export class MiniFastify {
  private routes: Route[] = [];
  private onRequest: Hook[] = [];
  private onSend: Hook[] = [];
  private notFound: Handler | null = null;
  private active = new Map<number, Reply>();

  private add(method: string, path: string, a: unknown, b?: unknown): void {
    const handler = (typeof a === 'function' ? a : b ?? (a as { handler: Handler }).handler) as Handler;
    this.routes.push({ method, parts: splitPath(path), handler });
  }
  get(p: string, a: unknown, b?: unknown) { this.add('GET', p, a, b); }
  post(p: string, a: unknown, b?: unknown) { this.add('POST', p, a, b); }
  put(p: string, a: unknown, b?: unknown) { this.add('PUT', p, a, b); }
  delete(p: string, a: unknown, b?: unknown) { this.add('DELETE', p, a, b); }
  patch(p: string, a: unknown, b?: unknown) { this.add('PATCH', p, a, b); }
  addHook(name: string, fn: Hook) {
    if (name === 'onRequest') this.onRequest.push(fn);
    else if (name === 'onSend') this.onSend.push(fn);
  }
  addContentTypeParser() { /* bodies are parsed by content type below */ }
  setNotFoundHandler(fn: Handler) { this.notFound = fn; }
  async register() { /* static files are served by the WebView */ }
  async listen() { return ''; }
  async close() { for (const r of this.active.values()) r.abort(); }
  async ready() {}

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const segs = splitPath(path);
    const m = method === 'HEAD' ? 'GET' : method;
    for (const route of this.routes) {
      if (route.method !== m || route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const want = route.parts[i];
        if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(segs[i]);
        else if (want !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  abort(id: number): void {
    this.active.get(id)?.abort();
    this.active.delete(id);
  }

  async dispatch(msg: Extract<ToWorker, { t: 'req' }>, post: (m: FromWorker, t?: Transferable[]) => void): Promise<void> {
    const u = new URL(msg.url, 'http://localhost');
    const query: Record<string, string> = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const headers: Record<string, string> = { host: 'localhost', ...Object.fromEntries(Object.entries(msg.headers).map(([k, v]) => [k.toLowerCase(), v])) };
    delete headers.origin;
    const ct = headers['content-type'] ?? '';
    let body: unknown = undefined;
    if (msg.body != null) {
      if (ct.includes('application/json')) {
        const text = typeof msg.body === 'string' ? msg.body : msg.body instanceof Blob ? await msg.body.text() : new TextDecoder().decode(msg.body);
        try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      } else if (ct.includes('application/octet-stream')) {
        const blob = msg.body instanceof Blob ? msg.body : new Blob([msg.body]);
        body = blobStream(blob);
      } else body = typeof msg.body === 'string' ? msg.body : msg.body instanceof Blob ? await msg.body.text() : new TextDecoder().decode(msg.body);
    }
    const req = new Req(msg.method, u.pathname + u.search, headers, query, body);
    const reply = new Reply(msg.id, post, this.onSend, req);
    this.active.set(msg.id, reply);
    reply.raw.once('close', () => this.active.delete(msg.id));
    try {
      for (const h of this.onRequest) {
        await h(req, reply);
        if (reply.sent) return;
      }
      const hit = this.match(msg.method, u.pathname);
      if (!hit) {
        if (this.notFound) await this.notFound(req, reply);
        if (!reply.sent) reply.code(404).send({ error: 'не найдено' });
        return;
      }
      req.params = hit.params;
      const out = await hit.route.handler(req, reply);
      if (reply.sent || reply.raw.headersSent) return;
      if (out !== undefined) reply.send(out === reply ? undefined : out);
    } catch (e) {
      if (!reply.sent && !reply.raw.headersSent) reply.sendError(e as Error);
      else console.error('[server]', e);
    }
  }
}

function blobStream(blob: Blob): Readable {
  let at = 0;
  const CHUNK = 1 << 20;
  return new Readable({
    async read() {
      if (at >= blob.size) { this.push(null); return; }
      const part = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
      at += part.byteLength;
      this.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
    },
  });
}

let instance: MiniFastify | null = null;
export function current(): MiniFastify | null { return instance; }

export default function Fastify(): MiniFastify {
  instance = new MiniFastify();
  return instance;
}
