import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass, ArrowUpRight, ArrowDown, ArrowUp, DotsSixVertical, PencilSimple, Trash, ListNumbers, Check, X } from '@phosphor-icons/react';
import { api, type HistoryItem, type PlaylistDetail, type Track } from '../lib/api.ts';
import { fmtDate, fmtTime, fmtTotal, tracksWord } from '../lib/format.ts';
import { go, useRoute } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { ConfirmModal, Cover, PromptModal } from '../components/common.tsx';
import { TrackList } from '../components/TrackList.tsx';
import { CollectionHeader } from './Library.tsx';
import { PlaylistMix } from '../components/PlaylistMix.tsx';
import { LikeAllTracks } from '../components/LikeAll.tsx';

export function PlaylistPage() {
  const { parts } = useRoute();
  const id = parts[1];
  const map = useApp((s) => s.tracks);
  const playlists = useApp((s) => s.playlists);
  const toast = useApp((s) => s.toast);
  const [pl, setPl] = useState<PlaylistDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<'rename' | 'delete' | null>(null);
  const [reorder, setReorder] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [mix, setMix] = useState(false);
  const loadRevision = useRef(0);

  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    try {
      const playlist = await api.playlist(id);
      if (revision !== loadRevision.current) return;
      setPl(playlist);
      setErr(null);
    } catch (e) {
      if (revision === loadRevision.current) setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
    return () => { loadRevision.current++; };
  }, [load, playlists]);
  useEffect(() => { setQuery(''); setReorder(false); setMix(false); setErr(null); }, [id]);

  const rows = useMemo(() => (pl?.entries ?? []).map((e) => ({ e, t: map.get(e.trackId) })).filter((r): r is { e: PlaylistDetail['entries'][number]; t: Track } => !!r.t), [pl, map]);
  const visibleRows = rows.filter(({t}) => `${t.title} ${t.artist}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru').trim()));
  const mixRows = useMemo(() => rows.map(({ e, t }) => ({ entryId: e.entryId, track: t })), [rows]);
  if (err) return <div className="main-inner"><p role="alert" className="muted">{err}</p><button className="btn btn-secondary" onClick={() => void load()}>Повторить</button></div>;
  if (!pl || pl.id !== id) return <div className="main-inner collection-skeleton" role="status" aria-label="Загружаем плейлист"><i /><i /></div>;
  const tracks = rows.map((r) => r.t);
  const play = (i: number, shuffle = false) => {
    const selected = reorder ? tracks : visibleRows.map(r => r.t);
    if (!selected.length) return;
    if (shuffle !== controller.state.shuffle) controller.toggleShuffle();
    void controller.playTracks(selected.map((t) => t.id), i, { type: 'playlist', id: pl.id, label: pl.name });
  };
  const saveOrder = async (entryIds: number[]) => {
    setPl({ ...pl, entries: entryIds.map((eid) => pl.entries.find((x) => x.entryId === eid)!) });
    try { await api.reorderPlaylist(pl.id, entryIds); }
    catch (error) { toast(`Не удалось сохранить порядок: ${(error as Error).message}`, 'error'); await load(); }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const ids = rows.map((r) => r.e.entryId);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    void saveOrder(ids);
  };
  const cover = tracks.find((t) => t.coverUrl)?.coverUrl ?? null;

  return (
    <div className="main-inner collection-studio playlist-studio">
      <a className="studio-back" href="#/library/playlists">Все плейлисты <ArrowUpRight size={15} /></a>
      <CollectionHeader disabled={reorder ? !tracks.length : !visibleRows.length} kind="Плейлист" title={pl.name} sub={`${tracksWord(tracks.length)}, ${fmtTotal(tracks.reduce((a, t) => a + t.duration, 0))}`} cover={cover} seed={pl.id} onPlay={() => tracks.length && play(0)} onShuffle={() => tracks.length && play(Math.floor(Math.random() * (reorder ? tracks.length : visibleRows.length)), true)}>
        <button className="btn btn-ghost btn-sm" onClick={() => setModal('rename')}>
          <PencilSimple size={16} /> Переименовать
        </button>
        <button className="btn btn-ghost btn-sm" aria-pressed={reorder} onClick={() => setReorder(!reorder)} disabled={tracks.length < 2}>
          {reorder ? <Check size={16} /> : <ListNumbers size={16} />} {reorder ? 'Готово' : 'Порядок'}
        </button>
        {tracks.length > 0 && <LikeAllTracks tracks={tracks} />}
        <a className="btn btn-ghost btn-sm" href={`/api/backup/playlists?playlist=${encodeURIComponent(id)}`} download="MORA-playlist.json">Экспорт</a>
        <button className="btn btn-secondary btn-sm" disabled={tracks.length < 2} onClick={() => setMix(true)}>Собрать микс</button>
        <button className="btn btn-danger btn-sm" onClick={() => setModal('delete')}>
          <Trash size={16} /> Удалить
        </button>
      </CollectionHeader>
      {mix && <PlaylistMix name={pl.name} rows={mixRows} onClose={() => setMix(false)} />}
      {!tracks.length && <div className="studio-empty"><h2>У каждой истории есть первый трек</h2><p>Добавьте музыку через меню «⋯» у трека.</p><a className="btn btn-secondary" href="#/library">Выбрать из медиатеки <ArrowUpRight size={16} /></a></div>}
      {tracks.length > 0 && !reorder && <div className="collection-search"><label className="search"><MagnifyingGlass size={18} /><span className="sr-only">Поиск в плейлисте</span><input type="search" placeholder="Найти в плейлисте" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="caption dim">{tracksWord(visibleRows.length)}</span></div>}
      {reorder ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }} aria-label="Изменение порядка">
          {rows.map(({ e, t }, i) => (
            <div
              key={e.entryId}
              className={`q-item ${drag === i ? 'dragging' : ''}`}
              style={{ gridTemplateColumns: '20px 40px minmax(0,1fr) auto' }}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={() => {
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
            >
              <span className="grip" aria-hidden="true">
                <DotsSixVertical size={16} weight="bold" />
              </span>
              <Cover url={t.coverUrl} seed={t.album || t.id} size={40} />
              <div style={{ minWidth: 0 }}>
                <div className="t-title ellipsis" style={{ fontSize: 14 }}>
                  {i + 1}. {t.title}
                </div>
                <div className="caption muted">{t.artist}</div>
              </div>
              <span style={{ display: 'flex' }}>
                <button className="icon-btn" aria-label={`Выше: ${t.title}`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp size={16} />
                </button>
                <button className="icon-btn" aria-label={`Ниже: ${t.title}`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown size={16} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <TrackList
          tracks={visibleRows.map(r => r.t)}
          rowKey={(_, i) => String(visibleRows[i].e.entryId)}
          onPlay={(i) => play(i)}
          extraMenu={(_t, i) => (
            <button
              role="menuitem"
              onClick={async () => {
                await api.removeFromPlaylist(pl.id, visibleRows[i].e.entryId);
                await load();
                await useApp.getState().loadPlaylists();
                toast('Убрано из плейлиста');
              }}
            >
              <X size={18} /> Убрать из плейлиста
            </button>
          )}
        />
      )}
      {modal === 'rename' && (
        <PromptModal
          title="Переименовать плейлист"
          label="Название"
          initial={pl.name}
          confirm="Сохранить"
          onSubmit={async (name) => {
            await api.renamePlaylist(pl.id, name);
            await useApp.getState().loadPlaylists();
            await load();
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'delete' && (
        <ConfirmModal
          title="Удалить плейлист?"
          text={`Плейлист «${pl.name}» будет удалён. Треки останутся в медиатеке.`}
          confirm="Удалить"
          danger
          onConfirm={async () => {
            await api.deletePlaylist(pl.id);
            await useApp.getState().loadPlaylists();
            go('/');
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export function LikedPage() {
  const order = useApp((s) => s.order);
  const map = useApp((s) => s.tracks);
  const liked = useMemo(() => order.map((id) => map.get(id)!).filter((t) => t && t.reaction > 0).sort((a, b) => (b.likedAt ?? b.addedAt) - (a.likedAt ?? a.addedAt) || a.id.localeCompare(b.id)), [order, map]);
  const disliked = useMemo(() => order.map((id) => map.get(id)!).filter((t) => t && t.reaction < 0), [order, map]);
  const [query, setQuery] = useState('');
  const [showDisliked, setShowDisliked] = useState(false);
  const filtered = liked.filter(t => `${t.title} ${t.artist}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru').trim()));
  const play = (i: number, shuffle = false) => {
    if (!filtered.length) return;
    if (shuffle !== controller.state.shuffle) controller.toggleShuffle();
    void controller.playTracks(filtered.map((t) => t.id), i, { type: 'liked', label: 'Любимое' });
  };
  return (
    <div className="main-inner collection-studio liked-studio">
      <CollectionHeader disabled={!filtered.length} kind="Коллекция" title="Любимое" sub={`${tracksWord(liked.length)} · ${fmtTotal(liked.reduce((sum, t) => sum + t.duration, 0))}`} cover={null} seed="liked-collection" onPlay={() => liked.length && play(0)} onShuffle={() => filtered.length && play(Math.floor(Math.random() * filtered.length), true)} />
      {liked.length > 0 && <div className="collection-search"><label className="search"><MagnifyingGlass size={18} /><span className="sr-only">Поиск в любимом</span><input type="search" placeholder="Найти то самое" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="caption dim">{tracksWord(filtered.length)}</span></div>}
      <TrackList tracks={filtered} onPlay={(i) => play(i)} emptyText={query ? 'Ничего не нашлось. Попробуйте другое название.' : 'Отмечайте треки сердцем — здесь будет ваша личная коллекция.'} />
      {disliked.length > 0 && (
        <details className="studio-disliked" open={showDisliked} onToggle={event => setShowDisliked(event.currentTarget.open)}>
          <summary>Не нравится <span>{tracksWord(disliked.length)}</span></summary>
          <p className="caption dim">Эти треки не звучат в «Моей волне». Снимите отметку в меню трека.</p>
          {showDisliked && <TrackList tracks={disliked} onPlay={(i) => void controller.playTracks(disliked.map((t) => t.id), i, { type: 'liked', label: 'Не нравится' })} />}
        </details>
      )}
    </div>
  );
}

const END_LABEL: Record<string, string> = {
  finished: 'дослушан',
  transition: 'AutoMix-переход',
  skip: 'пропущен',
  stop: 'остановлен',
  error: 'ошибка',
};

export function HistoryPage() {
  const map = useApp((s) => s.tracks);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const current = useApp((s) => s.player.queue[s.player.index]?.trackId);
  useEffect(() => {
    void api.history(300).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [current]);
  return (
    <div className="main-inner">
      <h1 className="page-title">История</h1>
      {items && items.length > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)} style={{ margin: '8px 0 16px' }}>
          Очистить историю
        </button>
      )}
      {items === null ? null : items.length === 0 ? (
        <p className="muted">История пуста.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {items.map((h) => {
            const t = map.get(h.trackId);
            if (!t) return null;
            return (
              <div key={h.id} className="track-row history-row">
                <span className="t-main">
                  <Cover className="thumb" url={t.coverUrl} seed={t.album || t.id} size={40} />
                  <span style={{ minWidth: 0 }}>
                    <div className="t-title ellipsis">{t.title}</div>
                    <div className="t-artist ellipsis">{t.artist}</div>
                  </span>
                </span>
                <span className="small col-album">{fmtDate(h.startedAt)}</span>
                <span className="small col-bpm">
                  <span className={`tag ${h.endReason === 'skip' ? 'warn' : h.endReason === 'transition' ? 'accent' : ''}`}>{END_LABEL[h.endReason ?? ''] ?? 'играл'}</span>
                </span>
                <span className="small tnum col-dur">{fmtTime(h.playedMs / 1000)}</span>
              </div>
            );
          })}
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title="Очистить историю?"
          text="Записи о прослушиваниях будут удалены. «Моя волна» начнёт учиться заново, лайки сохранятся."
          confirm="Очистить"
          danger
          onConfirm={async () => {
            await api.clearHistory();
            setItems([]);
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
