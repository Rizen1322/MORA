import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyDirectory } from './copy-directory.mjs';

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
  copyDirectory(path.join(source, 'resources'), path.join(destination, 'resources'));
}
export function withInstallerPayload(source, output, build, stagingRoot = output) {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(stagingRoot, 'payload-'));
  const payload = path.join(temp, 'app');
  try {
    preparePayload(source, payload);
    return build(payload);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function publishInstaller(staging, output, version) {
  const installer = `MORA-Setup-${version}.exe`;
  const names = [installer, `${installer}.blockmap`, 'latest.yml'];
  for (const name of names) {
    const stat = fs.statSync(path.join(staging, name));
    if (!stat.isFile() || stat.size === 0) throw Error(`Empty installer artifact: ${name}`);
  }
  for (const name of names) {
    const src = path.join(staging, name), dest = path.join(output, name);
    try { fs.renameSync(src, dest); }
    catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      const tmp = `${dest}.tmp`;
      fs.copyFileSync(src, tmp);
      try { fs.renameSync(tmp, dest); }
      catch (renameErr) { fs.rmSync(tmp, { force: true }); throw renameErr; }
      fs.unlinkSync(src);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(fs.readFileSync(path.join(here, 'src-tauri/tauri.conf.json'))).version;
  const output = path.join(here, 'dist-unified');
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.json')));
  const tempDir = process.env.TEMP && fs.existsSync(process.env.TEMP) && !/[^\x20-\x7e]/.test(process.env.TEMP) ? process.env.TEMP : os.tmpdir();
  withInstallerPayload(path.join(here, 'src-tauri/target/release'), output, payload => {
    const temp = path.dirname(payload);
    const artifacts = path.join(temp, 'artifacts');
    const assets = path.join(temp, 'assets');
    copyDirectory(path.join(root, 'apps/desktop/assets'), assets);
    const config = unifiedConfig(legacy, version, artifacts, assets);
    const file = path.join(temp, 'electron-builder-unified.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    const built = spawnSync(process.execPath, ['-r', path.join(root, 'tools/electron-builder-win-env.cjs'), path.join(root, 'node_modules/electron-builder/cli.js'), '--projectDir', path.join(root, 'apps/desktop'), '--prepackaged', payload, '--win', '--x64', '--config', file, '--publish', 'never'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, TEMP: tempDir, TMP: tempDir, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    if (built.status !== 0) throw Error('Unified NSIS installer build failed');
    publishInstaller(artifacts, output, version);
  }, tempDir);
}
