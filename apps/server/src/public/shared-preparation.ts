/** Each subscriber owns its cancellation; the worker stops only when nobody needs it. */
export class SharedPreparation<T> {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<T>; listeners: Set<{ progress?: (value: number) => void }> }>();

  run(key: string, options: { signal?: AbortSignal; onProgress?: (value: number) => void }, work: (signal: AbortSignal, progress: (value: number) => void) => Promise<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Отменено'));
    let job = this.jobs.get(key);
    if (!job) {
      const controller = new AbortController();
      const listeners = new Set<{ progress?: (value: number) => void }>();
      const created = { controller, listeners, promise: null as unknown as Promise<T> };
      created.promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal, (value) => {
        for (const listener of listeners) listener.progress?.(value);
      }); }).finally(() => { if (this.jobs.get(key) === created) this.jobs.delete(key); });
      job = created;
      this.jobs.set(key, job);
    }
    const current = job;
    return new Promise<T>((resolve, reject) => {
      const listener = { progress: options.onProgress };
      current.listeners.add(listener);
      let settled = false;
      const clean = () => { settled = true; current.listeners.delete(listener); options.signal?.removeEventListener('abort', abort); };
      const abort = () => {
        if (settled) return;
        clean();
        if (!current.listeners.size) {
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          current.controller.abort();
        }
        reject(options.signal?.reason ?? new Error('Отменено'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      current.promise.then((value) => { if (!settled) { clean(); resolve(value); } }, (error) => { if (!settled) { clean(); reject(error); } });
    });
  }
}
