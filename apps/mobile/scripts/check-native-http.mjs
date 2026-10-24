import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { runInNewContext } from 'node:vm';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'mora-native-http-'));
const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
const wave = Buffer.alloc(44 + 22050);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(22050, 24); wave.writeUInt32LE(44100, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(22050, 40);
for (let i = 0; i < 11025; i++) wave.writeInt16LE(Math.round(Math.sin(i * .05) * 4000), 44 + i * 2);
const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.writeHead(302, { Location: `http://localhost:${server.address().port}/body` }); res.end();
  } else if (req.url === '/body') {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length }); res.end(payload);
  } else if (req.url === '/list.m3u8') { assert.equal(req.headers['x-mora-test'], 'required'); res.end('#EXTM3U\n#EXTINF:1,\nfirst.aac\n#EXTINF:1,\nsecond.aac\n#EXT-X-ENDLIST\n'); }
  else if (req.url === '/wave') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wave.length }); res.end(wave); }
  else if (req.url === '/first.aac') { res.end(Buffer.from([1, 2, 3])); }
  else if (req.url === '/second.aac') { res.end(Buffer.from([4, 5, 6])); }
  else if (req.url === '/chunked') { res.writeHead(200); res.write(payload.subarray(0, 20)); res.end(payload.subarray(20)); }
  else { res.writeHead(404); res.end('missing'); }
});
try {
  assert.equal(process.platform, 'darwin', 'Native HTTP checks need macOS');
  const binary = join(folder, 'check');
  await bundle({ entryPoints: [resolve(root, 'apps/mobile/src/native-preparation-core.ts')], outfile: join(folder, 'preparation.js'),
    bundle: true, format: 'iife', platform: 'neutral', globalName: 'MoraPreparation', target: 'es2022' });
  const frames = 44100 * 4, input = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const beat = Math.exp(-(i % 22050) / 600) * Math.sin(i * 2 * Math.PI * 80 / 44100) * .25;
    input[i * 2] = beat + Math.sin(i * 2 * Math.PI * 261.63 / 44100) * .08;
    input[i * 2 + 1] = input[i * 2] * .8;
  }
  const inputBytes = Buffer.from(input.buffer);
  await writeFile(join(folder, 'analysis-input.f32le'), inputBytes);
  const source = await readFile(join(folder, 'preparation.js'), 'utf8');
  const expected = JSON.parse(runInNewContext(`${source}\nMoraPreparation.analyzeJSON(JSON.stringify({ frames: ${frames} }))`, {
    moraPreparationRead: (offset, frames) => inputBytes.subarray(offset * 8, (offset + frames) * 8).toString('base64'),
    moraPreparationCancelled: () => false,
  }, { timeout: 120000 }));
  const build = spawnSync('swiftc', [resolve(root, 'apps/mobile/ios/App/App/NativeMediaHTTP.swift'),
    resolve(root, 'apps/mobile/ios/App/App/NativeMediaLoader.swift'),
    resolve(root, 'apps/mobile/ios/App/App/NativePCMDecoder.swift'),
    resolve(root, 'apps/mobile/ios/App/App/NativePreparationCore.swift'),
    resolve(root, 'apps/mobile/ios/App/App/NativeQueuePreparation.swift'),
    resolve(root, 'apps/mobile/test/native-http/main.swift'), '-o', binary], { stdio: 'inherit' });
  assert.equal(build.status, 0);
  await new Promise(resolve => server.listen(0, '::', resolve));
  const files = join(folder, 'files'); await mkdir(files);
  const code = await new Promise((resolve, reject) => {
    const hash = createHash('md5').update('XGRlBW9FXlekgbPrRHuSiAtest/audio.mp3salt123').digest('hex');
    const child = spawn(binary, [`http://127.0.0.1:${server.address().port}`, files,
      `https://edge.storage.yandex.net/get-mp3/${hash}/1a/test/audio.mp3`], { stdio: 'inherit' });
    child.on('error', reject); child.on('close', resolve);
  });
  assert.equal(code, 0);
  const actual = JSON.parse(await readFile(join(folder, 'analysis-actual.json'), 'utf8'));
  function compare(a, b) {
    if (typeof a === 'number') assert.ok(Number.isFinite(b) && Math.abs(a - b) <= 2e-5 * Math.max(1, Math.abs(a)));
    else if (a && typeof a === 'object') {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      for (const key of Object.keys(a)) compare(a[key], b[key]);
    } else assert.equal(a, b);
  }
  compare(expected, actual);
  console.log('App-process MIR analysis agrees with Node on the streamed fixture');
} finally {
  await new Promise(resolve => server.close(resolve));
  assert.ok(resolve(folder).startsWith(resolve(tmpdir(), 'mora-native-http-')));
  await rm(folder, { recursive: true, force: true });
}
