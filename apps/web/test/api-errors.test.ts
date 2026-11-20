import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.ts';

afterEach(() => vi.unstubAllGlobals());

it('reports an unavailable local service in human language instead of the runtime text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(api.library()).rejects.toThrow('Нет связи с локальным сервером MORA');
});

it('turns a timed-out request into a retry hint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('signal timed out', 'TimeoutError'); }));
  await expect(api.library()).rejects.toThrow('Источник не ответил вовремя');
});

it('passes cancellation through so callers can ignore their own aborts', async () => {
  const abort = new DOMException('This operation was aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn(async () => { throw abort; }));
  await expect(api.library()).rejects.toBe(abort);
});
