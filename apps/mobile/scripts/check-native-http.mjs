import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'mora-native-http-'));
const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.writeHead(302, { Location: `http://localhost:${server.address().port}/body` }); res.end();
  } else if (req.url === '/body') {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length }); res.end(payload);
  } else if (req.url === '/chunked') { res.writeHead(200); res.write(payload.subarray(0, 20)); res.end(payload.subarray(20)); }
  else { res.writeHead(404); res.end('missing'); }
});
try {
  assert.equal(process.platform, 'darwin', 'Native HTTP checks need macOS');
  const binary = join(folder, 'check');
  const build = spawnSync('swiftc', [resolve(root, 'apps/mobile/ios/App/App/NativeMediaHTTP.swift'),
    resolve(root, 'apps/mobile/test/native-http/main.swift'), '-o', binary], { stdio: 'inherit' });
  assert.equal(build.status, 0);
  await new Promise(resolve => server.listen(0, '::', resolve));
  const files = join(folder, 'files'); await mkdir(files);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(binary, [`http://127.0.0.1:${server.address().port}`, files], { stdio: 'inherit' });
    child.on('error', reject); child.on('close', resolve);
  });
  assert.equal(code, 0);
} finally {
  await new Promise(resolve => server.close(resolve));
  assert.ok(resolve(folder).startsWith(resolve(tmpdir(), 'mora-native-http-')));
  await rm(folder, { recursive: true, force: true });
}
