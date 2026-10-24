import { describe, expect, it, vi } from 'vitest';
import { SharedPreparation } from '../src/public/shared-preparation.ts';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe('shared audio preparation ownership', () => {
  it('cancelling an offline download leaves a concurrent listener alive, with progress', async () => {
    const shared = new SharedPreparation<string>();
    const ready = deferred<string>();
    const cancel = new AbortController();
    let signal!: AbortSignal, progress!: (n: number) => void;
    const work = vi.fn((s: AbortSignal, p: (n: number) => void) => { signal = s; progress = p; return ready.promise; });
    const first = shared.run('same', { signal: cancel.signal }, work);
    const report = vi.fn();
    const listener = shared.run('same', { onProgress: report }, work);
    const rejected = expect(first).rejects.toThrow();
    await Promise.resolve();
    cancel.abort(); await rejected;
    expect(signal.aborted).toBe(false);
    progress(.75); expect(report).toHaveBeenCalledWith(.75);
    ready.resolve('audio'); expect(await listener).toBe('audio');
    expect(work).toHaveBeenCalledOnce();
  });

  it('aborts a worker with no consumers, and an old completion cannot erase its replacement', async () => {
    const shared = new SharedPreparation<string>(), cancel = new AbortController();
    const old = deferred<string>(), next = deferred<string>();
    let signal!: AbortSignal;
    const first = shared.run('same', { signal: cancel.signal }, (s) => { signal = s; return old.promise; });
    const rejected = expect(first).rejects.toThrow();
    await Promise.resolve(); cancel.abort(); await rejected;
    expect(signal.aborted).toBe(true);
    const work = vi.fn(() => next.promise);
    const second = shared.run('same', {}, work);
    old.resolve('old'); await Promise.resolve(); await Promise.resolve();
    const third = shared.run('same', {}, work);
    next.resolve('new'); expect(await second).toBe('new'); expect(await third).toBe('new');
    expect(work).toHaveBeenCalledOnce();
  });
});
