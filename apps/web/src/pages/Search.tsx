import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowBendDownRight, ArrowClockwise, ArrowSquareOut, Clock, DotsThree, DownloadSimple, Heart, ListPlus, MagnifyingGlass, Play, Plus, Radio, SpinnerGap, Swap, X } from '@phosphor-icons/react';
import { useIntentWarmup } from '../lib/intent-warmup.ts';
import { startRadio } from '../lib/radio.ts';
import type { CatalogTrack } from '@automix/core';
import { api, type PublicSource, type PublicTrack, type Track } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { publicAlbumHref, publicTrackArtistLinks, useRoute } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { publicPlayer, usePublicPlayback } from '../store/catalog.ts';
import { Cover } from '../components/common.tsx';
import { react } from '../components/TrackList.tsx';
import { TrackMenu } from '../components/TrackMenu.tsx';
import { openVersionPanel } from '../components/VersionPanel.tsx';

type Filter = 'all' | PublicSource | 'local';
const REMOTE: PublicSource[] = ['ytmusic', 'youtube', 'soundcloud'];
export const SOURCE_LABEL: Record<PublicSource, string> = { ytmusic: 'YouTube Music', youtube: 'YouTube', soundcloud: 'SoundCloud' };
const FILTERS: [Filter, string][] = [['all', 'Все'], ['ytmusic', 'YouTube Music'], ['youtube', 'YouTube'], ['soundcloud', 'SoundCloud'], ['local', 'Моя музыка']];
const RECENT_KEY = 'mora.search.recent';
const TAG_TEXT: Record<string, string> = {
  explicit: 'E', clean: 'Clean', remix: 'Ремикс', live: 'Live', acoustic: 'Акустика', slowed: 'Slowed', 'sped-up': 'Sped up', reverb: 'Reverb',
  nightcore: 'Nightcore', instrumental: 'Инструментал', karaoke: 'Караоке', cover: 'Кавер', remaster: 'Ремастер', extended: 'Extended',
  'radio-edit': 'Radio edit', demo: 'Демо', mashup: 'Мэшап', 'bass-boosted': 'Bass boosted', '8d': '8D', uncensored: 'Uncensored',
};

interface Slot { status: 'loading' | 'done' | 'error'; items: PublicTrack[]; error?: string }

function readRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 12) : []; } catch { return []; }
}
function writeRecent(v: string[]): void { try { localStorage.setItem(RECENT_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }

/** CatalogPlayer works on the Yandex catalog shape; public results map onto it one-to-one. */
export const asCatalog = (t: PublicTrack): CatalogTrack & { audioProvider: PublicTrack['audioProvider'] } => ({
  externalId: t.externalId, title: t.title, artist: t.artist, album: t.album, duration: t.duration, coverUrl: t.coverUrl, pageUrl: t.pageUrl,
  license: null, playable: t.playable, libraryTrackId: t.libraryTrackId, artists: [], albumId: t.albumId, explicit: t.explicit, audioProvider: t.audioProvider,
});

/** Prepares a public result and returns the library row (a technical one until saved). */
export async function ensurePublic(t: PublicTrack): Promise<Track> {
  const id = await publicPlayer.ensure(asCatalog(t));
  return useApp.getState().tracks.get(id) ?? (await api.track(id));
}

export function VersionTags({ labels, explicit }: { labels: { tag: string; origin: 'source' | 'title' }[]; explicit?: boolean }) {
  const shown = labels.filter((l) => l.tag !== 'explicit');
  return <>
    {(explicit || labels.some((l) => l.tag === 'explicit')) && <abbr className="version-tag explicit" title="Источник отмечает ненормативную лексику">E</abbr>}
    {shown.map((l) => <span key={l.tag} className={`version-tag ${l.origin}`} title={l.origin === 'source' ? 'Так указано источником' : 'Предположение по названию'}>{TAG_TEXT[l.tag] ?? l.tag}</span>)}
  </>;
}

export function SearchPage() {
  const preparation = usePublicPlayback();
  const route = useRoute();
  const [query, setQuery] = useState(route.query.get('q') ?? '');
  const initial = route.query.get('src') as Filter;
  const [filter, setFilter] = useState<Filter>(FILTERS.some(([f]) => f === initial) ? initial : 'all');
  const [settled, setSettled] = useState(query.trim());
  const [slots, setSlots] = useState<Partial<Record<PublicSource, Slot>>>({});
  const [recent, setRecent] = useState(readRecent);
  const [selected, setSelected] = useState<string | null>(null);
  const controllers = useRef(new Map<PublicSource, AbortController>());
  const input = useRef<HTMLInputElement>(null);
  const providers = useApp((s) => s.providers);
  const yandex = providers.find((p) => p.id === 'yandex')?.status === 'connected';
  const tracks = useApp((s) => s.tracks), order = useApp((s) => s.order);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { const t = setTimeout(() => setSettled(query.trim()), 300); return () => clearTimeout(t); }, [query]);

  const run = (src: PublicSource, q: string) => {
    controllers.current.get(src)?.abort();
    const ctl = new AbortController();
    controllers.current.set(src, ctl);
    setSlots((s) => ({ ...s, [src]: { status: 'loading', items: s[src]?.items ?? [] } }));
    api.publicSearch(src, q, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setSlots((s) => ({ ...s, [src]: { status: 'done', items: r.items } })); })
      .catch((e) => { if (!ctl.signal.aborted) setSlots((s) => ({ ...s, [src]: { status: 'error', items: [], error: (e as Error).message } })); });
  };

  useEffect(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    setSlots({});
    setSelected(null);
    if (!settled) return;
    for (const src of filter === 'all' ? REMOTE : REMOTE.includes(filter as PublicSource) ? [filter as PublicSource] : []) run(src, settled);
    history.replaceState(null, '', `#/search?${new URLSearchParams({ q: settled, src: filter })}`);
  }, [settled, filter]);
  useEffect(() => () => { for (const c of controllers.current.values()) c.abort(); }, []);

  const local = useMemo(() => {
    const parts = settled.toLocaleLowerCase('ru').replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    if (!parts.length || (filter !== 'all' && filter !== 'local')) return [] as Track[];
    return order.map((id) => tracks.get(id)!).filter((t) => t && parts.every((p) => `${t.title} ${t.artist} ${t.album}`.toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(p)));
  }, [settled, filter, order, tracks]);

  const remember = (q = query.trim()) => {
    if (!q) return;
    const next = [q, ...recent.filter((x) => x !== q)].slice(0, 12);
    setRecent(next); writeRecent(next);
  };

  // One flat list for the keyboard, in the same fixed section order as on screen.
  const limit = filter === 'all' ? 6 : 50;
  const localShown = filter === 'all' ? local.slice(0, 4) : local;
  const sections = REMOTE.filter((s) => slots[s]).map((s) => ({ src: s, slot: slots[s]!, items: slots[s]!.items.slice(0, limit) }));
  const keys = [...localShown.map((t) => `local:${t.id}`), ...sections.flatMap((s) => s.items.map((i) => `${s.src}:${i.externalId}`))];

  const playPublic = (src: PublicSource, i: number) => {
    remember();
    const list = slots[src]!.items;
    void publicPlayer.play(list.map(asCatalog), i, { type: 'search', label: `${SOURCE_LABEL[src]} · ${settled}` });
  };
  const playLocal = (i: number) => { remember(); void controller.playTracks(localShown.map((t) => t.id), i, { type: 'search', label: settled }); };
  const activate = (key: string) => {
    const [src, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (src === 'local') playLocal(localShown.findIndex((t) => t.id === id));
    else playPublic(src as PublicSource, slots[src as PublicSource]!.items.findIndex((t) => t.externalId === id));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!keys.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter')) return;
    if (e.key === 'Enter') { e.preventDefault(); activate(selected && keys.includes(selected) ? selected : keys[0]); return; }
    e.preventDefault();
    const i = selected ? keys.indexOf(selected) : -1;
    const next = keys[Math.max(0, Math.min(keys.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    setSelected(next);
    document.getElementById(`sr-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  return <div className="main-inner search-page" onKeyDown={onKey}>
    <h1 className="page-title">Поиск</h1>
    <form className="search-bar" role="search" onSubmit={(e) => { e.preventDefault(); setSettled(query.trim()); }}>
      <MagnifyingGlass size={22} aria-hidden="true" />
      <input ref={input} type="search" maxLength={200} placeholder="Исполнитель, трек или ссылка" aria-label="Поиск музыки" value={query}
        onChange={(e) => setQuery(e.target.value)} aria-controls="search-results" aria-activedescendant={selected ? `sr-${selected}` : undefined} />
      {query && <button type="button" className="icon-btn" aria-label="Очистить" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={18} /></button>}
    </form>
    {preparation.phase === 'starting' && <div role="status" className="setting"><span>Подготавливаем «{preparation.title}»…</span><button className="btn btn-ghost btn-sm" onClick={() => publicPlayer.cancel()}>Отмена</button></div>}
    {preparation.error && <div role="alert" className="setting"><span className="error-text">{preparation.error}</span><button className="btn btn-ghost btn-sm" onClick={() => publicPlayer.dismissError()}>Закрыть</button></div>}
    <div className="search-filters" role="group" aria-label="Где искать">
      {FILTERS.map(([f, label]) => <button key={f} className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
      {yandex && <a className="chip" href={`#/yandex?${new URLSearchParams({ q: query, type: 'all' })}`}>Яндекс Музыка</a>}
    </div>

    {!settled && <section className="search-recent">
      {recent.length > 0 ? <>
        <div className="search-section-head"><h2>Недавно искали</h2><button className="btn btn-ghost btn-sm" onClick={() => { setRecent([]); writeRecent([]); }}>Очистить</button></div>
        <div className="search-recent-list">{recent.map((r) => <button key={r} onClick={() => setQuery(r)}><Clock size={15} aria-hidden="true" />{r}</button>)}</div>
      </> : <p className="muted">Найдите любую песню: результаты YouTube Music, YouTube и SoundCloud играют сразу, без аккаунта. Ссылку на трек тоже можно вставить.</p>}
    </section>}

    <div id="search-results" role="listbox" aria-label="Результаты">
      {localShown.length > 0 && <section className="search-section">
        <div className="search-section-head"><h2>Моя музыка</h2>{filter === 'all' && local.length > 4 && <button className="btn btn-ghost btn-sm" onClick={() => setFilter('local')}>Все {local.length}</button>}</div>
        {localShown.map((t, i) => <LocalRow key={t.id} t={t} id={`local:${t.id}`} active={selected === `local:${t.id}`} onPlay={() => playLocal(i)} />)}
      </section>}
      {settled && filter === 'local' && !local.length && <p className="muted">В вашей музыке ничего не нашлось.</p>}
      {sections.map(({ src, slot, items }) => <section className="search-section" key={src} aria-busy={slot.status === 'loading'}>
        <div className="search-section-head"><h2>{SOURCE_LABEL[src]}</h2>
          {filter === 'all' && slot.items.length > limit && <button className="btn btn-ghost btn-sm" onClick={() => setFilter(src)}>Ещё {slot.items.length - limit}</button>}</div>
        {slot.status === 'loading' && !items.length && <div className="search-skeleton" aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <i key={i} />)}</div>}
        {slot.status === 'error' && <div className="search-error" role="alert"><span>{slot.error}</span><button className="btn btn-ghost btn-sm" onClick={() => run(src, settled)}><ArrowClockwise size={15} /> Повторить</button></div>}
        {slot.status === 'done' && !items.length && <p className="muted small">Ничего не нашлось.</p>}
        {items.map((t, i) => <PublicRow key={t.externalId} t={t} id={`${src}:${t.externalId}`} active={selected === `${src}:${t.externalId}`} onPlay={() => playPublic(src, i)} />)}
      </section>)}
    </div>
  </div>;
}

function LocalRow({ t, id, active, onPlay }: { t: Track; id: string; active: boolean; onPlay: () => void }) {
  const current = useApp((s) => s.player.queue[s.player.index]?.trackId);
  const toast = useApp((s) => s.toast);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right - 220, y: r.bottom + 4 });
  };
  return <div id={`sr-${id}`} role="option" aria-selected={active} className={`search-row ${active ? 'selected' : ''} ${current === t.id ? 'playing' : ''}`}>
    <button className="search-row-main" onClick={onPlay} aria-label={`Слушать: ${t.title}`}>
      <Cover url={t.coverUrl} seed={t.album || t.id} size={44} />
      <span className="search-row-text"><strong>{t.title}</strong><span className="muted small">{t.artist} · В медиатеке</span></span>
    </button>
    <span className="search-row-time tnum">{fmtTime(t.duration)}</span>
    <div className="search-row-actions">
      <button className={`icon-btn ${t.reaction > 0 ? 'liked' : ''}`} aria-pressed={t.reaction > 0} aria-label="Нравится" onClick={() => void react(t, t.reaction > 0 ? 0 : 1)}><Heart size={18} weight={t.reaction > 0 ? 'fill' : 'regular'} /></button>
      <button className="icon-btn" aria-label={`В очередь: ${t.title}`} title="В очередь" disabled={t.status !== 'ok'} onClick={() => { controller.addToQueue([t.id]); toast('Добавлено в очередь'); }}><ListPlus size={18} /></button>
      <button className="icon-btn" aria-label={`Действия: ${t.title}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={openMenu}><DotsThree size={20} weight="bold" /></button>
    </div>
    {menu && <TrackMenu track={t} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPlay={onPlay} />}
  </div>;
}

export function PublicRow({ t, id, active, onPlay, compact = false }: { t: PublicTrack; id: string; active: boolean; onPlay: () => void; compact?: boolean }) {
  const warmup = useIntentWarmup(t.audioProvider, t.externalId, active);
  const prep = usePublicPlayback();
  const tracks = useApp((s) => s.tracks);
  const current = useApp((s) => s.player.queue[s.player.index]?.trackId);
  const toast = useApp((s) => s.toast);
  const known = publicPlayer.known(asCatalog(t));
  const lib = known ? tracks.get(known) : undefined;
  const busy = prep.pending.includes(`${t.audioProvider}:${t.externalId}`);
  const credits = publicTrackArtistLinks(t);
  const albumLink = t.source === 'ytmusic' && /^MPRE[\w-]{6,80}$/.test(t.albumId ?? '') ? publicAlbumHref(t.albumId!) : null;
  const withTrack = (fn: (track: Track) => unknown) => { void ensurePublic(t).then(fn).catch((e) => toast((e as Error).message, 'error')); };
  return <div {...warmup} id={`sr-${id}`} role="option" aria-selected={active} className={`search-row ${active ? 'selected' : ''} ${known && current === known ? 'playing' : ''}`}>
    <div className="search-row-main">
      <button className="search-row-art" onClick={onPlay} aria-label={`Слушать: ${t.title}`} disabled={!t.playable}><Cover url={t.coverUrl} seed={t.externalId} size={44} />{busy ? <SpinnerGap size={20} className="spin" /> : <Play size={18} weight="fill" />}</button>
      <span className="search-row-text"><strong><button className="ellipsis public-track-title" onClick={onPlay} disabled={!t.playable}>{t.title}</button><VersionTags labels={t.labels} explicit={t.explicit} /></strong>
        <span className="muted small ellipsis public-track-credits">{credits.map((credit, index) => <span key={credit.href}>{index > 0 && ', '}<a href={credit.href}>{credit.name}</a></span>)}{t.album && <> · {albumLink ? <a href={albumLink}>{t.album}</a> : t.album}</>}{!compact && ` · ${SOURCE_LABEL[t.source]}`}{t.kind === 'video' ? ' · видео' : ''}{busy ? ' · готовим трек…' : ''}</span></span>
    </div>
    <span className="search-row-time tnum">{t.duration ? fmtTime(t.duration) : ''}</span>
    <div className="search-row-actions">
      <button className={`icon-btn ${lib && lib.reaction > 0 ? 'liked' : ''}`} aria-pressed={!!lib && lib.reaction > 0} aria-label={`Нравится: ${t.title}`} onClick={() => withTrack((x) => react(x, x.reaction > 0 ? 0 : 1))}><Heart size={18} weight={lib && lib.reaction > 0 ? 'fill' : 'regular'} /></button>
      {!compact && <button className="icon-btn" aria-label={`В очередь: ${t.title}`} title="В очередь" onClick={() => void publicPlayer.enqueue(asCatalog(t))}><ListPlus size={18} /></button>}
      <details className="search-row-menu"><summary className="icon-btn" aria-label={`Действия: ${t.title}`}><DotsThree size={20} weight="bold" /></summary><div role="menu">
        {((t.source === 'ytmusic' && /^UC[\w-]{22}$/.test(t.artistId ?? '')) || (t.source === 'soundcloud' && /^\d{1,20}$/.test(t.artistId ?? ''))) && credits[0] && <a role="menuitem" href={credits[0].href}>Открыть исполнителя</a>}
        {albumLink && <a role="menuitem" href={albumLink}>Открыть альбом</a>}
        <button role="menuitem" onClick={() => void publicPlayer.enqueue(asCatalog(t), true)}><ArrowBendDownRight size={17} /> Играть следующим</button>
        <button role="menuitem" onClick={() => void publicPlayer.enqueue(asCatalog(t))}><ListPlus size={17} /> Добавить в очередь</button>
        <button role="menuitem" disabled={!!lib?.saved} onClick={() => withTrack(async (x) => { await api.saveTrack(x.id); useApp.getState().upsertTrack({ ...x, saved: true }); toast(`«${x.title}» в медиатеке`, 'success'); })}><Plus size={17} /> {lib?.saved ? 'Уже в медиатеке' : 'Сохранить в медиатеку'}</button>
        <button role="menuitem" disabled={!!lib?.pinned} onClick={() => void api.download({ provider: t.audioProvider, externalId: t.externalId, title: t.title }).then(() => toast('Скачиваем — прогресс в «Загрузках»')).catch((e) => toast((e as Error).message, 'error'))}><DownloadSimple size={17} /> {lib?.pinned ? 'Скачано' : 'Скачать'}</button>
        <button role="menuitem" onClick={() => void startRadio({ title: t.title, artist: t.artist })}><Radio size={17} /> Радио по треку</button>
        <button role="menuitem" onClick={() => openVersionPanel({ title: t.title, artist: t.artist, duration: t.duration })}><Swap size={17} /> Найти другую версию</button>
        {t.pageUrl && <a role="menuitem" href={t.pageUrl} target="_blank" rel="noreferrer noopener"><ArrowSquareOut size={17} /> Открыть в {SOURCE_LABEL[t.source]}</a>}
      </div></details>
    </div>
  </div>;
}
