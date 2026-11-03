import type { FastifyInstance } from 'fastify';
import type { PhraseMixRecipe } from '@automix/core';
import type { Services } from '../app.ts';
import { assertRecordingsUnchanged, compileRecipe, playlistEdge, readRecipe, recipeContext, recordingSnapshot, type RecipeContext } from '../phrase-recipes.ts';
import { q } from '../db.ts';

export function registerPhraseRecipeRoutes(app: FastifyInstance, s: Services): void {
  const required = (raw: Parameters<typeof recipeContext>[0]): RecipeContext => {
    const context = recipeContext(raw);
    if (!context) throw Object.assign(new Error('Не указан переход плейлиста'), { statusCode: 400 });
    return context;
  };
  app.get<{ Querystring: RecipeContext }>('/api/automix/recipe', async (req, reply) => {
    try { const { recipe, stale, audioHashes } = readRecipe(s, required(req.query)); return { recipe, stale, audioHashes }; }
    catch (error) { const e = error as Error & { statusCode?: number }; return reply.code(e.statusCode ?? 400).send({ error: e.message }); }
  });
  app.put<{ Body: RecipeContext & { recipe: PhraseMixRecipe } }>('/api/automix/recipe', async (req, reply) => {
    try {
      const c = required(req.body ?? {}), { a, b, fromId, toId } = playlistEdge(s, c);
      const { plan: base } = await s.automix.planChecked(a.id, b.id, async () => null);
      if (!req.body.recipe || typeof req.body.recipe !== 'object') return reply.code(400).send({ error: 'Не указан сценарий перехода' });
      if (req.body.recipe.audioHashes && (req.body.recipe.audioHashes.a !== a.content_hash || req.body.recipe.audioHashes.b !== b.content_hash))
        return reply.code(409).send({ error: 'Запись аудио изменилась. Откройте переход заново.' });
      let recipe: PhraseMixRecipe = { ...req.body.recipe,
        tempo: req.body.recipe.tempo ?? { a: base.tempoA, b: base.tempoB },
        audioHashes: { a: a.content_hash, b: b.content_hash } };
      if (recipe.timing?.unit === 'bars') {
        if (recipe.timing.resolvedDuration !== undefined && (!Number.isFinite(recipe.timing.resolvedDuration)
          || recipe.timing.resolvedDuration < 0.5 || recipe.timing.resolvedDuration > 64))
          return reply.code(400).send({ error: 'Некорректная длительность перехода' });
        const saved = readRecipe(s, c).recipe;
        const savedTiming = saved?.timing;
        const retain = savedTiming?.unit === 'bars' && savedTiming.bars === recipe.timing.bars
          && savedTiming.resolvedDuration !== undefined && savedTiming.resolvedDuration === recipe.timing.resolvedDuration
          && JSON.stringify(saved?.tempo) === JSON.stringify(recipe.tempo);
        // A client cannot submit its own resolved length; only preserve a previously saved one.
        const timing = { unit: 'bars' as const, bars: recipe.timing.bars, ...(retain ? { resolvedDuration: savedTiming.resolvedDuration } : {}) };
        recipe = { ...recipe, timing };
        const resolved = compileRecipe(s, base, recipe).duration;
        recipe = { ...recipe, timing: { ...timing, resolvedDuration: resolved } };
      }
      const plan = compileRecipe(s, base, recipe);
      // Planning yields; ensure the occurrences and recordings still name this exact adjacent pair.
      const current = playlistEdge(s, c);
      if (current.fromId !== fromId || current.toId !== toId || current.a.content_hash !== a.content_hash || current.b.content_hash !== b.content_hash)
        return reply.code(409).send({ error: 'Пара треков изменилась. Откройте переход заново.' });
      q(s.db, `INSERT OR REPLACE INTO transition_recipes(playlist_id, from_entry, to_entry, from_hash, to_hash, recipe, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.playlistId, c.fromItemId, c.toItemId, a.content_hash, b.content_hash, JSON.stringify(recipe), Date.now());
      s.events.emit({ type: 'transition-recipe', playlistId: c.playlistId });
      return { recipe, plan: { ...plan, fromTrackId: fromId, toTrackId: toId } };
    } catch (error) { const e = error as Error & { statusCode?: number }; return reply.code(e.statusCode ?? 400).send({ error: e.message }); }
  });
  app.delete<{ Querystring: RecipeContext }>('/api/automix/recipe', async (req, reply) => {
    try {
      const c = required(req.query);
      q(s.db, 'DELETE FROM transition_recipes WHERE playlist_id = ? AND from_entry = ? AND to_entry = ?').run(c.playlistId, c.fromItemId, c.toItemId);
      s.events.emit({ type: 'transition-recipe', playlistId: c.playlistId });
      return { ok: true };
    } catch (error) { const e = error as Error & { statusCode?: number }; return reply.code(e.statusCode ?? 400).send({ error: e.message }); }
  });
  app.post<{ Body: { from: string; to: string; recipe?: PhraseMixRecipe } }>('/api/automix/phrase-plan', async (req, reply) => {
    try {
      const { from, to, recipe } = req.body ?? {};
      if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return reply.code(400).send({ error: 'Нужны два трека' });
      const recordings = recordingSnapshot(s, from, to);
      const result = await s.automix.planChecked(s.lib.mediaId(from), s.lib.mediaId(to), async () => null);
      assertRecordingsUnchanged(s, from, to, recordings);
      const plan = recipe === undefined ? result.plan : compileRecipe(s, result.plan, recipe);
      return { ...result, cached: recipe === undefined && result.cached, plan: { ...plan, fromTrackId: from, toTrackId: to } };
    } catch (error) { const e = error as Error & { statusCode?: number }; return reply.code(e.statusCode ?? 400).send({ error: e.message }); }
  });
}
