import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { publishLibrary } from '../src/publish.mjs';

let root = '', dataDir = '', staging = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-publish-'));
  dataDir = path.join(root, 'data'); staging = `${dataDir}.importing`;
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'automix.sqlite'), 'old');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'automix.sqlite'), 'new'); fs.writeFileSync(path.join(staging, '.import-complete'), '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Real fs whose n-th renameSync fails with the given code. */
const failingRename = (n: number, code: string) => {
  let calls = 0;
  return { ...fs, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (++calls === n) throw Object.assign(new Error(`rename ${code}`), { code });
    return fs.renameSync(from, to);
  } } as typeof fs;
};

it('swaps the import in and keeps the previous library as a backup', async () => {
  await publishLibrary(fs, dataDir, staging, 'x');
  expect(fs.readFileSync(path.join(dataDir, 'automix.sqlite'), 'utf8')).toBe('new');
  expect(fs.existsSync(path.join(dataDir, '.import-complete'))).toBe(false);
  expect(fs.readFileSync(path.join(`${dataDir}.backup-x`, 'automix.sqlite'), 'utf8')).toBe('old');
});

it('puts the previous library back when the second rename fails, and leaves staging alone', async () => {
  await expect(publishLibrary(failingRename(2, 'ENOSPC'), dataDir, staging, 'x')).rejects.toThrow('rename ENOSPC');
  expect(fs.readFileSync(path.join(dataDir, 'automix.sqlite'), 'utf8')).toBe('old');
  expect(fs.existsSync(`${dataDir}.backup-x`)).toBe(false);
  expect(fs.existsSync(path.join(staging, '.import-complete'))).toBe(true);
});

it('retries a briefly locked folder on Windows', async () => {
  await publishLibrary(failingRename(2, 'EPERM'), dataDir, staging, 'x');
  expect(fs.readFileSync(path.join(dataDir, 'automix.sqlite'), 'utf8')).toBe('new');
});
