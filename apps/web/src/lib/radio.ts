import { create } from 'zustand';
import { api, type PublicTrack } from './api.ts';
import { controller, useApp } from '../store/app.ts';
import { publicPlayer } from '../store/catalog.ts';
import { asCatalog } from '../pages/Search.tsx';
import { radioIdentity, rankRadio, tasteSeeds } from './radio-taste.ts';

export const useRadio = create(() => ({ active: false, loading: false, error: null as string | null }));
let session: { seen: Set<string>; loading: boolean; retryAt: number; owner: number; cursor: number; abort: AbortController } | null = null;
let startRequest = 0, seedCursor = 0;
const SEEN_LIMIT = 2000;
let startAbort: AbortController | null = null, startIntent = 0;
const library = () => [...useApp.getState().tracks.values()];
const tuning = () => useApp.getState().settings?.wave ?? { mood: 'normal' as const, diversity: 'balanced' as const, mode: 'normal' as const };
async function candidates(ids: string[], signal: AbortSignal): Promise<PublicTrack[]> {
  const results = await Promise.allSettled([...new Set(ids)].slice(0, 3).map(id => api.publicRadio(id, signal)));
  signal.throwIfAborted();
  return results.flatMap(r => r.status === 'fulfilled' ? r.value.items : []);
}
async function resolveSeed(seed: { title: string; artist: string }, signal: AbortSignal) {
  return (await api.publicSearch('ytmusic', `${seed.artist} ${seed.title}`.trim(), signal)).items.find(t => t.playable);
}

/** Multi-seed service candidates, filtered/ranked locally with current reactions on every refill. */
export async function startRadio(seed?: { title: string; artist: string }): Promise<void> {
  const request = ++startRequest, intent = controller.intentVersion;
  startAbort?.abort(); session?.abort.abort();
  const abort = new AbortController(); startAbort = abort; startIntent = intent;
  session = null; useRadio.setState({ active: false, loading: true, error: null });
  try {
    // Unlock during the launch gesture, before recommendation network requests.
    await controller.unlockAudio();
    if (request !== startRequest || intent !== controller.intentVersion) return;
    const seeds = tasteSeeds(library(), seedCursor++);
    const primary = seed ?? seeds.shift();
    if (!primary) throw new Error('Поставьте лайк или запустите радио по найденному треку — так появится основа для подбора.');
    const resolved = await Promise.allSettled([primary, ...seeds.slice(0, 2)].map(seed => resolveSeed(seed, abort.signal)));
    if (request !== startRequest || intent !== controller.intentVersion) return;
    const found = resolved.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
    // A personal station can use another liked seed when one search fails.
    // An explicit "radio by this track" must still resolve that requested track.
    const first = seed ? resolved[0].status === 'fulfilled' ? resolved[0].value : undefined : found[0];
    if (!first) throw new Error('Не нашли начальную песню для радио. Попробуйте другую.');
    const pool = await candidates(found.map(t => t.externalId), abort.signal);
    if (request !== startRequest || intent !== controller.intentVersion) return;
    const seen = new Set<string>();
    // The explicit seed may be played again deliberately; subsequent picks respect recency.
    let playlist: PublicTrack[];
    if (seed) {
      if (!rankRadio([first], library(), new Set(), [], tuning(), primary, Infinity).length) throw new Error('Эта песня отмечена дизлайком. Выберите другую основу радио.');
      seen.add(radioIdentity(first)); seen.add(`${first.audioProvider}:${first.externalId}`);
      playlist = [first, ...rankRadio([...found.slice(1), ...pool], library(), seen, [first.artist], tuning(), primary)];
    } else {
      playlist = rankRadio([...found, ...pool], library(), seen, [], tuning(), primary);
    }
    if (!playlist.length) throw new Error('Пока нет свежих рекомендаций. Попробуйте радио по другому треку.');
    // play() changes transport intent itself; only pending recommendation requests need cancelling.
    if (startAbort === abort) startAbort = null;
    await publicPlayer.play(playlist.map(asCatalog), 0, { type: 'online-radio', label: 'Онлайн-радио · Моя волна' });
    if (request !== startRequest || publicPlayer.sessionVersion === null) return;
    session = { seen, loading: false, retryAt: 0, owner: publicPlayer.sessionVersion, cursor: 0, abort };
    useRadio.setState({ active: true });
  } catch (e) {
    if (request === startRequest && intent === controller.intentVersion) {
      const error = (e as Error).message; useRadio.setState({ error }); useApp.getState().toast(error, 'error');
    }
  } finally { if (request === startRequest) useRadio.setState({ loading: false }); }
}

controller.subscribe(() => {
  const s = session;
  if (!s && useRadio.getState().loading && controller.intentVersion !== startIntent) startAbort?.abort();
  if (!s) return;
  if (publicPlayer.sessionVersion !== s.owner || publicPlayer.remaining < 0) {
    s.abort.abort(); session = null; useRadio.setState({ active: false }); return;
  }
  if (s.loading || Date.now() < s.retryAt || publicPlayer.remaining >= 10) return;
  const items = publicPlayer.sessionItems, last = items.at(-1);
  if (!last) return;
  s.loading = true;
  void (async () => {
    const seeds = tasteSeeds(library(), s.cursor++);
    const extra = seeds[0] ? await resolveSeed(seeds[0], s.abort.signal).catch(() => undefined) : undefined;
    const pool = await candidates([last.externalId, ...(extra ? [extra.externalId] : [])], s.abort.signal);
    if (session !== s || publicPlayer.sessionVersion !== s.owner) return;
    const more = rankRadio(pool, library(), s.seen, items.slice(-5).map(t => t.artist), tuning(), last);
    // Repeats are blocked over recent history only; a Set iterates oldest first.
    for (const old of s.seen) { if (s.seen.size <= SEEN_LIMIT) break; s.seen.delete(old); }
    if (!more.length) s.retryAt = Date.now() + 30_000;
    if (!publicPlayer.extend(more.map(asCatalog), s.owner)) { session = null; useRadio.setState({ active: false }); }
  })().catch(() => { s.retryAt = Date.now() + 30_000; }).finally(() => { s.loading = false; });
});
