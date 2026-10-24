import { EventEmitter } from 'events';
import { promises as fsp } from '../opfs-fs.ts';
import { decodePlanes } from '../rpc.ts';

/**
 * node:worker_threads for the analysis pool only. The real analyzer runs in a Web
 * Worker (analysis-worker.js); decoding happens on the page, so this side reads the
 * file, has it decoded to 44.1 kHz stereo float and hands the two channel planes over.
 */

type Job = { type: 'job'; jobId: number; input: string; duration: number };
type Msg = Job | { type: 'cancel'; jobId: number };

export class Worker extends EventEmitter {
  private w: globalThis.Worker;
  private current: { jobId: number; abort: AbortController; inWorker: boolean } | null = null;
  private terminated = false;

  constructor(_url: unknown, _opts?: unknown) {
    super();
    this.w = this.spawnWorker();
  }

  private spawnWorker(): globalThis.Worker {
    const w = new globalThis.Worker(new URL('./analysis-worker.js', self.location.href));
    w.onmessage = (e) => {
      const m = e.data as { jobId: number; type: string };
      if (m.type !== 'progress' && this.current?.jobId === m.jobId) this.current = null;
      this.emit('message', m);
    };
    w.onerror = (e) => { e.preventDefault(); this.emit('error', new Error(e.message || 'сбой анализатора')); };
    return w;
  }

  postMessage(msg: Msg): void {
    if (msg.type === 'cancel') {
      const c = this.current;
      if (!c || c.jobId !== msg.jobId) return;
      c.abort.abort();
      if (c.inWorker) {
        // the analyzer cannot be interrupted inside finish(): replace the worker
        this.w.terminate();
        if (!this.terminated) this.w = this.spawnWorker();
      }
      this.current = null;
      this.emit('message', { jobId: msg.jobId, type: 'cancelled' });
      return;
    }
    void this.run(msg);
  }

  private async run(job: Job): Promise<void> {
    const state = { jobId: job.jobId, abort: new AbortController(), inWorker: false };
    this.current = state;
    try {
      const bytes = await fsp.readFile(job.input) as Uint8Array;
      if (state.abort.signal.aborted) return;
      const copy = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
      this.emit('message', { jobId: job.jobId, type: 'progress', progress: 0.05 });
      const { planes: [L, R] } = await decodePlanes({ bytes: copy, sampleRate: 44100, channels: 2, format: 'f32le' }, state.abort.signal);
      if (state.abort.signal.aborted) return;
      state.inWorker = true;
      this.w.postMessage({ type: 'job', jobId: job.jobId, L, R, duration: job.duration }, [L, R]);
    } catch (e) {
      if (state.abort.signal.aborted) return;
      if (this.current === state) this.current = null;
      this.emit('message', { jobId: job.jobId, type: 'error', error: `не удалось декодировать файл: ${(e as Error).message}` });
    }
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    this.current?.abort.abort();
    this.w.terminate();
    return 0;
  }
  unref(): this { return this; }
  ref(): this { return this; }
}

export const parentPort = null;
export const workerData = null;
export const isMainThread = true;
export default { Worker, parentPort, workerData, isMainThread };
