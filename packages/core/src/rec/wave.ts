import { camelotCompatibility } from '../mir/key.ts';
import { LOCK_MAX_PERCENT, tempoRelation } from '../plan/planner.ts';
import type { TrackFeatures } from '../types.ts';

/**
 * "Моя волна": a personal, endless recommendation stream over the user's own
 * library. Pure function of the library, reactions and listening history, so it
 * can be unit tested and moved to a mobile client unchanged.
 */

export interface RecTrack {
  id: string;
  artist: string;
  album: string;
  genre: string;
  features: TrackFeatures | null;
  bpm: number | null;
  camelot: string | null;
  playCount: number;
  lastPlayedAt: number | null;
  available: boolean;
}

export interface RecPlay {
  trackId: string;
  at: number;
  /** played / duration, 0..1 */
  playedRatio: number;
  playedSeconds: number;
  skipped: boolean;
}

export interface RecSignals {
  likes: Set<string>;
  dislikes: Set<string>;
  plays: RecPlay[];
  now: number;
}

export type WaveMood = 'calm' | 'normal' | 'energetic';
export type WaveDiversity = 'familiar' | 'balanced' | 'discover';

export interface WaveContext {
  currentId: string | null;
  /** Track ids already played or queued in this wave session, oldest first. */
  session: string[];
  mood: WaveMood;
  diversity: WaveDiversity;
  exclude?: Set<string>;
  /** "Волна для микса": prefer next tracks that AutoMix can beatmatch with the current one. */
  mix?: boolean;
}

export interface WavePick {
  id: string;
  score: number;
  reasons: string[];
  components: Record<string, number>;
}

const DAY = 86400000;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

function vec(t: RecTrack): number[] | null {
  const f = t.features;
  if (!f) return null;
  let tempo = 0.5;
  if (t.bpm && t.bpm > 0) {
    let b = t.bpm;
    while (b >= 140) b /= 2;
    while (b < 70) b *= 2;
    tempo = Math.log2(b / 70);
  }
  return [f.energy, f.brightness, f.rhythmStrength, f.onsetRate, f.bassWeight, f.midDensity, f.dynamics, f.acousticness, tempo];
}

function similarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return 0.5;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  return clamp(1 - Math.sqrt(d / a.length) * 2.2);
}

interface Profile {
  pos: number[] | null;
  neg: number[] | null;
  weight: number;
  artist: Map<string, number>;
  genre: Map<string, number>;
  meanEnergy: number;
}

function buildProfile(tracks: Map<string, RecTrack>, sig: RecSignals): Profile {
  const w = new Map<string, number>();
  const add = (id: string, x: number) => w.set(id, (w.get(id) ?? 0) + x);
  for (const id of sig.likes) add(id, 3);
  for (const id of sig.dislikes) add(id, -3);
  for (const p of sig.plays) {
    const decay = Math.pow(0.5, (sig.now - p.at) / (21 * DAY));
    if (p.skipped && (p.playedSeconds < 30 || p.playedRatio < 0.25)) add(p.trackId, -1.2 * decay);
    else if (p.playedRatio >= 0.8) add(p.trackId, 1 * decay);
    else if (p.playedRatio >= 0.5) add(p.trackId, 0.5 * decay);
  }
  const dims = 9;
  const pos = new Array<number>(dims).fill(0);
  const neg = new Array<number>(dims).fill(0);
  let wp = 0;
  let wn = 0;
  const artist = new Map<string, number>();
  const genre = new Map<string, number>();
  let eSum = 0;
  let eW = 0;
  for (const [id, x] of w) {
    const t = tracks.get(id);
    if (!t) continue;
    if (t.artist) artist.set(t.artist, (artist.get(t.artist) ?? 0) + x);
    if (t.genre) genre.set(t.genre, (genre.get(t.genre) ?? 0) + x);
    const v = vec(t);
    if (!v) continue;
    if (x > 0) {
      for (let i = 0; i < dims; i++) pos[i] += v[i] * x;
      wp += x;
      eSum += v[0] * x;
      eW += x;
    } else if (x < 0) {
      for (let i = 0; i < dims; i++) neg[i] += v[i] * -x;
      wn += -x;
    }
  }
  return {
    pos: wp >= 1 ? pos.map((v) => v / wp) : null,
    neg: wn >= 1 ? neg.map((v) => v / wn) : null,
    weight: wp,
    artist,
    genre,
    meanEnergy: eW > 0 ? eSum / eW : 0.55,
  };
}

const WEIGHTS: Record<WaveDiversity, { taste: number; artist: number; transition: number; novelty: number; mood: number; temp: number; mmr: number }> = {
  familiar: { taste: 0.42, artist: 0.2, transition: 0.18, novelty: 0.04, mood: 0.12, temp: 0.06, mmr: 0.2 },
  balanced: { taste: 0.32, artist: 0.1, transition: 0.18, novelty: 0.16, mood: 0.12, temp: 0.09, mmr: 0.35 },
  discover: { taste: 0.18, artist: 0.04, transition: 0.18, novelty: 0.34, mood: 0.12, temp: 0.13, mmr: 0.5 },
};

export function transitionCompat(a: RecTrack | undefined, b: RecTrack, mood: WaveMood, mix = false): number {
  if (!a || !a.features || !b.features) return 0.5;
  let tempo = 0.5;
  if (a.bpm && b.bpm) {
    const stretch = tempoRelation(a.bpm, b.bpm).stretchPercent;
    // mix mode: what matters is whether the planner will lock beats (same limit), not just closeness
    tempo = mix ? (stretch <= LOCK_MAX_PERCENT ? 1 - stretch / (2 * LOCK_MAX_PERCENT) : 0.15 * Math.exp(-(stretch - LOCK_MAX_PERCENT) / 4)) : Math.exp(-stretch / 4);
  } else if (mix) tempo = 0.2;
  const key = a.camelot && b.camelot ? camelotCompatibility(a.camelot, b.camelot).score : 0.5;
  const de = b.features.energy - a.features.energy;
  const want = mood === 'energetic' ? 0.08 : mood === 'calm' ? -0.08 : 0;
  const flow = clamp(1 - Math.abs(de - want) * 2.5);
  return 0.45 * tempo + 0.35 * key + 0.2 * flow;
}

export function recommendNext(
  library: RecTrack[],
  sig: RecSignals,
  ctx: WaveContext,
  count = 3,
  rand: () => number = Math.random,
): WavePick[] {
  const byId = new Map(library.map((t) => [t.id, t]));
  const profile = buildProfile(byId, sig);
  const base = WEIGHTS[ctx.diversity];
  // mix mode trades some variety for beatmatchable neighbours; taste and dislikes still apply
  const W = ctx.mix ? { ...base, transition: 0.6, mmr: base.mmr * 0.5 } : base;
  const coldStart = !profile.pos;
  const targetEnergy = ctx.mood === 'calm' ? 0.3 : ctx.mood === 'energetic' ? 0.78 : profile.meanEnergy;
  const recentPlays = new Map<string, number>();
  const recentSkips = new Map<string, number>();
  for (const p of sig.plays) {
    recentPlays.set(p.trackId, Math.max(recentPlays.get(p.trackId) ?? 0, p.at));
    if (p.skipped && p.playedRatio < 0.25) recentSkips.set(p.trackId, Math.max(recentSkips.get(p.trackId) ?? 0, p.at));
  }
  const maxArtist = Math.max(1, ...[...profile.artist.values()].map(Math.abs));
  const picks: WavePick[] = [];
  const session = [...ctx.session];
  let current = ctx.currentId ? byId.get(ctx.currentId) : undefined;

  for (let k = 0; k < count; k++) {
    const sessionSet = new Set(session);
    const lastIds = session.slice(-3);
    const lastArtists = session.slice(-3).map((id) => byId.get(id)?.artist).filter(Boolean) as string[];
    const lastAlbums = session.slice(-5).map((id) => byId.get(id)?.album).filter(Boolean) as string[];
    const lastVecs = lastIds.map((id) => byId.get(id)).filter(Boolean).map((t) => vec(t!));
    let eligible = library.filter(
      (t) => t.available && !sig.dislikes.has(t.id) && !ctx.exclude?.has(t.id) && !sessionSet.has(t.id) && t.id !== current?.id,
    );
    if (!eligible.length) {
      // small library: allow tracks from early in the session again
      const old = new Set(session.slice(-Math.max(1, Math.floor(library.length / 2))));
      eligible = library.filter((t) => t.available && !sig.dislikes.has(t.id) && !old.has(t.id) && t.id !== current?.id);
    }
    if (!eligible.length) break;
    const scored = eligible.map((t) => {
      const v = vec(t);
      const c: Record<string, number> = {};
      c.taste = coldStart ? 0.5 : similarity(v, profile.pos) - (profile.neg ? 0.5 * Math.max(0, similarity(v, profile.neg) - 0.5) : 0);
      if (sig.likes.has(t.id)) c.taste = Math.min(1, c.taste + 0.25);
      const aff = profile.artist.get(t.artist) ?? 0;
      c.artist = Math.tanh((aff / maxArtist) * 2) * 0.5 + 0.5;
      c.transition = transitionCompat(current, t, ctx.mood, ctx.mix);
      const last = recentPlays.get(t.id);
      const sinceDays = last ? (sig.now - last) / DAY : 365;
      c.novelty = t.playCount === 0 ? 1 : clamp(0.3 / (1 + t.playCount * 0.3) + clamp(sinceDays / 30) * 0.5);
      c.mood = t.features ? clamp(1 - Math.abs(t.features.energy - targetEnergy) * 1.6) : 0.5;
      let penalty = 0;
      if (last && sig.now - last < 2 * 3600000) penalty += 0.6;
      if (lastArtists.length && t.artist && lastArtists[lastArtists.length - 1] === t.artist) penalty += 0.7;
      else if (t.artist && lastArtists.includes(t.artist)) penalty += 0.4;
      if (t.album && lastAlbums.includes(t.album)) penalty += 0.2;
      const sk = recentSkips.get(t.id);
      if (sk && sig.now - sk < 7 * DAY) penalty += 0.45;
      const maxSim = lastVecs.length ? Math.max(...lastVecs.map((lv) => similarity(lv, v))) : 0;
      // keep the stream varied: very similar consecutive tracks are discouraged
      penalty += W.mmr * Math.max(0, maxSim - 0.75) * 2;
      if (!t.features) penalty += 0.08;
      c.penalty = penalty;
      const score =
        W.taste * c.taste + W.artist * c.artist + W.transition * c.transition + W.novelty * c.novelty + W.mood * c.mood - penalty;
      return { t, score, c };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 15);
    const temp = W.temp * (coldStart ? 1.6 : 1);
    const mx = top[0].score;
    const ws = top.map((s) => Math.exp((s.score - mx) / Math.max(0.01, temp)));
    const total = ws.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < top.length - 1; idx++) {
      r -= ws[idx];
      if (r <= 0) break;
    }
    const chosen = top[idx];
    picks.push({ id: chosen.t.id, score: Math.round(chosen.score * 1000) / 1000, reasons: explain(chosen.c, coldStart, ctx, chosen.t, sig), components: chosen.c });
    session.push(chosen.t.id);
    current = chosen.t;
  }
  return picks;
}

function explain(c: Record<string, number>, cold: boolean, ctx: WaveContext, t: RecTrack, sig: RecSignals): string[] {
  const r: { s: number; text: string }[] = [];
  if (sig.likes.has(t.id)) r.push({ s: 1, text: 'вы отметили этот трек' });
  if (!cold && c.taste > 0.7) r.push({ s: c.taste, text: 'похож на то, что вам нравится' });
  if (c.artist > 0.7) r.push({ s: c.artist - 0.1, text: 'исполнитель, которого вы слушаете' });
  if (c.transition > 0.72) r.push({ s: c.transition - 0.05, text: ctx.mix ? 'сводится по битам с текущим треком' : 'плавно продолжает текущий трек' });
  if (c.novelty > 0.85) r.push({ s: c.novelty - 0.15, text: t.playCount === 0 ? 'ещё не звучал' : 'давно не звучал' });
  if (ctx.mood !== 'normal' && c.mood > 0.75) r.push({ s: c.mood - 0.1, text: ctx.mood === 'calm' ? 'под спокойное настроение' : 'под бодрое настроение' });
  if (cold && !r.length) r.push({ s: 0.5, text: 'знакомство с вашей медиатекой' });
  if (!r.length) r.push({ s: 0.4, text: 'разнообразие в потоке' });
  return r.sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.text);
}
