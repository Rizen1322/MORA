import { expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRustNetwork } from '../src/rust-network.ts';

vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

test('an unsupported automatic proxy policy uses Electron fallback before any upstream request is sent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-proxy-fixture-'));
  const fixture = path.join(dir, 'helper.cjs');
  await fs.writeFile(fixture, `const http=require('node:http');const server=http.createServer((req,res)=>{res.writeHead(502,{'x-mora-network-error':'1'});res.end('system proxy policy unsupported')});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));process.stdin.once('data',()=>server.close(()=>process.exit(0)));`);
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementationOnce((_bin, _args, options) => real.spawn(process.execPath, [fixture], options));
  const fallback = vi.fn<typeof fetch>(async () => new Response('electron proxy result'));
  const network = await createRustNetwork('synthetic-helper', {}, fallback);
  try {
    const response = await network.fetch('https://metadata.example/query', { method: 'POST', headers: { authorization: 'kept-in-memory' }, body: 'query-body' });
    expect(await response.text()).toBe('electron proxy result');
    expect(fallback).toHaveBeenCalledTimes(1);
    const [url, init] = fallback.mock.calls[0]!;
    expect(url).toBe('https://metadata.example/query');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('kept-in-memory');
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('query-body');
  } finally { await network.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
