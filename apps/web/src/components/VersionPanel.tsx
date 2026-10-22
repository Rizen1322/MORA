import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowCounterClockwise, Check, MagnifyingGlass, Pause, Play, Plus, SpinnerGap, X } from '@phosphor-icons/react';
import { api, type PublicSource, type PublicTrack, type Track } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { controller, useApp } from '../store/app.ts';
import { Cover } from './common.tsx';
import { ensurePublic, SOURCE_LABEL, VersionTags } from '../pages/Search.tsx';

export interface VersionTarget {
  trackId?: string;
  title: string;
  artist: string;
  duration: number;
  /** Picking mode (collection import): returns the choice instead of changing playback. */
  onPick?: (pick: { trackId: string } | PublicTrack) => void;
}

const useVersionPanel = create<{ target: VersionTarget | null }>(() => ({ target: null }));
export const openVersionPanel = (target: VersionTarget) => useVersionPanel.setState({ target });

const SOURCES: PublicSource[] = ['ytmusic', 'youtube', 'soundcloud'];
/** Quick variants refine the query; the labels on results still come from the source or the title. */
const VARIANTS: [string, string][] = [['', 'Как есть'], ['explicit', 'Explicit'], ['uncensored', 'Без цензуры'], ['clean', 'Clean'], ['radio edit', 'Radio edit'], ['album version', 'Альбомная'], ['remix', 'Ремикс'], ['live', 'Live'], ['slowed', 'Slowed']];

interface Candidate { key: string; local?: Track; remote?: PublicTrack }

const words = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\(.*?\)|\[.*?\]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || /\d/.test(w));
/** A version of the same song keeps the core title words; the artist's other songs do not. */
export function sameSong(original: string, candidate: string): boolean {
  const core = words(original);
  if (!core.length) return true;
  const have = new Set(candidate.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u));
  return core.filter((w) => have.has(w)).length / core.length >= 0.6;
}

/**
 * "Find another version": a side sheet (bottom sheet on phones) next to the
 * player. Previews pause the main transport instead of playing over it and
 * resume it only if the listener did not touch the transport meanwhile.
 */
export function VersionPanel() {
  const target = useVersionPanel((s) => s.target);
  if (!target) return null;
  return <Panel key={`${target.trackId ?? ''}:${target.title}`} target={target} />;
}

function Panel({ target }: { target: VersionTarget }) {
  const close = () => useVersionPanel.setState({ target: null });
  const base = `${target.artist} ${target.title}`.trim();
  const [query, setQuery] = useState(base);
  const [variant, setVariant] = useState('');
  const [sources, setSources] = useState<Set<PublicSource>>(new Set(['ytmusic', 'youtube']));
  const [results, setResults] = useState<Partial<Record<PublicSource, { loading: boolean; items: PublicTrack[]; error?: string }>>>({});
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; src: string } | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const resumeVersion = useRef<number | null>(null);
  const previewRequest = useRef(0);
  const alive = useRef(true);
  const tracks = useApp((s) => s.tracks), order = useApp((s) => s.order), toast = useApp((s) => s.toast);
  const own = target.trackId ? tracks.get(target.trackId) : undefined;
  const full = `${query} ${variant}`.trim();

  useEffect(() => {
    const ctl = new AbortController();
    setResults({});
    for (const src of sources) {
      setResults((r) => ({ ...r, [src]: { loading: true, items: [] } }));
      api.publicSearch(src, full, ctl.signal)
        .then((x) => { if (!ctl.signal.aborted) setResults((r) => ({ ...r, [src]: { loading: false, items: x.items.filter((i) => sameSong(target.title, i.title)).slice(0, 8) } })); })
        .catch((e) => { if (!ctl.signal.aborted) setResults((r) => ({ ...r, [src]: { loading: false, items: [], error: (e as Error).message } })); });
    }
    return () => ctl.abort();
  }, [full, [...sources].join()]);

  const locals = useMemo(() => {
    return order.map((id) => tracks.get(id)!).filter((x) => x && x.id !== target.trackId && sameSong(target.title, x.title));
  }, [order, tracks, target]);

  const stopPreview = () => {
    previewRequest.current++;
    setBusy(null);
    audio.current?.pause();
    setPreview(null);
    // Give the music back only if nobody pressed Play/Pause/Next meanwhile.
    if (resumeVersion.current !== null && controller.intentVersion === resumeVersion.current) void controller.resume();
    resumeVersion.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      previewRequest.current++;
      audio.current?.pause();
      if (resumeVersion.current !== null && controller.intentVersion === resumeVersion.current) void controller.resume();
      resumeVersion.current = null;
    };
  }, []);

  const resolve = async (c: Candidate): Promise<Track> => c.local ?? ensurePublic(c.remote!);
  const startPreview = async (c: Candidate) => {
    if (preview?.key === c.key) return stopPreview();
    const request = ++previewRequest.current;
    const intent = controller.intentVersion;
    audio.current?.pause();
    setBusy(c.key);
    try {
      const t = await resolve(c);
      if (!alive.current || request !== previewRequest.current || intent !== controller.intentVersion) return;
      const st = controller.state.status;
      if (resumeVersion.current === null && (st === 'playing' || st === 'buffering')) {
        controller.pause();
        resumeVersion.current = controller.intentVersion;
      }
      setPreview({ key: c.key, src: `/api/tracks/${t.id}/audio` });
    } catch (e) { if (alive.current && request === previewRequest.current) toast((e as Error).message, 'error'); }
    finally { if (alive.current && request === previewRequest.current) setBusy(null); }
  };

  const act = async (kind: 'now' | 'bind' | 'separate' | 'restore') => {
    try {
      if (kind === 'restore') {
        await api.bindRecording(target.trackId!, null);
        await useApp.getState().loadLibrary();
        toast('Вернули исходную запись', 'success');
        return;
      }
      if (!chosen) return;
      setBusy(chosen.key);
      const t = await resolve(chosen);
      if (kind === 'now') { audio.current?.pause(); setPreview(null); resumeVersion.current = null; await controller.playInstead(t.id); toast('Играет выбранная версия'); }
      else if (kind === 'bind') { await api.bindRecording(target.trackId!, t.id); await useApp.getState().loadLibrary(); toast('Эта версия будет играть для трека. Лайки и плейлисты сохранены', 'success'); }
      else { await api.saveTrack(t.id); useApp.getState().upsertTrack({ ...t, saved: true }); toast(`«${t.title}» добавлен отдельно`, 'success'); }
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const delta = (d: number) => (target.duration && d ? Math.round(d - target.duration) : null);
  const card = (c: Candidate, info: { cover: string | null; seed: string; title: string; artist: string; source: string; duration: number; labels: { tag: string; origin: 'source' | 'title' }[]; explicit?: boolean }) => {
    const d = delta(info.duration);
    return <div key={c.key} className={`version-card ${chosen?.key === c.key ? 'chosen' : ''}`}>
      <button className="version-card-main" onClick={() => setChosen(c)} aria-pressed={chosen?.key === c.key}>
        <Cover url={info.cover} seed={info.seed} size={48} />
        <span className="version-card-text"><strong className="ellipsis">{info.title}</strong>
          <span className="version-card-tags"><VersionTags labels={info.labels} explicit={info.explicit} /></span>
          <span className="muted small ellipsis">{info.artist} · {info.source} · {fmtTime(info.duration)}{d !== null && Math.abs(d) >= 2 ? ` (${d > 0 ? '+' : ''}${d} с)` : ''}</span></span>
        {chosen?.key === c.key && <Check size={18} className="version-check" />}
      </button>
      <button className="icon-btn" aria-label={preview?.key === c.key ? 'Остановить прослушивание' : `Прослушать: ${info.title}`} onClick={() => void startPreview(c)} disabled={busy === c.key}>
        {busy === c.key ? <SpinnerGap size={18} className="spin" /> : preview?.key === c.key ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
      </button>
      {preview?.key === c.key && <audio ref={audio} className="version-audio" src={preview.src} controls autoPlay onEnded={stopPreview} />}
    </div>;
  };

  return <aside className="version-panel" role="dialog" aria-label="Другая версия трека">
    <header className="version-head">
      <div><h2>Другая версия</h2><p className="muted small ellipsis">{target.artist} — {target.title}{own?.binding ? ' · сейчас играет выбранная версия' : ''}</p></div>
      <button className="icon-btn" aria-label="Закрыть" onClick={close}><X size={20} /></button>
    </header>
    <form className="version-query" onSubmit={(e) => e.preventDefault()}>
      <MagnifyingGlass size={18} aria-hidden="true" />
      <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Запрос" maxLength={200} />
    </form>
    <div className="version-chips" role="group" aria-label="Вариант">
      {VARIANTS.map(([v, label]) => <button key={label} className={`chip ${variant === v ? 'on' : ''}`} aria-pressed={variant === v} onClick={() => setVariant(v)}>{label}</button>)}
    </div>
    <div className="version-chips" role="group" aria-label="Источники">
      {SOURCES.map((s) => <button key={s} className={`chip ${sources.has(s) ? 'on' : ''}`} aria-pressed={sources.has(s)} onClick={() => setSources((x) => { const n = new Set(x); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>{SOURCE_LABEL[s]}</button>)}
    </div>
    <div className="version-list">
      {locals.length > 0 && <section><h3>Ваши файлы</h3>{locals.slice(0, 6).map((t) => card({ key: `local:${t.id}`, local: t }, { cover: t.coverUrl, seed: t.album || t.id, title: t.title, artist: t.artist, source: 'Медиатека', duration: t.duration, labels: t.origin?.labels ?? [] }))}</section>}
      {SOURCES.filter((s) => results[s]).map((s) => <section key={s}><h3>{SOURCE_LABEL[s]}</h3>
        {results[s]!.loading && <p className="muted small">Ищем…</p>}
        {results[s]!.error && <p className="small error-text">{results[s]!.error}</p>}
        {!results[s]!.loading && !results[s]!.error && !results[s]!.items.length && <p className="muted small">Ничего не нашлось</p>}
        {results[s]!.items.map((t) => card({ key: `${s}:${t.externalId}`, remote: t }, { cover: t.coverUrl, seed: t.externalId, title: t.title, artist: t.uploader || t.artist, source: SOURCE_LABEL[t.source], duration: t.duration, labels: t.labels, explicit: t.explicit }))}
      </section>)}
    </div>
    <footer className="version-actions">
      <p className="caption muted">«E» — так отмечает источник. Остальные метки — предположение по названию; отсутствие цензуры не проверялось.</p>
      <div>
        {target.onPick ? <button className="btn btn-primary btn-sm" disabled={!chosen} onClick={() => { stopPreview(); target.onPick!(chosen!.local ? { trackId: chosen!.local.id } : chosen!.remote!); close(); }}><Check size={15} /> Выбрать</button> : <>
        <button className="btn btn-primary btn-sm" disabled={!chosen || !!busy} onClick={() => void act('now')}><Play size={15} weight="fill" /> Только сейчас</button>
        {target.trackId && <button className="btn btn-secondary btn-sm" disabled={!chosen || !!busy} onClick={() => void act('bind')}><Check size={15} /> Использовать для этого трека</button>}
        <button className="btn btn-ghost btn-sm" disabled={!chosen || !!busy} onClick={() => void act('separate')}><Plus size={15} /> Добавить отдельно</button>
        {own?.binding && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void act('restore')}><ArrowCounterClockwise size={15} /> Вернуть исходную запись</button>}
        </>}
      </div>
    </footer>
  </aside>;
}
