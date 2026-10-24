import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mora-native-host-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`); return result.stdout.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let device;
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
<key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>HostCheck</string><key>CFBundleName</key><string>HostCheck</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>UIBackgroundModes</key><array><string>audio</string></array><key>UILaunchScreen</key><dict/></dict></plist>`);
  await copyFile(resolve(root, 'apps/mobile/www/native-preparation.js'), join(app, 'public/native-preparation.js'));
  const files = ['NativeMixTimeline', 'NativeDSPRenderer', 'NativeMixHost', 'NativeArtworkImage', 'NativePCMDecoder',
    'NativeMediaHTTP', 'NativeMediaLoader', 'NativePreparationCore', 'NativeQueuePreparation', 'NativeProbeWave']
    .map(name => resolve(root, `apps/mobile/ios/App/App/${name}.swift`));
  run('xcrun', ['swiftc', '-sdk', run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']),
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios17.4-simulator`,
    ...files, resolve(root, 'apps/mobile/test/native-host/main.swift'), '-o', join(app, 'HostCheck')]);
  run('codesign', ['--force', '--sign', '-', app]);
  run('xcrun', ['simctl', 'install', device.udid, app]);
  for (const mode of ['natural', 'skip']) {
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, bundle, ...(mode === 'skip' ? ['--skip'] : [])]);
    const container = run('xcrun', ['simctl', 'get_app_container', device.udid, bundle, 'data']);
    let report, backgrounded = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try { report = JSON.parse(await readFile(join(container, 'Documents', `${mode}.json`), 'utf8')); } catch { continue; }
      if (report.status === 'failed' || report.status === 'passed') break;
      if (!backgrounded) { run('xcrun', ['simctl', 'launch', device.udid, 'com.apple.Preferences']); backgrounded = true; }
    }
    assert.equal(report?.status, 'passed', JSON.stringify({ mode, report }));
    assert.ok(backgrounded, 'The test must leave the foreground before completing');
    console.log(`Native iOS host ${mode}: reached track 8 without WebView; duration, seek and background refill passed`);
  }
} finally {
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'mora-native-host-')));
  await rm(dir, { recursive: true, force: true });
}
