import { describe, expect, it } from 'vitest';
import { recommendNext, type RecSignals, type RecTrack } from '../src/rec/wave.ts';
import { synthesize } from '../src/synth/synth.ts';
import { countClicks } from './helpers.ts';

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function lib(): RecTrack[] {
  const out: RecTrack[] = [];
  const artists = ['Лиса', 'Северный ветер', 'Kollektiv', 'Mono Pine', 'Ойра', 'Grey Harbor'];
  for (let i = 0; i < 60; i++) {
    const calm = i % 3 === 0;
    out.push({
      id: `t${i}`,
      artist: artists[i % artists.length],
      album: `Альбом ${Math.floor(i / 5)}`,
      genre: calm ? 'ambient' : i % 3 === 1 ? 'house' : 'techno',
      features: {
        energy: calm ? 0.2 + (i % 5) * 0.02 : 0.6 + (i % 7) * 0.04,
        brightness: (i % 10) / 10,
        rhythmStrength: calm ? 0.1 : 0.9,
        onsetRate: calm ? 0.15 : 0.6,
        bassWeight: calm ? 0.3 : 0.7,
        midDensity: 0.3,
        dynamics: calm ? 0.5 : 0.2,
        acousticness: calm ? 0.7 : 0.1,
      },
      bpm: calm ? 80 + i : 120 + (i % 10),
      camelot: `${(i % 12) + 1}${i % 2 ? 'A' : 'B'}`,
      playCount: 0,
      lastPlayedAt: null,
      available: true,
    });
  }
  return out;
}

const empty = (): RecSignals => ({ likes: new Set(), dislikes: new Set(), plays: [], now: Date.now() });

describe('Моя волна recommender', () => {
  it('works on a cold start and keeps artists varied', () => {
    const picks = recommendNext(lib(), empty(), { currentId: null, session: [], mood: 'normal', diversity: 'balanced' }, 6, seeded(1));
    expect(picks).toHaveLength(6);
    expect(new Set(picks.map((p) => p.id)).size).toBe(6);
    const artists = picks.map((p) => lib().find((t) => t.id === p.id)!.artist);
    for (let i = 1; i < artists.length; i++) expect(artists[i]).not.toBe(artists[i - 1]);
    expect(picks[0].reasons.length).toBeGreaterThan(0);
  });

  it('never recommends disliked or unavailable tracks', () => {
    const l = lib();
    l[3].available = false;
    const sig = empty();
    for (let i = 0; i < 50; i++) if (i !== 7 && i !== 8) sig.dislikes.add(`t${i}`);
    const picks = recommendNext(l, sig, { currentId: null, session: [], mood: 'normal', diversity: 'balanced' }, 20, seeded(2));
    for (const p of picks) {
      expect(sig.dislikes.has(p.id)).toBe(false);
      expect(p.id).not.toBe('t3');
    }
  });

  it('leans towards what the listener likes', () => {
    const sig = empty();
    // likes only calm tracks
    for (const t of lib()) if (t.genre === 'ambient' && Number(t.id.slice(1)) < 30) sig.likes.add(t.id);
    let calm = 0;
    const n = 30;
    for (let k = 0; k < n; k++) {
      const p = recommendNext(lib(), sig, { currentId: null, session: [...sig.likes], mood: 'normal', diversity: 'familiar' }, 1, seeded(10 + k))[0];
      if (lib().find((t) => t.id === p.id)!.genre === 'ambient') calm++;
    }
    expect(calm / n).toBeGreaterThan(0.6);
  });

  it('learns from early skips', () => {
    const sig = empty();
    const now = Date.now();
    // skipped every techno track quickly
    for (const t of lib()) if (t.genre === 'techno') sig.plays.push({ trackId: t.id, at: now - 3600_000, playedRatio: 0.05, playedSeconds: 10, skipped: true });
    let techno = 0;
    for (let k = 0; k < 30; k++) {
      const p = recommendNext(lib(), sig, { currentId: null, session: [], mood: 'normal', diversity: 'balanced' }, 1, seeded(50 + k))[0];
      if (lib().find((t) => t.id === p.id)!.genre === 'techno') techno++;
    }
    expect(techno).toBeLessThan(6);
  });

  it('follows the mood setting', () => {
    let energetic = 0;
    for (let k = 0; k < 20; k++) {
      const p = recommendNext(lib(), empty(), { currentId: null, session: [], mood: 'energetic', diversity: 'balanced' }, 1, seeded(90 + k))[0];
      if (lib().find((t) => t.id === p.id)!.features!.energy > 0.5) energetic++;
    }
    expect(energetic).toBeGreaterThan(14);
  });

  it('keeps going when the session has used the whole small library', () => {
    const small = lib().slice(0, 4);
    const picks = recommendNext(small, empty(), { currentId: 't0', session: ['t1', 't2', 't3'], mood: 'normal', diversity: 'balanced' }, 3, seeded(3));
    expect(picks.length).toBeGreaterThan(0);
  });
});

describe('test tooling', () => {
  it('the click detector catches injected discontinuities (so "0 clicks" is meaningful)', () => {
    const s = synthesize({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 8, seed: 5, clean: true, introBars: 0, outroBars: 0 });
    expect(countClicks(s.L)).toBe(0);
    const x = s.L.slice();
    for (let k = 0; k < 4; k++) x[40000 + k * 50000] += 0.05;
    expect(countClicks(x)).toBe(4);
  });
});

describe('Волна для микса', () => {
  it('prefers next tracks AutoMix can beatmatch with the current one, unlike the normal wave', () => {
    // tempi spread over 70-180 BPM: only some neighbours are within the 8 % lock limit of 124 BPM
    const l = lib().map((t, i) => ({ ...t, bpm: 70 + ((i * 29) % 111) }));
    l[0] = { ...l[0], bpm: 124 };
    const lockable = (bpm: number | null) => {
      if (!bpm) return false;
      return [1, 2, 0.5].some((k) => Math.abs(124 / (bpm * k) - 1) <= 0.08);
    };
    const share = (mix: boolean) => {
      let hits = 0;
      for (let k = 0; k < 150; k++) {
        const [p] = recommendNext(l, empty(), { currentId: 't0', session: [], mood: 'normal', diversity: 'balanced', mix }, 1, seeded(500 + k));
        if (lockable(l.find((t) => t.id === p.id)!.bpm)) hits++;
      }
      return hits / 150;
    };
    const normal = share(false), mix = share(true);
    expect(mix).toBeGreaterThan(0.7);
    expect(mix - normal).toBeGreaterThan(0.25);
  });
});
