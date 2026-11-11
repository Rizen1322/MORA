import { Buffer } from 'buffer';
import { StringDecoder } from 'string_decoder';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { host } from './host.ts';

/**
 * The browser/worker globals apps/server and youtubei.js use, for bare JavaScriptCore, which has
 * only ECMAScript built-ins. Each one is installed only where missing. Keep to `g.X = …` here:
 * bare names like setTimeout are rewritten by the build's injected Node globals (../worker/globals.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const def = (name: string, value: unknown) => { if (g[name] === undefined) g[name] = value; };

// ---------------------------------------------------------------- worker scope

def('self', g);
def('location', { href: 'capacitor://localhost/server-worker.js', origin: 'capacitor://localhost', protocol: 'capacitor:', host: 'localhost', hostname: 'localhost', pathname: '/server-worker.js' });
def('postMessage', (message: unknown) => host.post(message));
/** Native → server: the page's messages and native replies, as a Web Worker would receive them. */
g.__moraReceive = (message: unknown) => g.onmessage?.({ data: message });

// ---------------------------------------------------------------- console, time

const show = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ? `${v.message}\n${v.stack}` : `${v.name}: ${v.message}`;
  try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? `<${x.byteLength} bytes>` : x)) ?? String(v); } catch { return String(v); }
};
const line = (level: 'debug' | 'info' | 'warn' | 'error') => (...a: unknown[]) => host.log(level, a.map(show).join(' '));
def('console', {
  log: line('info'), info: line('info'), debug: line('debug'), trace: line('debug'), warn: line('warn'), error: line('error'),
  table: line('info'), dir: line('info'), group: line('info'), groupCollapsed: line('info'), groupEnd: () => {},
  time: () => {}, timeEnd: () => {}, timeLog: () => {}, count: () => {}, assert: (ok: unknown, ...a: unknown[]) => { if (!ok) line('error')('Assertion failed', ...a); },
});

let nextTimer = 1;
const timers = new Map<number, { fn: (...a: unknown[]) => void; args: unknown[]; repeat: boolean }>();
g.__moraTimer = (id: number) => {
  const t = timers.get(id);
  if (!t) return;
  if (!t.repeat) timers.delete(id);
  t.fn(...t.args);
};
const arm = (repeat: boolean) => (fn: unknown, ms?: number, ...args: unknown[]) => {
  const id = nextTimer++;
  timers.set(id, { fn: typeof fn === 'function' ? fn as (...a: unknown[]) => void : new Function(String(fn)) as () => void, args, repeat });
  host.timer(id, Math.max(0, Number(ms) || 0), repeat);
  return id;
};
const disarm = (id: unknown) => { if (timers.delete(Number(id))) host.clearTimer(Number(id)); };
def('setTimeout', arm(false));
def('setInterval', arm(true));
def('clearTimeout', disarm);
def('clearInterval', disarm);
def('queueMicrotask', (fn: () => void) => { void Promise.resolve().then(fn); });
def('performance', { now: () => host.now(), timeOrigin: Date.now() - host.now(), mark: () => {}, measure: () => {} });

// ---------------------------------------------------------------- text, base64, cloning

class TextEncoderImpl {
  readonly encoding = 'utf-8';
  encode(s = ''): Uint8Array { const b = Buffer.from(String(s), 'utf8'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  encodeInto(s: string, dest: Uint8Array): { read: number; written: number } {
    const b = this.encode(s);
    const n = Math.min(b.byteLength, dest.byteLength);
    dest.set(b.subarray(0, n));
    return { read: n === b.byteLength ? s.length : Buffer.from(b.subarray(0, n)).toString('utf8').length, written: n };
  }
}
class TextDecoderImpl {
  readonly encoding: string;
  private dec: StringDecoder;
  private started = false;
  constructor(label = 'utf-8', private opts: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const l = label.toLowerCase();
    this.encoding = l === 'utf8' ? 'utf-8' : l === 'utf-16' ? 'utf-16le' : l === 'iso-8859-1' || l === 'ascii' || l === 'us-ascii' ? 'windows-1252' : l;
    const node = ({ 'utf-8': 'utf8', 'utf-16le': 'utf16le', 'windows-1252': 'latin1', latin1: 'latin1' } as Record<string, BufferEncoding>)[this.encoding];
    if (!node) throw new RangeError(`The "${label}" encoding is not supported`);
    this.dec = new StringDecoder(node);
  }
  get fatal() { return !!this.opts.fatal; }
  get ignoreBOM() { return !!this.opts.ignoreBOM; }
  decode(input?: ArrayBuffer | ArrayBufferView, o: { stream?: boolean } = {}): string {
    const bytes = input == null ? Buffer.alloc(0) : input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
    let s = this.dec.write(bytes);
    if (!o.stream) { s += this.dec.end(); }
    if (!this.started && s) {
      this.started = true;
      if (!this.ignoreBOM && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    }
    if (!o.stream) this.started = false;
    return s;
  }
}
def('TextEncoder', TextEncoderImpl);
def('TextDecoder', TextDecoderImpl);
def('btoa', (s: string) => Buffer.from(String(s), 'latin1').toString('base64'));
def('atob', (s: string) => Buffer.from(String(s).replace(/\s+/g, ''), 'base64').toString('latin1'));

const clone = (v: any, seen = new Map<any, any>()): any => {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (v instanceof ArrayBuffer) return v.slice(0);
  if (ArrayBuffer.isView(v)) { const C = (v as any).constructor; return new C(clone((v as any).buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), seen)); }
  if (v instanceof Map) { const m = new Map(); seen.set(v, m); for (const [k, x] of v) m.set(clone(k, seen), clone(x, seen)); return m; }
  if (v instanceof Set) { const s = new Set(); seen.set(v, s); for (const x of v) s.add(clone(x, seen)); return s; }
  if (typeof v === 'function') throw new (g.DOMException)('function could not be cloned', 'DataCloneError');
  const out: any = Array.isArray(v) ? [] : {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = clone(v[k], seen);
  return out;
};
def('structuredClone', (v: unknown) => clone(v));

// ---------------------------------------------------------------- crypto

const fill = <T extends ArrayBufferView>(view: T): T => {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  bytes.set(host.random(bytes.byteLength));
  return view;
};
const uuid = () => {
  const b = host.random(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const digests: Record<string, (d: Uint8Array) => Uint8Array> = { 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 };
def('crypto', {
  getRandomValues: fill,
  randomUUID: uuid,
  subtle: {
    async digest(alg: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
      const name = (typeof alg === 'string' ? alg : alg.name).toUpperCase();
      const fn = digests[name];
      if (!fn) throw new (g.DOMException)(`${name} не поддерживается`, 'NotSupportedError');
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return fn(bytes).slice().buffer;
    },
  },
});

// ---------------------------------------------------------------- events, abort

class DOMExceptionImpl extends Error {
  constructor(message = '', name = 'Error') { super(message); this.name = name; }
  get code(): number { return ({ AbortError: 20, TimeoutError: 23, NotSupportedError: 9, DataCloneError: 25 } as Record<string, number>)[this.name] ?? 0; }
}
def('DOMException', DOMExceptionImpl);

class EventImpl {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly timeStamp = Date.now();
  defaultPrevented = false;
  target: unknown = null;
  currentTarget: unknown = null;
  stopped = false;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() { this.stopped = true; }
}
class CustomEventImpl extends EventImpl {
  readonly detail: unknown;
  constructor(type: string, init: { detail?: unknown; bubbles?: boolean; cancelable?: boolean } = {}) { super(type, init); this.detail = init.detail ?? null; }
}
type Listener = { fn: any; once: boolean };
class EventTargetImpl {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: any, opts?: boolean | { once?: boolean; signal?: any }) {
    if (!fn) return;
    const list = this.listeners.get(type) ?? [];
    if (list.some((l) => l.fn === fn)) return;
    const o = typeof opts === 'object' ? opts : {};
    if (o.signal?.aborted) return;
    list.push({ fn, once: !!o.once });
    this.listeners.set(type, list);
    o.signal?.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
  }
  removeEventListener(type: string, fn: any) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev: EventImpl): boolean {
    if (ev.target == null) ev.target = this;
    ev.currentTarget = this;
    for (const l of [...(this.listeners.get(ev.type) ?? [])]) {
      if (l.once) this.removeEventListener(ev.type, l.fn);
      try { typeof l.fn === 'function' ? l.fn.call(this, ev) : l.fn.handleEvent(ev); } catch (e) { g.console.error(e); }
      if (ev.stopped) break;
    }
    return !ev.defaultPrevented;
  }
}
class AbortSignalImpl extends EventTargetImpl {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((ev: EventImpl) => void) | null = null;
  throwIfAborted() { if (this.aborted) throw this.reason; }
  _abort(reason?: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason === undefined ? new DOMExceptionImpl('This operation was aborted', 'AbortError') : reason;
    const ev = new EventImpl('abort');
    try { this.onabort?.call(this, ev); } catch (e) { g.console.error(e); }
    this.dispatchEvent(ev);
  }
  static abort(reason?: unknown) { const s = new AbortSignalImpl(); s._abort(reason); return s; }
  static timeout(ms: number) {
    const s = new AbortSignalImpl();
    g.setTimeout(() => s._abort(new DOMExceptionImpl('The operation timed out.', 'TimeoutError')), ms);
    return s;
  }
  static any(signals: AbortSignalImpl[]) {
    const s = new AbortSignalImpl();
    for (const x of signals) {
      if (x.aborted) { s._abort(x.reason); break; }
      x.addEventListener('abort', () => s._abort(x.reason), { once: true });
    }
    return s;
  }
}
class AbortControllerImpl {
  readonly signal = new AbortSignalImpl();
  abort(reason?: unknown) { this.signal._abort(reason); }
}
def('Event', EventImpl);
def('CustomEvent', CustomEventImpl);
def('EventTarget', EventTargetImpl);
def('AbortSignal', AbortSignalImpl);
def('AbortController', AbortControllerImpl);

// ---------------------------------------------------------------- URL

const SPECIAL: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21', 'file:': '' };
const pct = (set: RegExp) => (s: string) => s.replace(set, (c) => encodeURIComponent(c));
// characters each component must percent-encode (WHATWG encode sets, non-ASCII included)
const encPath = pct(/[^\x21-\x7e]|[ "#<>?`{}]/gu);
const encQuery = pct(/[^\x21-\x7e]|[ "#<>]/gu);
const encSpecialQuery = pct(/[^\x21-\x7e]|[ "#<>']/gu);
const encHash = pct(/[^\x21-\x7e]|[ "<>`]/gu);
const encUser = pct(/[^\x21-\x7e]|[ "#<>?`{}/:;=@[\\\]^|]/gu);

function dotless(path: string): string {
  const out: string[] = [];
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], last = i === segs.length - 1;
    if (s === '..' || s.toLowerCase() === '%2e%2e') { if (out.length > 1) out.pop(); if (last) out.push(''); }
    else if (s === '.' || s.toLowerCase() === '%2e') { if (last) out.push(''); }
    else out.push(s);
  }
  return out.join('/') || '/';
}

interface Parts { protocol: string; username: string; password: string; hostname: string; port: string; pathname: string; search: string; hash: string; opaque: boolean }

function parseURL(input: string, base?: Parts): Parts {
  let s = String(input).replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
  let hash = '', search = '';
  const hi = s.indexOf('#');
  if (hi >= 0) { hash = s.slice(hi); s = s.slice(0, hi); }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  let protocol: string, rest: string;
  if (scheme) { protocol = scheme[1].toLowerCase() + ':'; rest = s.slice(scheme[0].length); }
  else {
    if (!base) throw new TypeError(`Invalid URL: ${input}`);
    protocol = base.protocol; rest = s;
    if (base.opaque) {
      if (rest !== '') throw new TypeError(`Invalid URL: ${input}`);
      return { ...base, hash: hash ? encHash(hash) : '' };
    }
  }
  const special = protocol in SPECIAL;
  if (special) rest = rest.replace(/\\/g, '/');
  // a relative reference to a base with the same special scheme ("http:foo")
  const sameScheme = !!scheme && !!base && special && base.protocol === protocol && !rest.startsWith('/');
  const qi = rest.indexOf('?');
  if (qi >= 0) { search = rest.slice(qi); rest = rest.slice(0, qi); }
  const encS = special ? encSpecialQuery : encQuery;
  const finish = (p: Omit<Parts, 'search' | 'hash'>): Parts => ({ ...p, search: search.length > 1 ? encS(search) : '', hash: hash.length > 1 ? encHash(hash) : '' });

  if ((!scheme || sameScheme) && base) {
    const b = { protocol, username: base.username, password: base.password, hostname: base.hostname, port: base.port, opaque: false };
    if (rest.startsWith('//')) return finish(authority(protocol, rest.slice(2), special));
    if (rest.startsWith('/')) return finish({ ...b, pathname: dotless(encPath(rest)) });
    if (rest === '') return { ...b, pathname: base.pathname, search: qi >= 0 ? (search.length > 1 ? encS(search) : '') : base.search, hash: hash.length > 1 ? encHash(hash) : '' };
    const dir = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) || '/';
    return finish({ ...b, pathname: dotless(dir + encPath(rest)) });
  }
  // file:///path has an empty host: drop exactly the two slashes of "//", never the path's own
  if (rest.startsWith('//')) return finish(authority(protocol, protocol === 'file:' ? rest.slice(2) : rest.replace(/^\/*/, ''), special));
  if (special && protocol !== 'file:') return finish(authority(protocol, rest.replace(/^\/*/, ''), special));
  // opaque: data:, blob:, mailto:, javascript:
  return finish({ protocol, username: '', password: '', hostname: '', port: '', pathname: rest.replace(/[^\x20-\x7e]/gu, (c) => encodeURIComponent(c)), opaque: !rest.startsWith('/') });
}

function authority(protocol: string, rest: string, special: boolean): Omit<Parts, 'search' | 'hash'> {
  const end = rest.search(/\//);
  const auth = end < 0 ? rest : rest.slice(0, end);
  const path = end < 0 ? '' : rest.slice(end);
  const at = auth.lastIndexOf('@');
  const cred = at >= 0 ? auth.slice(0, at) : '';
  let hostport = at >= 0 ? auth.slice(at + 1) : auth;
  const ci = cred.indexOf(':');
  const username = encUser(ci >= 0 ? cred.slice(0, ci) : cred), password = ci >= 0 ? encUser(cred.slice(ci + 1)) : '';
  let port = '';
  const pm = /:(\d*)$/.exec(hostport);
  if (pm && !hostport.endsWith(']')) { port = pm[1]; hostport = hostport.slice(0, -pm[0].length); }
  if (port && Number(port) > 65535) throw new TypeError(`Invalid URL port: ${port}`);
  if (port) port = String(Number(port));
  if (port === SPECIAL[protocol]) port = '';
  let hostname = special ? decodeURIComponent(hostport).toLowerCase() : hostport;
  if (special && protocol !== 'file:' && !hostname) throw new TypeError(`Invalid URL: missing host`);
  if (/[\s#%/:<>?@[\\\]^|]/.test(hostname.replace(/^\[.*\]$/, ''))) throw new TypeError(`Invalid URL host: ${hostname}`);
  if (/[^\x00-\x7f]/.test(hostname)) hostname = hostname.normalize('NFC'); // shortcut: no punycode; non-ASCII hosts never reach the server
  return { protocol, username, password, hostname, port, pathname: special ? dotless(encPath(path || '/')) : encPath(path), opaque: false };
}

const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const formDecode = (s: string) => { const t = s.replace(/\+/g, ' '); try { return decodeURIComponent(t); } catch { return t.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))); } };

class URLSearchParamsImpl {
  private list: [string, string][] = [];
  _owner: URLImpl | null = null;
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParamsImpl) {
    if (init == null) return;
    if (typeof init === 'string') this._parse(init);
    else if (typeof (init as any)[Symbol.iterator] === 'function') for (const [k, v] of init as Iterable<[string, string]>) this.list.push([String(k), String(v)]);
    else for (const k of Object.keys(init)) this.list.push([k, String((init as Record<string, string>)[k])]);
  }
  _parse(s: string) {
    this.list = [];
    for (const part of s.replace(/^\?/, '').split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      this.list.push(i >= 0 ? [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))] : [formDecode(part), '']);
    }
  }
  private update() { if (this._owner) this._owner._setSearch(this.toString()); }
  get size() { return this.list.length; }
  append(k: string, v: string) { this.list.push([String(k), String(v)]); this.update(); }
  delete(k: string, v?: string) { this.list = this.list.filter(([a, b]) => a !== k || (v !== undefined && b !== String(v))); this.update(); }
  get(k: string) { return this.list.find(([a]) => a === k)?.[1] ?? null; }
  getAll(k: string) { return this.list.filter(([a]) => a === k).map(([, b]) => b); }
  has(k: string, v?: string) { return this.list.some(([a, b]) => a === k && (v === undefined || b === String(v))); }
  set(k: string, v: string) {
    const i = this.list.findIndex(([a]) => a === k);
    if (i < 0) this.list.push([String(k), String(v)]);
    else { this.list[i] = [String(k), String(v)]; this.list = this.list.filter(([a], j) => a !== k || j === i); }
    this.update();
  }
  sort() { this.list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this.update(); }
  forEach(fn: (v: string, k: string, p: this) => void, self?: unknown) { for (const [k, v] of [...this.list]) fn.call(self, v, k, this); }
  keys() { return this.list.map(([k]) => k)[Symbol.iterator](); }
  values() { return this.list.map(([, v]) => v)[Symbol.iterator](); }
  entries() { return this.list.map(([k, v]) => [k, v] as [string, string])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.list.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join('&'); }
}

class URLImpl {
  private p!: Parts;
  private params = new URLSearchParamsImpl();
  constructor(url: string | URLImpl, base?: string | URLImpl) {
    const b = base === undefined ? undefined : parseURL(String(base));
    this.p = parseURL(String(url), b);
    this.params._owner = this;
    this.params._parse(this.p.search);
  }
  static canParse(url: string, base?: string) { try { new URLImpl(url, base); return true; } catch { return false; } }
  _setSearch(q: string) { this.p.search = q ? `?${q}` : ''; }
  get protocol() { return this.p.protocol; }
  set protocol(v: string) { const s = String(v).replace(/:.*$/, '').toLowerCase() + ':'; if ((s in SPECIAL) === (this.p.protocol in SPECIAL)) { this.p.protocol = s; if (this.p.port === SPECIAL[s]) this.p.port = ''; } }
  get username() { return this.p.username; }
  set username(v: string) { this.p.username = encUser(String(v)); }
  get password() { return this.p.password; }
  set password(v: string) { this.p.password = encUser(String(v)); }
  get hostname() { return this.p.hostname; }
  set hostname(v: string) { if (!this.p.opaque) this.p.hostname = this.p.protocol in SPECIAL ? String(v).toLowerCase() : String(v); }
  get port() { return this.p.port; }
  set port(v: string) { const s = String(v).replace(/\D.*$/, ''); this.p.port = s === '' || s === SPECIAL[this.p.protocol] ? '' : String(Number(s)); }
  get host() { return this.p.port ? `${this.p.hostname}:${this.p.port}` : this.p.hostname; }
  set host(v: string) { const [h, port] = String(v).split(':'); this.hostname = h; if (port !== undefined) this.port = port; }
  get origin() { return this.p.protocol in SPECIAL && this.p.protocol !== 'file:' ? `${this.p.protocol}//${this.host}` : this.p.protocol === 'capacitor:' ? `capacitor://${this.host}` : 'null'; }
  get pathname() { return this.p.pathname; }
  set pathname(v: string) { if (this.p.opaque) return; const s = encPath(String(v)); this.p.pathname = this.p.protocol in SPECIAL ? dotless(s.startsWith('/') ? s : `/${s}`) : s; }
  get search() { return this.p.search.length > 1 ? this.p.search : ''; }
  set search(v: string) { const s = String(v).replace(/^\?/, ''); this.p.search = s ? (this.p.protocol in SPECIAL ? encSpecialQuery : encQuery)(`?${s}`) : ''; this.params._parse(this.p.search); }
  get searchParams() { return this.params; }
  get hash() { return this.p.hash.length > 1 ? this.p.hash : ''; }
  set hash(v: string) { const s = String(v).replace(/^#/, ''); this.p.hash = s ? encHash(`#${s}`) : ''; }
  get href() {
    const p = this.p;
    if (p.opaque) return `${p.protocol}${p.pathname}${p.search}${p.hash}`;
    const cred = p.username || p.password ? `${p.username}${p.password ? `:${p.password}` : ''}@` : '';
    const auth = p.hostname || p.protocol in SPECIAL ? `//${cred}${this.host}` : '';
    return `${p.protocol}${auth}${p.pathname}${p.search}${p.hash}`;
  }
  set href(v: string) { this.p = parseURL(String(v)); this.params._parse(this.p.search); }
  toString() { return this.href; }
  toJSON() { return this.href; }
}
def('URL', URLImpl);
def('URLSearchParams', URLSearchParamsImpl);

// ---------------------------------------------------------------- Blob, streams, fetch classes

type Bytes = Uint8Array;
const toBytes = (v: unknown): Bytes => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new TextEncoderImpl().encode(String(v));
};
const concat = (parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
};

class BlobImpl {
  readonly _bytes: Bytes;
  readonly type: string;
  constructor(parts: unknown[] = [], opts: { type?: string } = {}) {
    this._bytes = concat(parts.map((p) => (p instanceof BlobImpl ? p._bytes : toBytes(p))));
    this.type = (opts.type ?? '').toLowerCase();
  }
  get size() { return this._bytes.byteLength; }
  slice(start = 0, end = this.size, type = '') {
    const n = this.size, s = start < 0 ? Math.max(n + start, 0) : Math.min(start, n), e = end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
    return new BlobImpl([this._bytes.slice(s, Math.max(s, e))], { type });
  }
  async arrayBuffer() { return this._bytes.slice().buffer; }
  async bytes() { return this._bytes.slice(); }
  async text() { return new TextDecoderImpl().decode(this._bytes); }
  stream() { return bytesStream(this._bytes); }
}
class FileImpl extends BlobImpl {
  readonly name: string;
  readonly lastModified: number;
  constructor(parts: unknown[], name: string, opts: { type?: string; lastModified?: number } = {}) { super(parts, opts); this.name = String(name); this.lastModified = opts.lastModified ?? Date.now(); }
}
def('Blob', BlobImpl);
def('File', FileImpl);

/** Enough of ReadableStream for fetch bodies: a reader, async iteration and `tee`. */
class ReadableStreamImpl<T = Bytes> {
  private queue: T[] = [];
  private done = false;
  private failure: unknown = null;
  private waiting: ((v: void) => void) | null = null;
  private pulling = false;
  locked = false;
  constructor(private source: { start?: (c: any) => unknown; pull?: (c: any) => unknown; cancel?: (r?: unknown) => unknown } = {}) {
    void Promise.resolve(source.start?.(this.controller)).catch((e) => this.controller.error(e));
  }
  private wake() { const w = this.waiting; this.waiting = null; w?.(); }
  private controller = {
    enqueue: (chunk: T) => { if (!this.done) { this.queue.push(chunk); this.wake(); } },
    close: () => { this.done = true; this.wake(); },
    error: (e: unknown) => { this.failure = e ?? new Error('stream error'); this.done = true; this.queue = []; this.wake(); },
    get desiredSize() { return 1; },
  };
  async _read(): Promise<{ done: boolean; value?: T }> {
    for (;;) {
      if (this.queue.length) return { done: false, value: this.queue.shift() };
      if (this.failure) throw this.failure;
      if (this.done) return { done: true, value: undefined };
      if (this.source.pull && !this.pulling) {
        this.pulling = true;
        try { await this.source.pull(this.controller); } catch (e) { this.controller.error(e); } finally { this.pulling = false; }
        continue;
      }
      await new Promise<void>((r) => (this.waiting = r));
    }
  }
  async cancel(reason?: unknown) { this.done = true; this.queue = []; await this.source.cancel?.(reason); }
  getReader() {
    if (this.locked) throw new TypeError('ReadableStream is locked');
    this.locked = true;
    let released = false;
    return {
      read: () => (released ? Promise.reject(new TypeError('reader released')) : this._read()),
      releaseLock: () => { released = true; this.locked = false; },
      cancel: (r?: unknown) => this.cancel(r),
      closed: new Promise<void>(() => {}),
    };
  }
  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value as T; } } finally { reader.releaseLock(); }
  }
  tee(): [ReadableStreamImpl<T>, ReadableStreamImpl<T>] {
    const a: any[] = [], b: any[] = [];
    const reader = this.getReader();
    const make = (mine: any[], other: any[]) => new ReadableStreamImpl<T>({
      pull: async (c) => {
        if (!mine.length) { const r = await reader.read(); if (r.done) { mine.push(null); other.push(null); } else { mine.push(r.value); other.push(r.value); } }
        const v = mine.shift();
        if (v === null) c.close(); else c.enqueue(v);
      },
    });
    return [make(a, b), make(b, a)];
  }
}
function bytesStream(bytes: Bytes): ReadableStreamImpl<Bytes> {
  return new ReadableStreamImpl<Bytes>({ start: (c) => { if (bytes.byteLength) c.enqueue(bytes); c.close(); } });
}
def('ReadableStream', ReadableStreamImpl);

class HeadersImpl {
  private map = new Map<string, string>();
  private cookies: string[] = [];
  constructor(init?: HeadersImpl | [string, string][] | Record<string, string>) {
    if (!init) return;
    if (init instanceof HeadersImpl) init.forEach((v, k) => this.append(k, v));
    else if (Array.isArray(init) || typeof (init as any)[Symbol.iterator] === 'function') for (const [k, v] of init as [string, string][]) this.append(k, v);
    else for (const k of Object.keys(init)) this.append(k, (init as Record<string, string>)[k]);
  }
  append(k: string, v: string) {
    const key = String(k).toLowerCase(), val = String(v).trim();
    if (key === 'set-cookie') this.cookies.push(val);
    const old = this.map.get(key);
    this.map.set(key, old === undefined ? val : `${old}, ${val}`);
  }
  set(k: string, v: string) { const key = String(k).toLowerCase(); if (key === 'set-cookie') this.cookies = [String(v)]; this.map.set(key, String(v).trim()); }
  get(k: string) { return this.map.get(String(k).toLowerCase()) ?? null; }
  has(k: string) { return this.map.has(String(k).toLowerCase()); }
  delete(k: string) { const key = String(k).toLowerCase(); if (key === 'set-cookie') this.cookies = []; this.map.delete(key); }
  getSetCookie() { return [...this.cookies]; }
  forEach(fn: (v: string, k: string, h: this) => void, self?: unknown) { for (const [k, v] of this.entries()) fn.call(self, v, k, this); }
  *entries(): IterableIterator<[string, string]> { yield* [...this.map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
}
def('Headers', HeadersImpl);

class FormDataImpl {
  private list: [string, unknown][] = [];
  append(k: string, v: unknown) { this.list.push([String(k), v]); }
  set(k: string, v: unknown) { this.delete(k); this.append(k, v); }
  get(k: string) { return this.list.find(([a]) => a === k)?.[1] ?? null; }
  getAll(k: string) { return this.list.filter(([a]) => a === k).map(([, v]) => v); }
  has(k: string) { return this.list.some(([a]) => a === k); }
  delete(k: string) { this.list = this.list.filter(([a]) => a !== k); }
  *entries() { yield* this.list; }
  [Symbol.iterator]() { return this.entries(); }
}
def('FormData', FormDataImpl);

/** Request/Response bodies: bytes in memory, or a stream the caller gave. */
class BodyImpl {
  protected _bytes: Bytes | null = null;
  protected _stream: ReadableStreamImpl<Bytes> | null = null;
  bodyUsed = false;
  protected _contentType: string | null = null;
  protected initBody(body: unknown) {
    if (body == null) return;
    if (body instanceof ReadableStreamImpl) { this._stream = body as ReadableStreamImpl<Bytes>; return; }
    if (body instanceof BlobImpl) { this._bytes = body._bytes; if (body.type) this._contentType = body.type; return; }
    if (body instanceof URLSearchParamsImpl) { this._bytes = toBytes(body.toString()); this._contentType = 'application/x-www-form-urlencoded;charset=UTF-8'; return; }
    if (typeof body === 'string') { this._bytes = toBytes(body); this._contentType = 'text/plain;charset=UTF-8'; return; }
    this._bytes = toBytes(body);
  }
  get body(): ReadableStreamImpl<Bytes> | null {
    if (this._stream) return this._stream;
    if (this._bytes === null) return null;
    this._stream = bytesStream(this._bytes);
    this._bytes = null;
    return this._stream;
  }
  protected async consume(): Promise<Bytes> {
    if (this.bodyUsed) throw new TypeError('Body has already been consumed');
    this.bodyUsed = true;
    if (this._bytes) return this._bytes;
    if (!this._stream) return new Uint8Array(0);
    const parts: Bytes[] = [];
    for await (const chunk of this._stream) parts.push(toBytes(chunk));
    return concat(parts);
  }
  async arrayBuffer() { const b = await this.consume(); return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer; }
  async bytes() { return (await this.consume()).slice(); }
  async text() { return new TextDecoderImpl().decode(await this.consume()); }
  async json() { return JSON.parse(await this.text()); }
  async blob() { return new BlobImpl([await this.consume()], { type: (this as any).headers?.get('content-type') ?? '' }); }
  async formData(): Promise<never> { throw new TypeError('formData() не поддерживается'); }
  protected cloneBody(): unknown {
    if (this.bodyUsed) throw new TypeError('Body has already been consumed');
    if (this._bytes) return this._bytes;
    if (this._stream) { const [a, b] = this._stream.tee(); this._stream = a; return b; }
    return null;
  }
}

class RequestImpl extends BodyImpl {
  readonly url: string;
  readonly method: string;
  readonly headers: HeadersImpl;
  readonly signal: AbortSignalImpl;
  readonly redirect: string;
  readonly credentials: string;
  readonly mode = 'cors';
  readonly cache = 'default';
  readonly referrer = '';
  readonly keepalive = false;
  constructor(input: string | URLImpl | RequestImpl, init: Record<string, any> = {}) {
    super();
    const from = input instanceof RequestImpl ? input : null;
    this.url = from ? from.url : new URLImpl(String(input), g.location.href).href;
    this.method = String(init.method ?? from?.method ?? 'GET').toUpperCase();
    this.headers = new HeadersImpl(init.headers ?? from?.headers);
    this.signal = init.signal ?? from?.signal ?? new AbortSignalImpl();
    this.redirect = init.redirect ?? from?.redirect ?? 'follow';
    this.credentials = init.credentials ?? from?.credentials ?? 'same-origin';
    if (init.body !== undefined && init.body !== null) {
      if (this.method === 'GET' || this.method === 'HEAD') throw new TypeError('Request with GET/HEAD method cannot have body.');
      this.initBody(init.body);
    } else if (from) this.initBody(from.cloneBody());
    if (this._contentType && !this.headers.has('content-type')) this.headers.set('content-type', this._contentType);
  }
  clone() { return new RequestImpl(this); }
}
class ResponseImpl extends BodyImpl {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeadersImpl;
  url = '';
  redirected = false;
  type = 'basic';
  constructor(body: unknown = null, init: { status?: number; statusText?: string; headers?: any } = {}) {
    super();
    this.status = init.status ?? 200;
    if (this.status < 200 || this.status > 599) throw new RangeError(`Invalid status ${this.status}`);
    this.statusText = init.statusText ?? '';
    this.headers = new HeadersImpl(init.headers);
    this.initBody(body);
    if (this._contentType && !this.headers.has('content-type')) this.headers.set('content-type', this._contentType);
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { const r = new ResponseImpl(this.cloneBody(), { status: this.status, statusText: this.statusText, headers: this.headers }); r.url = this.url; return r; }
  static json(data: unknown, init: { status?: number; headers?: any } = {}) {
    const r = new ResponseImpl(JSON.stringify(data), init);
    r.headers.set('content-type', 'application/json');
    return r;
  }
  static error() { const r = new ResponseImpl(null, { status: 200 }); (r as any).status = 0; r.type = 'error'; return r; }
  static redirect(url: string, status = 302) { return new ResponseImpl(null, { status, headers: { location: String(url) } }); }
}
def('Request', RequestImpl);
def('Response', ResponseImpl);
// ../worker/main.ts sends every third-party URL to native HTTP; this one only sees the app's own origin.
def('fetch', async (input: unknown) => { throw new TypeError(`fetch недоступен для ${String(input instanceof RequestImpl ? input.url : input)}`); });
