import { EventEmitter } from 'events';
import { ANALYZER_VERSION } from '@automix/core';
import { host } from './host.ts';

/**
 * node:worker_threads for the analysis pool, in JavaScriptCore: there are no Web Workers there,
 * so a job goes to the app's own analyzer (decode + NativeRustAnalysis, the analyzer native
 * queue preparation already uses) and its messages come back in the shape analysis.ts expects.
 */

type Msg = { type: 'job'; jobId: number; input: string; duration: number } | { type: 'cancel'; jobId: number };

export class Worker extends EventEmitter {
  private jobs = new Map<number, number>();

  constructor(_url: unknown, _opts?: unknown) { super(); }

  postMessage(msg: Msg): void {
    if (msg.type === 'cancel') {
      const job = this.jobs.get(msg.jobId);
      if (job === undefined) return;
      this.jobs.delete(msg.jobId);
      host.cancelAnalysis(job);
      this.emit('message', { jobId: msg.jobId, type: 'cancelled' });
      return;
    }
    const { jobId } = msg;
    this.jobs.set(jobId, -1); // registered first: the host may answer before analyze() returns
    const job = host.analyze(msg.input, msg.duration, ANALYZER_VERSION, (error, analysis) => {
      if (!this.jobs.delete(jobId)) return; // cancelled meanwhile
      this.emit('message', error ? { jobId, type: 'error', error } : { jobId, type: 'done', analysis });
    }, (progress) => {
      if (this.jobs.has(jobId)) this.emit('message', { jobId, type: 'progress', progress });
    });
    if (this.jobs.has(jobId)) this.jobs.set(jobId, job);
  }

  async terminate(): Promise<number> {
    for (const job of this.jobs.values()) host.cancelAnalysis(job);
    this.jobs.clear();
    return 0;
  }
  unref(): this { return this; }
  ref(): this { return this; }
}

export const parentPort = null;
export const workerData = null;
export const isMainThread = true;
export default { Worker, parentPort, workerData, isMainThread };
