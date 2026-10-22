import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import type { Candidate } from '../public/imports.ts';

export function registerImportRoutes(app: FastifyInstance, s: Services): void {
  const { imports } = s;
  app.get('/api/imports', async () => ({ jobs: imports.list() }));
  app.get<{ Params: { id: string } }>('/api/imports/:id', async (req, reply) => imports.get(req.params.id) ?? reply.code(404).send({ error: 'импорт не найден' }));
  app.post<{ Body: { url?: string; file?: { name?: string; text?: string } } }>('/api/imports', async (req, reply) => {
    try {
      if (req.body?.url) return await imports.fromUrl(String(req.body.url).slice(0, 2000));
      if (req.body?.file?.text) return imports.fromFile(String(req.body.file.name ?? 'Импорт').slice(0, 200), String(req.body.file.text));
      return reply.code(400).send({ error: 'нужна ссылка или файл' });
    } catch (e) { return reply.code(422).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { position: number; choice: { trackId: string } | Candidate | null } }>('/api/imports/:id/resolve', async (req, reply) => {
    try { return imports.resolve(req.params.id, Number(req.body?.position), req.body?.choice ?? null); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { includeUncertain?: boolean } }>('/api/imports/:id/playlist', async (req, reply) => {
    try { return imports.createPlaylist(req.params.id, req.body?.includeUncertain === true); }
    catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>('/api/imports/:id', async (req) => { imports.remove(req.params.id); return { ok: true }; });
}
