import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeft, ArrowSquareOut, BookmarkSimple, Check, Clock, Heart, ListPlus, MagnifyingGlass, Play, Plus, Shuffle, SpinnerGap, ThumbsDown, X } from '@phosphor-icons/react';
import type { CatalogAlbum, CatalogAlbumPage as AlbumData, CatalogArtist, CatalogArtistPage as ArtistData, CatalogArtistRef, CatalogSearchResult, CatalogSearchType, CatalogTrack } from '@automix/core';
import { api } from '../lib/api.ts';
import { fmtTime, fmtTotal, tracksWord } from '../lib/format.ts';
import { catalogAlbumHref, catalogArtistHref, go, searchHref, useRoute } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { catalogPlayer, useCatalogPlayback } from '../store/catalog.ts';
import { Cover } from '../components/common.tsx';
import { TrackList, react } from '../components/TrackList.tsx';
import type { ReactionSync } from '../lib/api.ts';
import { create } from 'zustand';
import type { PlayContext } from '../audio/controller.ts';
import { Radio } from '@phosphor-icons/react';
import { LikeAllButton, likeLibraryTrack } from '../components/LikeAll.tsx';
import { startArtistRadio } from '../lib/radio.ts';
import { useCatalogResource, type CatalogCacheEntry } from '../lib/catalog-resource.ts';
import { TrackActionsMenu, useRecentSearches } from './Search.tsx';
import '../styles/catalog.css';

const SAVED_KEY = 'automix.catalog.artists';
const useReactions = create<{ values: Record<string, { value: number; sync?: ReactionSync }> }>(() => ({ values: {} }));
const reactionRevisions = new Map<string, number>();
const reactionsInFlight = new Set<string>();
// Background retries on the server end with a library event; pick up their final status for unimported songs.
async function refreshReactionSync() {
  const waiting = Object.entries(useReactions.getState().values).filter(([id, r]) => !reactionsInFlight.has(id) && (r.sync?.status === 'pending' || r.sync?.status === 'error'));
  if (!waiting.length) return;
  try {
    const items = new Map((await api.reactionSync()).items.map((item) => [item.externalId, item]));
    useReactions.setState((s) => {
      const values = { ...s.values };
      for (const [id] of waiting) { const item = items.get(id); if (item && !reactionsInFlight.has(id)) values[id] = { value: item.value, sync: item.sync }; }
      return { values };
    });
  } catch { /* next library event retries */ }
}
useApp.subscribe((s, prev) => { if (s.tracks !== prev.tracks) void refreshReactionSync(); });
async function catalogReact(track: CatalogTrack, value: number) {
  const known = catalogPlayer.known(track), local = known ? useApp.getState().tracks.get(known) : undefined;
  if (local) { await react(local, value); return; }
  const previous = useReactions.getState().values[track.externalId];
  const revision = (reactionRevisions.get(track.externalId) ?? 0) + 1;
  reactionRevisions.set(track.externalId, revision);
  const update = (next: { value: number; sync?: ReactionSync }) => useReactions.setState((s) => ({ values: { ...s.values, [track.externalId]: next } }));
  update({ value, sync: { status: 'pending' } });
  reactionsInFlight.add(track.externalId);
  try {
    const result = await api.catalogReact(track.externalId, value);
    if (reactionRevisions.get(track.externalId) !== revision) return;
    update(result);
    if (result.sync?.status === 'error' || result.sync?.status === 'pending') useApp.getState().toast(result.sync.error ?? 'Реакция сохранена. Отправка в Яндекс продолжится автоматически.', result.sync.status === 'error' ? 'error' : 'info');
  } catch (e) {
    if (reactionRevisions.get(track.externalId) !== revision) return;
    update(previous ?? { value: track.reaction ?? 0 }); useApp.getState().toast((e as Error).message, 'error');
  } finally {
    if (reactionRevisions.get(track.externalId) === revision) reactionsInFlight.delete(track.externalId);
  }
}
/** "Like all" on a catalog page: imported songs keep their library reaction, the rest are liked in the catalog. */
function CatalogLikeAll({ tracks }: { tracks: CatalogTrack[] }) {
  const library = useApp((s) => s.tracks);
  const reactions = useReactions((s) => s.values);
  const local = (track: CatalogTrack) => { const known = catalogPlayer.known(track); return known ? library.get(known) : undefined; };
  const like = async (track: CatalogTrack) => {
    const t = local(track);
    if (t) { await likeLibraryTrack(t); return; }
    const result = await api.catalogReact(track.externalId, 1);
    reactionRevisions.set(track.externalId, (reactionRevisions.get(track.externalId) ?? 0) + 1);
    useReactions.setState((s) => ({ values: { ...s.values, [track.externalId]: result } }));
  };
  return <LikeAllButton items={tracks} reaction={(track) => local(track)?.reaction ?? reactions[track.externalId]?.value ?? track.reaction ?? 0} like={like} />;
}
function stored<T>(key: string): T[] { try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.slice(0, 24) : []; } catch { return []; } }
function persist(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing/full storage */ } }
function unique<T>(items: T[], id: (item: T) => string): T[] { return [...new Map(items.map((item) => [id(item), item])).values()]; }
function albumKind(type: string): string { return type === 'single' ? 'Сингл' : type === 'compilation' ? 'Сборник' : 'Альбом'; }
function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

const searchCache = new Map<string, CatalogCacheEntry<CatalogSearchResult>>();
const artistCache = new Map<string, CatalogCacheEntry<ArtistData>>();
const albumCache = new Map<string, CatalogCacheEntry<AlbumData>>();
const yandexAccount = (state: ReturnType<typeof useApp.getState>) => {
  const provider = state.providers.find((entry) => entry.id === 'yandex');
  return provider?.status === 'connected' ? provider.account ?? '' : null;
};
useApp.subscribe((state, prev) => {
  if (state.providers === prev.providers || yandexAccount(state) === yandexAccount(prev)) return;
  searchCache.clear();
  artistCache.clear();
  albumCache.clear();
});

function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, cache: Map<string, CatalogCacheEntry<T>>, retainPrefix?: string) {
  const scope = useApp(yandexAccount);
  return useCatalogResource(key, load, cache, { scope, retainPrefix });
}

function ConnectionCard() {
  return <div className="catalog-empty"><MagnifyingGlass size={32} /><h2>Весь каталог — в одном поиске</h2>
    <p>Подключите Яндекс Музыку, чтобы находить артистов, открывать альбомы и слушать их с AutoMix. Поиск по вашей медиатеке доступен без подключения.</p>
    <a className="btn btn-primary" href="#/sources">Подключить Яндекс Музыку</a></div>;
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <div className="catalog-error" role="alert"><p>{message}</p><button className="btn btn-ghost btn-sm" onClick={retry}>Попробовать снова</button><a href="#/sources">Проверить подключение</a></div>;
}
function Skeleton({ profile = false }: { profile?: boolean }) {
  return <div className="catalog-skeleton" role="status"><span className="sr-only">Загружаю {profile ? 'страницу' : 'каталог'}…</span>
    {profile && <div className="catalog-skeleton-hero" aria-hidden="true" />}
    <div className="catalog-card-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div className="catalog-skeleton-card" key={i}><div /><span /><span /></div>)}</div></div>;
}
export function CatalogPlaybackNotice() {
  const state = useCatalogPlayback();
  if (state.phase === 'idle' && !state.error) return null;
  return <div className={`catalog-playback-notice ${state.error ? 'error' : ''}`} role={state.error ? 'alert' : 'status'}>
    {!state.error && <SpinnerGap className="catalog-spin" size={20} />}
    <span>{state.error ?? `${state.phase === 'starting' ? 'Готовлю к воспроизведению' : 'Готовлю следующую песню'}: ${state.title}`}</span>
    <button className="icon-btn" aria-label={state.error ? 'Закрыть сообщение' : 'Отменить подготовку очереди'} onClick={() => state.error ? catalogPlayer.dismissError() : catalogPlayer.cancel()}><X size={18} /></button>
  </div>;
}
function ArtistLinks({ artists, fallback }: { artists: CatalogArtistRef[]; fallback?: string }) {
  if (!artists.length) return <>{fallback}</>;
  return <>{artists.map((artist, i) => <span key={artist.id}>{i > 0 && ', '}<a href={catalogArtistHref(artist.id)}>{artist.name}</a></span>)}</>;
}
function CatalogNav() {
  return <div className="catalog-nav"><button className="icon-btn" aria-label="Назад" onClick={() => history.length > 1 ? history.back() : go('/yandex')}><ArrowLeft size={21} /></button>
    <a href="#/yandex"><MagnifyingGlass size={17} />Поиск</a><span>Яндекс Музыка</span></div>;
}
function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="catalog-section"><div className="catalog-section-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
function ArtistCard({ artist, onVisit }: { artist: CatalogArtistRef; onVisit?: () => void }) {
  return <a className="catalog-card artist" href={catalogArtistHref(artist.id)} onClick={onVisit}>
    <Cover url={artist.imageUrl} seed={artist.id} round /><h3>{artist.name}</h3><p>Исполнитель</p></a>;
}
function AlbumCard({ album, onVisit }: { album: CatalogAlbum; onVisit?: () => void }) {
  return <a className="catalog-card" href={catalogAlbumHref(album.id)} onClick={onVisit}>
    <Cover url={album.imageUrl} seed={album.id} /><h3>{album.title}</h3><p>{album.year ? `${album.year} · ` : ''}{albumKind(album.type)}</p>
    <p className="catalog-card-artists">{album.artists.map((a) => a.name).join(', ')}</p></a>;
}

function CatalogTracks({ tracks, label, artwork = true, albums = true, queueTracks = tracks, context = { type: 'search', label }, onPlay }: { tracks: CatalogTrack[]; label: string; artwork?: boolean; albums?: boolean; queueTracks?: CatalogTrack[]; context?: PlayContext; onPlay?: () => void }) {
  const preparation = useCatalogPlayback();
  const library = useApp((s) => s.tracks);
  const player = useApp(useShallow((s) => ({ queue: s.player.queue, index: s.player.index })));
  const reactions = useReactions((s) => s.values);
  const current = player.queue[player.index]?.trackId;
  const play = (track: CatalogTrack) => { onPlay?.(); void catalogPlayer.play(queueTracks, queueTracks.indexOf(track), context); };
  return <div className={`catalog-track-list ${artwork ? '' : 'no-art'} ${albums ? '' : 'no-album'}`} role="list" aria-label={label}>
    {tracks.map((track, i) => {
      const known = catalogPlayer.known(track), busy = preparation.pending.includes(track.externalId);
      const available = track.playable || !!known;
      const active = known && current === known;
      const local = known ? library.get(known) : null;
      const reaction = local?.reaction ?? reactions[track.externalId]?.value ?? track.reaction ?? 0;
      const sync = local?.reactionSync ?? reactions[track.externalId]?.sync;
      return <div className={`catalog-track ${available ? '' : 'unavailable'} ${active ? 'playing' : ''}`} role="listitem" key={track.externalId}>
        <button className="catalog-track-play" aria-label={`Слушать: ${track.title}`} disabled={!available || preparation.phase === 'starting' && preparation.externalId === track.externalId}
          onClick={() => play(track)}>
          <span className="catalog-track-number">{i + 1}</span><Play size={18} weight="fill" /></button>
        {artwork && <Cover url={track.coverUrl} seed={track.externalId} size={42} />}
        <div className="catalog-track-name"><button disabled={!available} onClick={() => play(track)}>{track.title}</button>
          <div className="catalog-track-meta">{track.explicit && <abbr title="Ненормативная лексика" className="catalog-explicit">E</abbr>}<span><ArtistLinks artists={track.artists} fallback={track.artist} /></span><span className="catalog-mobile-time"> · {fmtTime(track.duration)}</span></div>
          {busy ? <span className="catalog-track-state">Подготавливается…</span> : !available ? <span className="catalog-track-state">Недоступно</span> : sync?.status === 'pending' ? <span className="catalog-track-state">Отправляю реакцию в Яндекс…</span>
            : sync?.status === 'error' ? <span className="catalog-track-state error" title={sync.error}>Яндекс не принял реакцию · повторю автоматически</span>
            : local && local.analysis.status !== 'done' ? <span className="catalog-track-state">Анализ в фоне</span> : null}
        </div>
        {albums && <div className="catalog-track-album">{track.albumId ? <a href={catalogAlbumHref(track.albumId)}>{track.album}</a> : track.album}</div>}
        <span className="catalog-track-duration">{fmtTime(track.duration)}</span>
        <div className="catalog-track-actions"><button className={`icon-btn ${reaction > 0 ? 'liked' : ''}`} aria-pressed={reaction > 0} aria-label={reaction > 0 ? `Убрать лайк: ${track.title}` : `Нравится: ${track.title}`} title={sync?.status === 'pending' ? 'Отправляется в Яндекс' : sync?.status === 'error' ? sync.error : 'Нравится · Яндекс Музыка'} onClick={() => void catalogReact(track, reaction > 0 ? 0 : 1)}><Heart size={18} weight={reaction > 0 ? 'fill' : 'regular'} /></button>
          <button className={`icon-btn catalog-dislike ${reaction < 0 ? 'liked' : ''}`} aria-pressed={reaction < 0} aria-label={reaction < 0 ? `Убрать дизлайк: ${track.title}` : `Не нравится: ${track.title}`} title="Не нравится · Яндекс Музыка" onClick={() => void catalogReact(track, reaction < 0 ? 0 : -1)}><ThumbsDown size={18} weight={reaction < 0 ? 'fill' : 'regular'} /></button>
          <button className="icon-btn catalog-save-button" aria-label={known ? `В медиатеке: ${track.title}` : `Добавить в медиатеку: ${track.title}`} title={known ? 'В медиатеке' : 'Добавить в медиатеку'} disabled={!!known || busy || !available} onClick={() => void catalogPlayer.save(track)}>
          {busy ? <SpinnerGap className="catalog-spin" size={18} /> : known ? <Check size={18} /> : <Plus size={18} />}</button>
          <button className="icon-btn catalog-queue-button" aria-label={`В очередь: ${track.title}`} title="Добавить в очередь" disabled={busy || !available} onClick={() => void catalogPlayer.enqueue(track)}><ListPlus size={19} /></button>
          <TrackActionsMenu className="catalog-options" title={track.title}>
            <button role="menuitem" disabled={busy || !available} onClick={() => void catalogPlayer.enqueue(track)}><ListPlus size={19} />Добавить в очередь</button>
            <button role="menuitem" disabled={!!known || busy || !available} onClick={() => void catalogPlayer.save(track)}><Plus size={19} />{known ? 'Уже в медиатеке' : 'Добавить в медиатеку'}</button>
            <button role="menuitem" onClick={() => void catalogReact(track, reaction < 0 ? 0 : -1)}><ThumbsDown size={19} weight={reaction < 0 ? 'fill' : 'regular'} />{reaction < 0 ? 'Убрать дизлайк' : 'Не нравится'}</button>
          </TrackActionsMenu></div>
      </div>;
    })}
  </div>;
}

type Scope = CatalogSearchType | 'local';
const SCOPES: [Scope, string][] = [['all', 'Всё'], ['track', 'Треки'], ['artist', 'Исполнители'], ['album', 'Альбомы'], ['local', 'Медиатека']];
function mergeSearch(base: CatalogSearchResult, more: CatalogSearchResult): CatalogSearchResult {
  return { ...more, best: base.best, artists: unique([...base.artists, ...more.artists], (x) => x.id), albums: unique([...base.albums, ...more.albums], (x) => x.id), tracks: unique([...base.tracks, ...more.tracks], (x) => x.externalId) };
}

/** Yandex Music catalog search (optional source; needs a connected account). */
export function YandexSearchPage() {
  const route = useRoute();
  const initialScope = route.query.get('type') as Scope;
  const [query, setQuery] = useState(route.query.get('q') ?? '');
  const [scope, setScope] = useState<Scope>(SCOPES.some(([s]) => s === initialScope) ? initialScope : 'all');
  const [settled, setSettled] = useState(query.trim());
  const { recent, remember: rememberQuery, clear } = useRecentSearches();
  const [saved] = useState(() => stored<CatalogArtist>(SAVED_KEY).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string'));
  const [more, setMore] = useState<{ key: string; result: CatalogSearchResult } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const providers = useApp((s) => s.providers), tracks = useApp((s) => s.tracks);
  const connected = providers.find((p) => p.id === 'yandex')?.status === 'connected';
  const routeQuery = route.query.get('q') ?? '';
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { setQuery(routeQuery); setSettled(routeQuery.trim()); setScope(SCOPES.some(([v]) => initialScope === v) ? initialScope : 'all'); }, [routeQuery, initialScope]);
  useEffect(() => { const timer = setTimeout(() => setSettled(query.trim()), 220); return () => clearTimeout(timer); }, [query]);
  const prefix = `search:${scope}:`;
  const key = connected && scope !== 'local' ? settled ? prefix + settled : 'home' : null;
  const keyRef = useRef(key); keyRef.current = key;
  useEffect(() => { setMoreBusy(false); setMoreError(null); }, [key]);
  const resource = useResource(key, (signal) => settled ? api.catalogSearch(settled, scope as CatalogSearchType, 0, signal) : api.catalogHome(signal), searchCache, prefix);
  const result = resource.data ? more && more.key === resource.dataKey ? mergeSearch(resource.data, more.result) : resource.data : null;
  const shownQuery = resource.dataKey?.startsWith(prefix) ? resource.dataKey.slice(prefix.length) : '';
  const waiting = scope !== 'local' && (query.trim() !== settled || resource.loading);
  const local = useMemo(() => [...tracks.values()].filter((t) => query.trim().toLowerCase().split(/\s+/).every((part) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(part))), [tracks, query]);
  const remember = () => rememberQuery(shownQuery);
  const moveResultFocus = (event: KeyboardEvent) => {
    if (waiting || event.nativeEvent.isComposing || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const items = [...resultsRef.current?.querySelectorAll<HTMLElement>('.catalog-track-play:enabled, .track-art-play:enabled, a.catalog-card, a.catalog-best, .catalog-best button:enabled') ?? []];
    const index = items.indexOf(event.target as HTMLElement);
    if (event.target !== searchRef.current && index < 0) return;
    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)] ?? (index === 0 && event.key === 'ArrowUp' ? searchRef.current : null);
    if (next) { event.preventDefault(); next.focus(); }
  };
  const updateQuery = (q: string) => {
    setQuery(q);
    if (!q.trim()) setSettled('');
    history.replaceState(null, '', searchHref(q, scope));
  };
  const changeScope = (s: Scope) => {
    if (s === scope) return;
    setScope(s);
    setSettled(query.trim());
    setMoreError(null);
    go(`/yandex?${new URLSearchParams({ q: query, type: s })}`);
  };
  const moreResults = async () => {
    if (!result || !key || scope === 'local' || waiting || resource.dataKey !== key) return;
    setMoreBusy(true); setMoreError(null); const requested = key;
    try {
      const page = await api.catalogSearch(settled, scope, result.page + 1);
      if (keyRef.current === requested) setMore({ key: requested, result: more?.key === requested ? mergeSearch(more.result, page) : page });
    } catch (e) { if (keyRef.current === requested) setMoreError((e as Error).message); }
    finally { if (keyRef.current === requested) setMoreBusy(false); }
  };
  const bestArtist = result?.best?.type === 'artist' ? result.artists.find((a) => a.id === result.best!.id) : undefined;
  const bestAlbum = result?.best?.type === 'album' ? result.albums.find((a) => a.id === result.best!.id) : undefined;
  const bestTrack = result?.best?.type === 'track' ? result.tracks.find((a) => a.externalId === result.best!.id) : undefined;
  const hasResults = !!result && !!(result.tracks.length + result.artists.length + result.albums.length);
  return <div className="main-inner catalog-page catalog-search-page" onKeyDown={moveResultFocus}>
    <header className="catalog-search-header"><div><p className="catalog-eyebrow">Каталог музыки</p><h1 className="page-title">Поиск</h1></div><span className="catalog-source-label">{scope === 'local' ? 'Ваша медиатека' : 'Яндекс Музыка'}</span></header>
    <div className="catalog-search-tools"><form className="catalog-search-field" role="search" onSubmit={(e) => { e.preventDefault(); rememberQuery(query); setSettled(query.trim()); }}>
      {waiting && resource.data ? <SpinnerGap size={22} className="catalog-spin" role="status" aria-label="Обновляю результаты" /> : <MagnifyingGlass size={22} aria-hidden="true" />}
      <input ref={searchRef} type="search" maxLength={300} placeholder="Трек, исполнитель или альбом" aria-label="Поиск музыки" aria-controls="catalog-search-results" value={query} onChange={(e) => updateQuery(e.target.value)} />
      {query && <button className="icon-btn" type="button" aria-label="Очистить поиск" onClick={() => { updateQuery(''); searchRef.current?.focus(); }}><X size={19} /></button>}
    </form>
    <div className="catalog-scopes" aria-label="Тип результатов">{SCOPES.map(([id, label]) => <button className={`chip ${scope === id ? 'on' : ''}`} key={id} aria-pressed={scope === id} onClick={() => changeScope(id)}>{label}</button>)}
      <a className="chip" href={`#/search?${new URLSearchParams({ q: query })}`}>Другие источники</a></div></div>
    {!query && recent.length > 0 && <section className="catalog-recent"><div className="catalog-section-heading"><h2>Недавно искали</h2><button onClick={clear}>Очистить</button></div><div>{recent.map((q) => <button key={q} onClick={() => { updateQuery(q); setSettled(q.trim()); }}><Clock size={15} />{q}</button>)}</div></section>}
    <div id="catalog-search-results" ref={resultsRef} aria-busy={waiting}>
    {scope === 'local' ? <Section title={query ? `В медиатеке · ${local.length}` : 'Ваша музыка'}><TrackList tracks={local} emptyText="В медиатеке ничего не нашлось" onPlay={(i) => { rememberQuery(query); void controller.playTracks(local.map((t) => t.id), i, { type: 'search', label: query || 'Медиатека' }); }} /></Section>
      : !connected ? providers.length ? <ConnectionCard /> : <Skeleton />
      : resource.error ? <Failure message={resource.error} retry={resource.retry} />
      : (!result || waiting && !hasResults) ? <Skeleton />
      : !hasResults && query ? <div className="catalog-empty"><MagnifyingGlass size={32} /><h2>Ничего не нашлось</h2><p>Проверьте название или попробуйте имя исполнителя. Можно также поискать в своей медиатеке.</p><button className="btn btn-ghost" onClick={() => changeScope('local')}>Искать в медиатеке</button></div>
      : <>
        {shownQuery && scope === 'all' && (bestArtist || bestAlbum || bestTrack) && <Section title="Лучшее совпадение">
          {bestArtist ? <a className="catalog-best" href={catalogArtistHref(bestArtist.id)} onClick={remember}><Cover url={bestArtist.imageUrl} seed={bestArtist.id} round size={104} /><div><span>Исполнитель</span><h3>{bestArtist.name}</h3><span>Открыть страницу →</span></div></a>
            : bestAlbum ? <a className="catalog-best" href={catalogAlbumHref(bestAlbum.id)} onClick={remember}><Cover url={bestAlbum.imageUrl} seed={bestAlbum.id} size={104} /><div><span>{albumKind(bestAlbum.type)}</span><h3>{bestAlbum.title}</h3><span>{bestAlbum.artists.map((a) => a.name).join(', ')}</span></div></a>
            : bestTrack && <div className="catalog-best"><Cover url={bestTrack.coverUrl} seed={bestTrack.externalId} size={104} /><div><span>Трек</span><h3>{bestTrack.title}</h3><span>{bestTrack.artist}</span><button className="btn btn-primary btn-sm" onClick={() => { remember(); void catalogPlayer.play(result.tracks, result.tracks.indexOf(bestTrack), { type: 'search', label: shownQuery }); }}><Play size={15} weight="fill" />Слушать</button></div></div>}
        </Section>}
        {!query && saved.length > 0 && <Section title="Сохранённые исполнители"><div className="catalog-card-grid">{saved.map((a) => <ArtistCard key={a.id} artist={a} />)}</div></Section>}
        {(scope === 'track' || !shownQuery || scope === 'all') && result.tracks.length > 0 && <Section title={shownQuery ? 'Треки' : 'Ваши любимые треки'} action={scope === 'all' && shownQuery && result.hasMore.tracks ? <button onClick={() => changeScope('track')}>Больше треков</button> : undefined}><CatalogTracks tracks={result.tracks} label={shownQuery ? `Поиск «${shownQuery}»` : 'Любимые треки Яндекса'} onPlay={remember} /></Section>}
        {(scope === 'all' || scope === 'artist') && result.artists.length > 0 && <Section title={shownQuery ? 'Исполнители' : 'Исполнители из вашей коллекции'} action={scope === 'all' && shownQuery ? <button onClick={() => changeScope('artist')}>Показать всех</button> : undefined}><div className="catalog-card-grid">{(scope === 'all' ? result.artists.slice(0, 8) : result.artists).map((a) => <ArtistCard key={a.id} artist={a} onVisit={remember} />)}</div></Section>}
        {(scope === 'all' || scope === 'album') && result.albums.length > 0 && <Section title="Альбомы и синглы" action={scope === 'all' && shownQuery ? <button onClick={() => changeScope('album')}>Показать все</button> : undefined}><div className="catalog-card-grid">{(scope === 'all' ? result.albums.slice(0, 8) : result.albums).map((a) => <AlbumCard key={a.id} album={a} onVisit={remember} />)}</div></Section>}
        {scope !== 'all' && result.hasMore[scope === 'track' ? 'tracks' : scope === 'artist' ? 'artists' : 'albums'] && <button className="btn btn-ghost catalog-load-more" onClick={() => void moreResults()} disabled={moreBusy || waiting}>{moreBusy ? 'Загружаю…' : 'Показать ещё'}</button>}
        {moreError && <Failure message={moreError} retry={() => void moreResults()} />}
      </>}
    </div>
  </div>;
}

export function CatalogArtistPage() {
  const { parts } = useRoute(); const id = parts[2] ?? '';
  const resource = useResource<ArtistData>(`artist:${id}`, (signal) => api.catalogArtist(id, 0, signal), artistCache);
  const [saved, setSaved] = useState(() => stored<CatalogArtist>(SAVED_KEY).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string'));
  const [showTracks, setShowTracks] = useState(false);
  const [more, setMore] = useState<{ id: string; albums: CatalogAlbum[]; page: number; hasMore: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const idRef = useRef(id); idRef.current = id;
  useEffect(() => { setShowTracks(false); setBusy(false); setError(null); }, [id]);
  const data = resource.data;
  const moreHere = more?.id === id ? more : null;
  const albums = unique([...(data?.albums ?? []), ...(moreHere?.albums ?? [])], (a) => a.id);
  const moreAlbums = async () => {
    setBusy(true); setError(null); const requested = id;
    try { const next = await api.catalogArtist(id, (moreHere?.page ?? 0) + 1); if (idRef.current === requested) setMore({ id, albums: unique([...(moreHere?.albums ?? []), ...next.albums], (a) => a.id), page: next.page, hasMore: next.hasMoreAlbums }); }
    catch (e) { if (idRef.current === requested) setError((e as Error).message); }
    finally { if (idRef.current === requested) setBusy(false); }
  };
  const toggleSaved = () => { if (!data) return; const next = saved.some((a) => a.id === id) ? saved.filter((a) => a.id !== id) : [data.artist, ...saved].slice(0, 24); setSaved(next); persist(SAVED_KEY, next); };
  const play = (shuffle = false) => {
    if (!data?.popularTracks.length) return;
    const tracks = shuffle ? shuffled(data.popularTracks) : data.popularTracks;
    void catalogPlayer.play(tracks, 0, { type: 'artist', id, label: data.artist.name });
  };
  return <div className="main-inner catalog-page"><CatalogNav />{resource.loading ? <Skeleton profile /> : resource.error ? <Failure message={resource.error} retry={resource.retry} /> : data && <>
    <header className="catalog-hero artist"><Cover url={data.artist.imageUrl} seed={id} round /><div className="catalog-hero-content"><p className="catalog-eyebrow">Исполнитель</p><h1>{data.artist.name}</h1>
      {data.artist.listeners != null && <p className="muted">{data.artist.listeners.toLocaleString('ru-RU')} слушателей в месяц</p>}
      {data.artist.genres.length > 0 && <p className="catalog-genres">{data.artist.genres.slice(0, 4).join(' · ')}</p>}
      <div className="catalog-hero-actions"><button className="btn btn-primary" disabled={!data.popularTracks.some((t) => t.playable)} onClick={() => play()}><Play size={19} weight="fill" />Слушать</button>
        <button className="btn btn-ghost" onClick={toggleSaved} aria-pressed={saved.some((a) => a.id === id)}><BookmarkSimple size={19} weight={saved.some((a) => a.id === id) ? 'fill' : 'regular'} />{saved.some((a) => a.id === id) ? 'В сохранённых' : 'Сохранить артиста'}</button>
        <button className="icon-btn" aria-label="Слушать исполнителя вперемешку" disabled={!data.popularTracks.length} onClick={() => play(true)}><Shuffle size={22} /></button>
        <button className="btn btn-ghost" onClick={() => void startArtistRadio(data.artist.name, data.popularTracks)}><Radio size={19} />Радио по исполнителю</button>
        {data.popularTracks.length > 0 && <CatalogLikeAll tracks={data.popularTracks} />}</div>
    </div></header>
    <Section title="Популярное">{data.popularTracks.length ? <><CatalogTracks tracks={showTracks ? data.popularTracks : data.popularTracks.slice(0, 5)} label={data.artist.name} queueTracks={data.popularTracks} context={{ type: 'artist', id, label: data.artist.name }} />{data.popularTracks.length > 5 && <button className="catalog-text-button" onClick={() => setShowTracks((v) => !v)}>{showTracks ? 'Свернуть' : 'Показать все треки'}</button>}</> : <p className="muted">У этого исполнителя пока нет доступных треков.</p>}</Section>
    {albums.length > 0 && <Section title="Дискография"><div className="catalog-card-grid">{albums.map((album) => <AlbumCard key={album.id} album={album} />)}</div>
      {(moreHere?.hasMore ?? data.hasMoreAlbums) && <button className="btn btn-ghost catalog-load-more" disabled={busy} onClick={() => void moreAlbums()}>{busy ? 'Загружаю…' : 'Ещё релизы'}</button>}{error && <Failure message={error} retry={() => void moreAlbums()} />}</Section>}
    {data.artist.description && <Section title="Об исполнителе"><p className="catalog-biography">{data.artist.description}</p><a className="catalog-external" href={`https://music.yandex.ru/artist/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer noopener">Страница на Яндекс Музыке <ArrowSquareOut size={15} /></a></Section>}
    {data.similarArtists.length > 0 && <Section title="Вам также могут понравиться"><div className="catalog-card-grid">{data.similarArtists.map((a) => <ArtistCard key={a.id} artist={a} />)}</div></Section>}
  </>}</div>;
}

export function CatalogAlbumPage() {
  const { parts } = useRoute(); const id = parts[2] ?? '';
  const resource = useResource<AlbumData>(`album:${id}`, (signal) => api.catalogAlbum(id, signal), albumCache);
  const data = resource.data;
  const play = (shuffle = false) => {
    if (!data) return; const tracks = shuffle ? shuffled(data.tracks) : data.tracks;
    void catalogPlayer.play(tracks, 0, { type: 'album', id, label: data.album.title });
  };
  const discs = data ? [...new Set(data.tracks.map((t) => t.disc ?? 1))] : [];
  return <div className="main-inner catalog-page"><CatalogNav />{resource.loading ? <Skeleton profile /> : resource.error ? <Failure message={resource.error} retry={resource.retry} /> : data && <>
    <header className="catalog-hero album"><Cover url={data.album.imageUrl} seed={id} /><div className="catalog-hero-content"><p className="catalog-eyebrow">{albumKind(data.album.type)}</p><h1>{data.album.title}</h1>
      <div className="catalog-album-by"><ArtistLinks artists={data.album.artists} /></div><p className="muted">{data.album.year ? `${data.album.year} · ` : ''}{tracksWord(data.tracks.length)} · {fmtTotal(data.tracks.reduce((sum, t) => sum + t.duration, 0))}</p>
      <div className="catalog-hero-actions"><button className="btn btn-primary" disabled={!data.tracks.some((t) => t.playable)} onClick={() => play()}><Play size={19} weight="fill" />Слушать альбом</button><button className="btn btn-ghost" disabled={!data.tracks.some((t) => t.playable)} onClick={() => play(true)}><Shuffle size={19} />Вперемешку</button>{data.tracks.length > 0 && <CatalogLikeAll tracks={data.tracks} />}</div>
    </div></header>
    {!data.album.available && <p className="catalog-availability">Часть записей этого релиза может быть недоступна для вашего аккаунта.</p>}
    <Section title="Треки">{data.tracks.length === 0 ? <p className="muted">Список треков пока недоступен.</p> : discs.map((disc) => <div key={disc}>{discs.length > 1 && <h3 className="catalog-disc">Диск {disc}</h3>}<CatalogTracks tracks={data.tracks.filter((t) => (t.disc ?? 1) === disc)} label={data.album.title} queueTracks={data.tracks} context={{ type: 'album', id, label: data.album.title }} artwork={false} albums={false} /></div>)}</Section>
    {data.description && <p className="catalog-biography">{data.description}</p>}
    <a className="catalog-external" href={`https://music.yandex.ru/album/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer noopener">Открыть на Яндекс Музыке <ArrowSquareOut size={15} /></a>
  </>}</div>;
}
