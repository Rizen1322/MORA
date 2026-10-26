import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mora-native-host-'));
const run = (command, args) => {
  console.log('[native-host]', command, args.slice(0, 4).join(' '));
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`); return result.stdout.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let device;
const covers = new Set();
const audio = new Set();
const wave = Buffer.alloc(44 + 48000 * 2 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28); wave.writeUInt16LE(4, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const server = createServer((req, res) => {
  if (req.url === '/cover') { covers.add(res); res.on('close', () => covers.delete(res)); }
  else if (req.url === '/audio-wait') { audio.add(res); res.on('close', () => audio.delete(res)); }
  else if (req.url === '/audio-pending') { res.end(String(audio.size)); }
  else if (req.url === '/audio-release') { for (const pending of audio) { pending.writeHead(200, { 'Content-Type': 'audio/wav' }); pending.end(wave); } audio.clear(); res.end('released'); }
  else if (req.url === '/pending') { res.end(String(covers.size)); }
  else if (req.url === '/release') { for (const cover of covers) { cover.writeHead(200, { 'Content-Type': 'image/png' }); cover.end(png); } covers.clear(); res.end('released'); }
  else { res.writeHead(404); res.end(); }
});
try {
  assert.equal(process.platform, 'darwin');
  const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const candidates = Object.entries(devices.devices).filter(([runtime]) => runtime.includes('iOS'))
    .flatMap(([, list]) => list).filter(d => d.name.includes('iPhone'));
  device = candidates.find(d => d.state === 'Booted') ?? candidates[0];
  assert.ok(device, 'An available iPhone simulator is required');
  if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  const app = join(dir, 'HostCheck.app'); await mkdir(join(app, 'public'), { recursive: true });
  const bundle = 'ru.mora.native-host-check';
  await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>HostCheck</string><key>CFBundleName</key><string>HostCheck</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>UIBackgroundModes</key><array><string>audio</string></array><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict><key>UILaunchScreen</key><dict/></dict></plist>`);
  await copyFile(resolve(root, 'apps/mobile/www/native-preparation.js'), join(app, 'public/native-preparation.js'));
  const files = ['NativeMixTimeline', 'NativeDSPRenderer', 'NativeMixHost', 'NativeArtworkImage', 'NativePCMDecoder',
    'NativeMediaHTTP', 'NativeMediaLoader', 'NativePreparationCore', 'NativeQueuePreparation', 'NativeProbeWave']
    .map(name => resolve(root, `apps/mobile/ios/App/App/${name}.swift`));
  run('xcrun', ['swiftc', '-sdk', run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']),
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios17.4-simulator`,
    ...files, resolve(root, 'apps/mobile/test/native-host/main.swift'), '-o', join(app, 'HostCheck')]);
  run('codesign', ['--force', '--sign', '-', app]);
  run('xcrun', ['simctl', 'install', device.udid, app]);
  const container = run('xcrun', ['simctl', 'get_app_container', device.udid, bundle, 'data']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const mode of ['natural', 'skip', 'slow-analysis']) {
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, bundle,
      '--fixture-base', `http://127.0.0.1:${server.address().port}`, ...(mode === 'skip' ? ['--skip'] : mode === 'slow-analysis' ? ['--slow-analysis'] : [])]);
    let report;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try { report = JSON.parse(await readFile(join(container, 'Documents', `${mode}.json`), 'utf8')); } catch { continue; }
      if (report.status === 'failed' || report.status === 'passed') break;
    }
    assert.equal(report?.status, 'passed', JSON.stringify({ mode, report }));
    assert.equal(report.backgrounded, true, 'The iOS app must observe its own background state');
    console.log(`Native iOS host ${mode}: eight tracks, artwork leases, Previous boundary, speed, reset and configuration recovery passed`);
  }
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'mora-native-host-')));
  await rm(dir, { recursive: true, force: true });
}
