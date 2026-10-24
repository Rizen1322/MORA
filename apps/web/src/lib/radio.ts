import { create } from 'zustand';
import { api, type PublicTrack, type Track } from './api.ts';
import type { PlayContext, QueueEntry } from '../audio/controller.ts';
import { controller, useApp } from '../store/app.ts';
import { publicPlayer } from '../store/catalog.ts';
import { asCatalog } from '../pages/Search.tsx';
import { radioIdentity, rankRadio, tasteSeeds } from './radio-taste.ts';
import { artistSeeds, continuationFilter, continuationLabel, continuationSeeds, wantsContinuation } from './continue-radio.ts';

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

type Seed = { title: string; artist: string };
type Station = { ranked: PublicTrack[]; seen: Set<string> };
const libraryTrack = (id: string) => useApp.getState().tracks.get(id);

/** One recommendation engine for the queue end, the way back online and the "similar"/"artist" stations:
 * songs related to up to two seeds, minus this session's songs and turned-down artists. Metadata only;
 * null when the listener moved on meanwhile. */
async function station(seeds: Seed[], queue: QueueEntry[], anchor: Seed, signal: AbortSignal, relevant: () => boolean): Promise<Station | null> {
  const { seen, allow } = continuationFilter(queue, libraryTrack, library());
  for (const seed of seeds) seen.add(radioIdentity(seed));
  const resolved = await Promise.allSettled(seeds.slice(0, 2).map((seed) => resolveSeed(seed, signal)));
  if (!relevant()) return null;
  const found = resolved.flatMap((r) => r.status === 'fulfilled' && r.value ? [r.value] : []);
  for (const t of found) seen.add(`${t.audioProvider}:${t.externalId}`);
  const pool = await candidates(found.map((t) => t.externalId), signal);
  if (!relevant()) return null;
  const recent = queue.slice(-5).map((e) => libraryTrack(e.trackId)?.artist ?? '');
  // 'mix' scores tempo and key against the anchor wherever a candidate is already analysed.
  return { ranked: rankRadio(pool.filter(allow), library(), seen, recent, { ...tuning(), mode: 'mix' }, anchor), seen };
}

function followStation(found: Station, items: PublicTrack[], abort: AbortController): void {
  session?.abort.abort();
  session = { seen: found.seen, loading: false, retryAt: 0, owner: publicPlayer.follow(items.map(asCatalog)), cursor: 0, abort };
  useRadio.setState({ active: true, error: null });
}

/** The station takes over from the next song, its first song already prepared: the playing one is not cut
 * and the next transition never waits for a download. */
async function takeOver(context: PlayContext, found: Station, abort: AbortController, relevant: () => boolean): Promise<boolean> {
  const first = await publicPlayer.ensure(asCatalog(found.ranked[0]));
  if (!relevant()) return false;
  controller.continueAs(context, [first], 'context', true);
  followStation(found, found.ranked.slice(1), abort);
  return true;
}

let continuedEntry: string | null = null;
const continueEnabled = () => useApp.getState().settings?.wave.continueRadio !== false;
/** Network is checked again no more often than this while the queue-end radio plays the local wave. */
export const RETRY_ONLINE_MS = 30_000;
let offline: { context: PlayContext; label: string; lastTry: number; busy: boolean } | null = null;

/** The finite queue ends: an online station after the songs just heard, the local wave when offline.
 * Only candidate metadata is fetched here; the station downloads at most two songs ahead. */
export async function continueQueue(entryId: string): Promise<void> {
  const p = controller.state, version = controller.queueVersion;
  const seeds = continuationSeeds(p.queue, p.index, controller.heard, libraryTrack);
  if (!seeds.length) return;
  const anchor = seeds.find((t) => t.id === p.queue[p.index]?.trackId) ?? seeds[0];
  const label = continuationLabel(p.context, anchor);
  // A new queue, a song added at the end, repeat or the switch turned off: the listener decided otherwise.
  const relevant = () => controller.queueVersion === version && controller.state.repeat === 'off' && continueEnabled() &&
    controller.state.queue.at(-1)?.entryId === entryId;
  const abort = new AbortController();
  let continued = false;
  controller.holdQueueEnd(label);
  try {
    const found = await station(seeds, p.queue, anchor, abort.signal, relevant).catch(() => undefined /* offline: the local wave below */);
    if (!relevant()) return;
    if (found?.ranked.length) {
      controller.continueAs({ type: 'online-radio', label });
      followStation(found, found.ranked, abort);
      continued = true;
      return;
    }
    const { picks } = await api.waveNext({ currentId: p.queue[p.index]?.trackId ?? null, session: controller.state.queue.map((e) => e.trackId), count: 2 });
    if (!relevant() || !picks.length) return;
    const context: PlayContext = { type: 'wave', label: 'Моя волна' };
    controller.continueAs(context, picks.map((pick) => pick.id), 'wave');
    offline = { context, label, lastTry: Date.now(), busy: false };
    continued = true;
  } catch { /* nothing to continue with */ } finally {
    if (!continued) {
      abort.abort();
      if (controller.state.continuation === label) controller.holdQueueEnd(null);
      if (relevant()) useApp.getState().toast('Похожая музыка не нашлась: очередь закончится на этом треке', 'info');
    }
  }
}

/** The queue-end radio fell back to the local wave: once the network is back, the online station
 * takes over again from the next song. */
export async function returnOnline(): Promise<void> {
  const o = offline;
  if (!o || o.busy) return;
  if (controller.state.context !== o.context) { offline = null; return; }
  if (globalThis.navigator?.onLine === false || Date.now() - o.lastTry < RETRY_ONLINE_MS) return;
  o.busy = true; o.lastTry = Date.now();
  const abort = new AbortController();
  const relevant = () => offline === o && controller.state.context === o.context;
  let back = false;
  try {
    const p = controller.state;
    const seeds = continuationSeeds(p.queue, p.index, controller.heard, libraryTrack);
    if (!seeds.length) return;
    const found = await station(seeds, p.queue, seeds.find((t) => t.id === p.queue[p.index]?.trackId) ?? seeds[0], abort.signal, relevant);
    if (!found?.ranked.length || !relevant()) return;
    back = await takeOver({ type: 'online-radio', label: o.label }, found, abort, relevant);
    if (back) offline = null;
  } catch { /* still offline: the next try in RETRY_ONLINE_MS */ } finally {
    o.busy = false;
    if (!back) abort.abort();
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => void returnOnline());
useApp.subscribe((s, prev) => { if (s.serverOnline && !prev.serverOnline) void returnOnline(); });

controller.subscribe(() => {
  if (offline) void returnOnline();
  const p = controller.state, entry = p.queue[p.index];
  if (!entry || entry.entryId === continuedEntry || !wantsContinuation(p, continueEnabled())) return;
  continuedEntry = entry.entryId;
  void continueQueue(entry.entryId);
});

let buttonRequest = 0;
async function buttonStation(run: (request: number, abort: AbortController) => Promise<void>): Promise<void> {
  const request = ++buttonRequest, abort = new AbortController();
  useRadio.setState({ loading: true, error: null });
  try { await run(request, abort); }
  catch (e) {
    abort.abort();
    if (request === buttonRequest) { const error = (e as Error).message; useRadio.setState({ error }); useApp.getState().toast(error, 'error'); }
  } finally { if (request === buttonRequest) useRadio.setState({ loading: false }); }
}

/** "Similar to this song": the playing song stays and the station follows it; any other song starts first. */
export function startSimilar(t: Track): Promise<void> {
  return buttonStation(async (request, abort) => {
    if (t.reaction < 0) throw new Error('Эта песня отмечена дизлайком. Выберите другую основу радио.');
    const context: PlayContext = { type: 'online-radio', label: `Похожее на «${t.title}»` };
    if (controller.currentEntry?.trackId !== t.id) await controller.playTracks([t.id], 0, context);
    const version = controller.queueVersion, entryId = controller.currentEntry?.entryId;
    const relevant = () => request === buttonRequest && controller.queueVersion === version && controller.currentEntry?.entryId === entryId;
    const found = await station([t], controller.state.queue, t, abort.signal, relevant);
    if (!found) return abort.abort();
    if (!found.ranked.length) throw new Error('Не нашли похожих песен. Попробуйте позже или другой трек.');
    if (!await takeOver(context, found, abort, relevant)) abort.abort();
  });
}

/** Radio by an artist: seeds from their songs in the library (liked first), or the catalog's popular ones. */
export function startArtistRadio(artist: string, songs: Seed[] = []): Promise<void> {
  return buttonStation(async (request, abort) => {
    await controller.unlockAudio();
    const intent = controller.intentVersion;
    const relevant = () => request === buttonRequest && controller.intentVersion === intent;
    const seeds = artistSeeds(artist, library(), songs);
    const found = await station(seeds, [], seeds[0], abort.signal, relevant);
    if (!found) return abort.abort();
    if (!found.ranked.length) throw new Error(`Не нашли музыку для радио «${artist}». Попробуйте позже.`);
    await publicPlayer.play(found.ranked.map(asCatalog), 0, { type: 'online-radio', label: `Радио: ${artist}` });
    if (request !== buttonRequest || publicPlayer.sessionVersion === null) return abort.abort();
    session?.abort.abort();
    session = { seen: found.seen, loading: false, retryAt: 0, owner: publicPlayer.sessionVersion, cursor: 0, abort };
    useRadio.setState({ active: true });
  });
}

