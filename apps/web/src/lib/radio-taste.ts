import type { PublicTrack, Track, AppSettings } from './api.ts';

export type RadioTuning = AppSettings['wave'];
type Song = Pick<Track, 'title' | 'artist'>;
export const normalizeMusic = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\b(feat|ft)\.?/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const radioIdentity = (t: Song) => `${normalizeMusic(t.artist)}|${normalizeMusic(t.title)}`;
export const artistsOf = (s: string) => s.split(/,|&| feat\.? | ft\.? | featuring /i).map(normalizeMusic).filter(Boolean);
export function tasteSeeds(tracks: Track[], cursor = 0): Track[] {
  const likes = tracks.filter(t => t.reaction > 0 && t.status === 'ok').sort((a, b) => (b.likedAt ?? b.addedAt) - (a.likedAt ?? a.addedAt));
  const source = likes.length ? likes : tracks.filter(t => t.reaction >= 0 && t.playCount > 0 && t.status === 'ok').sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
  const out: Track[] = [], seen = new Set<string>();
  for (let i = 0; i < source.length && out.length < 8; i++) {
    const t = source[(i + cursor) % source.length], artist = artistsOf(t.artist)[0] || t.id;
    if (!seen.has(artist)) { seen.add(artist); out.push(t); }
  }
  return out;
}

/** Service-related candidates ranked by explicit taste, recency and measured mix compatibility. */
export function rankRadio(items: PublicTrack[], library: Track[], seen: Set<string>, recentArtists: string[], tuning: RadioTuning, anchor?: Song, now = Date.now()): PublicTrack[] {
  const byKey = new Map<string, Track>();
  for (const t of library) {
    const key=radioIdentity(t), old=byKey.get(key);
    if (!old || t.reaction>old.reaction || t.reaction===old.reaction && !old.analysis?.bpm && t.analysis?.bpm) byKey.set(key,t);
  }
  const byId = new Map(library.map(t => [t.id, t]));
  const byTitle = new Map<string, Track[]>(), affinity = new Map<string, number>();
  for (const t of library) {
    const title = normalizeMusic(t.title); byTitle.set(title, [...(byTitle.get(title) ?? []), t]);
    if (t.reaction < 0) continue;
    const weight = t.reaction > 0 ? 3 : Math.min(1, Math.log1p(t.playCount) / 4);
    for (const a of artistsOf(t.artist)) affinity.set(a, (affinity.get(a) ?? 0) + weight);
  }
  const known = (t: Song & { libraryTrackId?: string | null }) => byKey.get(radioIdentity(t)) ?? (t.libraryTrackId ? byId.get(t.libraryTrackId) : undefined)
    ?? byTitle.get(normalizeMusic(t.title))?.find(x => artistsOf(x.artist).some(a => artistsOf(t.artist).includes(a)));
  let previous = anchor ? known(anchor) : undefined;
  const blocked = (t: PublicTrack) => byTitle.get(normalizeMusic(t.title))?.some(x => x.reaction < 0 && artistsOf(x.artist).some(a => artistsOf(t.artist).includes(a)));
  const unique = new Set<string>();
  const pool = items.filter(t => {
    const key = radioIdentity(t), id = `${t.audioProvider}:${t.externalId}`;
    if (!t.playable || seen.has(key) || seen.has(id) || unique.has(key) || blocked(t)) return false;
    unique.add(key); return true;
  });
  const out: PublicTrack[] = [], recent = recentArtists.map(a => artistsOf(a)[0] ?? '');
  while (pool.length && out.length < 18) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const t = pool[i], k = known(t), artists = artistsOf(t.artist), artist = artists[0] || '';
      if (recent.length >= 2 && artist && recent.slice(-2).every(a => a === artist)) continue;
      // A recent repeat never wins merely because it is liked. Backfill older items when possible.
      if (byTitle.get(normalizeMusic(t.title))?.some(x => x.lastPlayedAt && now - x.lastPlayedAt < 2 * 3600000 && artistsOf(x.artist).some(a => artists.includes(a)))) continue;
      const familiarity = Math.min(1, Math.max(0, ...artists.map(a => (affinity.get(a) ?? 0) / 8)));
      let score = 1 - i / Math.max(1, items.length) * .25;
      score += familiarity * (tuning.diversity === 'discover' ? .35 : 1.5);
      if ((k?.reaction ?? 0) > 0) score += tuning.diversity === 'familiar' ? 2 : tuning.diversity === 'discover' ? -.5 : .8;
      if (!k || !k.playCount) score += tuning.diversity === 'discover' ? 1 : .15;
      score -= recent.slice(-5).filter(a => a === artist).length * .7;
      const energy = k?.analysis?.energy;
      if (typeof energy === 'number' && tuning.mood !== 'normal') score += tuning.mood === 'calm' ? (1 - energy) * 1.2 : energy * 1.2;
      if (tuning.mode === 'mix' && previous?.analysis?.bpm && k?.analysis?.bpm) {
        const a = previous.analysis.bpm, b = k.analysis.bpm;
        const distance = Math.min(...[.5, 1, 2].map(r => Math.abs(Math.log2(b * r / a))));
        score += Math.max(-1, 1.5 - distance * 8);
        if (previous.analysis.camelot && k.analysis.camelot === previous.analysis.camelot) score += .3;
      }
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const [t] = pool.splice(best, 1); out.push(t); recent.push(artistsOf(t.artist)[0] ?? ''); previous = known(t) ?? previous;
    seen.add(radioIdentity(t)); seen.add(`${t.audioProvider}:${t.externalId}`);
  }
  return out;
}
