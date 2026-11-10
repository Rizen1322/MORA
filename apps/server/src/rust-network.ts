import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export interface NetworkOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  priority?: 0 | 1 | 2 | 3;
  /** undefined uses system environment proxies; empty string bypasses them. */
  proxy?: string;
  redirect?: RequestInit['redirect'];
  headers?: RequestInit['headers'];
  allowedDomains?: string[];
  allowedOrigin?: string;
}

export type NetworkFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], maxBytes?: number) => ReturnType<typeof fetch>;

export interface RustNetwork {
  readonly pid?: number;
  readonly nativeDownloads?: boolean;
  fetch: NetworkFetch;
  download(url: string, file: string, options?: NetworkOptions): Promise<{ bytes: number; status: number }>;
  close(): Promise<void>;
}

let active: RustNetwork | null = null;
export function configureRustNetwork(network: RustNetwork | null): void { active = network; }
export function rustNetworkEnabled(): boolean { return active !== null && active.nativeDownloads !== false; }
export const networkFetch: typeof fetch = (input, init) => (active?.fetch ?? fetch)(input, init);
/** Null keeps the browser/server installation on its existing transport. */
export function nativeDownload(url: string, file: string, options: NetworkOptions): Promise<{ bytes: number; status: number }> | null {
  return rustNetworkEnabled() ? active!.download(url, file, options) : null;
}

/** One helper per backend, pooled HTTP connections for its entire lifetime. */
export async function createRustNetwork(executable: string, proxies: { youtube?: string; soundcloud?: string; default?: string } = {}, fallbackFetch?: typeof fetch): Promise<RustNetwork> {
  let current = await startRustNetwork(executable, proxies, fallbackFetch);
  let restarting: Promise<typeof current> | null = null;
  let closed = false;
  async function available() {
    if (closed) throw new Error('Rust HTTP transport closed');
    if (!current.alive()) {
      restarting ??= startRustNetwork(executable, proxies, fallbackFetch);
      try { current = await restarting; } finally { restarting = null; }
    }
    return current;
  }
  return {
    get pid() { return current.pid; },
    get nativeDownloads() { return current.nativeDownloads; },
    fetch: async (input, init, maxBytes) => (await available()).fetch(input, init, maxBytes),
    download: async (url, file, options) => (await available()).download(url, file, options),
    close: async () => { closed = true; await restarting?.catch(() => {}); await current.close(); },
  };
}

async function startRustNetwork(executable: string, proxies: { youtube?: string; soundcloud?: string; default?: string }, fallbackFetch?: typeof fetch): Promise<RustNetwork & { alive(): boolean }> {
  const token = randomBytes(32).toString('hex');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE)$/i.test(name)));
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, MORA_NETWORK_TOKEN: token } });
  const lines = createInterface({ input: child.stdout });
  let stopped = false;
  child.on('error', () => { stopped = true; });
  child.on('exit', () => { stopped = true; });
  const handshake = await new Promise<{ port: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Rust HTTP helper startup timed out')); }, 10000);
    const fail = () => { clearTimeout(timer); reject(new Error('Rust HTTP helper unavailable')); };
    child.once('error', fail);
    child.once('exit', fail);
    lines.once('line', (line) => {
      clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail);
      try {
        const value = JSON.parse(line);
        if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error();
        resolve(value);
      } catch { child.kill(); reject(new Error('Invalid Rust HTTP helper handshake')); }
    });
  });
  const origin = `http://127.0.0.1:${handshake.port}`;
  const headers = { authorization: token, 'content-type': 'application/json' };
  async function request(payload: object, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    if (stopped) throw new Error('Rust HTTP helper stopped');
    const id = randomUUID();
    const cancel = () => { void fetch(`${origin}/cancel`, { method: 'POST', headers, body: JSON.stringify({ id }) }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(`${origin}/request`, { method: 'POST', headers, body: JSON.stringify({ ...payload, id }), signal, redirect: 'manual' });
      if (response.headers.has('x-mora-network-error')) {
        const message = await response.text();
        throw new Error(message.slice(0, 200));
      }
      return response;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  return {
    pid: child.pid,
    alive: () => !stopped,
    nativeDownloads: true,
    fetch: async (input, init, maxBytes) => {
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error('Invalid HTTP response size limit');
      const req = new Request(input, init);
      const body = req.body ? Buffer.from(await req.arrayBuffer()).toString('base64') : undefined;
      const host = new URL(req.url).hostname;
      const proxy = /(^|\.)youtube\.com$|(^|\.)googlevideo\.com$/.test(host) ? proxies.youtube
        : /(^|\.)soundcloud\.com$/.test(host) ? proxies.soundcloud : proxies.default;
      let response: Response;
      try {
        response = await request({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body, redirect: req.redirect, proxy, maxBytes }, req.signal);
      } catch (error) {
        if (fallbackFetch && error instanceof Error && /^system proxy /.test(error.message)) {
          return fallbackFetch(req.url, { method: req.method, headers: req.headers, body: body ? Buffer.from(body, 'base64') : undefined, redirect: req.redirect, signal: req.signal });
        }
        throw error;
      }
      const url = response.headers.get('x-mora-response-url') ?? req.url;
      const headers = new Headers(response.headers);
      headers.delete('x-mora-response-url');
      const headLength = headers.get('x-mora-head-content-length');
      headers.delete('x-mora-head-content-length');
      if (req.method === 'HEAD' && headLength) headers.set('content-length', headLength);
      const nullBody = req.method === 'HEAD' || [204, 205, 304].includes(response.status);
      if (nullBody) await response.body?.cancel();
      const result = new Response(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers });
      Object.defineProperty(result, 'url', { value: url });
      Object.defineProperty(result, 'redirected', { value: url !== req.url });
      return result;
    },
    download: async (url, file, options = {}) => {
      const { signal, headers: upstreamHeaders, ...rest } = options;
      const response = await request({ url, file, proxy: proxies.default, ...rest, headers: Object.fromEntries(new Headers(upstreamHeaders)) }, signal);
      return await response.json() as { bytes: number; status: number };
    },
    close: async () => {
      if (stopped) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.stdin.end('\n');
      const timer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(timer);
      lines.close();
    },
  };
}
