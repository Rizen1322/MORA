import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSearchRoutes } from '../src/routes/search.ts';

it('keeps POST warmup alive after reading its body, but stops it on client disconnect', async () => {
  let entered!: () => void;
  let cancelled!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const stopped = new Promise<void>(r => { cancelled = r; });
  const warmup = vi.fn(async (_provider, id, signal: AbortSignal) => {
    if (id === 'first') {
      await new Promise(r => setTimeout(r, 40));
      return !signal.aborted;
    }
    entered();
    return new Promise<boolean>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve(false); }, { once: true }));
  });
  const app = Fastify();
  registerSearchRoutes(app, { publicMusic: { warmup } } as never);
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = (id: string, signal?: AbortSignal) => fetch(`${origin}/api/public/warmup`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'youtube', externalId: id }) });
    expect(await (await post('first')).json()).toEqual({ ready: true });
    const ctl = new AbortController();
    const rejected = expect(post('second', ctl.signal)).rejects.toThrow();
    await started;
    ctl.abort();
    await rejected;
    await stopped;
  } finally { await app.close(); }
});
