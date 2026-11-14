import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerYandexLikesImportRoutes } from '../src/routes/yandex-likes-import.ts';
import type { Services } from '../src/app.ts';

it('wraps an absent or active import for native screens while preserving the existing response', async () => {
  const app = Fastify();
  let job: { state: string; done: number } | null = null;
  registerYandexLikesImportRoutes(app, { yandexLikesImport: { status: () => job } } as unknown as Services);
  try {
    expect((await app.inject('/api/providers/yandex/likes/import?envelope=1')).json()).toEqual({ job: null });
    job = { state: 'running', done: 3 };
    expect((await app.inject('/api/providers/yandex/likes/import?envelope=1')).json()).toEqual({ job });
    expect((await app.inject('/api/providers/yandex/likes/import')).json()).toEqual(job);
  } finally { await app.close(); }
});
