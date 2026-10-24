// Browser harness for the iOS bundle: serves www/ and forwards third-party HTTP
// through /__proxy (what CapacitorHttp does natively in the app). Dev only.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../www');
const port = Number(process.env.PORT ?? 4741);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const DROP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']);

async function proxy(req, res, target) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.fromEntries(Object.entries(JSON.parse(req.headers['x-fwd-headers'] ?? '{}')).filter(([k]) => !DROP.has(k.toLowerCase())));
  try {
    const r = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'follow' });
    const body = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) h[k] = v; });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-fwd-status': String(r.status), 'x-fwd-url': encodeURI(r.url), 'x-fwd-headers': encodeURI(JSON.stringify(h)).replace(/%20/g, ' ') });
    res.end(body);
  } catch (e) {
    res.writeHead(599, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e?.cause?.message ?? e?.message ?? e));
  }
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/__proxy') return proxy(req, res, u.searchParams.get('url'));
  let file = normalize(join(root, decodeURIComponent(u.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(root, 'index.html'); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`MORA iOS harness: http://localhost:${port}`));
