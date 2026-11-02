import { expect, it, vi } from 'vitest';
import { NativeListening } from '../src/native-listening.ts';

it('closes a delayed history start once, tracks bounded audible position, and attributes Yandex feedback', async () => {
  let resolveStart!: (value: { id: number }) => void;
  const calls: { method: string; path: string; body: any }[] = [];
  const request = vi.fn((method: 'POST' | 'PATCH', path: string, body: object) => {
    calls.push({ method, path, body });
    if (path === '/api/plays') return new Promise<{ id: number }>(resolve => { resolveStart = resolve; });
    return Promise.resolve({});
  });
  const listening = new NativeListening(request);
  const entry = { entryId: 'entry', trackId: 'track', origin: 'yandex', yandexId: '1:2', yandexSessionId: 's', yandexBatchId: 'b', binding: false };
  listening.start(entry);
  listening.start(entry);
  listening.tick(1, true);
  listening.tick(100, true);
  listening.tick(120, false);
  listening.tick(121, true);
  listening.finish('transition');
  listening.finish();
  await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
  resolveStart({ id: 5 });
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls.map(c => c.path)).toEqual(['/api/plays', '/api/providers/yandex/feedback', '/api/plays/5', '/api/providers/yandex/feedback']);
  expect(calls[2].body).toEqual({ playedMs: 4000, endReason: 'transition' });
  expect(calls[3].body.event).toEqual({ type: 'trackFinished', trackId: '1:2', totalPlayedSeconds: 4 });
});

it('continues after request failures and never sends feedback for a bound or unknown recording', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ id: 7 });
  const listening = new NativeListening(request);
  const entry = { entryId: 'one', trackId: 'a', origin: 'yandex', yandexId: '1', yandexSessionId: 's', binding: true };
  listening.start(entry);
  listening.finish('skip');
  listening.start({ ...entry, entryId: 'two', binding: undefined });
  listening.finish('stop');
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.map(c => c[1])).toEqual(['/api/plays', '/api/plays', '/api/plays/7']);
});
