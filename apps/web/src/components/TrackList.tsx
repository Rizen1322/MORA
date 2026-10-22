import { TrackArtists } from './TrackArtists.tsx';
import { useShallow } from 'zustand/react/shallow';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DotsThree, Heart, Play, Pause, Warning, CircleNotch } from '@phosphor-icons/react';
import { api, type Track } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { trackAlbumHref } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { Cover, Equalizer } from './common.tsx';
import { TrackMenu } from './TrackMenu.tsx';

export type SortKey = 'title' | 'artist' | 'album' | 'added' | 'duration' | 'bpm' | 'plays';

const ROW_H = 56;

export interface TrackListProps {
  tracks: Track[];
  /** Called with the index the user wants to play from. */
  onPlay: (index: number) => void;
  showAlbum?: boolean;
  numbered?: boolean;
  sort?: { key: SortKey; dir: 1 | -1 };
  onSort?: (k: SortKey) => void;
  extraMenu?: (t: Track, index: number) => ReactNode;
  emptyText?: string;
  rowKey?: (t: Track, i: number) => string;
}

/** `mounted` re-subscribes once the list element exists (an empty list renders no element). */
function useScrollParent(ref: React.RefObject<HTMLElement | null>, mounted: boolean) {
  const [, force] = useState(0);
  useEffect(() => {
    const main = ref.current?.closest('.main') as HTMLElement | null;
    if (!main) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((x) => x + 1));
    };
    main.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      main.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      cancelAnimationFrame(raf);
    };
  }, [ref, mounted]);
}

export function TrackList({ tracks, onPlay, showAlbum = true, numbered = true, sort, onSort, extraMenu, emptyText = 'Здесь пока пусто', rowKey }: TrackListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const player = useApp(useShallow((s) => ({ queue: s.player.queue, index: s.player.index, status: s.player.status })));
  const curId = player.queue[player.index]?.trackId;
  const playing = player.status === 'playing' || player.status === 'buffering';
  const [menu, setMenu] = useState<{ t: Track; i: number; x: number; y: number } | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 60]);
  useScrollParent(ref, tracks.length > 0);

  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest('.main') as HTMLElement | null;
    if (!el || !main) return;
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    const start = Math.max(0, Math.floor(-top / ROW_H) - 10);
    const end = Math.min(tracks.length, start + Math.ceil(main.clientHeight / ROW_H) + 20);
    if (start !== range[0] || end !== range[1]) setRange([start, end]);
  });

  const openMenu = useCallback((e: React.MouseEvent, t: Track, i: number) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ t, i, x: e.type === 'contextmenu' ? e.clientX : r.right - 220, y: e.type === 'contextmenu' ? e.clientY : r.bottom + 4 });
  }, []);

  if (!tracks.length) return <p className="muted" style={{ padding: '24px 12px' }}>{emptyText}</p>;

  const head = (k: SortKey, label: string, cls = '') =>
    onSort ? (
      <button className={cls} onClick={() => onSort(k)} aria-label={`Сортировать: ${label}`}>
        {label}
        {sort?.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    ) : (
      <span className={cls}>{label}</span>
    );

  const [a, b] = range;
  return (
    <div className="tracklist" ref={ref} role="table" aria-label="Список треков" aria-rowcount={tracks.length}>
      <div className="tracklist-head" role="row">
        <span className="t-num">#</span>
        {head('title', 'Название')}
        {showAlbum ? head('album', 'Альбом', 'col-album') : head('artist', 'Исполнитель', 'col-album')}
        {head('bpm', 'BPM · тон', 'col-bpm col-key')}
        {head('added', 'Добавлен', 'col-key')}
        {head('duration', 'Время', 'col-dur')}
        <span />
      </div>
      <div style={{ height: a * ROW_H }} />
      {tracks.slice(a, b).map((t, k) => {
        const i = a + k;
        const isCur = t.id === curId;
        const unavailable = t.status !== 'ok';
        return (
          <div
            key={rowKey ? rowKey(t, i) : t.id}
            role="row"
            aria-rowindex={i + 1}
            className={`track-row ${isCur ? 'playing' : ''} ${unavailable ? 'unavailable' : ''}`}
            onDoubleClick={() => !unavailable && onPlay(i)}
            onContextMenu={(e) => openMenu(e, t, i)}
          >
            <span className="t-num muted">
              {isCur ? (
                <span className="n">
                  <Equalizer playing={playing} />
                </span>
              ) : (
                <span className="n">{numbered ? i + 1 : ''}</span>
              )}
            </span>
            <span className="t-main" role="cell">
              <button className="track-art-play" aria-label={isCur && playing ? `Пауза: ${t.title}` : `Играть: ${t.title}`} disabled={unavailable} onClick={() => isCur ? controller.toggle() : onPlay(i)}>
                <Cover className="thumb" url={t.coverUrl} seed={t.album || t.id} size={40} />
                <span aria-hidden="true">{isCur && playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}</span>
              </button>
              <span style={{ minWidth: 0 }}>
                <div className="t-title ellipsis">{t.title}</div>
                <div className="t-artist ellipsis">
                  {unavailable && <Warning size={13} weight="fill" color="var(--danger)" style={{ verticalAlign: '-2px', marginRight: 4 }} aria-label="недоступен" />}
                  <TrackArtists track={t} />
                </div>
              </span>
            </span>
            <span className="col-album t-album ellipsis small" role="cell">
              {showAlbum ? t.album ? <a href={trackAlbumHref(t)}>{t.album}</a> : <span className="dim">—</span> : t.artist}
            </span>
            <span className="col-bpm col-key small tnum" role="cell">
              <AnalysisCell t={t} />
            </span>
            <span className="col-key small dim" role="cell">
              {new Date(t.addedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
            </span>
            <span className="col-dur small tnum" role="cell">
              {fmtTime(t.duration)}
            </span>
            <span className="t-actions" role="cell">
              <button
                className={`icon-btn ${t.reaction > 0 ? 'liked' : 'hover-only'}`}
                aria-pressed={t.reaction > 0}
                aria-label={t.reaction > 0 ? 'Убрать из любимого' : 'Нравится'}
                onClick={() => void react(t, t.reaction > 0 ? 0 : 1)}
              >
                <Heart size={18} weight={t.reaction > 0 ? 'fill' : 'regular'} />
              </button>
              <button className="icon-btn hover-only" aria-label={`Действия: ${t.title}`} aria-haspopup="menu" onClick={(e) => openMenu(e, t, i)}>
                <DotsThree size={20} weight="bold" />
              </button>
            </span>
          </div>
        );
      })}
      <div style={{ height: Math.max(0, tracks.length - b) * ROW_H }} />
      {menu && <TrackMenu track={menu.t} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPlay={() => onPlay(menu.i)} extra={extraMenu?.(menu.t, menu.i)} />}
    </div>
  );
}

function AnalysisCell({ t }: { t: Track }) {
  const a = t.analysis;
  if (a.status === 'done') {
    return (
      <span title={a.keyName ? `Тональность: ${a.keyName}` : undefined}>
        {a.bpm ? Math.round(a.bpm) : <span className="dim">без бита</span>}
        {a.camelot ? <span className="dim"> · {a.camelot}</span> : null}
      </span>
    );
  }
  if (a.status === 'running' || a.status === 'pending') {
    return (
      <span className="dim" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} title="Анализ звука">
        <CircleNotch size={12} className="spin" /> {a.status === 'running' && a.progress ? `${Math.round(a.progress * 100)} %` : 'в очереди'}
      </span>
    );
  }
  if (a.status === 'error') return <span className="tag warn" title={a.error}>ошибка</span>;
  if (!t.mixingAllowed) return <span className="dim" title="Источник не разрешает анализ">—</span>;
  return <span className="dim">—</span>;
}

const reactionRequests = new Map<string, number>();
export async function react(t: Track, value: number): Promise<void> {
  const st = useApp.getState();
  const revision = (reactionRequests.get(t.id) ?? 0) + 1;
  reactionRequests.set(t.id, revision);
  st.patchTrack(t.id, { reaction: value, reactionSync: t.provider === 'yandex' ? { status: 'pending' } : undefined });
  try {
    const result = await api.react(t.id, value);
    if (revision !== reactionRequests.get(t.id)) return;
    st.patchTrack(t.id, { reaction: result.value, reactionSync: result.sync });
    if (result.sync?.status === 'error') st.toast(`Реакция сохранена здесь. ${result.sync.error ?? 'Яндекс пока не принял её; отправка повторится автоматически.'}`, 'error');
    else if (result.sync?.status === 'pending') st.toast('Реакция сохранена. Отправка в Яндекс продолжится автоматически.', 'info');
    if (value < 0 && controller.currentEntry?.trackId === t.id) {
      const wave = controller.state.context?.type === 'wave' || controller.state.context?.type === 'yandex-wave' || controller.state.context?.type === 'online-radio';
      st.toast(wave ? 'Больше не будет в «Моей волне». Переключаю.' : 'Трек не будет предлагаться в «Моей волне»', 'info');
      if (wave) void controller.nextTrack('dislike');
    }
  } catch (e) {
    if (revision !== reactionRequests.get(t.id)) return;
    st.patchTrack(t.id, { reaction: t.reaction });
    st.toast((e as Error).message, 'error');
  }
}
