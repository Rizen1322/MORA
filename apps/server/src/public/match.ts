/**
 * Text normalisation, version labels and ranking for search results and
 * collection matching. Labels keep their origin: what the source declares
 * (explicit badge) is different from a guess made from a title.
 */

export type VersionTag =
  | 'explicit' | 'clean' | 'remix' | 'live' | 'acoustic' | 'slowed' | 'sped-up' | 'reverb' | 'nightcore'
  | 'instrumental' | 'karaoke' | 'cover' | 'remaster' | 'extended' | 'radio-edit' | 'demo' | 'mashup' | 'bass-boosted' | '8d' | 'uncensored';

export interface VersionLabel { tag: VersionTag; origin: 'source' | 'title' }

const TAG_RULES: [VersionTag, RegExp][] = [
  ['slowed', /\bslowed\b|замедл/i],
  ['sped-up', /\bsped\s*up\b|\bspeed\s*up\b|ускор/i],
  ['reverb', /\breverb\b|ревер/i],
  ['nightcore', /\bnightcore\b/i],
  ['remix', /\bremix\b|\brmx\b|\bflip\b|\bbootleg\b|ремикс/i],
  ['mashup', /\bmash\s*-?up\b|мэшап/i],
  ['live', /\blive\b|концерт|живое исполнение|лайв/i],
  ['acoustic', /\bacoustic\b|акустик/i],
  ['instrumental', /\binstrumental\b|\bminus\b|минусовк|инструментал/i],
  ['karaoke', /\bkaraoke\b|караоке/i],
  ['cover', /\bcover\b|кавер/i],
  ['remaster', /\bremaster(ed)?\b|ремастер/i],
  ['extended', /\bextended\b|\bext\.? mix\b/i],
  ['radio-edit', /\bradio\s*(edit|version)\b/i],
  ['clean', /\bclean\b|\bcensored\b|без мата|цензур/i],
  ['uncensored', /\buncensored\b|\bdirty\b|без цензуры/i],
  ['demo', /\bdemo\b|демо/i],
  ['bass-boosted', /bass\s*boost/i],
  ['8d', /\b8d\b/i],
];

export const TAG_LABELS: Record<VersionTag, string> = {
  explicit: 'Explicit', clean: 'Clean', remix: 'Ремикс', live: 'Live', acoustic: 'Акустика', slowed: 'Slowed', 'sped-up': 'Sped up',
  reverb: 'Reverb', nightcore: 'Nightcore', instrumental: 'Инструментал', karaoke: 'Караоке', cover: 'Кавер', remaster: 'Ремастер',
  extended: 'Extended', 'radio-edit': 'Radio edit', demo: 'Демо', mashup: 'Мэшап', 'bass-boosted': 'Bass boosted', '8d': '8D', uncensored: 'Uncensored',
};

/** Lowercase, NFKC, ё→е, punctuation and repeated spaces folded; "feat." spelt one way. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/\b(featuring|feat\.?|ft\.?)\b/g, ' feat ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function versionLabels(title: string, sourceExplicit = false): VersionLabel[] {
  const labels: VersionLabel[] = sourceExplicit ? [{ tag: 'explicit', origin: 'source' }] : [];
  for (const [tag, re] of TAG_RULES) if (re.test(title)) labels.push({ tag, origin: 'title' });
  return labels;
}

/** Tags that mean "a different recording than the one usually meant". */
const ALTERNATE: VersionTag[] = ['slowed', 'sped-up', 'reverb', 'nightcore', 'remix', 'mashup', 'live', 'acoustic', 'instrumental', 'karaoke', 'cover', 'bass-boosted', '8d', 'demo', 'extended'];

export interface Rankable { title: string; artist: string; album?: string; duration?: number; kind?: 'song' | 'video' | 'track'; labels: VersionLabel[] }

const tokens = (s: string) => normalize(s).split(' ').filter((t) => t && t !== 'feat');

/**
 * Relevance of one result to a free-text query: how much of the query the title
 * and artist cover, minus alternate-version tags the query did not ask for.
 * Views or upload counts are deliberately not used.
 */
export function relevance(query: string, r: Rankable): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const title = new Set(tokens(r.title)), artist = new Set(tokens(r.artist)), album = new Set(tokens(r.album ?? ''));
  let hit = 0;
  for (const t of q) hit += title.has(t) || artist.has(t) ? 1 : album.has(t) ? 0.5 : 0;
  let score = hit / q.length;
  const qtags = new Set(versionLabels(query).map((l) => l.tag));
  for (const l of r.labels) if (l.origin === 'title' && ALTERNATE.includes(l.tag) && !qtags.has(l.tag)) score -= 0.35;
  // Extra words in the title that the query lacks hint at a different song.
  const extra = [...title].filter((t) => !q.includes(t) && !artist.has(t)).length;
  score -= Math.min(0.2, extra * 0.03);
  if (r.kind === 'song') score += 0.08;
  if (r.duration && (r.duration < 45 || r.duration > 15 * 60)) score -= 0.3;
  return score;
}

/** Stable re-order: equal scores keep the source's own order. */
export function rank<T extends Rankable>(query: string, items: T[]): T[] {
  return items.map((item, i) => ({ item, i, s: relevance(query, item) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.item);
}

export interface MatchTarget { title: string; artist: string; album?: string; duration?: number; isrc?: string | null }

/**
 * Confidence that a candidate is the same recording as a target (collection
 * import, version search). 0..1; ≥ 0.8 is treated as a confident match.
 */
export function matchConfidence(target: MatchTarget, c: Rankable & { isrc?: string | null }): number {
  if (target.isrc && c.isrc) return target.isrc.toUpperCase() === c.isrc.toUpperCase() ? 1 : 0.1;
  const tt = tokens(target.title), ct = new Set(tokens(c.title));
  const ta = tokens(target.artist), ca = new Set([...tokens(c.artist), ...ct]);
  const titleCover = tt.length ? tt.filter((t) => ct.has(t)).length / tt.length : 0;
  const artistCover = ta.length ? ta.filter((t) => ca.has(t)).length / ta.length : 0.5;
  let s = titleCover * 0.55 + artistCover * 0.3;
  if (target.duration && c.duration) {
    const d = Math.abs(target.duration - c.duration);
    s += d <= 3 ? 0.15 : d <= 8 ? 0.08 : d > 30 ? -0.25 : 0;
  } else s += 0.05;
  const want = new Set(versionLabels(target.title).map((l) => l.tag));
  for (const l of c.labels) if (l.origin === 'title' && ALTERNATE.includes(l.tag) && !want.has(l.tag)) s -= 0.3;
  return Math.max(0, Math.min(1, s));
}
