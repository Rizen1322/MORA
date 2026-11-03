import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
export function unifiedConfig(legacy, version, output, resources) {
  return { ...legacy, directories: { output, buildResources: resources }, extraResources: [],
    extraMetadata: { version }, electronVersion: '44.9.2',
    win: { ...legacy.win, executableName: 'MORA', signAndEditExecutable: false },
    nsis: { ...legacy.nsis, installerLanguages: ['ru_RU', 'en_US'], displayLanguageSelector: false } };
}
export function preparePayload(source, destination) {
  const executable = path.join(source, 'mora-desktop-native.exe');
  const image = fs.readFileSync(executable), pe = image.readUInt32LE(0x3c);
  if (image.toString('ascii', pe, pe + 4) !== 'PE\0\0' || image.readUInt16LE(pe + 92) !== 2) throw Error('Native shell must use the Windows GUI subsystem');
  if (!fs.existsSync(path.join(source, 'resources/backend/tauri-backend.mjs'))) throw Error('Native resources unavailable');
  if (fs.existsSync(destination)) throw Error('Installer payload directory must be fresh');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(executable, path.join(destination, 'MORA.exe'));
  fs.copyFileSync(path.join(source, 'WebView2Loader.dll'), path.join(destination, 'WebView2Loader.dll'));
  fs.cpSync(path.join(source, 'resources'), path.join(destination, 'resources'), { recursive: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(fs.readFileSync(path.join(here, 'src-tauri/tauri.conf.json'))).version;
  const output = path.join(here, 'dist-unified');
  fs.mkdirSync(output, { recursive: true });
  const payload = fs.mkdtempSync(path.join(output, 'payload-'));
  fs.rmdirSync(payload);
  preparePayload(path.join(here, 'src-tauri/target/release'), payload);
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.json')));
  const config = unifiedConfig(legacy, version, output, path.join(root, 'apps/desktop/assets'));
  const file = path.join(output, 'electron-builder-unified.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const built = spawnSync(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--projectDir', path.join(root, 'apps/desktop'), '--prepackaged', payload, '--win', '--x64', '--config', file, '--publish', 'never'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (built.status !== 0) throw Error('Unified NSIS installer build failed');
}
