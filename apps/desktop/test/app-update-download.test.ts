import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
// @ts-expect-error desktop shell modules are plain ESM JavaScript
import { AppUpdates } from '../src/app-update.mjs';

const require = createRequire(import.meta.url);
const { NsisUpdater } = require('electron-updater');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');

it('uses the real NSIS updater to reject older versions and corrupt downloads, and revalidate cached files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-app-update-'));
  const original = Buffer.from('MZ synthetic update fixture; never executed');
  const sha512 = crypto.createHash('sha512').update(original).digest('base64');
  let version = '0.3.13', corrupt = false, downloads = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/latest.yml')) {
      res.end(`version: ${version}\nfiles:\n  - url: MORA-Setup-${version}.exe\n    sha512: ${sha512}\n    size: ${original.length}\n`);
    } else if (req.url?.endsWith('.exe')) {
      downloads++;
      const body = Buffer.from(original); if (corrupt) body[0] ^= 255;
      res.setHeader('Content-Length', body.length); res.end(body);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const config = path.join(dir, 'app-update.yml');
  fs.writeFileSync(config, 'updaterCacheDirName: test-cache\n');
  const quit = vi.fn();
  const make = () => {
    const adapter = { version: '0.3.14', name: 'MORA', isPackaged: true, appUpdateConfigPath: config,
      userDataPath: path.join(dir, 'profile'), baseCachePath: dir, whenReady: async () => {}, onQuit: vi.fn(), quit };
    const updater = new NsisUpdater(null, adapter);
    const executor = new NodeHttpExecutor();
    // Keep the real downloader, SHA-512 verification and cancellation; only transport uses Node in this test.
    executor.download = ElectronHttpExecutor.prototype.download;
    updater.httpExecutor = executor;
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}` });
    updater.disableDifferentialDownload = true;
    const updates = new AppUpdates({ updater, currentVersion: adapter.version, enabled: true });
    return { updater, updates };
  };
  try {
    const first = make();
    expect((await first.updates.check()).phase).toBe('current'); // Older than installed.
    expect(downloads).toBe(0);
    version = '0.3.15'; corrupt = true;
    await first.updates.check();
    expect((await first.updates.download()).phase).toBe('error');
    expect(first.updates.status().error).toContain('Проверка файла');
    expect(() => first.updates.install()).toThrow();
    corrupt = false;
    await first.updates.check();
    expect((await first.updates.download()).phase).toBe('downloaded');
    const file = first.updater.downloadedUpdateHelper.file;
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    fs.writeFileSync(file, Buffer.alloc(original.length)); // Corrupted cache after a previous run.
    const second = make();
    await second.updates.check();
    expect((await second.updates.download()).phase).toBe('downloaded');
    expect(downloads).toBe(3);
    expect(fs.readFileSync(second.updater.downloadedUpdateHelper.file).equals(original)).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    first.updates.dispose(); second.updates.dispose();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
