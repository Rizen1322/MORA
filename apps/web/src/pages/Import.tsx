import { useEffect, useRef, useState } from 'react';
import { Check, FileArrowUp, Link, MagnifyingGlass, Trash, X } from '@phosphor-icons/react';
import { api, type ImportJob, type ImportRow } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { useApp } from '../store/app.ts';
import { Cover } from '../components/common.tsx';
import { openVersionPanel } from '../components/VersionPanel.tsx';
import { VersionTags } from './Search.tsx';

const SOURCE: Record<string, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube', soundcloud: 'SoundCloud', file: 'Файл' };
const STATUS: Record<ImportRow['status'], string> = { matched: 'Найдено', uncertain: 'Проверьте', missing: 'Не найдено', pending: 'Ищем…' };

/**
 * Collection import: a link or an export file → metadata → matched recordings →
 * preview report → playlist. Only metadata comes from Spotify/Apple Music;
 * the sound plays from the matched public recording shown next to each row.
 */
export function ImportPage() {
  const [url, setUrl] = useState('');
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withUncertain, setWithUncertain] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const toast = useApp((s) => s.toast);
  const refreshList = () => void api.imports().then((r) => setJobs(r.jobs)).catch(() => {});
  useEffect(refreshList, []);

  // Live progress while matching: re-read the job (throttled by the server's events).
  useEffect(() => {
    if (!job || job.state !== 'matching') return;
    const t = setInterval(() => void api.importJob(job.id).then((j) => { setJob(j); if (j.state !== 'matching') refreshList(); }).catch(() => {}), 1200);
    return () => clearInterval(t);
  }, [job?.id, job?.state]);

  const start = async (body: Parameters<typeof api.startImport>[0]) => {
    setBusy(true); setError(null);
    try { const j = await api.startImport(body); setJob(j); refreshList(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const resolve = async (row: ImportRow, choice: Parameters<typeof api.resolveImport>[2]) => {
    if (!job) return;
    try { setJob(await api.resolveImport(job.id, row.position, choice)); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const pick = (row: ImportRow) => openVersionPanel({
    title: row.title, artist: row.artist, duration: row.duration ?? 0,
    onPick: (p) => void resolve(row, 'trackId' in p ? p : { provider: p.audioProvider, externalId: p.externalId, title: p.title, artist: p.artist, duration: p.duration, coverUrl: p.coverUrl, labels: p.labels }),
  });
  const create = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const j = await api.importPlaylist(job.id, withUncertain);
      setJob(j); refreshList();
      await useApp.getState().loadPlaylists();
      await useApp.getState().loadLibrary();
      toast('Плейлист готов', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const c = job ? job.rows.reduce((a, r) => ({ ...a, [r.status]: a[r.status] + 1 }), { matched: 0, uncertain: 0, missing: 0, pending: 0 }) : null;

  return <div className="main-inner import-page">
    <h1 className="page-title">Импорт плейлиста</h1>
    <p className="page-intro">Ссылка на плейлист или альбом Spotify, Apple Music, YouTube, SoundCloud — или файл CSV, JSON, M3U. Из сервисов берутся только названия; звук играет из найденной публичной записи, она указана у каждой строки.</p>
    <form className="search-bar import-bar" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void start({ url: url.trim() }); }}>
      <Link size={20} aria-hidden="true" />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://open.spotify.com/playlist/…" aria-label="Ссылка на плейлист" />
      <button className="btn btn-primary btn-sm" disabled={busy || !url.trim()}>Прочитать</button>
    </form>
    <div className="import-actions">
      <button className="btn btn-ghost btn-sm" onClick={() => file.current?.click()}><FileArrowUp size={16} /> Выбрать файл</button>
      <input ref={file} type="file" hidden accept=".csv,.json,.m3u,.m3u8,.txt" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void start({ file: { name: f.name, text: await f.text() } }); }} />
      {error && <span className="small error-text" role="alert">{error}</span>}
    </div>

    {!job && jobs.length > 0 && <section className="section"><h2 className="section-title">Недавние импорты</h2>
      {jobs.map((j) => <div key={j.id} className="download-row">
        <button className="download-main" onClick={() => void api.importJob(j.id).then(setJob)}>
          <Cover url={j.cover} seed={j.id} size={44} />
          <span className="download-text"><strong className="ellipsis">{j.name}</strong><span className="small muted">{SOURCE[j.source] ?? j.source} · {j.state === 'matching' ? 'сопоставляется' : j.state === 'done' ? 'плейлист создан' : 'ждёт подтверждения'}{j.counts ? ` · найдено ${j.counts.matched}, проверить ${j.counts.uncertain}, нет ${j.counts.missing}` : ''}</span></span>
        </button>
        <button className="icon-btn" aria-label="Удалить отчёт" onClick={() => void api.deleteImport(j.id).then(refreshList)}><Trash size={18} /></button>
      </div>)}
    </section>}

    {job && c && <section className="section import-report">
      <div className="import-head">
        <Cover url={job.cover} seed={job.id} size={72} />
        <div className="import-head-text">
          <h2>{job.name}</h2>
          <p className="small muted">{SOURCE[job.source] ?? job.source} · прочитано {job.rows.length}{job.total !== null ? ` из ${job.total}` : ''}</p>
          {!job.complete && <p className="small warn-text">{job.note ?? 'Источник показал не весь список.'} Остальное без входа недоступно — проверьте, прежде чем создавать.</p>}
          <div className="import-counts"><span className="tag ok">Найдено {c.matched}</span><span className="tag warn">Проверьте {c.uncertain}</span><span className="tag">Не найдено {c.missing}</span>{c.pending > 0 && <span className="tag">Ищем {c.pending}</span>}</div>
        </div>
        <button className="icon-btn" aria-label="Закрыть отчёт" onClick={() => setJob(null)}><X size={20} /></button>
      </div>
      {job.state === 'matching' && <div className="progress" aria-label="Сопоставление"><i style={{ width: `${Math.round(((job.rows.length - c.pending) / Math.max(1, job.rows.length)) * 100)}%` }} /></div>}
      <div className="import-rows">
        {job.rows.map((r) => <div key={r.position} className={`import-row ${r.status}`}>
          <span className="import-pos tnum">{r.position + 1}</span>
          <div className="import-cell"><strong className="ellipsis">{r.title}</strong><span className="small muted ellipsis">{r.artist}{r.duration ? ` · ${fmtTime(r.duration)}` : ''}</span></div>
          <div className="import-cell">{r.candidate ? <><strong className="ellipsis">{r.candidate.title} <VersionTags labels={r.candidate.labels} /></strong>
            <span className="small muted ellipsis">{r.candidate.artist} · {r.candidate.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}{r.candidate.duration ? ` · ${fmtTime(r.candidate.duration)}` : ''}{r.how === 'user' ? ' · выбрано вами' : r.how === 'source' ? ' · из плейлиста' : ` · уверенность ${Math.round(r.confidence * 100)}%`}</span></> : <span className="small muted">{STATUS[r.status]}</span>}</div>
          <span className={`tag ${r.status === 'matched' ? 'ok' : r.status === 'uncertain' ? 'warn' : ''}`}>{STATUS[r.status]}</span>
          <div className="import-row-actions">
            {r.status === 'uncertain' && <button className="icon-btn" aria-label="Принять вариант" title="Принять" onClick={() => void resolve(r, r.candidate!)}><Check size={17} /></button>}
            {r.status !== 'pending' && <button className="icon-btn" aria-label="Найти вручную" title="Найти вручную" onClick={() => pick(r)}><MagnifyingGlass size={17} /></button>}
            {(r.status === 'uncertain' || (r.status === 'matched' && r.how !== 'source')) && <button className="icon-btn" aria-label="Пропустить" title="Не добавлять" onClick={() => void resolve(r, null)}><X size={17} /></button>}
          </div>
        </div>)}
      </div>
      <div className="import-footer">
        <label className="source-check"><input type="checkbox" checked={withUncertain} onChange={(e) => setWithUncertain(e.target.checked)} /> Добавить и непроверенные ({c.uncertain})</label>
        {job.playlistId && <a className="btn btn-ghost btn-sm" href={`#/playlist/${job.playlistId}`}>Открыть плейлист</a>}
        <button className="btn btn-primary" disabled={busy || job.state === 'matching' || !(c.matched + (withUncertain ? c.uncertain : 0))} onClick={() => void create()}>
          {job.playlistId ? 'Обновить плейлист' : `Создать плейлист · ${c.matched + (withUncertain ? c.uncertain : 0)}`}</button>
      </div>
      <p className="caption muted">Ненайденные позиции остаются в этом отчёте со своим местом в списке: найдите их вручную, и они встанут на своё место в плейлисте. Звук скачивается при первом прослушивании.</p>
    </section>}
  </div>;
}
