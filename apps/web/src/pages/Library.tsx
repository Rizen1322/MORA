import { hasTrackArtist, trackArtists } from '../lib/artists.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass, Play, Shuffle, Plus, ArrowUpRight, Stack } from '@phosphor-icons/react';
import { api, type Track } from '../lib/api.ts';
import { fmtTotal, tracksWord } from '../lib/format.ts';
import { albumHref, artistHref, searchHref, useRoute } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { Cover, PromptModal } from '../components/common.tsx';
import { SleeveScene } from '../components/SleeveScene.tsx';
import { ImportActions } from '../components/ImportActions.tsx';
import { TrackList, type SortKey } from '../components/TrackList.tsx';

type Filter = 'liked' | 'nodislike' | 'analyzed' | 'beat' | 'issues';

function matches(t: Track, q: string): boolean {
  if (!q) return true;
  const hay = `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().replace(/ё/g, 'е');
  return q
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function sortTracks(list: Track[], key: SortKey, dir: 1 | -1): Track[] {
  const s = [...list];
  const cmp = (a: Track, b: Track): number => {
    switch (key) {
      case 'title':
        return a.title.localeCompare(b.title, 'ru');
      case 'artist':
        return a.artist.localeCompare(b.artist, 'ru') || a.title.localeCompare(b.title, 'ru');
      case 'album':
        return a.album.localeCompare(b.album, 'ru') || (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0);
      case 'duration':
        return a.duration - b.duration;
      case 'bpm':
        return (a.analysis.bpm ?? 0) - (b.analysis.bpm ?? 0);
      case 'plays':
        return a.playCount - b.playCount;
      case 'added':
      default:
        return a.addedAt - b.addedAt;
    }
  };
  s.sort((a, b) => cmp(a, b) * dir);
  return s;
}

export function LibraryPage() {
  const { parts } = useRoute();
  const tab = parts[1] ?? 'tracks';
  const order = useApp((s) => s.order);
  const map = useApp((s) => s.tracks);
  const loaded = useApp((s) => s.loaded);
  const all = useMemo(() => order.map((id) => map.get(id)!).filter(Boolean), [order, map]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'added', dir: -1 });
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tab === 'search') searchRef.current?.focus();
  }, [tab]);

  const filtered = useMemo(() => {
    let l = all.filter((t) => matches(t, q));
    if (filters.has('liked')) l = l.filter((t) => t.reaction > 0);
    if (filters.has('nodislike')) l = l.filter((t) => t.reaction >= 0);
    if (filters.has('analyzed')) l = l.filter((t) => t.analysis.status === 'done');
    if (filters.has('beat')) l = l.filter((t) => !!t.analysis.bpm);
    if (filters.has('issues')) l = l.filter((t) => t.status !== 'ok' || t.analysis.status === 'error');
    return sortTracks(l, sort.key, sort.dir);
  }, [all, q, filters, sort]);

  const toggle = (f: Filter) => {
    const n = new Set(filters);
    if (n.has(f)) n.delete(f);
    else n.add(f);
    setFilters(n);
  };
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === 'added' || k === 'plays' ? -1 : 1 }));
  const total = filtered.reduce((a, t) => a + t.duration, 0);
  const playable = filtered.filter((t) => t.status === 'ok');

  return (
    <div className="main-inner library-studio collection-studio">
      <header className="library-masthead">
        <div className="library-masthead-copy"><h1 className="page-title">Ваша<br /><span>медиатека.</span></h1><p className="studio-lead">Всё, что звучит по-вашему.</p><div className="stat-row">
        <span>{tracksWord(all.length)}</span>
        <span>{fmtTotal(all.reduce((a, t) => a + t.duration, 0))}</span>
        </div></div>
        <SleeveScene tracks={all.filter(t => t.coverUrl).slice(0, 3)} />
      </header>
      <div className="tabs" style={{ marginTop: 16 }} role="tablist">
        {[
          ['tracks', 'Треки'],
          ['albums', 'Альбомы'],
          ['artists', 'Исполнители'],
          ['playlists', 'Плейлисты'],
        ].map(([id, label]) => (
          <a key={id} role="tab" aria-selected={tab === id || (id === 'tracks' && tab === 'search')} className={`chip ${tab === id || (id === 'tracks' && tab === 'search') ? 'on' : ''}`} href={`#/library/${id}`}>
            {label}
          </a>
        ))}
      </div>
      {tab === 'playlists' ? <PlaylistShelf /> : loaded && all.length === 0 ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <h2>Медиатека пуста</h2>
          <p>Перетащите сюда файлы или папку, либо выберите их кнопками ниже.</p>
          <ImportActions />
        </div>
      ) : tab === 'albums' ? (
        <Albums all={all} />
      ) : tab === 'artists' ? (
        <Artists all={all} />
      ) : (
        <>
          <div className="toolbar">
            <label className="search">
              <MagnifyingGlass size={18} />
              <span className="sr-only">Поиск в медиатеке</span>
              <input ref={searchRef} type="search" placeholder="Название, исполнитель, альбом, жанр" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <select className="select" aria-label="Сортировка" value={`${sort.key}:${sort.dir}`} onChange={(e) => {
              const [k, d] = e.target.value.split(':');
              setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 });
            }}>
              <option value="added:-1">Сначала новые</option>
              <option value="added:1">Сначала старые</option>
              <option value="title:1">По названию</option>
              <option value="artist:1">По исполнителю</option>
              <option value="album:1">По альбому</option>
              <option value="bpm:1">По темпу</option>
              <option value="duration:1">По длительности</option>
              <option value="plays:-1">Чаще слушаю</option>
            </select>
            <button className="btn btn-primary btn-sm" disabled={!playable.length} onClick={() => void controller.playTracks(playable.map((t) => t.id), 0, { type: 'library', label: q ? `Поиск «${q}»` : 'Медиатека' })}>
              <Play size={16} weight="fill" /> Слушать
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!playable.length}
              onClick={() => {
                if (!controller.state.shuffle) controller.toggleShuffle();
                void controller.playTracks(playable.map((t) => t.id), Math.floor(Math.random() * playable.length), { type: 'library', label: 'Медиатека' });
              }}
            >
              <Shuffle size={16} /> Вперемешку
            </button>
          </div>
          <details className="studio-filters"><summary>Уточнить подборку {filters.size > 0 && <span>{filters.size}</span>}</summary><div className="tabs" aria-label="Фильтры">
            {(
              [
                ['liked', 'Любимое'],
                ['nodislike', 'Без «не нравится»'],
                ['analyzed', 'Анализ готов'],
                ['beat', 'С ритмом'],
                ['issues', 'Проблемы'],
              ] as [Filter, string][]
            ).map(([f, l]) => (
              <button key={f} className="chip" aria-pressed={filters.has(f)} onClick={() => toggle(f)} style={{ height: 28, fontSize: 12 }}>
                {l}
              </button>
            ))}
          </div></details>
          <p className="caption dim" style={{ margin: '10px 0 0' }}>
            {tracksWord(filtered.length)} · {fmtTotal(total)}
          </p>
          <TrackList
            tracks={filtered}
            sort={sort}
            onSort={onSort}
            numbered={false}
            emptyText={q ? `По запросу «${q}» ничего не нашлось` : 'Нет треков с такими фильтрами'}
            onPlay={(i) => void controller.playTracks(filtered.map((t) => t.id), i, { type: 'library', label: q ? `Поиск «${q}»` : 'Медиатека' })}
          />
        </>
      )}
    </div>
  );
}

function Albums({ all }: { all: Track[] }) {
  const albums = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const t of all) {
      if (!t.album) continue;
      const k = `${t.albumArtist || t.artist}\u0000${t.album}`;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()].sort((a, b) => a[1][0].album.localeCompare(b[1][0].album, 'ru'));
  }, [all]);
  if (!albums.length) return <p className="muted" style={{ marginTop: 24 }}>У треков нет сведений об альбомах.</p>;
  return (
    <div className="grid" style={{ marginTop: 20 }}>
      {albums.map(([k, list]) => {
        const t = list.find((x) => x.coverUrl) ?? list[0];
        return (
          <a key={k} className="card" href={albumHref(t.albumArtist || t.artist, t.album)}>
            <Cover url={t.coverUrl} seed={t.album} />
            <div style={{ minWidth: 0 }}>
              <div className="card-title ellipsis">{t.album}</div>
              <div className="card-sub ellipsis">
                {t.year ? `${t.year} · ` : ''}
                {t.albumArtist || t.artist}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

function Artists({ all }: { all: Track[] }) {
  const artists = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const t of all) {
      const names = trackArtists(t).map(a => a.name);
      for (const name of names.length ? names : ['Неизвестный исполнитель']) {
        const list = m.get(name);
        if (list) list.push(t); else m.set(name, [t]);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [all]);
  return (
    <div className="grid" style={{ marginTop: 20 }}>
      {artists.map(([name, list]) => {
        const t = list.find((x) => x.coverUrl) ?? list[0];
        return (
          <a key={name} className="card" href={artistHref(name)}>
            <Cover url={t.coverUrl} seed={name} round />
            <div style={{ minWidth: 0, textAlign: 'center' }}>
              <div className="card-title ellipsis">{name}</div>
              <div className="card-sub">{tracksWord(list.length)}</div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export function CollectionHeader({ kind, title, sub, cover, seed, round, onPlay, onShuffle, children, disabled = false }: { kind: string; title: string; sub: string; cover: string | null; seed: string; round?: boolean; onPlay: () => void; onShuffle: () => void; children?: React.ReactNode; disabled?: boolean }) {
  const liked = seed === 'liked-collection';
  return (
    <header className={`collection-masthead ${liked ? 'collection-loved' : ''}`}>
      <div className="page-head">
        <div className="collection-object">{liked ? <SleeveScene liked /> : <div className="collection-sleeve"><span className="collection-record" /><Cover url={cover} seed={seed} round={round} /></div>}</div>
        <div className="collection-copy" style={{ minWidth: 0 }}>
          <div className="studio-kicker">
            {kind}
          </div>
          <h1 className="page-title">{title}</h1>
          <p className="collection-tagline">{liked ? 'То, что хочется слушать снова.' : kind === 'Плейлист' ? 'Собрано вами. Звучит по-особенному.' : 'Включите и останьтесь в моменте.'}</p>
          <div className="small muted">{sub}</div>
        </div>
      </div>
      <div className="toolbar">
        <button className="play-circle lg" aria-label={`Слушать: ${title}`} onClick={onPlay} disabled={disabled}>
          <Play size={28} weight="fill" />
        </button>
        <button className="icon-btn" style={{ width: 48, height: 48 }} aria-label="Слушать вперемешку" onClick={onShuffle} disabled={disabled}>
          <Shuffle size={26} />
        </button>
        {children}
      </div>
    </header>
  );
}

function PlaylistShelf() {
  const playlists = useApp(s => s.playlists);
  const [creating, setCreating] = useState(false);
  return <section className="playlist-shelf" aria-label="Мои плейлисты">
    <div className="section-head"><div><h2 className="section-title">Собрано вами</h2><p className="small muted">Свои истории из любимых треков.</p></div><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} /> Создать</button></div>
    <div className="studio-playlists">
      {playlists.map(pl => <a key={pl.id} className="studio-playlist-card" href={`#/playlist/${pl.id}`}><div className="playlist-card-art"><span className="playlist-card-layer" /><Cover url={pl.coverUrl} seed={pl.id} /><span className="playlist-card-arrow"><ArrowUpRight size={22} /></span></div><h3>{pl.name}</h3><span>{tracksWord(pl.count)}</span></a>)}
      <button className="playlist-create-card" onClick={() => setCreating(true)}><span><Plus size={28} weight="light" /></span><strong>Новая история</strong><span>Создать плейлист</span></button>
    </div>
    {!playlists.length && <p className="studio-note"><Stack size={17} /> Добавляйте музыку в плейлист через меню трека.</p>}
    {creating && <PromptModal title="Новый плейлист" label="Название" confirm="Создать" onClose={() => setCreating(false)} onSubmit={async name => { const pl = await api.createPlaylist(name); await useApp.getState().loadPlaylists(); location.hash = `/playlist/${pl.id}`; }} />}
  </section>;
}

export function AlbumPage() {
  const { parts } = useRoute();
  const [artist, album] = [parts[1], parts[2]];
  const order = useApp((s) => s.order);
  const map = useApp((s) => s.tracks);
  const list = useMemo(
    () =>
      sortTracks(
        order.map((id) => map.get(id)!).filter((t) => t && t.album === album && ((t.albumArtist || t.artist) === artist || artist === '—')),
        'album',
        1,
      ),
    [order, map, album, artist],
  );
  const play = (i: number, shuffle = false) => {
    if (shuffle !== controller.state.shuffle) controller.toggleShuffle();
    void controller.playTracks(list.map((t) => t.id), i, { type: 'album', id: album, label: album });
  };
  if (!list.length) return <div className="main-inner"><p className="muted">Альбом не найден.</p></div>;
  const t = list.find((x) => x.coverUrl) ?? list[0];
  return (
    <div className="main-inner">
      <CollectionHeader kind="Альбом" title={album} sub={`${artist} · ${t.year ?? ''} ${tracksWord(list.length)}, ${fmtTotal(list.reduce((a, x) => a + x.duration, 0))}`} cover={t.coverUrl} seed={album} onPlay={() => play(0)} onShuffle={() => play(Math.floor(Math.random() * list.length), true)} />
      <TrackList tracks={list} showAlbum={false} onPlay={(i) => play(i)} />
    </div>
  );
}

export function ArtistPage() {
  const { parts } = useRoute();
  const artist = parts[1];
  const order = useApp((s) => s.order);
  const map = useApp((s) => s.tracks);
  const list = useMemo(() => sortTracks(order.map((id) => map.get(id)!).filter((t) => t && hasTrackArtist(t, artist)), 'album', 1), [order, map, artist]);
  const play = (i: number, shuffle = false) => {
    if (shuffle !== controller.state.shuffle) controller.toggleShuffle();
    void controller.playTracks(list.map((t) => t.id), i, { type: 'artist', id: artist, label: artist });
  };
  if (!list.length) return <div className="main-inner"><p className="muted">Исполнитель не найден.</p></div>;
  const t = list.find((x) => x.coverUrl) ?? list[0];
  return (
    <div className="main-inner">
      <CollectionHeader kind="Исполнитель" title={artist} sub={tracksWord(list.length)} cover={t.coverUrl} seed={artist} round onPlay={() => play(0)} onShuffle={() => play(Math.floor(Math.random() * list.length), true)}><a className="btn btn-ghost" href={searchHref(artist, 'artist')}>Найти в каталоге Яндекса</a></CollectionHeader>
      <TrackList tracks={list} onPlay={(i) => play(i)} />
    </div>
  );
}
