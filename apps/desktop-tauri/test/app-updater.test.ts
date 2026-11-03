import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AppUpdates } from '../../desktop/src/app-update.mjs';
import { GithubNsisUpdater } from '../app-updater.mjs';

const feed = (installer: Buffer, version = '0.4.3', sha512 = crypto.createHash('sha512').update(installer).digest('base64')) =>
  async (url: string) => url.endsWith('latest.yml')
    ? new Response(`version: ${version}\nfiles:\n  - url: MORA-Setup-${version}.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: MORA-Setup-${version}.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-04T00:00:00.000Z'\n`)
    : new Response(installer);

const setup = (fetcher: any, currentVersion = '0.4.2') => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-app-update-'));
  const updater = new GithubNsisUpdater({ directory, currentVersion, fetcher, feed: 'https://feed.test/' });
  return { directory, updates: new AppUpdates({ updater, currentVersion, enabled: true }) };
};

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
    expect(() => updates.install()).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
