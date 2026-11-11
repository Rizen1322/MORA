// Checks the current IPA: bundle, version, widget extension, ad-hoc signature with App Group,
// CarPlay code, offline wave, and the integrity of every archive entry.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yauzl = require('yauzl');
const zlib = require('node:zlib');
const crc32 = require('buffer-crc32');
const bplist = require('bplist-parser');
const plist = require('plist');
const { version } = require('../package.json');
const build = String(Number(version.split('.')[2]) + 1);

const readPlist = (buf) => (buf.subarray(0, 8).toString() === 'bplist00' ? bplist.parseBuffer(buf)[0] : plist.parse(buf.toString()));

async function loadEntries(file) {
  const archive = await fs.readFile(file);
  const entries = new Map();
  await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        const offset = entry.relativeOffsetOfLocalHeader;
        assert.equal(archive.readUInt32LE(offset), 0x04034b50);
        const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
        const compressed = archive.subarray(start, start + entry.compressedSize);
        assert([0, 8].includes(entry.compressionMethod));
        const data = entry.compressionMethod === 0 ? compressed : zlib.inflateRawSync(compressed);
        assert.equal(data.length, entry.uncompressedSize);
        assert.equal(crc32.unsigned(data), entry.crc32);
        entries.set(entry.fileName, data);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
  return entries;
}

function readEntitlements(macho) {
  assert.equal(macho.readUInt32LE(0), 0xfeedfacf, 'Expected a 64-bit Mach-O executable');
  const commands = macho.readUInt32LE(16);
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    const command = macho.readUInt32LE(offset);
    const size = macho.readUInt32LE(offset + 4);
    if (command === 0x1d) {
      const dataOffset = macho.readUInt32LE(offset + 8);
      const dataSize = macho.readUInt32LE(offset + 12);
      const blob = macho.subarray(dataOffset, dataOffset + dataSize);
      assert.equal(blob.readUInt32BE(0), 0xfade0cc0, 'Expected an embedded code signature');
      const count = blob.readUInt32BE(8);
      let der = null;
      for (let j = 0; j < count; j++) {
        const type = blob.readUInt32BE(12 + j * 8);
        const blobOffset = blob.readUInt32BE(16 + j * 8);
        const entitlements = blob.subarray(blobOffset);
        if (type === 5) {
          assert.equal(entitlements.readUInt32BE(0), 0xfade7171);
          return readPlist(entitlements.subarray(8, entitlements.readUInt32BE(4)));
        }
        if (type === 7) der = entitlements.subarray(8, entitlements.readUInt32BE(4));
      }
      // Newer codesign versions can emit DER-only entitlements.
      if (der) return { __der: der.toString('utf8') };
      return null;
    }
    offset += size;
  }
  return null;
}

(async () => {
  const file = path.resolve(process.argv[2]);
  const commit = process.argv[3];
  const run = process.argv[4];
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(run, /^https:\/\/github\.com\/Rizen1322\/MORA\/actions\/runs\/\d+$/);

  const entries = await loadEntries(file);
  const names = [...entries.keys()];
  const appPlistRaw = entries.get('Payload/App.app/Info.plist');
  assert(appPlistRaw, 'App Info.plist missing');
  const info = readPlist(appPlistRaw);
  assert.equal(info.CFBundleIdentifier, 'ru.mora.player');
  assert.equal(info.CFBundleShortVersionString, version);
  assert.equal(String(info.CFBundleVersion), build);
  assert.equal(info.MinimumOSVersion, '17.4');
  assert.equal(info.UIUserInterfaceStyle, 'Dark');
  assert.deepEqual(info.UIDeviceFamily, [1]);
  assert.equal(info.NSSupportsLiveActivities, undefined);
  assert.equal(info.DTPlatformName, 'iphoneos');
  assert(info.UIBackgroundModes.includes('audio'));
  assert(info.UIRequiredDeviceCapabilities.includes('arm64'));
  const carPlayScene = info.UIApplicationSceneManifest?.UISceneConfigurations?.CPTemplateApplicationSceneSessionRoleApplication?.[0];
  assert(carPlayScene, 'CarPlay scene configuration missing');
  assert.equal(carPlayScene.UISceneDelegateClassName, 'App.CarPlaySceneDelegate');

  const widgetPlistRaw = entries.get('Payload/App.app/PlugIns/MORAWidgets.appex/Info.plist');
  assert(widgetPlistRaw, 'Widget Info.plist missing');
  const widget = readPlist(widgetPlistRaw);
  assert.equal(widget.CFBundleIdentifier, 'ru.mora.player.widgets');
  assert.equal(widget.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
  assert.equal(widget.CFBundleShortVersionString, version);
  assert.equal(String(widget.CFBundleVersion), build);

  const appBinary = entries.get('Payload/App.app/' + info.CFBundleExecutable);
  assert(appBinary, 'App executable missing');
  const widgetBinary = entries.get('Payload/App.app/PlugIns/MORAWidgets.appex/' + widget.CFBundleExecutable);
  assert(widgetBinary, 'Widget executable missing');
  for (const binary of [appBinary, widgetBinary]) {
    assert.equal(binary.readUInt32LE(4), 0x0100000c, 'Expected arm64');
  }

  assert(!names.includes('Payload/App.app/embedded.mobileprovision'), 'Expected no Apple provisioning profile');
  for (const bundle of ['Payload/App.app', 'Payload/App.app/PlugIns/MORAWidgets.appex',
    'Payload/App.app/Frameworks/Capacitor.framework', 'Payload/App.app/Frameworks/Cordova.framework']) {
    assert(names.includes(bundle + '/_CodeSignature/CodeResources'), 'Missing ad-hoc signature: ' + bundle);
  }

  const appEntitlements = readEntitlements(appBinary);
  const widgetEntitlements = readEntitlements(widgetBinary);
  const entitlementsText = (value) => (value?.__der ? value.__der : JSON.stringify(value ?? {}));
  const hasAppGroup = (value) => {
    const text = entitlementsText(value);
    return text.includes('com.apple.security.application-groups') && text.includes('group.ru.mora.player');
  };
  assert(appEntitlements && hasAppGroup(appEntitlements), 'App Group entitlement missing in the app');
  assert(widgetEntitlements && hasAppGroup(widgetEntitlements), 'App Group entitlement missing in the widget');
  const carPlayAudio = entitlementsText(appEntitlements).includes('com.apple.developer.carplay-audio');
  const iCloudDrive = entitlementsText(appEntitlements).includes('com.apple.developer.icloud-services');
  assert.equal(carPlayAudio, process.env.MORA_CARPLAY === '1', 'CarPlay entitlement gate');
  assert.equal(iCloudDrive, process.env.MORA_ICLOUD === '1', 'iCloud entitlement gate');

  const scripts = Buffer.concat(names.filter((name) => /\/public\/.*\.js$/.test(name)).map((name) => entries.get(name)));
  const appText = appBinary.toString('latin1');
  const widgetText = widgetBinary.toString('latin1');
  const features = {
    adHocSignature: true,
    appGroup: 'group.ru.mora.player',
    carPlayScenes: ['NativeCarPlay', 'CPListTemplate', 'CarPlaySceneDelegate'].every((probe) => appText.includes(probe)),
    widgets: widgetText.includes('WidgetKit') && names.includes('Payload/App.app/PlugIns/MORAWidgets.appex/MORAWidgets'),
    offlineWaveContexts: ['Моя волна · без сети', 'Онлайн-радио · Моя волна'].every((probe) => scripts.includes(probe)),
    offlineOnlyController: ['offlineOnly', 'setOfflineOnly', 'waveNext'].every((probe) => scripts.includes(probe)),
    widgetSharedData: appText.includes('NativeWidgetData') && widgetText.includes('NativeWidgetData') && appText.includes('NativeDeepLink'),
    nativeStation: appText.includes('StationStarter') && appText.includes('NativeStationSnapshot'),
    backgroundDownloads: appText.includes('NativeDownloadManager'),
    noLiveActivity: !appText.includes('NativeActivityAttributes') && !widgetText.includes('NativeActivityAttributes'),
    configurableWaveWidget: widgetText.includes('WaveWidgetIntent'),
    localBackups: appText.includes('NativeBackupStore'),
    metrics: appText.includes('NativeMetrics'),
    releaseBuild: !appText.includes('--native-ui-check') && !appText.includes('installVisualFixture'),
  };
  for (const [name, present] of Object.entries(features)) assert(present, 'Missing feature: ' + name);

  const bytes = await fs.readFile(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const verification = {
    version: info.CFBundleShortVersionString,
    build: String(info.CFBundleVersion),
    bundleId: info.CFBundleIdentifier,
    minimumOSVersion: info.MinimumOSVersion,
    bytes: bytes.length,
    sha256,
    infoPlistSha256: crypto.createHash('sha256').update(appPlistRaw).digest('hex'),
    widgetExtension: { bundleId: widget.CFBundleIdentifier, version: widget.CFBundleShortVersionString, build: String(widget.CFBundleVersion) },
    architecture: 'arm64',
    signature: 'ad-hoc, no Apple provisioning profile',
    entitlements: { applicationGroups: ['group.ru.mora.player'], carPlayAudio, iCloudDrive },
    entries: names.length,
    commit,
    run,
    features,
  };
  await fs.writeFile(file + '.verification.json', JSON.stringify(verification, null, 2) + '\n');
  await fs.writeFile(file + '.sha256', `${sha256}  ${path.basename(file)}\n`);
  process.stdout.write(JSON.stringify(verification, null, 2) + '\n');
})().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
