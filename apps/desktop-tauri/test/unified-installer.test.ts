import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishInstaller, unifiedConfig, withInstallerPayload } from '../unified-installer.mjs';
it('preserves the released Electron NSIS identity and update contract for the native payload', () => {
  const legacy = JSON.parse(fs.readFileSync(new URL('../../desktop/electron-builder.json', import.meta.url), 'utf8'));
  const config = unifiedConfig(legacy, '0.4.2', '/output', '/icons');
  expect(config.appId).toBe('ru.mora.desktop');
  expect(config.productName).toBe('MORA');
  expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, shortcutName: 'MORA', artifactName: 'MORA-Setup-${version}.exe' });
  expect(config.win.executableName).toBe('MORA');
  expect(config.extraResources).toEqual([]);
  expect(config.extraMetadata.version).toBe('0.4.2');
});

it.each([false, true])('removes the staged payload on success or failure (%s)', fail => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-nsis-'));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  try {
    fs.mkdirSync(path.join(source, 'resources/backend'), { recursive: true });
    fs.writeFileSync(path.join(source, 'resources/backend/tauri-backend.mjs'), '');
    fs.writeFileSync(path.join(source, 'WebView2Loader.dll'), '');
    const shell = Buffer.alloc(160);
    shell.writeUInt32LE(64, 0x3c);
    shell.write('PE\0\0', 64);
    shell.writeUInt16LE(2, 64 + 92);
    fs.writeFileSync(path.join(source, 'mora-desktop-native.exe'), shell);
    const build = () => withInstallerPayload(source, output, (payload: string) => {
      expect(fs.existsSync(path.join(payload, 'MORA.exe'))).toBe(true);
      if (fail) throw Error('build failed');
      fs.writeFileSync(path.join(output, 'MORA-Setup.exe'), '');
    });
    if (fail) expect(build).toThrow('build failed');
    else build();
    expect(fs.readdirSync(output)).toEqual(fail ? [] : ['MORA-Setup.exe']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('stages payloads from a Cyrillic path in an external ASCII root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-nsis-ext-'));
  const source = path.join(root, 'исходники'), output = path.join(root, 'output'), staging = path.join(root, 'staging');
  try {
    fs.mkdirSync(path.join(source, 'resources/backend'), { recursive: true });
    fs.writeFileSync(path.join(source, 'resources/backend/tauri-backend.mjs'), 'backend');
    fs.writeFileSync(path.join(source, 'WebView2Loader.dll'), '');
    const shell = Buffer.alloc(160);
    shell.writeUInt32LE(64, 0x3c);
    shell.write('PE\0\0', 64);
    shell.writeUInt16LE(2, 64 + 92);
    fs.writeFileSync(path.join(source, 'mora-desktop-native.exe'), shell);
    withInstallerPayload(source, output, (payload: string) => {
      expect(payload.startsWith(staging)).toBe(true);
      expect(fs.existsSync(path.join(payload, 'MORA.exe'))).toBe(true);
      expect(fs.readFileSync(path.join(payload, 'resources/backend/tauri-backend.mjs'), 'utf8')).toBe('backend');
    }, staging);
    expect(fs.readdirSync(staging)).toEqual([]);
    expect(fs.readdirSync(output)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('publishes the installer and update manifest only after all build artifacts exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-nsis-publish-'));
  const staging = path.join(root, 'staging'), output = path.join(root, 'output');
  try {
    fs.mkdirSync(staging); fs.mkdirSync(output);
    const installer = 'MORA-Setup-0.4.2.exe';
    fs.writeFileSync(path.join(staging, installer), 'installer');
    fs.writeFileSync(path.join(staging, 'latest.yml'), 'new manifest');
    fs.writeFileSync(path.join(output, 'latest.yml'), 'old manifest');
    expect(() => publishInstaller(staging, output, '0.4.2')).toThrow();
    expect(fs.readdirSync(output)).toEqual(['latest.yml']);
    expect(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8')).toBe('old manifest');
    fs.writeFileSync(path.join(staging, `${installer}.blockmap`), 'blockmap');
    publishInstaller(staging, output, '0.4.2');
    expect(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8')).toBe('new manifest');
    expect(fs.readdirSync(staging)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves Windows TEMP and SystemRoot when WineVmManager runs a command with custom env', async () => {
  const require = createRequire(import.meta.url);
  require('../../../tools/electron-builder-win-env.cjs');
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
  const vm = new WineVmManager();
  const output = await vm.exec(process.execPath, [
    '-e',
    'console.log(JSON.stringify({ compat: process.env.__COMPAT_LAYER, hasTemp: Boolean(process.env.TEMP || process.env.TMP), hasSystemRoot: Boolean(process.env.SystemRoot) }))',
  ], { env: { __COMPAT_LAYER: 'RunAsInvoker' } });
  const parsed = JSON.parse(String(output).trim());
  expect(parsed.compat).toBe('RunAsInvoker');
  if (process.platform === 'win32') {
    expect(parsed.hasTemp).toBe(true);
    expect(parsed.hasSystemRoot).toBe(true);
  }
});
