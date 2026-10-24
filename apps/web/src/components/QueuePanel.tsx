import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DotsSixVertical, X, Trash, Sparkle, Headphones, Stop, CircleNotch } from '@phosphor-icons/react';
import { fmtTime, methodShort, tracksWord } from '../lib/format.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { Cover, Equalizer } from './common.tsx';
import { togglePreview, usePreview } from '../lib/transition-preview.ts';

/** Plays the rendered blend from the current track into `to`; again stops it. */
function PreviewButton({ from, to, title }: { from: string; to: string; title: string }) {
  const preview = usePreview(), key = `${from}>${to}`;
  const on = preview.playing === key, wait = preview.loading === key;
  return (
    <button className="icon-btn" aria-pressed={on} aria-label={on ? 'Остановить прослушивание перехода' : `Послушать переход в «${title}»`} title="Послушать переход" onClick={() => void togglePreview(from, to)}>
      {wait ? <CircleNotch size={16} className="spin" /> : on ? <Stop size={16} weight="fill" /> : <Headphones size={16} />}
    </button>
  );
}

export function QueuePanel({ onClose, className = '' }: { onClose?: () => void; className?: string } = {}) {
  // Only what the panel shows: position ticks must not re-render the whole queue.
  const p = useApp(useShallow((s) => ({
    queue: s.player.queue, index: s.player.index, status: s.player.status, context: s.player.context,
    nextPlan: s.player.nextPlan, transitionActive: !!s.player.transition?.active, waveLoading: s.player.waveLoading,
    continuation: s.player.continuation,
  })));
  const setOpen = useApp((s) => s.setQueueOpen);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const cur = p.queue[p.index];
  const curT = trackOf(cur?.trackId);
  const upcoming = p.queue.map((e, i) => ({ e, i })).filter(({ i }) => i > p.index);
  const playing = p.status === 'playing' || p.status === 'buffering';
  const wave = p.context?.type === 'wave' || p.context?.type === 'yandex-wave';

  // Rows outside the scrolled view are replaced by spacers, as in TrackList.
  const scrollRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number, number]>([0, 40, 64]);
  const [, rerender] = useState(0);
  const raf = useRef(0);
  useLayoutEffect(() => {
    const box = scrollRef.current, list = listRef.current;
    if (!box || !list) return;
    const row = (list.querySelector('.q-item') as HTMLElement | null)?.offsetHeight || range[2];
    const scrolled = box.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const start = Math.max(0, Math.floor(scrolled / row) - 10);
    const end = Math.min(upcoming.length, start + Math.ceil(box.clientHeight / row) + 20);
    if (start !== range[0] || end !== range[1] || row !== range[2]) setRange([start, end, row]);
  });
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => rerender((x) => x + 1)); };
  const [a, b, rowH] = range;

  return (
    <aside className={`queue-panel ${className}`} aria-label="Очередь">
      <div className="queue-head">
        <div><h2 className="section-title">Очередь</h2><p className="caption dim queue-subtitle">{upcoming.length ? `${tracksWord(upcoming.length)} впереди` : 'Всё, что звучит дальше'}</p></div>
        <div style={{ display: 'flex', gap: 4 }}>
          {upcoming.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => controller.clearUpcoming()} aria-label="Очистить очередь">
              <Trash size={16} /> Очистить
            </button>
          )}
          <button className="icon-btn" aria-label="Закрыть очередь" onClick={() => (onClose ? onClose() : setOpen(false))}>
            <X size={20} />
          </button>
        </div>
      </div>
      <div className="queue-scroll" ref={scrollRef} onScroll={onScroll}>
        {curT ? (
          <>
            <div className="queue-label">Сейчас играет</div>
            <div className="q-item current" aria-current="true">
              <span>
                <Equalizer playing={playing} />
              </span>
              <Cover url={curT.coverUrl} seed={curT.album || curT.id} size={40} />
              <div style={{ minWidth: 0 }}>
                <div className="t-title ellipsis" style={{ fontSize: 14 }}>
                  {curT.title}
                </div>
                <div className="caption muted ellipsis">{curT.artist}</div>
              </div>
            </div>
            {p.nextPlan && (
              <div className="mix-link" title={p.nextPlan.reasons.join('\n')}>
                <Sparkle size={12} weight="fill" /> {p.transitionActive ? 'Сейчас: ' : ''}
                <span><strong>{methodShort(p.nextPlan)}</strong><span className="mix-link-cue">Вход следующего с {fmtTime(p.nextPlan.bEntry)} · {p.nextPlan.vocalA || p.nextPlan.vocalB || p.nextPlan.voiceEcho ? 'отдельный вокал' : 'исходный звук'}</span></span>
              </div>
            )}
          </>
        ) : (
          <div className="queue-empty"><Sparkle size={28} aria-hidden="true" /><h3>Здесь будет продолжение</h3><p>Включите альбом или добавьте треки из поиска.</p><a className="btn btn-secondary btn-sm" href="#/search" onClick={() => (onClose ? onClose() : setOpen(false))}>Найти музыку</a></div>
        )}
        {upcoming.length > 0 && <div className="queue-label">{wave ? 'Дальше в «Моей волне»' : `Далее · ${p.context?.label ?? 'очередь'}`}</div>}
        <div ref={listRef}>
        <div style={{ height: a * rowH }} />
        {upcoming.slice(a, b).map(({ e, i }) => {
          const t = trackOf(e.trackId);
          if (!t) return null;
          return (
            <div
              key={e.entryId}
              className={`q-item ${drag === i ? 'dragging' : ''} ${over === i ? 'drag-over' : ''}`}
              draggable
              onDragStart={(ev) => {
                setDrag(i);
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', String(i));
              }}
              onDragOver={(ev) => {
                ev.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(ev) => {
                ev.preventDefault();
                if (drag !== null) controller.move(drag, i);
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              onDoubleClick={() => controller.jumpTo(i)}
              onKeyDown={(ev) => {
                if (ev.altKey && ev.key === 'ArrowUp' && i > p.index + 1) {
                  ev.preventDefault();
                  controller.move(i, i - 1);
                } else if (ev.altKey && ev.key === 'ArrowDown' && i < p.queue.length - 1) {
                  ev.preventDefault();
                  controller.move(i, i + 1);
                }
              }}
            >
              <span className="grip" aria-hidden="true">
                <DotsSixVertical size={16} weight="bold" />
              </span>
              <Cover url={t.coverUrl} seed={t.album || t.id} size={40} />
              <button style={{ minWidth: 0, textAlign: 'left' }} onClick={() => controller.jumpTo(i)} aria-label={`Играть: ${t.title}. Alt+стрелки меняют порядок`}>
                <div className="t-title ellipsis" style={{ fontSize: 14 }}>
                  {t.title}
                </div>
                <div className="caption muted ellipsis">
                  {t.artist}
                </div>
              </button>
              <span className="q-actions">
                {curT && t.mixingAllowed !== false && curT.mixingAllowed !== false && <PreviewButton from={curT.id} to={t.id} title={t.title} />}
                <button className="icon-btn" aria-label={`Убрать из очереди: ${t.title}`} onClick={() => controller.removeAt(i)}>
                  <X size={16} />
                </button>
              </span>
            </div>
          );
        })}
        <div style={{ height: Math.max(0, upcoming.length - b) * rowH }} />
        </div>
        {wave && p.waveLoading && <p className="caption dim" style={{ padding: 8 }}>Подбираю следующие треки…</p>}
        {p.continuation && <><div className="queue-label">Далее · {p.continuation}</div><p className="caption dim" style={{ padding: 8 }}>Очередь заканчивается — подбираю похожую музыку, она начнётся без паузы.</p></>}
      </div>
    </aside>
  );
}
