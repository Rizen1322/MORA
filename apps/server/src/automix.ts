import { sanitizeSound, type SoundSettings } from '@automix/core';
import {
  ANALYZER_VERSION,
  DEFAULT_AUTOMIX_SETTINGS,
  PLANNER_VERSION,
  chooseByRender,
  finalistSpans,
  fnv1a,
  planFinalistsSteps,
  planSkip,
  planTransition,
  planRequestedTransition,
  ratingFeatures,
  ratingStats,
  stepAsync,
  type AutoMixSettings,
  type PcmSpan,
  type PlannerTrack,
  type RatingStats,
  type TransitionPlan,
  type TransitionRating,
  type TransitionRatingReason,
  type TrackAnalysis,
} from '@automix/core';
import { PRIORITY, type AnalysisService } from './analysis.ts';
import { kvGet, q, type Db } from './db.ts';
import type { Library, TrackRow } from './library.ts';
import { reviewedGeometryHash, type ReviewedPlanResolver } from './reviewed-transitions.ts';
import { rustCompute, rustComputeAsync, rustCorePath } from './rust-core.ts';
import { measureRust } from './rust-render.ts';

export interface AppSettings {
  automix: AutoMixSettings;
  /** continueRadio: a finished queue goes on as a station of similar music. */
  wave: { mood: 'calm' | 'normal' | 'energetic'; diversity: 'familiar' | 'balanced' | 'discover'; mode: 'normal' | 'mix'; yandexSeeds?: string[]; continueRadio: boolean };
  ui: { showDiagnostics: boolean; motion?: 'system'|'full'|'reduced'; graphics?: 'auto'|'canvas' };
  sound: SoundSettings;
  yandex: YandexIntegrationSettings;
  /** autoLiked: liking an online track also downloads it for offline listening. */
  downloads: { autoLiked: boolean };
  /** onlyWhenIdle (desktop, default on there): the whole library is analyzed only while the computer is idle
   * and on mains power; the current and next tracks always are. */
  analysis: { onlyWhenIdle: boolean };
}

/** What the connected Yandex Music account is used for. Every switch defaults to on. */
export interface YandexIntegrationSettings {
  syncLikes: boolean;
  syncDislikes: boolean;
  importLikes: boolean;
  waveFeedback: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  automix: DEFAULT_AUTOMIX_SETTINGS,
  wave: { mood: 'normal', diversity: 'balanced', mode: 'normal', continueRadio: true },
  ui: { showDiagnostics: false },
  sound: sanitizeSound(undefined),
  yandex: { syncLikes: true, syncDislikes: true, importLikes: true, waveFeedback: true },
  downloads: { autoLiked: false },
  analysis: { onlyWhenIdle: false },
};

const vocalKeys = new WeakMap<object, string>();
function vocalKey(activity: TrackAnalysis['vocalActivity']): string {
  if (!activity) return '';
  // New PCM can have new activity with the same model and feature schema.
  let key = vocalKeys.get(activity);
  if (!key) { key = fnv1a(JSON.stringify(activity)); vocalKeys.set(activity, key); }
  return key;
}

export function getSettings(db: Db): AppSettings {
  const s = kvGet<Partial<AppSettings> & { version?: number }>(db, 'settings', {});
  if (s.automix && (s.version ?? 1) < 2) {
    // v2: long beatmatched glides became the default; lift values that were the old defaults
    if (s.automix.maxStretchPercent === 6) s.automix.maxStretchPercent = 12;
    if (s.automix.maxBlendSeconds === 24) s.automix.maxBlendSeconds = 32;
    if (s.automix.loudnessTarget === -14) s.automix.loudnessTarget = -16;
  }
  return {
    automix: { ...DEFAULT_SETTINGS.automix, ...(s.automix ?? {}) },
    wave: { ...DEFAULT_SETTINGS.wave, ...(s.wave ?? {}) },
    ui: { ...DEFAULT_SETTINGS.ui, motion: process.env.AUTOMIX_DESKTOP === '1' ? 'full' : 'system', ...(s.ui ?? {}) },
    // Older settings have no sound section: flat and bypassed.
    sound: sanitizeSound(s.sound),
    // Older settings predate the integration switches: everything stays enabled.
    yandex: { ...DEFAULT_SETTINGS.yandex, ...(s.yandex ?? {}) },
    downloads: { ...DEFAULT_SETTINGS.downloads, ...(s.downloads ?? {}) },
    // only the desktop app reports idle and mains power
    analysis: { ...DEFAULT_SETTINGS.analysis, onlyWhenIdle: process.env.AUTOMIX_DESKTOP === '1', ...(s.analysis ?? {}) },
  };
}

/** Plans transitions between tracks and caches/logs TransitionPlans. */
export class AutoMixService {
  constructor(
    private readonly db: Db,
    private readonly lib: Library,
    private readonly analysis: AnalysisService,
    private readonly reviewed?: ReviewedPlanResolver,
  ) {}

  private plannerTrack(t: TrackRow): PlannerTrack {
    const analysis = this.analysis.get(t.content_hash);
    return {
      id: t.id,
      duration: t.duration,
      album: t.album || null,
      albumArtist: t.album_artist || t.artist || null,
      trackNo: t.track_no,
      discNo: t.disc_no,
      mixingAllowed: this.lib.mixingPolicy.get(t.provider) ?? false,
      // Desktop mixes original recordings; old separation metadata must not reactivate vocal cuts.
      analysis: process.env.AUTOMIX_DESKTOP === '1' && analysis ? { ...analysis, vocalActivity: undefined } : analysis,
    };
  }

  plan(fromId: string, toId: string): { plan: TransitionPlan; cached: boolean; pending: string[] } {
    const r = this.prepare(fromId, toId);
    if ('plan' in r) return r;
    const plan = rustCorePath() ? rustCompute<TransitionPlan>('plan', { from: r.pa, to: r.pb, settings: r.settings, feedback: r.feedback }) : planTransition(r.pa, r.pb, r.settings, undefined, r.feedback);
    if (!r.pending.length) this.store(r.key, plan, r.a.content_hash, r.b.content_hash);
    return { plan, cached: false, pending: r.pending };
  }

  /** Prepares the musical choice without decoding a playlist; playback still verifies it on PCM. */
  async preplan(fromId: string, toId: string): Promise<void> {
    const r = this.prepare(fromId, toId);
    if ('plan' in r || r.pending.length) return;
    const plan = rustCorePath() ? await rustComputeAsync<TransitionPlan>('plan', { from: r.pa, to: r.pb, settings: r.settings, feedback: r.feedback })
      : planTransition(r.pa, r.pb, r.settings, undefined, r.feedback);
    this.store(r.key, { ...plan, debug: { ...plan.debug, renderCheck: { policy: 'render-finalists-2', skipped: 'pcm-not-ready' } } }, r.a.content_hash, r.b.content_hash);
  }

  /** P10: a full-mix pair (a voice unknown) renders its finalists on PCM that is already decoding and
   * keeps the planner's choice unless it fails technically. Without that PCM the planner's choice is
   * cached marked as unchecked and checked by a later request; other pairs behave exactly like plan(). */
  async planChecked(fromId: string, toId: string, read: (trackId: string, from: number, to: number) => Promise<PcmSpan | null>): Promise<{ plan: TransitionPlan; cached: boolean; pending: string[] }> {
    const cached = this.prepare(fromId, toId);
    const unchecked = 'plan' in cached && !!(cached.plan.debug.renderCheck as { skipped?: string } | undefined)?.skipped;
    if ('plan' in cached && !unchecked) return cached;
    const r = unchecked ? this.prepare(fromId, toId, true) : cached;
    if ('plan' in r) return r;
    // stepped: the iPhone app's in-process server keeps answering PCM reads while this plans
    const finalists = rustCorePath()
      ? r.pending.length ? [await rustComputeAsync<TransitionPlan>('plan', { from: r.pa, to: r.pb, settings: r.settings, feedback: r.feedback })]
        : await rustComputeAsync<TransitionPlan[]>('plan', { from: r.pa, to: r.pb, settings: r.settings, feedback: r.feedback, mode: 'finalists' })
      : r.pending.length ? [planTransition(r.pa, r.pb, r.settings, undefined, r.feedback)] : await stepAsync(planFinalistsSteps(r.pa, r.pb, r.settings, r.feedback));
    if (finalists.length < 2) {
      if (!r.pending.length) this.store(r.key, finalists[0], r.a.content_hash, r.b.content_hash);
      return { plan: finalists[0], cached: false, pending: r.pending };
    }
    const spans = finalistSpans(finalists);
    // iPhone hot or in Low Power Mode (set by apps/mobile): the 2-5 renders wait like missing PCM does
    const saver = process.env.MORA_POWER_SAVER === '1';
    const [sa, sb] = saver ? [null, null] : await Promise.all([read(fromId, ...spans.a), read(toId, ...spans.b)]).catch(() => [null, null]);
    if (!sa || !sb || sa.pcm.sampleRate !== sb.pcm.sampleRate) {
      if (unchecked) return cached as { plan: TransitionPlan; cached: true; pending: string[] };
      const skipped = { ...finalists[0], debug: { ...finalists[0].debug, renderCheck: { policy: 'render-finalists-2', skipped: 'pcm-not-ready' } } };
      this.store(r.key, skipped, r.a.content_hash, r.b.content_hash);
      return { plan: skipped, cached: false, pending: r.pending };
    }
    let plan = finalists[0];
    try { plan = await chooseByRender(finalists, sa, sb, rustCorePath() ? measureRust : undefined); } catch { /* a failed check keeps the planner's choice */ }
    this.store(r.key, plan, r.a.content_hash, r.b.content_hash);
    return { plan, cached: false, pending: r.pending };
  }

  private prepare(fromId: string, toId: string, ignoreCache = false): { plan: TransitionPlan; cached: true; pending: string[] }
    | { a: TrackRow; b: TrackRow; pa: PlannerTrack; pb: PlannerTrack; settings: AutoMixSettings; feedback: RatingStats | null; key: string; pending: string[] } {
    const a = this.lib.get(fromId);
    const b = this.lib.get(toId);
    if (!a || !b) throw new Error('трек не найден');
    const settings = getSettings(this.db).automix;
    const pa = this.plannerTrack(a);
    const pb = this.plannerTrack(b);
    const pending: string[] = [];
    if (!pa.analysis && pa.mixingAllowed) pending.push(a.id);
    if (!pb.analysis && pb.mixingAllowed) pending.push(b.id);
    if (pending.length) this.analysis.prioritize(pending, PRIORITY.next);
    // Exact local approvals are resolved before the general cache. Removing or
    // changing the catalog must not leave a reviewed plan stuck in that cache.
    const reviewed = this.reviewed?.resolve(pa, pb, a.content_hash, b.content_hash, settings);
    if (reviewed && !this.reviewedRejected(reviewed)) return { plan: reviewed, cached: true, pending: [] };
    const feedback = this.ratingStats();
    const key = fnv1a(
      // Invalidate automatic choices while preserving the exact IDs of listener-approved plans.
      [a.id, b.id, a.content_hash, b.content_hash, ANALYZER_VERSION, PLANNER_VERSION, 'transition-styles-7-echo-flavors', JSON.stringify(settings), pa.mixingAllowed, pb.mixingAllowed,
        ...(process.env.AUTOMIX_DESKTOP === '1' ? ['desktop-full-mix-1'] : []),
        a.album, b.album, pa.albumArtist, pb.albumArtist, a.track_no, b.track_no, a.disc_no, b.disc_no, !!pa.analysis, !!pb.analysis,
        // new ratings make new plans; without any the key stays as before
        vocalKey(pa.analysis?.vocalActivity),vocalKey(pb.analysis?.vocalActivity), ...(feedback ? [feedback.version] : [])].join('|'),
    );
    const row = q(this.db, 'SELECT plan FROM transition_cache WHERE key = ?').get(key) as { plan: string } | undefined;
    if (row && !ignoreCache) {
      q(this.db, 'UPDATE transition_cache SET used_at = ? WHERE key = ?').run(Date.now(), key);
      return { plan: JSON.parse(row.plan) as TransitionPlan, cached: true, pending };
    }
    return { a, b, pa, pb, settings, feedback, key, pending };
  }

  private feedback: { sig: string; stats: RatingStats | null } | null = null;

  /** A new dislike of this exact reviewed recording/plan takes precedence. */
  private reviewedRejected(plan: TransitionPlan): boolean {
    const identity = plan.debug.reviewedTransition as { sourcePlanSha256: string; fromHash: string; toHash: string; geometrySha256: string };
    const rows = q(this.db, 'SELECT plan,rating,outcome FROM transition_log WHERE rating IS NOT NULL ORDER BY id DESC').all() as { plan: string; rating: string; outcome: string }[];
    for (const row of rows) {
      try {
        const executed = JSON.parse(row.plan) as TransitionPlan, outcome = JSON.parse(row.outcome), previous = executed.debug?.reviewedTransition as typeof identity;
        if (outcome?.forced === true || outcome?.late === true) continue;
        if (previous?.sourcePlanSha256 === identity.sourcePlanSha256 && previous.fromHash === identity.fromHash && previous.toHash === identity.toHash
          && reviewedGeometryHash(executed) === identity.geometrySha256)
          return row.rating === 'bad';
      } catch { /* Damaged history cannot activate or reject a preference. */ }
    }
    return false;
  }

  /** Fingerprint the evidence itself: reason/rating edits can share the same millisecond. */
  ratingStats(): RatingStats | null {
    const rows = q(this.db, 'SELECT from_track, to_track, plan, outcome, rating, rating_reason FROM transition_log WHERE rating IS NOT NULL ORDER BY id').all() as
      { from_track: string | null; to_track: string | null; plan: string; outcome: string; rating: TransitionRating; rating_reason: TransitionRatingReason | null }[];
    const sig = fnv1a(JSON.stringify(rows));
    if (this.feedback?.sig === sig) return this.feedback.stats;
    // the tempo of an unlocked pair comes from the small analysis summary, not the whole analysis
    const tempoOf = (id: string | null) => {
      const t = id ? this.lib.get(id) : undefined;
      const row = t && q(this.db, "SELECT summary FROM analysis WHERE content_hash = ? AND status = 'done' AND summary IS NOT NULL ORDER BY version = ? DESC, updated_at DESC LIMIT 1")
        .get(t.content_hash, ANALYZER_VERSION) as { summary: string } | undefined;
      let bpm: unknown = null;
      try { bpm = row ? (JSON.parse(row.summary) as { bpm?: number | null }).bpm : null; } catch { /* damaged historical summary stays unknown */ }
      return { beat: typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? { bpm } : null };
    };
    const rated = rows.flatMap((r) => {
      let plan: TransitionPlan;
      try { plan = JSON.parse(r.plan) as TransitionPlan; } catch { return []; }
      if (!plan?.method) return [];
      if (r.rating !== 'good' && r.rating !== 'bad') return [];
      let outcome: Record<string, unknown> = {};
      try { outcome = JSON.parse(r.outcome) ?? {}; } catch { /* older logs need no execution context */ }
      const snapshot = outcome.listenerFeatures as { version?: number; features?: unknown } | undefined;
      const features = snapshot?.version === 4 && Array.isArray(snapshot.features) && snapshot.features.every(f => typeof f === 'string')
        ? snapshot.features as string[]
        : ratingFeatures(plan, plan.beatAlign ? null : tempoOf(r.from_track), plan.beatAlign ? null : tempoOf(r.to_track), { outcome });
      return [{ rating: r.rating, reason: r.rating_reason, features }];
    });
    const stats = ratingStats(rated);
    this.feedback = { sig, stats };
    return stats;
  }

  /** Only plans built on finished analysis are worth caching. */
  private store(key: string, plan: TransitionPlan, fromHash: string, toHash: string): void {
    q(this.db, 'INSERT OR REPLACE INTO transition_cache(key, plan_id, from_hash, to_hash, plan, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      key, plan.id, fromHash, toHash, JSON.stringify(plan), Date.now(), Date.now());
    this.prune();
  }

  skip(fromId: string, toId: string, position: number): TransitionPlan {
    const a = this.lib.get(fromId);
    const b = this.lib.get(toId);
    if (!a || !b) throw new Error('трек не найден');
    const from = this.plannerTrack(a), to = this.plannerTrack(b), settings = getSettings(this.db).automix;
    return rustCorePath() ? rustCompute<TransitionPlan>('plan', { from, to, position, settings, mode: 'skip' }) : planSkip(from, to, position, settings);
  }

  /** catchUp: the prepared AutoMix point is already behind the playhead (a seek): plan the same musical
   * moves from here even when Next itself is set to skip (mixOnNext off). */
  requested(fromId:string,toId:string,position:number,catchUp=false):TransitionPlan {
    const a=this.lib.get(fromId),b=this.lib.get(toId);
    if(!a||!b)throw new Error('трек не найден');
    const from = this.plannerTrack(a), to = this.plannerTrack(b), saved = getSettings(this.db).automix, settings = catchUp ? { ...saved, mixOnNext: true } : saved;
    return rustCorePath() ? rustCompute<TransitionPlan>('plan', { from, to, position, settings, mode: 'requested' }) : planRequestedTransition(from,to,position,settings);
  }

  async manualAsync(fromId: string, toId: string, position: number, mode: 'skip' | 'requested', catchUp = false): Promise<TransitionPlan> {
    if (!rustCorePath()) return mode === 'skip' ? this.skip(fromId, toId, position) : this.requested(fromId, toId, position, catchUp);
    const a = this.lib.get(fromId), b = this.lib.get(toId);
    if (!a || !b) throw new Error('трек не найден');
    const saved = getSettings(this.db).automix;
    return rustComputeAsync<TransitionPlan>('plan', { from: this.plannerTrack(a), to: this.plannerTrack(b),
      position, settings: catchUp && mode === 'requested' ? { ...saved, mixOnNext: true } : saved, mode });
  }

  log(entry: { plan: TransitionPlan; outcome: Record<string, unknown> }): number {
    const analysisOf = (id: string) => {
      const track = this.lib.get(id);
      return track ? this.analysis.get(track.content_hash) : null;
    };
    const outcome = { ...entry.outcome, listenerFeatures: { version: 4, features: ratingFeatures(entry.plan,
      analysisOf(entry.plan.fromTrackId), analysisOf(entry.plan.toTrackId), { outcome: entry.outcome }) } };
    const { lastInsertRowid } = q(this.db, 'INSERT INTO transition_log(plan_id, from_track, to_track, method, executed_at, outcome, plan) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      entry.plan.id,
      entry.plan.fromTrackId,
      entry.plan.toTrackId,
      entry.plan.method,
      Date.now(),
      JSON.stringify(outcome),
      JSON.stringify(entry.plan),
    );
    // Listener ratings are scarce feedback: never prune rated rows.
    q(this.db, 'DELETE FROM transition_log WHERE rating IS NULL AND id NOT IN (SELECT id FROM transition_log ORDER BY id DESC LIMIT 500)').run();
    return Number(lastInsertRowid);
  }

  /** Stores (or clears, with null) the listener rating of one executed transition. False when the row is gone. */
  rate(id: number, rating: TransitionRating | null, reason: TransitionRatingReason | null): boolean {
    return q(this.db, 'UPDATE transition_log SET rating = ?, rating_reason = ?, rated_at = ? WHERE id = ?').run(
      rating, rating === 'bad' ? reason : null, rating ? Date.now() : null, id).changes > 0;
  }

  recent(limit = 30): unknown[] {
    const rows = q(this.db, 'SELECT * FROM transition_log ORDER BY id DESC LIMIT ?').all(limit) as {
      id: number;
      plan_id: string;
      from_track: string;
      to_track: string;
      method: string;
      executed_at: number;
      outcome: string;
      plan: string;
      rating: TransitionRating | null;
      rating_reason: TransitionRatingReason | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      fromTrackId: r.from_track,
      toTrackId: r.to_track,
      method: r.method,
      executedAt: r.executed_at,
      outcome: JSON.parse(r.outcome),
      plan: JSON.parse(r.plan),
      rating: r.rating,
      ratingReason: r.rating_reason,
    }));
  }

  private prune(): void {
    q(this.db, 'DELETE FROM transition_cache WHERE key NOT IN (SELECT key FROM transition_cache ORDER BY used_at DESC LIMIT 2000)').run();
  }

  clearCache(): void {
    q(this.db, 'DELETE FROM transition_cache').run();
  }
}
