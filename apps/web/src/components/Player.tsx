import { TrackArtists } from './TrackArtists.tsx';
import { Radio } from '@phosphor-icons/react';
import { startSimilar } from '../lib/radio.ts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  CaretDown,
  CaretRight,
  ChartLine,
  Heart,
  HeartBreak,
  Pause,
  Play,
  Queue,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
  CircleNotch,
  ArrowsOutSimple,
  SlidersHorizontal,
  MicrophoneStage,
  MoonStars,
  PictureInPicture,
  ArrowsOut,
  PushPin,
} from '@phosphor-icons/react';
import { desktop } from '../lib/desktop.ts';
import { setSleep, sleepEndOfTrack, sleepLeft, sleepMinutes, useSleep } from '../lib/sleepTimer.ts';
import { useSwipe } from '../lib/swipe.ts';
import { systemVolume, type PlayerSnapshot } from '../audio/controller.ts';
import { artColors } from '../lib/color.ts';
import { fmtTime, methodShort } from '../lib/format.ts';
import { trackAlbumHref, go } from '../lib/router.ts';
import type { Track } from '../lib/api.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { Cover, SplitWords, Swap, useDialogFocus, useReducedMotion } from './common.tsx';
import { PlayerBackdrop } from './PlayerBackdrop.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { react } from './TrackList.tsx';
import { LyricsPanel } from './LyricsPanel.tsx';
import { usePlayerLayout } from '../lib/player-layout.ts';

type Rgb = [number, number, number];
const SPRUCE: [Rgb, Rgb] = [[28, 74, 52], [8, 26, 18]];
const lerp = (x: Rgb, y: Rgb, k: number): Rgb => [0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * k) as Rgb;
export const smooth = (k: number) => k * k * (3 - 2 * k);

/** Artwork colours pulled toward spruce green so the app keeps its forest tone. */
async function artPair(url: string | null | undefined): Promise<[Rgb, Rgb]> {
  if (!url) return SPRUCE;
  try {
    const [a, b] = await artColors(url);
    return [lerp(a as Rgb, SPRUCE[0], 0.3), lerp(b as Rgb, SPRUCE[1], 0.45)];
  } catch {
    return SPRUCE;
  }
}

// One animator for the whole page: --art glides toward its target instead of jumping.
const art = { cur: SPRUCE.map((c) => [...c]) as [Rgb, Rgb], target: SPRUCE, raf: 0 };
function glideArt(target: [Rgb, Rgb], instant: boolean) {
  art.target = target;
  const root = document.documentElement;
  const write = () => {
    root.style.setProperty('--art', art.cur[0].map(Math.round).join(' '));
    root.style.setProperty('--art-2', art.cur[1].map(Math.round).join(' '));
  };
  if (instant) {
    art.cur = [[...target[0]], [...target[1]]] as [Rgb, Rgb];
    write();
    return;
  }
  if (art.raf) return;
  const step = () => {
    let far = false;
    for (const j of [0, 1]) {
      art.cur[j] = lerp(art.cur[j], art.target[j], 0.06);
      if (art.cur[j].some((v, i) => Math.abs(v - art.target[j][i]) > 0.5)) far = true;
    }
    write();
    art.raf = far ? requestAnimationFrame(step) : 0;
  };
  art.raf = requestAnimationFrame(step);
}

/**
 * Pushes the artwork colour into CSS variables (the artwork supplies the colour).
 * During an AutoMix blend the colour follows the blend: from A's cover to B's by `k`.
 */
export function useArtColor(url: string | null | undefined, nextUrl?: string | null, k = 0): void {
  const reduced = useReducedMotion();
  const [pairs, setPairs] = useState<[[Rgb, Rgb], [Rgb, Rgb]] | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([artPair(url), artPair(nextUrl ?? url)]).then((p) => alive && setPairs(p));
    return () => {
      alive = false;
    };
  }, [url, nextUrl]);
  useEffect(() => {
    if (!pairs) return;
    const e = smooth(Math.max(0, Math.min(1, k)));
    glideArt([lerp(pairs[0][0], pairs[1][0], e), lerp(pairs[0][1], pairs[1][1], e)], reduced);
  }, [pairs, k, reduced]);
}

/** Covers and colour of the current moment: during a blend, from A to B by its progress. */
export function useBlend(p: PlayerSnapshot) {
  const tr = p.transition?.active ? p.transition : null;
  const from = tr ? trackOf(tr.plan.fromTrackId) : trackOf(p.queue[p.index]?.trackId);
  const to = tr ? trackOf(tr.plan.toTrackId) : undefined;
  return { from, to: to && to.id !== from?.id ? to : undefined, k: tr ? tr.progress : 0 };
}

export function Seekbar({ p, compact = false }: { p: PlayerSnapshot; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dur = p.duration || 0;
  const pos = drag ?? p.position;
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const plan = p.nextPlan;
  const zone = plan && dur && plan.duration > 0.5 && !p.transition?.active ? { l: (plan.aExit / dur) * 100, w: (Math.min(plan.duration, dur - plan.aExit) / dur) * 100 } : null;
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
  };
  return (
    <div className="seek">
      {!compact && <span className="tnum" style={{ minWidth: 38, textAlign: 'right' }}>{fmtTime(pos)}</span>}
      <div
        className="seekbar"
        ref={ref}
        role="slider"
        tabIndex={dur > 0 ? 0 : -1}
        aria-disabled={!dur}
        aria-label="Позиция в треке"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${fmtTime(pos)} из ${fmtTime(dur)}`}
        onPointerDown={(e) => {
          if (!dur) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(at(e.clientX));
        }}
        onPointerMove={(e) => drag !== null && setDrag(at(e.clientX))}
        onPointerUp={(e) => {
          if (drag === null) return;
          controller.seek(at(e.clientX));
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') controller.seek(p.position + 5);
          else if (e.key === 'ArrowLeft') controller.seek(p.position - 5);
          else if (e.key === 'Home') controller.seek(0);
          else if (e.key === 'End') controller.seek(dur);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="track">
          {zone && <div className="mix-zone" style={{ left: `${zone.l}%`, width: `${Math.max(0.6, zone.w)}%` }} title="Здесь начнётся переход AutoMix" />}
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="knob" style={{ left: `${pct}%` }} />
        </div>
      </div>
      {!compact && <span className="tnum" style={{ minWidth: 38 }}>{fmtTime(dur)}</span>}
    </div>
  );
}

export function AutoMixStatus({ p }: { p: PlayerSnapshot }) {
  const enabled = useApp((s) => s.settings?.automix.enabled ?? true);
  if (!enabled) return <span className="automix-pill off">AutoMix выключен</span>;
  const tr = p.transition;
  if (tr?.active) {
    return (
      <span className="automix-pill active mixing" title={`${methodShort(tr.plan)} · вход ${fmtTime(tr.plan.bEntry)}`}>
        <span className="mix-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        Сведение
        <span className="mix-progress" aria-hidden="true">
          <i style={{ width: `${Math.round(tr.progress * 100)}%` }} />
        </span>
      </span>
    );
  }
  const plan = p.nextPlan;
  if (!plan) return p.index >= 0 && p.status !== 'idle' ? <span className="automix-pill off">{p.nextPending.length ? 'AutoMix · подготовка' : 'AutoMix · ожидает следующий трек'}</span> : null;
  const left = Math.max(0, plan.aExit - p.position);
  return (
    <span className="automix-pill" title={`${plan.reasons.join('\n')}\nВход следующего трека: ${fmtTime(plan.bEntry)}`}>
      <span className="pulse" aria-hidden="true" />
      {p.nextPending.length ? 'анализ… ' : ''}
      {methodShort(plan)} через {fmtTime(left)}
    </span>
  );
}

function Volume({ p }: { p: PlayerSnapshot }) {
  if (systemVolume) return null;
  const v = p.muted ? 0 : p.volume;
  const Icon = v === 0 ? SpeakerSlash : v < 0.5 ? SpeakerLow : SpeakerHigh;
  return (
    <div className="volume">
      <button className="icon-btn" onClick={() => controller.toggleMute()} aria-label={p.muted ? 'Включить звук' : 'Выключить звук'}>
        <Icon size={20} />
      </button>
      <input
        className="range"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={v}
        aria-label="Громкость"
        aria-valuetext={`${Math.round(v * 100)} %`}
        style={{ '--fill': `${v * 100}%` } as CSSProperties}
        onChange={(e) => controller.setVolume(Number(e.target.value))}
      />
    </div>
  );
}

function Controls({ p, big = false }: { p: PlayerSnapshot; big?: boolean }) {
  const mixOnNext = useApp((s) => (s.settings?.automix.enabled ?? true) && (s.settings?.automix.mixOnNext ?? true));
  const playing = p.status === 'playing' || p.status === 'buffering';
  const size = big ? 28 : 20;
  const RepeatIcon = p.repeat === 'one' ? RepeatOnce : Repeat;
  const wave = p.context?.type === 'wave' || p.context?.type === 'yandex-wave';
  return (
    <div className={big ? 'fp-controls' : 'pb-controls'}>
      <button className="icon-btn" aria-pressed={p.shuffle} aria-label="Перемешать" onClick={() => controller.toggleShuffle()} disabled={wave} title={wave ? 'В «Моей волне» порядок подбирается автоматически' : undefined}>
        <Shuffle size={size} />
      </button>
      <button className="icon-btn" aria-label="Предыдущий" disabled={p.index < 0} onClick={() => void controller.prevTrack()}>
        <SkipBack size={size} weight="fill" />
      </button>
      <button className={`play-circle ${big ? 'lg' : ''}`} aria-label={playing ? 'Пауза' : 'Слушать'} onClick={() => controller.toggle()} disabled={p.index < 0}>
        {p.status === 'loading' ? <CircleNotch size={big ? 28 : 18} className="spin" /> : playing ? <Pause size={big ? 28 : 18} weight="fill" /> : <Play size={big ? 28 : 18} weight="fill" />}
      </button>
      <button className="icon-btn" aria-label="Следующий" disabled={p.index < 0} title={p.transition?.active || p.nextPlan?.debug.requested === true ? 'Завершить переход сразу' : mixOnNext ? 'Короткий переход к следующему треку. Нажмите ещё раз, чтобы переключить сразу' : 'Следующий трек'} onClick={() => void controller.nextTrack()}>
        <SkipForward size={size} weight="fill" />
      </button>
      <button className="icon-btn" aria-pressed={p.repeat !== 'off'} aria-label={p.repeat === 'off' ? 'Повтор выключен' : p.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека'} onClick={() => controller.cycleRepeat()}>
        <RepeatIcon size={size} />
      </button>
    </div>
  );
}

/** Desktop mini-player: the same window, shrunk (one audio engine), optionally above other windows. */
export function CompactToggle() {
  const [on, setOn] = useState(document.documentElement.classList.contains('compact'));
  const [onTop, setOnTop] = useState(true);
  useEffect(() => { void desktop!.getSettings().then((s) => { setOn(s.compact); setOnTop(s.compactOnTop); }); return desktop!.onCompact(setOn); }, []);
  return <>
    {on && <button className={`icon-btn compact-only ${onTop ? 'on' : ''}`} aria-pressed={onTop} aria-label="Поверх других окон" title="Поверх других окон" onClick={() => void desktop!.setCompact(true, !onTop).then((r) => setOnTop(r.onTop))}><PushPin size={18} weight={onTop ? 'fill' : 'regular'} /></button>}
    <button className="icon-btn" aria-label={on ? 'Развернуть окно' : 'Мини-плеер'} title={on ? 'Развернуть' : 'Мини-плеер'} onClick={() => void desktop!.setCompact(!on, onTop)}>
      {on ? <ArrowsOut size={18} /> : <PictureInPicture size={18} />}
    </button>
  </>;
}

function SleepMenu() {
  const mode = useSleep((s) => s.mode);
  useApp((s) => s.player.position); // re-render for the countdown
  const left = sleepLeft(mode);
  const [custom, setCustom] = useState(false);
  const close = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  return <details className="sleep-menu">
    <summary className={`icon-btn ${mode ? 'on' : ''}`} aria-label={mode ? 'Таймер сна включён' : 'Таймер сна'} title={mode ? (left !== null ? `Сон через ${fmtTime(left)}` : 'Сон в конце очереди') : 'Таймер сна'}><MoonStars size={19} weight={mode ? 'fill' : 'regular'} /></summary>
    <div role="menu">
      <p className="caption muted">{mode ? (left !== null ? `Музыка затихнет через ${fmtTime(left)}` : 'Затихнет в конце очереди') : 'Плавно остановить музыку'}</p>
      {[15, 30, 60].map((m) => <button key={m} role="menuitem" onClick={(e) => { sleepMinutes(m); close(e); }}>Через {m} мин</button>)}
      {custom ? <form onSubmit={(e) => { e.preventDefault(); const v = Number(new FormData(e.currentTarget).get('m')); if (v > 0 && v <= 600) { sleepMinutes(v); setCustom(false); (e.currentTarget.closest('details') as HTMLDetailsElement).removeAttribute('open'); } }}>
        <input className="input" name="m" type="number" min={1} max={600} placeholder="минут" autoFocus aria-label="Минут до остановки" /></form>
        : <button role="menuitem" onClick={() => setCustom(true)}>Своё время…</button>}
      <button role="menuitem" onClick={(e) => { sleepEndOfTrack(); close(e); }}>В конце трека</button>
      <button role="menuitem" onClick={(e) => { setSleep({ kind: 'queue' }); close(e); }}>В конце очереди</button>
      {mode && <button role="menuitem" onClick={(e) => { setSleep(null); close(e); }}>Отменить таймер</button>}
    </div>
  </details>;
}

export function PlayerBar() {
  const p = useApp((s) => s.player);
  const queueOpen = useApp((s) => s.queueOpen);
  const setQueueOpen = useApp((s) => s.setQueueOpen);
  const panel = useApp((s) => s.panel);
  const setPanel = useApp((s) => s.setPanel);
  const setFull = useApp((s) => s.setFullPlayer);
  const t = trackOf(p.queue[p.index]?.trackId);
  const blend = useBlend(p);
  const upcoming = trackOf(p.queue[p.index + 1]?.trackId);
  useArtColor(blend.from?.coverUrl ?? t?.coverUrl, blend.to?.coverUrl, blend.k);
  return (
    <footer className={`player-bar studio-dock ${p.transition?.active ? 'is-mixing' : ''}`} aria-label="Плеер">
      <div className="pb-left">
        {t ? (
          <>
            <button onClick={() => setFull(true)} aria-label="Открыть полноэкранный плеер" style={{ flex: 'none' }}>
              <Swap k={t.id}><Cover className="thumb" url={t.coverUrl} seed={t.album || t.id} size={56} /></Swap>
            </button>
            <div className="pb-track-info" style={{ minWidth: 0 }}>
              <span className="pb-overline">{p.status === 'playing' ? 'Сейчас играет' : p.status === 'buffering' ? 'Готовим звук' : 'Ваша музыка'}</span>
              <div className="t-title ellipsis" style={{ fontSize: 14 }}>
                <Swap k={t.id}>{t.title}</Swap>
              </div>
              <div className="small muted ellipsis"><Swap k={t.id}><TrackArtists track={t} /></Swap></div>
            </div>
            <button className={`icon-btn ${t.reaction > 0 ? 'liked' : ''}`} aria-pressed={t.reaction > 0} aria-label="Нравится" onClick={() => void react(t, t.reaction > 0 ? 0 : 1)}>
              <Heart size={18} weight={t.reaction > 0 ? 'fill' : 'regular'} />
            </button>
          </>
        ) : (
          <span className="small dim">Ничего не играет</span>
        )}
      </div>
      <div className="pb-center">
        <Controls p={p} />
        <Seekbar p={p} />
      </div>
      <div className="pb-right">
        <button className="pb-next-preview" onClick={() => setQueueOpen(!queueOpen)} aria-label={upcoming ? `Дальше: ${upcoming.title}. Открыть очередь` : 'Открыть очередь'}>
          {upcoming ? <><Cover url={upcoming.coverUrl} seed={upcoming.album || upcoming.id} size={30} /><span><span>Дальше</span><strong>{upcoming.title}</strong></span><Queue size={16} /></>
            : p.continuation ? <><span><span>Дальше</span><strong>{p.continuation}</strong></span><Queue size={16} /></> : <span>Ваша очередь <Queue size={16} /></span>}
        </button>
        <div className="pb-tools">
        <button className="icon-btn" aria-label="Диагностика AutoMix" onClick={() => go('/diagnostics')}>
          <ChartLine size={20} />
        </button>
        <SleepMenu />
        <button className="icon-btn" aria-pressed={panel === 'lyrics'} aria-label="Текст песни" title="Текст" onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')} disabled={!t}>
          <MicrophoneStage size={20} />
        </button>
        <button className="icon-btn" aria-pressed={panel === 'sound'} aria-label="Звук" title="Звук" onClick={() => setPanel(panel === 'sound' ? null : 'sound')}>
          <SlidersHorizontal size={20} />
        </button>
        <button className="icon-btn" aria-pressed={queueOpen} aria-label="Очередь" onClick={() => setQueueOpen(!queueOpen)}>
          <Queue size={20} />
        </button>
        <Volume p={p} />
        <button className="icon-btn" aria-label="Полноэкранный плеер" onClick={() => setFull(true)} disabled={!t}>
          <ArrowsOutSimple size={18} />
        </button>
        {desktop && <CompactToggle />}
        </div>
      </div>
    </footer>
  );
}

export function MiniPlayer() {
  const p = useApp((s) => s.player);
  const setFull = useApp((s) => s.setFullPlayer);
  const t = trackOf(p.queue[p.index]?.trackId);
  // In the desktop mini-player the cover brings the full window back.
  const open = () => (document.documentElement.classList.contains('compact') ? void desktop?.setCompact(false) : setFull(true));
  const swipe = useSwipe(() => ({ left: () => void controller.nextTrack(), right: () => void controller.prevTrack(), up: open }));
  if (!t) return null;
  const playing = p.status === 'playing' || p.status === 'buffering';
  return (
    <div className="mini-player" {...swipe}>
      <button onClick={open} aria-label="Открыть плеер">
        <Swap k={t.id}><Cover url={t.coverUrl} seed={t.album || t.id} size={44} /></Swap>
      </button>
      <button onClick={open} style={{ minWidth: 0, textAlign: 'left' }}>
        <div className="t-title ellipsis" style={{ fontSize: 14 }}>
          <Swap k={t.id}>{t.title}</Swap>
        </div>
        <div className="caption muted ellipsis"><Swap k={p.transition?.active ? 'mix' : t.id}>{p.transition?.active ? `AutoMix · ${methodShort(p.transition.plan)}` : t.artist}</Swap></div>
      </button>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className={`icon-btn ${t.reaction > 0 ? 'liked' : ''}`} aria-label="Нравится" aria-pressed={t.reaction > 0} onClick={() => void react(t, t.reaction > 0 ? 0 : 1)}>
          <Heart size={22} weight={t.reaction > 0 ? 'fill' : 'regular'} />
        </button>
        <button className="icon-btn compact-only" aria-label="Предыдущий" onClick={() => void controller.prevTrack()}><SkipBack size={20} weight="fill" /></button>
        <button className="icon-btn" aria-label={playing ? 'Пауза' : 'Слушать'} onClick={() => controller.toggle()} style={{ color: 'var(--text)' }}>
          {p.status === 'loading' ? <CircleNotch size={24} className="spin" /> : playing ? <Pause size={24} weight="fill" /> : <Play size={24} weight="fill" />}
        </button>
        <button className="icon-btn compact-only" aria-label="Следующий" onClick={() => void controller.nextTrack()}><SkipForward size={20} weight="fill" /></button>
      </div>
      <div className="mini-progress" aria-hidden="true">
        <i style={{ width: `${p.duration ? (p.position / p.duration) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

type Layer = { track: Track; opacity?: number; enter?: boolean };

/**
 * Cover crossfade: during an AutoMix blend B's cover fades in at the blend's own pace.
 * Keys are track ids, so the incoming layer stays the same element after the swap and
 * never flashes; a plain skip fades the new cover over the old one.
 */
function CoverStack({ current, from, to, k }: { current: Track; from?: Track; to?: Track; k: number }) {
  const blended = useRef<string | null>(null);
  if (to) blended.current = to.id;
  // Derived during render, so the old cover never disappears for a frame.
  const [shown, setShown] = useState<{ cur: Track; leaving: Track | null }>({ cur: current, leaving: null });
  if (shown.cur.id !== current.id) setShown({ cur: current, leaving: blended.current === current.id ? null : shown.cur });
  const leaving = shown.leaving;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setShown((s) => ({ ...s, leaving: null })), 900);
    return () => clearTimeout(t);
  }, [leaving]);
  // When a blend ends early, B is not fully opaque yet: keep A underneath until it is.
  const [blendFrom, setBlendFrom] = useState<Track | null>(null);
  const [hold, setHold] = useState<Track | null>(null);
  if (to && from && blendFrom?.id !== from.id) setBlendFrom(from);
  if (!(to && from) && blendFrom) {
    setHold(blendFrom);
    setBlendFrom(null);
  }
  useEffect(() => {
    if (!hold) return;
    const t = setTimeout(() => setHold(null), 700);
    return () => clearTimeout(t);
  }, [hold]);
  const under = leaving ?? hold;
  const layers: Layer[] = to && from
    ? [{ track: from }, { track: to, opacity: smooth(Math.max(0, Math.min(1, k))) }]
    : [...(under && under.id !== current.id ? [{ track: under }] : []), { track: current, enter: !!leaving }];
  return (
    <div className="fp-covers">
      {layers.map(({ track, opacity, enter }) => (
        <div key={track.id} className={`fp-cover-layer ${enter ? 'enter' : ''}`} style={opacity === undefined ? undefined : { opacity }}>
          <Cover url={track.coverUrl} seed={track.album || track.id} alt={track.id === current.id ? `Обложка: ${track.album || track.title}` : ''} />
        </div>
      ))}
    </div>
  );
}

export function FullPlayer() {
  const p = useApp((s) => s.player);
  const setFull = useApp((s) => s.setFullPlayer);
  const t = trackOf(p.queue[p.index]?.trackId);
  const plan = p.transition?.active ? p.transition.plan : p.nextPlan;
  const next = trackOf(plan?.toTrackId ?? p.queue[p.index + 1]?.trackId);
  const blend = useBlend(p);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, () => setFull(false));
  // Swipe down closes only from the top, so it never fights scrolling back up.
  const atTop = () => (bodyRef.current?.scrollTop ?? 0) <= 0 && (dialogRef.current?.scrollTop ?? 0) <= 0;
  // Phone layout: slide down (.is-closing in apps/mobile), then unmount.
  const close = () => {
    const el = dialogRef.current;
    if (reduced || !el || !document.documentElement.classList.contains('mora-mobile')) { setFull(false); return; }
    el.classList.add('is-closing');
    setTimeout(() => setFull(false), 240);
  };
  const swipeTop = useSwipe(() => (atTop() ? { down: close } : {}));
  const swipeCover = useSwipe(() => ({ left: () => void controller.nextTrack(), right: () => void controller.prevTrack(), ...(atTop() ? { down: close } : {}) }));
  const reduced = useReducedMotion();
  const [showQueue, setShowQueue] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsOpened, setLyricsOpened] = useState(false);
  usePlayerLayout(dialogRef, reduced);
  // Caption buttons are native and paint above the page: make their strip
  // transparent here, otherwise its fixed dark color shows as a box over the
  // full player backdrop. Restored when the player closes.
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    void d.setTitlebarOverlay(true).catch(() => {});
    return () => { void d.setTitlebarOverlay(false).catch(() => {}); };
  }, []);
  if (!t) return null;
  // Cover leans toward the pointer; written straight to style, no React re-render per move.
  const tilt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    e.currentTarget.style.setProperty('--ry', `${x * 14}deg`);
    e.currentTarget.style.setProperty('--rx', `${y * -14}deg`);
    e.currentTarget.style.setProperty('--px', String(x));
    e.currentTarget.style.setProperty('--py', String(y));
  };
  const untilt = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.removeProperty('--ry');
    e.currentTarget.style.removeProperty('--rx');
    e.currentTarget.style.removeProperty('--px');
    e.currentTarget.style.removeProperty('--py');
  };
  return (
    <div className="full-player" role="dialog" aria-modal="true" aria-label="Сейчас играет" ref={dialogRef}>
      <PlayerBackdrop cover={t.coverUrl} next={blend.to?.coverUrl ?? null} k={blend.k} />
      <div className="fp-top" {...swipeTop}>
        <button className="icon-btn" aria-label="Свернуть" onClick={close}>
          <CaretDown size={24} />
        </button>
        <div className="small fp-source">
          <div className="dim caption">{p.context ? 'Играет из' : 'Сейчас играет'}</div>
          <div style={{ fontWeight: 700 }}>{p.context?.label ?? 'Очередь'}</div>
        </div>
        <button className="icon-btn" aria-label="Очередь" aria-pressed={showQueue} onClick={() => setShowQueue(!showQueue)}>
          <Queue size={22} />
        </button>
      </div>
      {showQueue && <QueuePanel className="fp-queue" onClose={() => setShowQueue(false)} />}
      <div className="fp-body" ref={bodyRef}>
        <div className={`fp-art-stage ${showLyrics ? 'shows-lyrics' : ''}`}>
          <div className={`fp-art ${p.transition?.active ? 'is-mixing' : ''} ${p.status === 'playing' ? 'is-playing' : ''}`} inert={showLyrics} aria-hidden={showLyrics} onPointerMove={tilt} onPointerLeave={untilt} {...(showLyrics ? {} : swipeCover)}>
            <div className="fp-vinyl" aria-hidden="true" />
            <CoverStack current={t} from={blend.from} to={blend.to} k={blend.k} />
          </div>
          {lyricsOpened && <div className="fp-lyrics-layer" inert={!showLyrics} aria-hidden={!showLyrics}><LyricsPanel embedded onClose={() => setShowLyrics(false)} /></div>}
        </div>
        <div className="fp-info">
          <div className="fp-track-heading">
            <p className="fp-eyebrow"><span className="session-dot" data-playing={p.status === 'playing' || p.status === 'buffering'} aria-hidden="true" />{p.status === 'playing' || p.status === 'buffering' ? 'Сейчас играет' : 'На паузе'}</p>
            <h1 className="fp-title">
              <Swap k={t.id}>
                {t.album ? <a className="fp-link" href={trackAlbumHref(t)} onClick={() => setFull(false)}><SplitWords text={t.title} /></a> : <SplitWords text={t.title} />}
              </Swap>
            </h1>
            <div className="fp-artist" style={{ marginTop: 10 }}>
              <Swap k={t.id} className="swap-late">
                <span>
                  <TrackArtists track={t} className="fp-link" onNavigate={() => setFull(false)} />
                  {t.album ? <> <span className="dim">·</span> <a className="fp-link dim" href={trackAlbumHref(t)} onClick={() => setFull(false)}>{t.album}</a></> : null}
                </span>
              </Swap>
            </div>
          </div>
          <div className="fp-listening-tools">
            <div className="fp-reactions" role="group" aria-label="Оценить трек">
              <button className={`icon-btn ${t.reaction > 0 ? 'liked' : ''}`} aria-pressed={t.reaction > 0} aria-label="Нравится" onClick={() => void react(t, t.reaction > 0 ? 0 : 1)}>
                <Heart size={23} weight={t.reaction > 0 ? 'fill' : 'regular'} />
              </button>
              <button className="icon-btn fp-lyrics-toggle" aria-label={showLyrics ? 'Показать обложку' : 'Показать текст песни'} title="Текст песни" aria-pressed={showLyrics} onClick={() => { if (!showLyrics) { setLyricsOpened(true); useApp.getState().setPanel(null); } setShowLyrics(!showLyrics); }}><MicrophoneStage size={23} /></button>
              <button className="icon-btn" aria-pressed={t.reaction < 0} aria-label="Не нравится" onClick={() => void react(t, t.reaction < 0 ? 0 : -1)}>
                <HeartBreak size={23} weight={t.reaction < 0 ? 'fill' : 'regular'} />
              </button>
              <button className="icon-btn" aria-label="Похожее на этот трек" title="Дальше — похожее на этот трек" disabled={t.reaction < 0} onClick={() => void startSimilar(t)}><Radio size={23} /></button>
            </div>
            <Volume p={p} />
          </div>
          <Seekbar p={p} />
          <Controls p={p} big />
          {next && <section className={`fp-up-next ${p.transition?.active ? 'is-mixing' : ''}`} aria-label={p.transition?.active ? 'Идёт переход' : 'Следующий трек'}>
            <button className="fp-next-track" onClick={() => setShowQueue(true)} aria-label={`Открыть очередь. Далее: ${next.title}`}>
              <Swap k={next.id} className="fp-next-cover"><Cover url={next.coverUrl} seed={next.album || next.id} size={48} /></Swap>
              <span><span className="fp-next-label">{p.transition?.active ? 'Уже входит в микс' : 'Следом за этим треком'}</span><Swap k={next.id} className="fp-next-copy"><span><strong className="ellipsis">{next.title}</strong><span className="caption muted ellipsis">{next.artist}</span></span></Swap></span>
              <CaretRight size={18} aria-hidden="true" />
            </button>
          </section>}
          {!next && p.continuation && <section className="fp-up-next" aria-label="Следующий трек">
            <button className="fp-next-track" onClick={() => setShowQueue(true)} aria-label={`Открыть очередь. Далее: ${p.continuation}`}>
              <span><span className="fp-next-label">Следом за этим треком</span><Swap k="continuation" className="fp-next-copy"><span><strong className="ellipsis">{p.continuation}</strong><span className="caption muted ellipsis">Подбираю похожую музыку…</span></span></Swap></span>
              <CaretRight size={18} aria-hidden="true" />
            </button>
          </section>}
          {p.transition?.fallback && <div className="small" style={{ color: 'var(--danger)' }}>{p.transition.fallback}</div>}
        </div>
      </div>
      <div />
    </div>
  );
}
