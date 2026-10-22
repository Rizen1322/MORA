import { sanitizeSound, type SoundSettings } from '@automix/core';
import {
  ANALYZER_VERSION,
  DEFAULT_AUTOMIX_SETTINGS,
  PLANNER_VERSION,
  fnv1a,
  planSkip,
  planTransition,
  planRequestedTransition,
  type AutoMixSettings,
  type PlannerTrack,
  type TransitionPlan,
  type TransitionRating,
  type TransitionRatingReason,
  type TrackAnalysis,
} from '@automix/core';
import { PRIORITY, type AnalysisService } from './analysis.ts';
import { kvGet, q, type Db } from './db.ts';
import type { Library, TrackRow } from './library.ts';

export interface AppSettings {
  automix: AutoMixSettings;
  wave: { mood: 'calm' | 'normal' | 'energetic'; diversity: 'familiar' | 'balanced' | 'discover'; mode: 'normal' | 'mix'; yandexSeeds?: string[] };
  ui: { showDiagnostics: boolean; motion?: 'system'|'full'|'reduced'; graphics?: 'auto'|'canvas' };
  sound: SoundSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  automix: DEFAULT_AUTOMIX_SETTINGS,
  wave: { mood: 'normal', diversity: 'balanced', mode: 'normal' },
  ui: { showDiagnostics: false },
  sound: sanitizeSound(undefined),
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
  };
}

/** Plans transitions between tracks and caches/logs TransitionPlans. */
export class AutoMixService {
  constructor(
    private readonly db: Db,
    private readonly lib: Library,
    private readonly analysis: AnalysisService,
  ) {}

  private plannerTrack(t: TrackRow): PlannerTrack {
    return {
      id: t.id,
      duration: t.duration,
      album: t.album || null,
      albumArtist: t.album_artist || t.artist || null,
      trackNo: t.track_no,
      discNo: t.disc_no,
      mixingAllowed: this.lib.mixingPolicy.get(t.provider) ?? false,
      analysis: this.analysis.get(t.content_hash),
    };
  }

  plan(fromId: string, toId: string): { plan: TransitionPlan; cached: boolean; pending: string[] } {
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
    const key = fnv1a(
      [a.id, b.id, a.content_hash, b.content_hash, ANALYZER_VERSION, PLANNER_VERSION, JSON.stringify(settings), pa.mixingAllowed, pb.mixingAllowed,
        a.album, b.album, pa.albumArtist, pb.albumArtist, a.track_no, b.track_no, a.disc_no, b.disc_no, !!pa.analysis, !!pb.analysis,
        vocalKey(pa.analysis?.vocalActivity),vocalKey(pb.analysis?.vocalActivity)].join('|'),
    );
    const row = q(this.db, 'SELECT plan FROM transition_cache WHERE key = ?').get(key) as { plan: string } | undefined;
    if (row) {
      q(this.db, 'UPDATE transition_cache SET used_at = ? WHERE key = ?').run(Date.now(), key);
      return { plan: JSON.parse(row.plan), cached: true, pending };
    }
    const plan = planTransition(pa, pb, settings);
    // only plans built on finished analysis are worth caching
    if (!pending.length) {
      q(this.db, 'INSERT OR REPLACE INTO transition_cache(key, plan_id, from_hash, to_hash, plan, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        key,
        plan.id,
        a.content_hash,
        b.content_hash,
        JSON.stringify(plan),
        Date.now(),
        Date.now(),
      );
      this.prune();
    }
    return { plan, cached: false, pending };
  }

  skip(fromId: string, toId: string, position: number): TransitionPlan {
    const a = this.lib.get(fromId);
    const b = this.lib.get(toId);
    if (!a || !b) throw new Error('трек не найден');
    return planSkip(this.plannerTrack(a), this.plannerTrack(b), position, getSettings(this.db).automix);
  }

  requested(fromId:string,toId:string,position:number):TransitionPlan {
    const a=this.lib.get(fromId),b=this.lib.get(toId);
    if(!a||!b)throw new Error('трек не найден');
    return planRequestedTransition(this.plannerTrack(a),this.plannerTrack(b),position,getSettings(this.db).automix);
  }

  log(entry: { plan: TransitionPlan; outcome: Record<string, unknown> }): number {
    const { lastInsertRowid } = q(this.db, 'INSERT INTO transition_log(plan_id, from_track, to_track, method, executed_at, outcome, plan) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      entry.plan.id,
      entry.plan.fromTrackId,
      entry.plan.toTrackId,
      entry.plan.method,
      Date.now(),
      JSON.stringify(entry.outcome ?? {}),
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
