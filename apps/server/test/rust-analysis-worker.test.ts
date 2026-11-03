import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const binary = path.resolve('packages/audio-rust/target/release/mora-audio.exe');
const nativeTest = fs.existsSync(binary) ? it : it.skip;
async function withNativeWorker(seconds: number, check: (run: (jobId: number, cancelOnProgress?: boolean) => Promise<any>, cancel: Int32Array) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-native-analysis-'));
  const ffmpeg = loadConfig({ dataDir: dir }).ffmpeg;
  const input = path.join(dir, 'tone.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=44100`, '-ac', '2', input], { windowsHide: true });
  const cancel = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('../src/analysisWorkerBoot.mjs', import.meta.url), { workerData: { cancel }, env: { ...process.env, AUTOMIX_RUST_CORE: binary } });
  const run = (jobId: number, cancelOnProgress = false) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Analysis worker timeout')); }, 30000);
    let requestedCancel = false;
    const message = (m: any) => {
      if (m.jobId !== jobId) return;
      if (m.type !== 'progress') { cleanup(); resolve(m); }
      else if (cancelOnProgress && !requestedCancel) {
        requestedCancel = true;
        Atomics.store(cancel, 0, jobId);
        worker.postMessage({ type: 'cancel', jobId });
      }
    };
    const error = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); };
    worker.on('message', message); worker.on('error', error);
    worker.postMessage({ type: 'job', jobId, input, duration: seconds, ffmpeg });
  });
  try {
    await check(run, cancel);
  } finally {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

nativeTest('native analysis worker streams a decoded recording and cancels the next job', async () => {
  await withNativeWorker(4, async (run, cancel) => {
    const result = await run(1);
    expect(result.type).toBe('done');
    expect(result.analysis.duration).toBeCloseTo(4, 3);
    expect(result.analysis.loudness.integratedLufs).toBeLessThan(0);
    expect(result.analysis.curves.rmsDb.length).toBeGreaterThan(0);
    Atomics.store(cancel, 0, 2);
    expect((await run(2)).type).toBe('cancelled');
    Atomics.store(cancel, 0, 0);
    expect((await run(3)).type).toBe('done');
  });
});

nativeTest('cancels native analysis after decoding started and reuses the worker', async () => {
  await withNativeWorker(120, async (run, cancel) => {
    expect((await run(1, true)).type).toBe('cancelled');
    Atomics.store(cancel, 0, 0);
    const result = await run(2);
    expect(result.type).toBe('done');
    expect(result.analysis.duration).toBeCloseTo(120, 3);
  });
});
