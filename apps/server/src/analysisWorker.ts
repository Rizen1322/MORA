import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { AnalysisAccumulator } from '@automix/core';

/**
 * Worker thread: decodes a file with ffmpeg (f32le stereo 44.1 kHz) and runs
 * the DSP/MIR analyzer. Runs off the main thread so the API stays responsive.
 */

interface Job {
  type: 'job';
  jobId: number;
  input: string;
  duration: number;
  ffmpeg: string;
}

let current: { jobId: number; cancelled: boolean; kill: () => void } | null = null;

class Cancelled extends Error {}

/** Set by the main thread; read while acc.finish() blocks this thread's message loop. */
const cancelFlag = (workerData as { cancel?: Int32Array } | null)?.cancel;

parentPort!.on('message', (msg: Job | { type: 'cancel'; jobId: number }) => {
  if (msg.type === 'cancel') {
    if (current && current.jobId === msg.jobId) {
      current.cancelled = true;
      current.kill();
    }
    return;
  }
  void run(msg);
});

async function run(job: Job): Promise<void> {
  const state = { jobId: job.jobId, cancelled: false, kill: () => {} };
  current = state;
  const post = (m: object) => parentPort!.postMessage({ jobId: job.jobId, ...m });
  try {
    const acc = new AnalysisAccumulator(Math.max(30, job.duration + 5));
    const proc = spawn(job.ffmpeg, ['-v', 'error', '-nostdin', '-i', job.input, '-vn', '-ac', '2', '-ar', '44100', '-f', 'f32le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.kill = () => proc.kill('SIGKILL');
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1500)));
    let leftover: Buffer = Buffer.alloc(0);
    let L = new Float32Array(0);
    let R = new Float32Array(0);
    let inter = new Float32Array(0);
    let interBytes = new Uint8Array(0);
    let lastProgress = 0;
    const expected = Math.max(1, job.duration * 44100);
    proc.stdout.on('data', (chunk: Buffer) => {
      const buf: Buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const frames = Math.floor(buf.length / 8);
      leftover = buf.subarray(frames * 8);
      if (L.length < frames) {
        L = new Float32Array(frames);
        R = new Float32Array(frames);
        inter = new Float32Array(frames * 2);
        interBytes = new Uint8Array(inter.buffer);
      }
      // copy into an aligned buffer, then deinterleave
      interBytes.set(buf.subarray(0, frames * 8));
      for (let i = 0; i < frames; i++) {
        L[i] = inter[2 * i];
        R[i] = inter[2 * i + 1];
      }
      acc.push(L, R, frames);
      const p = Math.min(0.5, (acc.frames / expected) * 0.5);
      if (p - lastProgress > 0.05) {
        lastProgress = p;
        post({ type: 'progress', progress: p });
      }
    });
    const code: number | null = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.on('error', () => resolve(-1));
    });
    if (state.cancelled) throw new Cancelled();
    if (code !== 0) throw new Error(stderr.split('\n').filter(Boolean).pop() || `ffmpeg завершился с кодом ${code}`);
    if (acc.frames < 4410) throw new Error('файл не содержит звука');
    const analysis = acc.finish({
      onProgress: (p) => post({ type: 'progress', progress: 0.5 + p * 0.5 }),
      checkCancel: () => {
        if (state.cancelled || (cancelFlag && Atomics.load(cancelFlag, 0) === job.jobId)) throw new Cancelled();
      },
    });
    post({ type: 'done', analysis });
  } catch (e) {
    if (e instanceof Cancelled || state.cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', error: (e as Error).message });
  } finally {
    if (current === state) current = null;
  }
}
