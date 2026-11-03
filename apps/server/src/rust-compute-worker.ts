import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_BYTES = 256 * 1024 * 1024;
interface Job {
  id: number; wire: string; bytes: number; signal?: AbortSignal; abort: () => void;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
}

/** A serial native worker. Cancellation kills only its active computation; queued jobs restart safely. */
export class RustComputeWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: Job | null = null;
  private queue: Job[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private parts: Buffer[] = [];
  private received = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private binary: string) {}

  run<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(this.cancelled(signal));
    let wire: string;
    const id = ++this.sequence;
    try { wire = JSON.stringify({ request: id, value: { ...input, operation } }) + '\n'; }
    catch (error) { return Promise.reject(error); }
    const bytes = Buffer.byteLength(wire);
    if (bytes > MAX_BYTES || this.queue.length >= 16 || this.queuedBytes + bytes > MAX_BYTES)
      return Promise.reject(new Error('Очередь Rust-вычислений переполнена'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id, wire, bytes, signal, resolve: value => resolve(value as T), reject,
        abort: () => {
          if (this.active === job) this.fail(this.cancelled(signal));
          else {
            const index = this.queue.indexOf(job);
            if (index >= 0) { this.queue.splice(index, 1); this.queuedBytes -= bytes; this.finish(job, this.cancelled(signal)); }
          }
        } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.queuedBytes += bytes;
      this.pump();
    });
  }

  close(): void {
    clearTimeout(this.idle);
    const pending = this.queue.splice(0); this.queuedBytes = 0;
    for (const job of pending) this.finish(job, new Error('Rust-ядро остановлено'));
    this.fail(new Error('Rust-ядро остановлено'));
  }

  private cancelled(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error('Отменено');
  }
  private finish(job: Job, error?: Error, value?: unknown): void {
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
  }
  private fail(error: Error): void {
    const child = this.child; this.child = null;
    clearTimeout(this.timeout); this.timeout = undefined;
    this.parts = []; this.received = 0;
    const active = this.active; this.active = null;
    child?.kill();
    if (active) this.finish(active, error);
    if (this.queue.length) this.pump();
  }
  private pump(): void {
    if (this.active || !this.queue.length) return;
    clearTimeout(this.idle);
    if (!this.child) {
      const child = this.child = spawn(this.binary, ['--compute-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      child.stderr.resume();
      child.on('error', error => { if (this.child === child) this.fail(error); });
      child.on('close', () => { if (this.child === child) this.fail(new Error('Rust-ядро завершилось')); });
      child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        const end = chunk.indexOf(10);
        this.received += end < 0 ? chunk.length : end;
        if (this.received > MAX_BYTES) return this.fail(new Error('Слишком большой ответ Rust-ядра'));
        this.parts.push(end < 0 ? chunk : chunk.subarray(0, end));
        if (end < 0) return;
        if (end !== chunk.length - 1) return this.fail(new Error('Некорректный ответ Rust-ядра'));
        const job = this.active;
        let output: { request: number; ok: boolean; error?: string; value?: unknown };
        try {
          output = JSON.parse(Buffer.concat(this.parts).toString('utf8'));
          if (!job || output.request !== job.id || typeof output.ok !== 'boolean') throw new Error();
        } catch { return this.fail(new Error('Некорректный ответ Rust-ядра')); }
        this.parts = []; this.received = 0;
        clearTimeout(this.timeout); this.timeout = undefined;
        this.active = null;
        this.finish(job, output.ok ? undefined : new Error(output.error || 'Ошибка Rust-вычислений'), output.value);
        if (this.queue.length) this.pump();
        else { this.idle = setTimeout(() => this.fail(new Error('Rust-ядро освобождено после простоя')), 30000); this.idle.unref(); }
      });
    }
    const child = this.child, job = this.queue.shift()!;
    this.queuedBytes -= job.bytes;
    this.active = job;
    this.timeout = setTimeout(() => this.fail(new Error('Rust-ядро не ответило за 60 секунд')), 60000);
    child.stdin.write(job.wire, error => { if (error && this.child === child) this.fail(error); });
  }
}
