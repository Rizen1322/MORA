import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { AnalysisService } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { Library, TrackRow } from '../src/library.ts';

it('does not start a job cancelled while its audio was still being fetched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-analysis-cancel-'));
  const db = openDb(dir);
  let fetched!: (file: string) => void;
  let signal: AbortSignal | undefined;
  const track = { id: 't1', content_hash: 'h1', provider: 'local', status: 'ok', duration: 10 } as TrackRow;
  const lib = {
    get: () => track, mixingPolicy: new Map([['local', true]]),
    resolveMediaPath: (_id: string, s?: AbortSignal) => { signal = s; return new Promise<string>((r) => { fetched = r; }); },
  } as unknown as Library;
  const service = new AnalysisService(db, loadConfig({ dataDir: dir }), lib, new EventHub());
  const postMessage = vi.fn();
  (service as unknown as { pool: unknown[] }).pool.push({ w: { postMessage, terminate: async () => 0 }, busy: false, cancel: new Int32Array(1) });
  try {
    service.ensure(track, 100);
    expect(service.statusOf('h1').status).toBe('running');
    service.cancel('h1');
    expect(signal?.aborted).toBe(true);
    fetched(path.join(dir, 'a.wav'));
    await vi.waitFor(() => expect(service.statusOf('h1').status).toBe('none'));
    expect(postMessage.mock.calls.some(([m]) => m.type === 'job')).toBe(false);
  } finally { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('lets the worker see a cancel inside its synchronous analysis', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-analysis-flag-'));
  const ffmpeg = loadConfig({ dataDir: dir }).ffmpeg;
  const input = path.join(dir, 'tone.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40:sample_rate=44100', '-ac', '2', input], { windowsHide: true });
  // The flag is raised before the job starts; no cancel message is sent, so only the shared flag can stop it.
  const cancel = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancel, 0, 7);
  const w = new Worker(new URL('../src/analysisWorkerBoot.mjs', import.meta.url), { workerData: { cancel } });
  try {
    const reply = await new Promise<{ type: string }>((resolve) => {
      w.on('message', (m: { type: string }) => { if (m.type !== 'progress') resolve(m); });
      w.postMessage({ type: 'job', jobId: 7, input, duration: 40, ffmpeg });
    });
    expect(reply.type).toBe('cancelled');
  } finally { await w.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
});
