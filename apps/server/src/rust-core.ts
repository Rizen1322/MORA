import { spawn, spawnSync } from 'node:child_process';
import { RustComputeWorker } from './rust-compute-worker.ts';

/** Set only by the desktop shell; web/mobile keep their own platform implementation. */
export const rustCorePath = () => process.env.AUTOMIX_RUST_CORE || null;
const MAX_RESULT = 256 * 1024 * 1024;
let workers: { binary: string; plan: RustComputeWorker; render: RustComputeWorker } | undefined;

export function stopRustCompute(): void {
  const old = workers; workers = undefined;
  old?.plan.close(); old?.render.close();
}

function result<T>(code: number | null, output: string, error?: Error): T {
  if (error) throw error;
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('Некорректный ответ Rust-ядра'); }
  if (code !== 0) throw new Error((value as { error?: string })?.error || `Rust-ядро завершилось с кодом ${code}`);
  return value as T;
}

export function rustCompute<T>(operation: string, input: Record<string, unknown>): T {
  const binary = rustCorePath();
  if (!binary) throw new Error('Rust-ядро не настроено');
  const process = spawnSync(binary, ['--compute'], { input: JSON.stringify({ ...input, operation }), encoding: 'utf8', windowsHide: true, maxBuffer: MAX_RESULT, timeout: 60000 });
  return result<T>(process.status, process.stdout ?? '', process.error);
}

export function rustComputeAsync<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const binary = rustCorePath();
  if (!binary) return Promise.reject(new Error('Rust-ядро не настроено'));
  if (!workers || workers.binary !== binary) {
    stopRustCompute();
    workers = { binary, plan: new RustComputeWorker(binary), render: new RustComputeWorker(binary) };
  }
  return workers[operation === 'render' ? 'render' : 'plan'].run<T>(operation, input, signal);
}

/** Kept for CLI parity benchmarks; production asynchronous calls reuse native workers. */
export function rustComputeOnceAsync<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const binary = rustCorePath();
  if (!binary) return Promise.reject(new Error('Rust-ядро не настроено'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Отменено'));
  let request: string;
  try { request = JSON.stringify({ ...input, operation }); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--compute'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0, error: Error | undefined, stderr = '';
    const abort = () => { error = signal?.reason instanceof Error ? signal.reason : new Error('Отменено'); child.kill('SIGKILL'); };
    const timeout = setTimeout(() => { error = new Error('Rust-ядро не ответило за 60 секунд'); child.kill('SIGKILL'); }, 60000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', e => { error = e; });
    child.stdin.on('error', () => { /* a native validation failure closes input before replying */ });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESULT) { error = new Error('Слишком большой ответ Rust-ядра'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.once('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (code !== 0 && !size && !error) error = new Error(stderr || `Rust-ядро завершилось с кодом ${code}`);
      try { resolve(result<T>(code, Buffer.concat(chunks).toString('utf8'), error)); } catch (e) { reject(e); }
    });
    child.stdin.end(request);
  });
}
