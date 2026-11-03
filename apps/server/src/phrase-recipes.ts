import { compilePhraseMix, type PhraseMixRecipe, type TransitionPlan } from '@automix/core';
import { integrateTempo } from '@automix/core/plan/timing.ts';
import type { Services } from './app.ts';
import { getSettings } from './automix.ts';
import { q } from './db.ts';
import { rustCompute, rustCorePath } from './rust-core.ts';

export interface RecipeContext { playlistId: string; fromItemId: number; toItemId: number }
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };

/** Capture the resolved recordings across asynchronous planning and decoding. */
export function recordingSnapshot(s: Services, from: string, to: string) {
  const a = s.lib.media(from), b = s.lib.media(to);
  if (!a || !b) return fail('Запись для перехода не найдена', 404);
  return { a: { id: a.id, hash: a.content_hash }, b: { id: b.id, hash: b.content_hash } };
}

export function assertRecordingsUnchanged(s: Services, from: string, to: string, before: ReturnType<typeof recordingSnapshot>) {
  const now = recordingSnapshot(s, from, to);
  if (now.a.id !== before.a.id || now.a.hash !== before.a.hash || now.b.id !== before.b.id || now.b.hash !== before.b.hash)
    return fail('Запись аудио изменилась. Откройте переход заново.', 409);
}

/** Stable playlist occurrences, rather than track IDs or mutable position indexes. */
export function recipeContext(raw: { playlistId?: unknown; fromItemId?: unknown; toItemId?: unknown }): RecipeContext | undefined {
  if (raw.playlistId === undefined && raw.fromItemId === undefined && raw.toItemId === undefined) return undefined;
  const { playlistId } = raw, fromItemId = Number(raw.fromItemId), toItemId = Number(raw.toItemId);
  if (typeof playlistId !== 'string' || !playlistId || !Number.isSafeInteger(fromItemId) || fromItemId <= 0
    || !Number.isSafeInteger(toItemId) || toItemId <= 0 || fromItemId === toItemId) return fail('Нужны плейлист и два разных вхождения треков');
  return { playlistId, fromItemId, toItemId };
}

export function playlistEdge(s: Services, context: RecipeContext) {
  const rows = q(s.db, 'SELECT id, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id')
    .all(context.playlistId) as { id: number; track_id: string }[];
  const at = rows.findIndex(r => r.id === context.fromItemId);
  if (at < 0 || rows[at + 1]?.id !== context.toItemId) return fail('Этот переход доступен только между соседними треками плейлиста', 409);
  const a = s.lib.media(rows[at].track_id), b = s.lib.media(rows[at + 1].track_id);
  if (!a || !b) return fail('Запись для перехода не найдена', 404);
  return { a, b, fromId: rows[at].track_id, toId: rows[at + 1].track_id };
}

export function readRecipe(s: Services, context: RecipeContext) {
  const edge = playlistEdge(s, context);
  const row = q(s.db, 'SELECT recipe, from_hash, to_hash FROM transition_recipes WHERE playlist_id = ? AND from_entry = ? AND to_entry = ?')
    .get(context.playlistId, context.fromItemId, context.toItemId) as { recipe: string; from_hash: string; to_hash: string } | undefined;
  const stale = !!row && (row.from_hash !== edge.a.content_hash || row.to_hash !== edge.b.content_hash);
  return { ...edge, audioHashes: { a: edge.a.content_hash, b: edge.b.content_hash }, recipe: row && !stale ? JSON.parse(row.recipe) as PhraseMixRecipe : null, stale };
}

/** Only persist the editable intent. Plans are recompiled against the actual recordings. */
export function compileRecipe(s: Services, base: TransitionPlan, recipe: PhraseMixRecipe): TransitionPlan {
  const a = s.lib.media(base.fromTrackId), b = s.lib.media(base.toTrackId);
  if (!a || !b) return fail('Запись для перехода не найдена', 404);
  if (recipe?.audioHashes && (recipe.audioHashes.a !== a.content_hash || recipe.audioHashes.b !== b.content_hash))
    return fail('Запись аудио изменилась. Откройте переход заново.', 409);
  if (s.lib.mixingPolicy.get(a.provider) !== true || s.lib.mixingPolicy.get(b.provider) !== true) return fail('Источник не поддерживает редактирование переходов', 409);
  let plan: TransitionPlan;
  try {
    const A = s.analysis.get(a.content_hash), B = s.analysis.get(b.content_hash);
    plan = rustCorePath() ? rustCompute<TransitionPlan>('phrase', { base, recipe, a: A, b: B }) : compilePhraseMix(base, recipe, A, B);
  }
  catch (error) { return fail((error as Error).message); }
  const endA = plan.aExit + integrateTempo(plan.tempoA, plan.duration);
  const endB = plan.bEntry + integrateTempo(plan.tempoB, plan.duration - (plan.bDelay ?? 0));
  if (endA > a.duration + 0.025 || endB > b.duration + 0.025) return fail('Переход выходит за границы аудиозаписи');
  return plan;
}

/** A reordered/shuffled/filtered queue never accidentally inherits another edge's recipe. */
export function applySavedRecipe(s: Services, base: TransitionPlan, context?: RecipeContext): TransitionPlan {
  if (!context || !getSettings(s.db).automix.enabled) return base;
  try {
    const saved = readRecipe(s, context);
    if (saved.fromId !== base.fromTrackId || saved.toId !== base.toTrackId || !saved.recipe) return base;
    const plan = compileRecipe(s, base, saved.recipe);
    return { ...plan, debug: { ...plan.debug, recipeContext: context } };
  } catch (error) {
    return { ...base, debug: { ...base.debug, recipeFallback: (error as Error).message } };
  }
}
