import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { AnalysisAccumulator } from '@automix/core';
import { FfmpegTools } from './ffmpeg.ts';

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
  ffprobe?: string;
  decoder?: string;
}

async function decode(job: Job, state: NonNullable<typeof current>) {
  const tools = new FfmpegTools(job.ffmpeg, job.ffprobe ?? 'ffprobe', job.decoder);
  if (job.decoder) {
    const abort = new AbortController();
    state.kill = () => abort.abort();
    await tools.probe(job.input, abort.signal).catch(() => {});
    if (state.cancelled) throw new Cancelled();
  }
  return tools.decode(job.input, { sampleRate: 44100, channels: 2, format: 'f32le' });
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
    if (process.env.AUTOMIX_RUST_CORE) {
      const analysis = await runNative(job, state, post);
      post({ type: 'done', analysis });
      return;
    }
    const acc = new AnalysisAccumulator(Math.max(30, job.duration + 5));
    const proc = await decode(job, state);
    if (state.cancelled) { proc.kill('SIGKILL'); throw new Cancelled(); }
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

/** Pipe decoder PCM directly to the native accumulator; never retain full-rate stereo in JS. */
async function runNative(job: Job, state: NonNullable<typeof current>, post: (message: object) => void) {
  if (cancelFlag && Atomics.load(cancelFlag, 0) === job.jobId) throw new Cancelled();
  const decoder = await decode(job, state);
  if (state.cancelled) { decoder.kill('SIGKILL'); throw new Cancelled(); }
  const native = spawn(process.env.AUTOMIX_RUST_CORE!, ['--analyze', '-', '-', String(job.duration)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  state.kill = () => { decoder.kill('SIGKILL'); native.kill('SIGKILL'); };
  let error = '', decodeError = '', bytes = 0, size = 0, progress = 0;
  const output: Buffer[] = [];
  const closed = (child: typeof native | typeof decoder) => new Promise<number | null>(resolve => { child.once('close', resolve); child.once('error', e => { error = e.message; resolve(-1); }); });
  const nativeClosed = closed(native), decoderClosed = closed(decoder);
  const poll = setInterval(() => { if (cancelFlag && Atomics.load(cancelFlag, 0) === job.jobId) { state.cancelled = true; state.kill(); } }, 25);
  native.stderr.on('data', (b: Buffer) => { error = (error + b.toString()).slice(-1500); });
  decoder.stderr.on('data', (b: Buffer) => { decodeError = (decodeError + b.toString()).slice(-1500); });
  native.stdin.on('error', () => decoder.kill('SIGKILL'));
  native.stdout.on('data', (b: Buffer) => {
    size += b.length;
    if (size > 128 * 1024 * 1024) { error = 'Слишком большой результат анализа'; state.kill(); }
    else output.push(b);
  });
  decoder.stdout.on('data', (b: Buffer) => {
    bytes += b.length;
    const p = Math.min(.5, bytes / 8 / Math.max(1, job.duration * 44100) * .5);
    if (p - progress > .05) { progress = p; post({ type: 'progress', progress }); }
  });
  decoder.stdout.pipe(native.stdin);
  try {
    const decodeCode = await decoderClosed;
    if (state.cancelled) throw new Cancelled();
    if (decodeCode !== 0) { native.kill('SIGKILL'); throw new Error(decodeError.trim().split('\n').pop() || error || `ffmpeg завершился с кодом ${decodeCode}`); }
    post({ type: 'progress', progress: .55 });
    const code = await nativeClosed;
    if (state.cancelled) throw new Cancelled();
    const body = Buffer.concat(output).toString('utf8');
    if (code !== 0) {
      try { error = JSON.parse(body).error || error; } catch { /* native startup errors may have no JSON */ }
      throw new Error(error || `Rust-анализатор завершился с кодом ${code}`);
    }
    const analysis = JSON.parse(body);
    if (!analysis || !Number.isFinite(analysis.duration) || !analysis.loudness || !analysis.curves || !analysis.version) throw new Error('Некорректный результат Rust-анализа');
    return analysis;
  } finally { clearInterval(poll); state.kill(); await Promise.allSettled([nativeClosed, decoderClosed]); }
}
