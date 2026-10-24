/** Node globals the server code expects, injected into the worker bundle. */
import { Buffer } from 'buffer';

const env: Record<string, string | undefined> = { AUTOMIX_ROOT: '/app', NODE_ENV: 'production' };
const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
export const process = {
  env,
  platform: 'ios',
  arch: 'arm64',
  pid: 1,
  version: 'v22.0.0',
  versions: { node: '22.0.0' } as Record<string, string>,
  execPath: '/app/mora',
  argv: [] as string[],
  cwd: () => '/',
  exit: () => {},
  on(ev: string, fn: (...a: unknown[]) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return process; },
  once(ev: string, fn: (...a: unknown[]) => void) { return process.on(ev, fn); },
  off(ev: string, fn: (...a: unknown[]) => void) { listeners.get(ev)?.delete(fn); return process; },
  removeListener(ev: string, fn: (...a: unknown[]) => void) { return process.off(ev, fn); },
  emitWarning: (...a: unknown[]) => console.warn(...a),
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign((prev?: [number, number]) => {
    const t = performance.now();
    const s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6);
    return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }),
  uptime: () => performance.now() / 1000,
  stdout: { write: (s: string) => (console.log(s), true), isTTY: false },
  stderr: { write: (s: string) => (console.warn(s), true), isTTY: false },
};
export { Buffer };
/** Node timers are objects with unref()/ref(); browser ids are numbers. Both clear the same way. */
class Timeout {
  constructor(readonly id: number) {}
  unref() { return this; }
  ref() { return this; }
  hasRef() { return true; }
  refresh() { return this; }
  [Symbol.toPrimitive]() { return this.id; }
}
const st = globalThis.setTimeout.bind(globalThis), si = globalThis.setInterval.bind(globalThis);
const ct = globalThis.clearTimeout.bind(globalThis), ci = globalThis.clearInterval.bind(globalThis);
const idOf = (t: unknown) => (t instanceof Timeout ? t.id : (t as number));
const _setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => new Timeout(st(fn, ms, ...args) as unknown as number);
const _setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => new Timeout(si(fn, ms, ...args) as unknown as number);
const _clearTimeout = (t: unknown) => ct(idOf(t));
const _clearInterval = (t: unknown) => ci(idOf(t));
export { _setTimeout as setTimeout, _setInterval as setInterval, _clearTimeout as clearTimeout, _clearInterval as clearInterval };
export const setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) => _setTimeout(fn, 0, ...args);
export const clearImmediate = _clearTimeout;
// The server iterates fetch bodies with for-await (Node can); WebKit's ReadableStream is not async-iterable.
const rsProto = globalThis.ReadableStream?.prototype as (ReadableStream<unknown> & { [Symbol.asyncIterator]?: unknown }) | undefined;
if (rsProto && !(Symbol.asyncIterator in rsProto)) {
  Object.defineProperty(rsProto, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream<unknown>) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally { reader.releaseLock(); }
    },
  });
}
// Not cross-origin isolated in the app: a plain buffer is enough for the analysis cancel flag.
export const SharedArrayBuffer = globalThis.SharedArrayBuffer ?? ArrayBuffer;
export const global = globalThis;
