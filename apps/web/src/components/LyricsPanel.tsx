import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Crosshair, Minus, Plus, X } from '@phosphor-icons/react';
import { api, type Lyrics } from '../lib/api.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { useReducedMotion } from './common.tsx';
import {WordLyricLine} from './WordLyricLine.tsx';

/**
 * Synced lyrics: the current line is highlighted and followed; a click seeks.
 * Scrolling by hand pauses following until "К текущей строке". The offset is
 * saved for this recording. Display only: AutoMix never uses these timings.
 */
export function LyricsPanel({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void } = {}) {
  const setPanel = useApp((s) => s.setPanel);
  const p = useApp((s) => s.player);
  const ready=useApp(s=>s.lyricsReady);
  const t = trackOf(p.queue[p.index]?.trackId);
  const recording = `${t?.id ?? ''}/${t?.binding?.assetId ?? ''}`;
  const reduced = useReducedMotion();
  const [state, setState] = useState<{ id: string; data?: Lyrics; error?: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const seekLine=useCallback((time:number)=>{setFollow(true);controller.seek(Math.max(0,time-offset));},[offset]);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const request = useRef<AbortController | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = (id: string, refresh = false) => {
    request.current?.abort();
    const ctl = new AbortController();
    request.current = ctl;
    setState({ id: recording });
    setOffset(0);
    api.lyrics(id, refresh, ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) { setState({ id: recording, data }); setOffset(data.offsetMs / 1000); } })
      .catch((e) => { if (!ctl.signal.aborted) setState({ id: recording, error: (e as Error).message }); });
    return ctl;
  };
  useEffect(() => { if (!t) return; setFollow(true); load(t.id); return () => request.current?.abort(); }, [t?.id, t?.binding?.assetId]);
  useEffect(()=>{
    if(t&&ready&&(ready.trackId===t.id||ready.trackId===t.binding?.assetId))load(t.id);
  },[ready]);

  const current = state?.id === recording ? state : null;
  const lines = current?.data?.wordLines ?? (current?.data?.status === 'synced' ? current.data.lines : []);
  const now = p.position + offset;
  let active = -1;
  for (let i = 0; i < lines.length && lines[i].t <= now; i++) active = i;

  useEffect(() => {
    if (!follow || active < 0) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!el || !box.current) return;
    programmatic.current = true;
    box.current.scrollTo({ top: el.offsetTop - box.current.clientHeight * 0.38, behavior: reduced ? 'auto' : 'smooth' });
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { programmatic.current = false; }, 500);
    return () => clearTimeout(scrollTimer.current);
  }, [active, follow, reduced]);

  const shift = (d: number) => {
    const next = Math.round((offset + d) * 100) / 100;
    setOffset(next);
    if (t) void api.setLyricsOffset(t.id, Math.round(next * 1000)).catch(() => {});
  };

  return (
    <aside className={embedded ? 'lyrics-panel lyrics-stage' : 'queue-panel lyrics-panel'} aria-label="Текст песни">
      <div className="queue-head">
        <div><h2 className="section-title">Текст</h2>{!embedded && <p className="caption dim queue-subtitle ellipsis">{t ? `${t.artist} — ${t.title}` : 'Ничего не играет'}</p>}</div>
        <button className="icon-btn" aria-label={embedded ? 'Вернуться к обложке' : 'Закрыть'} onClick={() => onClose ? onClose() : setPanel(null)}><X size={20} /></button>
      </div>
      {current?.data?.status === 'synced' && <div className="lyrics-tools">
        <button className="icon-btn" aria-label="Текст раньше на 0,25 с" onClick={() => shift(-0.25)}><Minus size={16} /></button>
        <span className="small tnum" title="Сдвиг сохраняется для этой записи">сдвиг {offset > 0 ? '+' : ''}{offset.toFixed(2).replace('.', ',')} с</span>
        <button className="icon-btn" aria-label="Текст позже на 0,25 с" onClick={() => shift(0.25)}><Plus size={16} /></button>
      </div>}
      {!follow && lines.length > 0 && <button className="btn btn-ghost btn-sm lyrics-follow" onClick={() => setFollow(true)}><Crosshair size={15} /> К текущей строке</button>}
      <div className="queue-scroll lyrics-scroll" ref={box}
        onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}
        onKeyDown={(e) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) setFollow(false); }}
        onScroll={() => { if (!programmatic.current && document.activeElement === box.current) setFollow(false); }} tabIndex={0}>
        {!t ? <p className="muted">Включите трек, чтобы увидеть текст.</p>
          : !current?.data && !current?.error ? <div className="lyrics-empty lyrics-loading" role="status"><span className="lyrics-loading-line" /><span className="lyrics-loading-line" /><span className="lyrics-loading-line" /><p>Ищем текст…</p></div>
          : current.error ? <div className="lyrics-empty"><p>{current.error}</p><button className="btn btn-ghost btn-sm" onClick={() => load(t.id)}><ArrowClockwise size={15} /> Повторить</button></div>
          : current.data!.status === 'none' && !current.data!.wordLines ? <div className="lyrics-empty"><p>Текст для этой песни не найден.</p><button className="btn btn-ghost btn-sm" onClick={() => load(t.id, true)}><ArrowClockwise size={15} /> Поискать снова</button></div>
          : current.data!.wordLines ? current.data!.wordLines.map((line,index)=><WordLyricLine key={index} line={line} index={index}
              active={index===active} past={index<active} now={index===active?now:index<active?Infinity:-Infinity} onSeek={seekLine}/>)
          : current.data!.status === 'plain' ? <><p className="caption muted">Текст без синхронизации</p><div className="lyrics-plain">{current.data!.plain}</div></>
          : lines.map((l, i) => <button key={i} data-line={i} className={`lyrics-line ${i === active ? 'now' : i < active ? 'past' : ''}`}
              aria-current={i === active ? 'true' : undefined} onClick={() => { setFollow(true); controller.seek(Math.max(0, l.t - offset)); }}>{l.text || '♪'}</button>)}
        {current?.data && (current.data.status !== 'none' || current.data.wordLines) && <p className="caption muted lyrics-source">{current.data.wordLines ? 'Текст распознан локально (Whisper)' : current.data.source === 'file' ? 'Из файла рядом с треком' : 'Текст: LRCLIB'}{current.data.matched && !current.data.wordLines ? ` · ${current.data.matched.artist} — ${current.data.matched.title}` : ''}</p>}
      </div>
    </aside>
  );
}
