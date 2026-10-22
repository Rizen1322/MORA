import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { downloadTo } from '../src/providers/types.ts';

let server: http.Server, base = '', dir = '', requests = 0;
const body = Buffer.alloc(256 * 1024, 7);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-download-to-'));
  requests = 0;
  server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    // two chunks with a pause, so concurrent callers overlap
    res.write(body.subarray(0, body.length / 2));
    setTimeout(() => res.end(body.subarray(body.length / 2)), 50);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

it('rejects on a write error instead of crashing the process', async () => {
  // a path component longer than any file system allows: mkdir succeeds, opening the temp file fails
  const file = path.join(dir, `${'x'.repeat(250)}.mp3`);
  await expect(downloadTo(`${base}/a`, file)).rejects.toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('removes the partial file when the size limit is exceeded', async () => {
  const file = path.join(dir, 'big.mp3');
  await expect(downloadTo(`${base}/a`, file, 1000)).rejects.toThrow('файл слишком большой');
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('shares one transfer between concurrent requests for the same file', async () => {
  const file = path.join(dir, 'same.mp3');
  await Promise.all([downloadTo(`${base}/a`, file), downloadTo(`${base}/a`, file), downloadTo(`${base}/a`, file)]);
  expect(requests).toBe(1);
  expect(fs.readFileSync(file).equals(body)).toBe(true);
  expect(fs.readdirSync(dir)).toEqual(['same.mp3']);
});
