import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

it('radio failures do not block search, and the cooldown recovers', async () => {
  vi.useFakeTimers();
  const { setYtmTransport, searchYtm, radioYtm } = await import('../src/public/ytmusic.ts');
  const fetcher = vi.fn(async (url: unknown) => new Response('{}', { status: String(url).includes('/next?') ? 503 : 200 }));
  setYtmTransport(fetcher);
  for (let i = 0; i < 3; i++) await expect(radioYtm('abcdefghijk')).rejects.toThrow('503');
  await expect(searchYtm('test', 'song')).resolves.toEqual([]);
  await expect(radioYtm('abcdefghijk')).rejects.toThrow('временно');
  expect(fetcher).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(15_001);
  await expect(radioYtm('abcdefghijk')).rejects.toThrow('503');
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('does not start an already cancelled request', async () => {
  const { setYtmTransport, searchYtm } = await import('../src/public/ytmusic.ts');
  const fetcher = vi.fn();
  setYtmTransport(fetcher);
  await expect(searchYtm('test', 'song', AbortSignal.abort())).rejects.toThrow('Отменено');
  expect(fetcher).not.toHaveBeenCalled();
});
