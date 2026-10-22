import { ANALYZER_VERSION, recommendNext, type RecPlay, type RecTrack, type WaveDiversity, type WaveMood, type WavePick } from '@automix/core';
import { PRIORITY, type AnalysisService } from './analysis.ts';
import { q, type Db } from './db.ts';
import type { Library } from './library.ts';

/** "Моя волна" on the user's own library: data plumbing around the pure recommender. */
export class WaveService {
  constructor(
    private readonly db: Db,
    private readonly lib: Library,
    private readonly analysis: AnalysisService,
  ) {}

  private library(): RecTrack[] {
    const feats = new Map(
      (
        q(this.db, "SELECT content_hash, summary FROM analysis WHERE version = ? AND status = 'done'").all(ANALYZER_VERSION) as {
          content_hash: string;
          summary: string;
        }[]
      ).map((r) => {
        const a = JSON.parse(r.summary || '{}');
        return [r.content_hash, { features: a.features ?? null, bpm: a.bpm ?? null, camelot: a.camelot || null }];
      }),
    );
    return this.lib.all().map((t) => {
      const f = feats.get(t.content_hash);
      return {
        id: t.id,
        artist: t.artist,
        album: t.album,
        genre: t.genre,
        features: f?.features ?? null,
        bpm: f?.bpm ?? null,
        camelot: f?.camelot ?? null,
        playCount: t.play_count,
        lastPlayedAt: t.last_played_at,
        available: t.status === 'ok',
      };
    });
  }

  next(input: { currentId: string | null; session: string[]; mood: WaveMood; diversity: WaveDiversity; mix?: boolean; count: number; exclude?: string[] }): WavePick[] {
    const reactions = q(this.db, 'SELECT track_id, value FROM reactions').all() as { track_id: string; value: number }[];
    const likes = new Set(reactions.filter((r) => r.value > 0).map((r) => r.track_id));
    const dislikes = new Set(reactions.filter((r) => r.value < 0).map((r) => r.track_id));
    const plays = (
      q(this.db, 'SELECT track_id, started_at, played_ms, duration_ms, end_reason FROM plays ORDER BY id DESC LIMIT 800').all() as {
        track_id: string;
        started_at: number;
        played_ms: number;
        duration_ms: number | null;
        end_reason: string | null;
      }[]
    ).map(
      (p): RecPlay => ({
        trackId: p.track_id,
        at: p.started_at,
        playedSeconds: p.played_ms / 1000,
        playedRatio: p.duration_ms ? Math.min(1, p.played_ms / p.duration_ms) : 0,
        skipped: p.end_reason === 'skip',
      }),
    );
    const picks = recommendNext(
      this.library(),
      { likes, dislikes, plays, now: Date.now() },
      { currentId: input.currentId, session: input.session.slice(-200), mood: input.mood, diversity: input.diversity, mix: input.mix, exclude: new Set(input.exclude ?? []) },
      Math.max(1, Math.min(10, input.count)),
    );
    // get candidates analyzed early so their transitions can be planned
    this.analysis.prioritize(
      picks.map((p) => p.id),
      PRIORITY.wave,
    );
    return picks;
  }
}
