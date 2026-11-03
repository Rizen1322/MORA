import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { configureRustNetwork, createRustNetwork, type RustNetwork } from '../src/rust-network.ts';
import { YandexAudio } from '../src/providers/yandex-audio.ts';
import { downloadTo } from '../src/providers/types.ts';
import { loadConfig } from '../src/config.ts';
import { FfmpegTools } from '../src/ffmpeg.ts';

const executable = process.env.AUTOMIX_NETWORK_RUST || path.resolve(`packages/network-rust/target/release/mora-network${process.platform === 'win32' ? '.exe' : ''}`);
const bytes = Buffer.alloc(256 * 1024, 71);
let network: RustNetwork, dir: string, origin: string, otherOrigin: string;
let connections = 0, bulkActive = 0;
const other = http.createServer((req, res) => { res.end(JSON.stringify({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })); });
const server = http.createServer((req, res) => {
  if (req.url === '/large-head') { res.writeHead(200, { 'content-length': 32 << 20 }); res.end(); return; }
  if (req.url?.startsWith('/status/')) { res.writeHead(Number(req.url.slice(8))); res.end(); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: `${otherOrigin}/headers` }); res.end(); return; }
  if (req.url === '/truncated') { res.writeHead(200, { 'content-length': bytes.length * 2 }); res.write(bytes); setTimeout(() => res.destroy(), 5); return; }
  if (req.url === '/slow') {
    bulkActive++;
    res.writeHead(200); res.write(bytes.subarray(0, 1024));
    const timer = setInterval(() => res.write(bytes.subarray(0, 1024)), 20);
    res.on('close', () => { clearInterval(timer); bulkActive--; }); return;
  }
  const start = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
  const body = bytes.subarray(start);
  res.writeHead(start ? 206 : 200, { 'content-length': body.length, ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
  res.end(body);
});
server.on('connection', () => connections++);
describe.skipIf(!process.env.AUTOMIX_NETWORK_RUST && !existsSync(executable))('native HTTP transport', () => {
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-network-'));
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  network = await createRustNetwork(executable, { default: '' });
});
afterAll(async () => {
  await network?.close(); server.closeAllConnections(); other.closeAllConnections();
  await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => other.close(() => r()))]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('persistent client reuses connections and preserves streamed range bytes', async () => {
  const before = connections;
  for (let i = 0; i < 3; i++) {
    const response = await network.fetch(`${origin}/audio`, { headers: { range: 'bytes=12000-' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 12000-${bytes.length - 1}/${bytes.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(12000));
  }
  expect(connections - before).toBe(1);
});

test('a per-call response cap reaches the helper without changing its default metadata cap', async () => {
  await expect(network.fetch(`${origin}/audio`, {}, 100)).rejects.toThrow('size limit');
  const allowed = await network.fetch(`${origin}/audio`, {}, bytes.length);
  expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes);
  const defaultLimit = await network.fetch(`${origin}/audio`);
  expect(Buffer.from(await defaultLimit.arrayBuffer())).toEqual(bytes);
});

test('manual/error redirects hold and cross-origin redirects strip credentials', async () => {
  const manual = await network.fetch(`${origin}/redirect`, { redirect: 'manual' });
  expect(manual.status).toBe(302); expect(manual.headers.get('location')).toBe(`${otherOrigin}/headers`);
  await manual.body?.cancel();
  await expect(network.fetch(`${origin}/redirect`, { redirect: 'error' })).rejects.toThrow();
  const followed = await network.fetch(`${origin}/redirect`, { headers: { authorization: 'secret', cookie: 'session=secret' } });
  expect(await followed.json()).toEqual({ auth: null, cookie: null });
  expect(followed.redirected).toBe(true); expect(followed.url).toBe(`${otherOrigin}/headers`);
});

test('native download streams to disk, rejects truncation/caps and preserves preexisting files', async () => {
  const file = path.join(dir, 'audio.bin');
  expect(await network.download(`${origin}/audio`, file, { maxBytes: bytes.length })).toEqual({ bytes: bytes.length, status: 200 });
  expect(await fs.readFile(file)).toEqual(bytes);
  await expect(network.download(`${origin}/audio`, file)).rejects.toThrow('cannot create');
  expect(await fs.readFile(file)).toEqual(bytes);
  const cap = path.join(dir, 'cap.bin'), truncated = path.join(dir, 'truncated.bin');
  await expect(network.download(`${origin}/audio`, cap, { maxBytes: 100 })).rejects.toThrow('size limit');
  await expect(network.download(`${origin}/truncated`, truncated)).rejects.toThrow();
  await expect(fs.stat(cap)).rejects.toThrow(); await expect(fs.stat(truncated)).rejects.toThrow();
});

test('bulk is bounded to three, foreground keeps a slot, cancellation and timeout remove partial files', async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((abort, i) => network.download(`${origin}/slow`, path.join(dir, `slow${i}`), { priority: 3, signal: abort.signal }).catch(() => {}));
  for (let i = 0; i < 100 && bulkActive < 3; i++) await new Promise(r => setTimeout(r, 10));
  expect(bulkActive).toBe(3);
  await vi.waitFor(async () => expect((await fs.stat(path.join(dir, 'slow0'))).size).toBeGreaterThan(0));
  const foreground = path.join(dir, 'foreground');
  const started = performance.now(); await network.download(`${origin}/audio`, foreground, { priority: 0 });
  expect(performance.now() - started).toBeLessThan(1000);
  for (const abort of controllers) abort.abort(); await Promise.all(pending);
  for (let i = 0; i < 100 && bulkActive > 0; i++) await new Promise(r => setTimeout(r, 10));
  expect(bulkActive).toBe(0);
  for (let i = 0; i < 4; i++) await expect(fs.stat(path.join(dir, `slow${i}`))).rejects.toThrow();
  const timed = path.join(dir, 'timed');
  await expect(network.download(`${origin}/slow`, timed, { timeoutMs: 50 })).rejects.toThrow();
  await expect(fs.stat(timed)).rejects.toThrow();
});

test('native redirect targets obey the provider allowlist', async () => {
  await expect(network.download(`${origin}/redirect`, path.join(dir, 'unsafe'), { allowedDomains: ['yandex.net'], allowedOrigin: origin })).rejects.toThrow();
});

test('explicit authenticated proxy settings carry the request without exposing credentials in errors', async () => {
  let proxyAuthorization: string | undefined;
  const proxy = http.createServer((req, res) => { proxyAuthorization = req.headers['proxy-authorization']; res.end('proxied bytes'); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const port = (proxy.address() as { port: number }).port;
  const file = path.join(dir, 'proxied');
  try {
    await network.download('http://not-resolvable.invalid/audio?secret=must-not-log', file, { proxy: `http://user:password@127.0.0.1:${port}` });
    expect(await fs.readFile(file, 'utf8')).toBe('proxied bytes');
    expect(proxyAuthorization).toBe(`Basic ${Buffer.from('user:password').toString('base64')}`);
    await expect(network.download('http://127.0.0.1:1/audio?secret=must-not-log', path.join(dir, 'failed'))).rejects.toThrow('HTTP connection failed');
  } finally { proxy.closeAllConnections(); await new Promise<void>(r => proxy.close(() => r())); }
});

test('HEAD and null-body HTTP statuses preserve Fetch semantics', async () => {
  const head = await network.fetch(`${origin}/audio`, { method: 'HEAD' });
  expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(await head.text()).toBe('');
  expect(head.headers.get('content-length')).toBe(String(bytes.length));
  const large = await network.fetch(`${origin}/large-head`, { method: 'HEAD' });
  expect(large.headers.get('content-length')).toBe(String(32 << 20)); expect(large.body).toBeNull();
  for (const status of [204, 205, 304]) {
    const response = await network.fetch(`${origin}/status/${status}`, { redirect: 'manual' });
    expect(response.status).toBe(status); expect(response.body).toBeNull(); expect(await response.text()).toBe('');
  }
});

test('a crashed helper restarts lazily on the next request without replaying the failed stream', async () => {
  const previous = network.pid!;
  const response = await network.fetch(`${origin}/slow`);
  const reader = response.body!.getReader(); await reader.read();
  process.kill(previous);
  await expect(reader.read()).rejects.toThrow();
  await new Promise(r => setTimeout(r, 50));
  const resumed = await network.fetch(`${origin}/audio`);
  expect(Buffer.from(await resumed.arrayBuffer())).toEqual(bytes);
  expect(network.pid).not.toBe(previous);
});

test('aborting a streamed fetch after headers closes its upstream HTTP stream', async () => {
  const abort = new AbortController();
  const response = await network.fetch(`${origin}/slow`, { signal: abort.signal });
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.length).toBeGreaterThan(0);
  abort.abort();
  await expect(reader.read()).rejects.toThrow();
  for (let i = 0; i < 100 && bulkActive > 0; i++) await new Promise(r => setTimeout(r, 10));
  expect(bulkActive).toBe(0);
});

test('Yandex and shared provider download callers publish the native file bytes', async () => {
  configureRustNetwork(network);
  // Decoding/preview/hash validation has its own Yandex fixture suite; this checks the transport wiring.
  const ff = new FfmpegTools('unused', 'unused');
  vi.spyOn(ff, 'probe').mockResolvedValue({ duration: 3, codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 320000, hasAudio: true });
  const audio = new YandexAudio(loadConfig({ dataDir: dir }), ff, origin, async () => [{ codec: 'mp3', bitrateInKbps: 320, preview: false, direct: true, downloadInfoUrl: `${origin}/audio` }]);
  try {
    const prepared = await audio.prepare('123', 3);
    expect(await fs.readFile(prepared.file)).toEqual(bytes);
    const shared = path.join(dir, 'generic-provider.mp3');
    await downloadTo(`${origin}/audio`, shared, bytes.length, { priority: 1 });
    expect(await fs.readFile(shared)).toEqual(bytes);
  } finally { configureRustNetwork(null); }
});
});
