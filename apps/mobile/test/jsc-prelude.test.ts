import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** The JavaScriptCore globals (src/jsc/prelude.ts) against Node's own implementations. */
const entry = fileURLToPath(new URL('../src/jsc/prelude.ts', import.meta.url));
const code = (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'safari16.4' })).outputFiles[0].text;
const ctx = vm.createContext({});
const realm = vm.runInContext('globalThis', ctx);
realm.moraHost = { log() {}, post() {}, timer() {}, clearTimer() {}, now: () => 0, random: (n: number) => new realm.Uint8Array(n).fill(7) };
vm.runInContext(code, ctx);
const run = <T>(src: string): T => vm.runInContext(src, ctx) as T;

const urls: [string, string?][] = [
  ['https://www.youtube.com/youtubei/v1/player?prettyPrint=false'],
  ['https://Example.COM:443/a/./b/../c?x=1&y=a b#frag ment'],
  ['http://example.com:8080'],
  ['https://user:pa ss@host.com/p'],
  ['https://host.com/путь?q=привет'],
  ['/s/player/abc/base.js', 'https://www.youtube.com/watch?v=1'],
  ['../x?y', 'https://a.com/b/c/d'],
  ['?only', 'https://a.com/b/c?old#h'],
  ['#h2', 'https://a.com/b?q'],
  ['//cdn.com/x', 'https://a.com/'],
  ['https:rel', 'https://a.com/b/c'],
  ['data:text/plain,hi there'],
  ['capacitor://localhost/server-worker.js'],
  ['file:///app/server/src/app.ts'],
  ['./analysis-worker.js', 'capacitor://localhost/server-worker.js'],
  ['https://a.com/%D0%BF?a=%20'],
];

describe('URL in JavaScriptCore', () => {
  it.each(urls)('%s', (input, base) => {
    const want = new URL(input, base);
    const got = run<Record<string, string>>(`(() => { const u = new URL(${JSON.stringify(input)}${base ? `, ${JSON.stringify(base)}` : ''});
      return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin }; })()`);
    const { href, protocol, host, hostname, port, pathname, search, hash } = want;
    expect(got).toMatchObject({ href, protocol, host, hostname, port, pathname, search, hash });
    if (want.origin !== 'null') expect(got.origin).toBe(want.origin);
  });

  it('rejects what Node rejects', () => {
    for (const bad of ['', 'no scheme', 'https://', 'http://a b.com/']) {
      expect(() => new URL(bad)).toThrow();
      expect(run<boolean>(`URL.canParse(${JSON.stringify(bad)})`)).toBe(false);
    }
  });

  it('keeps searchParams and the URL in step', () => {
    const got = run<string[]>(`(() => { const u = new URL('https://a.com/p?x=1&y=2');
      u.searchParams.set('x', 'a b&c'); u.searchParams.append('z', 'ж'); u.searchParams.delete('y');
      const a = u.href; u.search = '?k=v'; return [a, u.searchParams.get('k'), String(new URLSearchParams({ a: "!'()~*" }))]; })()`);
    const u = new URL('https://a.com/p?x=1&y=2');
    u.searchParams.set('x', 'a b&c'); u.searchParams.append('z', 'ж'); u.searchParams.delete('y');
    expect(got).toEqual([u.href, 'v', String(new URLSearchParams({ a: "!'()~*" }))]);
  });
});

describe('fetch classes in JavaScriptCore', () => {
  it('reads bodies, clones and streams like the platform', async () => {
    const got = await run<Promise<unknown[]>>(`(async () => {
      const r = new Response('{"a":1}', { status: 201, headers: { 'X-A': '1' } });
      const c = r.clone();
      const parts = [];
      for await (const chunk of new Response(new Uint8Array([104, 105])).body) parts.push(chunk.length);
      const req = new Request('https://a.com/x', { method: 'post', body: new URLSearchParams({ q: 'a b' }), headers: { 'User-Agent': 'ua' } });
      return [r.ok, r.status, r.headers.get('x-a'), await r.json(), await c.text(), parts, req.method, req.headers.get('content-type'), await req.text(), req.headers.get('user-agent')];
    })()`);
    expect(got).toEqual([true, 201, '1', { a: 1 }, '{"a":1}', [2], 'POST', 'application/x-www-form-urlencoded;charset=UTF-8', 'q=a+b', 'ua']);
  });

  it('decodes split UTF-8 across stream chunks and aborts with AbortError', () => {
    const got = run<unknown[]>(`(() => {
      const d = new TextDecoder(); const b = new TextEncoder().encode('жар');
      const text = d.decode(b.subarray(0, 1), { stream: true }) + d.decode(b.subarray(1));
      const c = new AbortController(); let seen = null; c.signal.addEventListener('abort', () => { seen = c.signal.reason.name; }); c.abort();
      return [text, seen, c.signal.aborted, atob(btoa('ab\\u00ff')) === 'ab\\u00ff', crypto.randomUUID().length];
    })()`);
    expect(got).toEqual(['жар', 'AbortError', true, true, 36]);
  });
});
