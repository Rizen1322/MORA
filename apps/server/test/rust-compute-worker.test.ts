import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS } from '@automix/core';
import { RustComputeWorker } from '../src/rust-compute-worker.ts';

const binary = path.resolve('packages/audio-rust/target/release/mora-audio.exe');
const native = fs.existsSync(binary) ? it : it.skip;
const input = { from: { id: 'a', duration: 180, mixingAllowed: true, analysis: null },
  to: { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, settings: DEFAULT_AUTOMIX_SETTINGS };

native('reuses the process after successful and rejected computations', async () => {
  const worker = new RustComputeWorker(binary);
  try {
    const first = await worker.run('plan', input);
    const pid = (worker as unknown as { child: { pid: number } }).child.pid;
    await expect(worker.run('unknown', {})).rejects.toThrow('Unknown core operation');
    expect(await worker.run('plan', input)).toEqual(first);
    expect((worker as unknown as { child: { pid: number } }).child.pid).toBe(pid);
  } finally { worker.close(); }
});

native('cancels queued and running work without losing subsequent jobs', async () => {
  const worker = new RustComputeWorker(binary);
  try {
    const active = new AbortController(), queued = new AbortController();
    const first = worker.run('plan', input, active.signal).catch(e => e);
    const second = worker.run('plan', input, queued.signal).catch(e => e);
    const third = worker.run('plan', input);
    queued.abort(new Error('queued cancelled'));
    active.abort(new Error('active cancelled'));
    expect(await first).toMatchObject({ message: 'active cancelled' });
    expect(await second).toMatchObject({ message: 'queued cancelled' });
    expect(await third).toMatchObject({ fromTrackId: 'a', toTrackId: 'b' });
  } finally { worker.close(); }
});
