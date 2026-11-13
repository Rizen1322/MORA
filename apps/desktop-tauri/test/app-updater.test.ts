import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { AppUpdates } from '../../desktop/src/app-update.mjs';
import { GithubNsisUpdater } from '../app-updater.mjs';

const feed = (installer: Buffer, version = '0.4.3', sha512 = crypto.createHash('sha512').update(installer).digest('base64')) =>
  async (url: string) => url.endsWith('latest.yml')
    ? new Response(`version: ${version}\nfiles:\n  - url: MORA-Setup-${version}.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: MORA-Setup-${version}.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-04T00:00:00.000Z'\n`)
    : new Response(installer);

const setup = (fetcher: any, currentVersion = '0.4.2') => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-app-update-'));
  const updater = new GithubNsisUpdater({ directory, currentVersion, fetcher, feed: 'https://feed.test/' });
  return { directory, updater, updates: new AppUpdates({ updater, currentVersion, enabled: true }) };
};
const stagingDirs = (directory: string) => fs.readdirSync(path.dirname(directory))
  .filter(name => name.startsWith(`${path.basename(directory)}.download-`));

it('checks, downloads, verifies and hands a pending installer to the shell', async () => {
  const installer = Buffer.from('MZ fake installer');
  const { directory, updates } = setup(feed(installer));
  try {
    expect(await updates.check()).toMatchObject({ phase: 'available', version: '0.4.3', size: installer.length });
    expect(await updates.download()).toMatchObject({ phase: 'downloaded', percent: 100 });
    expect(fs.readFileSync(path.join(directory, 'MORA-Setup-0.4.3.exe'))).toEqual(installer);
    expect(updates.install().phase).toBe('installing');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8'))).toEqual({ version: '0.4.3', file: 'MORA-Setup-0.4.3.exe' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('reports current for the same or older feed version', async () => {
  const { directory, updates } = setup(feed(Buffer.from('MZ'), '0.4.2'));
  try { expect((await updates.check()).phase).toBe('current'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('rejects a download whose checksum does not match and keeps nothing to install', async () => {
  const { directory, updates } = setup(feed(Buffer.from('MZ tampered'), '0.4.3', crypto.createHash('sha512').update('other').digest('base64')));
  try {
    await updates.check();
    expect(await updates.download()).toMatchObject({ phase: 'error' });
    expect(fs.existsSync(path.join(directory, 'MORA-Setup-0.4.3.exe'))).toBe(false);
    expect(stagingDirs(directory)).toEqual([]);
    expect(() => updates.install()).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('writes chunks to disk while downloading and publishes only after the complete checksum passes', async () => {
  const installer = Buffer.alloc(256 * 1024, 42), metadata = feed(installer);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const { directory, updates } = setup((url: string) => url.endsWith('latest.yml') ? metadata(url) : new Response(body));
  try {
    await updates.check();
    const pending = updates.download();
    controller.enqueue(installer.subarray(0, 65536));
    await vi.waitFor(() => {
      const staging = stagingDirs(directory);
      expect(staging).toHaveLength(1);
      expect(fs.statSync(path.join(path.dirname(directory), staging[0], 'MORA-Setup-0.4.3.exe')).size).toBe(65536);
    });
    expect(fs.existsSync(path.join(directory, 'MORA-Setup-0.4.3.exe'))).toBe(false);
    controller.enqueue(installer.subarray(65536)); controller.close();
    expect((await pending).phase).toBe('downloaded');
    expect(fs.readFileSync(path.join(directory, 'MORA-Setup-0.4.3.exe'))).toEqual(installer);
    expect(stagingDirs(directory)).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it.each(['truncated', 'oversized', 'network', 'cancel', 'disk'] as const)('cleans partial files after %s failure and allows a fresh download', async mode => {
  const installer = Buffer.from('MZ installer'), metadata = feed(installer);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (mode === 'network') { controller.error(Error('connection reset')); return; }
      controller.enqueue(mode === 'truncated' ? installer.subarray(1) : installer);
      if (mode === 'oversized') controller.enqueue(Buffer.from('extra'));
      if (mode !== 'cancel') controller.close();
    },
    cancel() { cancelled = true; },
  });
  let failed = true;
  const { directory, updates, updater } = setup((url: string) => url.endsWith('latest.yml') || !failed ? metadata(url) : new Response(body));
  let writer: ReturnType<typeof vi.spyOn> | undefined;
  if (mode === 'disk') writer = vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => new Writable({ write(_chunk, _encoding, done) { done(Error('ENOSPC')); } }) as fs.WriteStream);
  if (mode === 'cancel') updater.on('download-progress', () => { if (failed) updates.cancel(); });
  try {
    await updates.check();
    expect((await updates.download()).phase).toBe(mode === 'cancel' ? 'available' : 'error');
    expect(stagingDirs(directory)).toEqual([]);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(() => updater.quitAndInstall()).toThrow('Обновление не скачано');
    if (mode === 'cancel') expect(cancelled).toBe(true);
    failed = false;
    await updates.check();
    expect((await updates.download()).phase).toBe('downloaded');
    expect(fs.readFileSync(path.join(directory, 'MORA-Setup-0.4.3.exe'))).toEqual(installer);
  } finally { writer?.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});
