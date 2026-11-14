import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { importNativeFile } from '../src/native-sources.ts';
import type { Services } from '../src/app.ts';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-native-import-')); folders.push(root);
  const folder = path.join(root, 'incoming', 'native'); fs.mkdirSync(folder, { recursive: true });
  const file = randomUUID() + '.wav', staged = path.join(folder, file), original = path.join(root, 'original.wav');
  fs.writeFileSync(original, 'fixture audio'); fs.copyFileSync(original, staged);
  const importFile = vi.fn(async (file: string) => {
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture audio');
    return { track: { id: 'saved', title: 'Song' }, duplicate: false };
  });
  return { root, folder, file, staged, original, importFile, services: { cfg: { dataDir: root }, lib: { importFile } } as unknown as Services };
}
it('imports a private staged copy and leaves the original untouched', async () => {
  const f = fixture();
  expect(await importNativeFile(f.services, { file: f.file, name: 'Артист — Песня.wav' })).toEqual({ trackId: 'saved', title: 'Song', duplicate: false });
  expect(f.importFile).toHaveBeenCalledWith(f.staged, 'Артист — Песня.wav', 'managed');
  expect(fs.existsSync(f.staged)).toBe(false);
  expect(fs.readFileSync(f.original, 'utf8')).toBe('fixture audio');
});
it('cleans the copy after a duplicate or decoder failure without deleting the original', async () => {
  for (const duplicate of [true, false]) {
    const f = fixture();
    if (duplicate) f.importFile.mockResolvedValue({ track: { id: 'saved', title: 'Song' }, duplicate: true });
    else f.importFile.mockRejectedValue(new Error('corrupt'));
    if (duplicate) expect((await importNativeFile(f.services, { file: f.file, name: 'Song.wav' })).duplicate).toBe(true);
    else await expect(importNativeFile(f.services, { file: f.file, name: 'Song.wav' })).rejects.toThrow('corrupt');
    expect(fs.existsSync(f.staged)).toBe(false);
    expect(fs.existsSync(f.original)).toBe(true);
  }
});
it('rejects paths and empty files before importing anything', async () => {
  const f = fixture();
  for (const file of ['../original.wav', f.original, 'not-a-private-copy.wav']) {
    await expect(importNativeFile(f.services, { file, name: 'Song.wav' })).rejects.toThrow('Некорректный');
  }
  fs.writeFileSync(f.staged, '');
  await expect(importNativeFile(f.services, { file: f.file, name: 'Song.wav' })).rejects.toThrow('непустой');
  expect(f.importFile).not.toHaveBeenCalled();
  expect(fs.existsSync(f.original)).toBe(true);
});
it.skipIf(process.platform === 'win32')('rejects a staged symlink without touching its target', async () => {
  const f = fixture(); fs.rmSync(f.staged); fs.symlinkSync(f.original, f.staged);
  await expect(importNativeFile(f.services, { file: f.file, name: 'Song.wav' })).rejects.toThrow('вне папки');
  expect(f.importFile).not.toHaveBeenCalled(); expect(fs.existsSync(f.original)).toBe(true);
});
