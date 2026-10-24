import type { PlayContext, PlayerSnapshot, QueueEntry } from '../audio/controller.ts';
import type { PublicTrack, Track } from './api.ts';
import { artistsOf, normalizeMusic, radioIdentity } from './radio-taste.ts';

/** Remaining seconds of the last song when its continuation is chosen: time to download, analyse
 * and plan an ordinary AutoMix transition, which itself starts well before the song ends. */
export const CONTINUE_LEAD_SECONDS = 90;
const SEED_COUNT = 3;

type Transport = Pick<PlayerSnapshot, 'status' | 'queue' | 'index' | 'repeat' | 'context' | 'position' | 'duration'>;

/** The last song of a finite queue plays (not paused) with no repeat: time to pick what follows. */
export function wantsContinuation(p: Transport, enabled: boolean): boolean {
  const type = p.context?.type;
  // Stations continue themselves; a listening check of one transition is not a queue to extend.
  if (!enabled || p.repeat !== 'off' || p.status !== 'playing' || !p.context || p.context.id === 'preview') return false;
  if (type === 'wave' || type === 'yandex-wave' || type === 'online-radio') return false;
  return p.index >= 0 && p.index === p.queue.length - 1 && p.duration > 0 && p.duration - p.position <= CONTINUE_LEAD_SECONDS;
}

/** Recent songs of this queue that were let play through (the playing last one included), liked first, never a dislike. */
export function continuationSeeds(queue: QueueEntry[], index: number, heard: ReadonlySet<string>, track: (id: string) => Track | undefined): Track[] {
  const out: Track[] = [], seen = new Set<string>();
  for (let i = Math.min(index, queue.length - 1); i >= 0 && out.length < SEED_COUNT * 2; i--) {
    const t = track(queue[i].trackId);
    if (!t || t.status !== 'ok' || t.reaction < 0 || (i !== index && !heard.has(queue[i].entryId))) continue;
    const key = radioIdentity(t);
    if (seen.has(key)) continue;
    seen.add(key); out.push(t);
  }
  // sort is stable: recency order is kept within the same reaction
  return out.sort((a, b) => Math.sign(b.reaction) - Math.sign(a.reaction)).slice(0, SEED_COUNT);
}

/** Artists turned down at least twice and never liked. */
export function dislikedArtists(library: Track[]): Set<string> {
  const votes = new Map<string, { down: number; up: number }>();
  for (const t of library) {
    if (!t.reaction) continue;
    for (const a of artistsOf(t.artist)) {
      const v = votes.get(a) ?? { down: 0, up: 0 };
      if (t.reaction < 0) v.down++; else v.up++;
      votes.set(a, v);
    }
  }
  return new Set([...votes].filter(([, v]) => v.down >= 2 && !v.up).map(([a]) => a));
}

/** Songs of this listening session never come back; neither do turned-down artists. */
export function continuationFilter(queue: QueueEntry[], track: (id: string) => Track | undefined, library: Track[]) {
  const seen = new Set(queue.flatMap((e) => { const t = track(e.trackId); return t ? [radioIdentity(t)] : []; }));
  const banned = dislikedArtists(library);
  return { seen, allow: (t: PublicTrack) => !artistsOf(t.artist).some((a) => banned.has(a)) };
}

/** Seeds of an artist station: their songs in the library (liked first, then most played, never a dislike),
 * then the catalog's popular ones; the bare name when nothing else is known. */
export function artistSeeds(artist: string, library: Track[], songs: { title: string; artist: string }[] = []): { title: string; artist: string }[] {
  const name = normalizeMusic(artist);
  const own = library.filter((t) => t.status === 'ok' && t.reaction >= 0 && artistsOf(t.artist).includes(name))
    .sort((a, b) => Math.sign(b.reaction) - Math.sign(a.reaction) || b.playCount - a.playCount);
  const seen = new Set<string>(), out: { title: string; artist: string }[] = [];
  for (const t of [...own, ...songs]) {
    const key = radioIdentity(t);
    if (!seen.has(key) && out.length < SEED_COUNT) { seen.add(key); out.push({ title: t.title, artist: t.artist }); }
  }
  return out.length ? out : [{ title: '', artist }];
}

export function continuationLabel(context: PlayContext | null, seed: Track | undefined): string {
  const named = context && !['queue', 'search', 'history'].includes(context.type) ? context.label : seed?.artist;
  return named ? `Радио по мотивам «${named}»` : 'Радио по мотивам очереди';
}
