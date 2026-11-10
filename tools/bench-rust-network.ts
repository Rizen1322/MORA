import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const chunk = Buffer.alloc(256 * 1024, 71);
const expected = crypto.createHash('sha256'); for (let i = 0; i < 128; i++) expected.update(chunk);
const hash = expected.digest('hex');
let connections = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/metadata') { res.setHeader('content-type', 'application/json'); res.end('{"fixture":"pooled HTTP metadata"}'); return; }
  if (req.url === '/first-byte') {
    res.writeHead(200, { 'content-length': 65536 });
    setTimeout(() => res.write(chunk.subarray(0, 32768)), 10);
    setTimeout(() => res.end(chunk.subarray(0, 32768)), 90);
    return;
  }
  res.writeHead(200, { 'content-length': 32 << 20, 'content-type': 'audio/mpeg' });
  let sent = 0;
  const write = () => { while (sent < 128) { sent++; if (!res.write(chunk)) { res.once('drain', write); return; } } res.end(); };
  write();
});
server.on('connection', () => connections++);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-network-bench-'));
const executable = process.env.AUTOMIX_NETWORK_RUST || path.resolve('packages/network-rust/target/release/mora-network.exe');
const electron = process.env.AUTOMIX_BENCH_ELECTRON;
const results: unknown[] = [];
try {
  for (let round = 0; round < 3; round++) for (const kind of round % 2 ? ['rust', ...(electron ? ['electron-rust', 'electron'] : []), 'node'] : ['node', ...(electron ? ['electron', 'electron-rust'] : []), 'rust']) {
    const before = connections, start = performance.now();
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    env.AUTOMIX_NETWORK_BENCH = JSON.stringify({ kind, origin, dir, executable });
    const child = spawn(kind.startsWith('electron') ? electron! : process.execPath, [path.resolve('tools/network-bench-worker.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
    const elapsedMs = performance.now() - start;
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
    assert.deepEqual(result.hashes, Array(4).fill(hash));
    const row = { round: round + 1, ...result, elapsedIncludingStartupAndVerificationMs: elapsedMs, upstreamConnections: connections - before };
    results.push(row); console.log(JSON.stringify(row));
    for (let i = 0; i < 4; i++) await fs.rm(path.join(dir, `${kind}-${i}`));
  }
  const report = { fixture: 'loopback HTTP/1.1 keep-alive, 16 metadata requests then 4 × 32 MiB audio files, SHA256 verified, alternating order; elapsed includes process startup, child metrics collection and final verification', date: new Date().toISOString(), node: process.version, results };
  const destination = path.resolve('data-bench-results/rust-network.json'); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
}
