/** node:timers/promises */
function delay<T>(ms = 0, value?: T, opts?: { signal?: AbortSignal }): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    opts?.signal?.throwIfAborted();
    const t = globalThis.setTimeout(() => resolve(value), ms);
    opts?.signal?.addEventListener('abort', () => { globalThis.clearTimeout(t); reject(opts.signal!.reason); }, { once: true });
  });
}
export { delay as setTimeout };
export default { setTimeout: delay };
