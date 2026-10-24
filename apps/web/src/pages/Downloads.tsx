import { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, Pause, Play, Trash, X } from '@phosphor-icons/react';
import { api, type DownloadUsage } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { controller, useApp } from '../store/app.ts';
import { useDownloads } from '../store/downloads.ts';
import { Cover } from '../components/common.tsx';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const mb = (b: number) => (b >= GB ? `${(b / GB).toFixed(1).replace('.', ',')} ГБ` : `${Math.round(b / MB)} МБ`);
const STATE: Record<string, string> = { queued: 'В очереди', downloading: 'Скачивается', waiting: 'Ждём подключения', paused: 'На паузе', failed: 'Ошибка', cancelled: 'Отменено', done: 'Готово' };

/**
 * Offline copies: downloaded tracks never leave the device by cache cleanup.
 * The audio cache (recently played search results) is separate and limited.
 */
export function DownloadsPage() {
  const jobs = useDownloads((s) => s.jobs);
  const load = useDownloads((s) => s.load);
  const tracks = useApp((s) => s.tracks);
  const toast = useApp((s) => s.toast);
  const [usage, setUsage] = useState<DownloadUsage | null>(null);
  const refresh = () => { void load(); void api.downloads().then((r) => setUsage(r.usage)).catch(() => {}); };
  useEffect(refresh, []);
  const active = [...jobs.values()].filter((j) => j.state !== 'done' && j.state !== 'cancelled');
  const pinned = useMemo(() => [...tracks.values()].filter((t) => t.pinned).sort((a, b) => a.title.localeCompare(b.title, 'ru')), [tracks]);
  const act = (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => void api.downloadAction(id, a).then(refresh).catch((e) => toast((e as Error).message, 'error'));

  return <div className="main-inner downloads-page">
    <h1 className="page-title">Загрузки</h1>
    <p className="page-intro">Скачанные треки играют без интернета. Подготовка к AutoMix (анализ, вокал) идёт отдельно и не мешает слушать.</p>

    {active.length > 0 && <section className="section">
      <h2 className="section-title">Скачивается</h2>
      {active.map((j) => <div key={j.id} className="download-row">
        <div className="download-text"><strong className="ellipsis">{j.title || 'Трек'}</strong>
          <span className={`small ${j.state === 'failed' ? 'error-text' : 'muted'}`}>{j.error && j.state !== 'downloading' ? j.error : STATE[j.state]}{j.state === 'downloading' ? ` · ${Math.round(j.progress * 100)}%` : ''}</span>
          {j.state === 'downloading' && <div className="progress"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
        </div>
        <div className="download-actions">
          {(j.state === 'queued' || j.state === 'downloading' || j.state === 'waiting') && <button className="icon-btn" aria-label="Пауза" onClick={() => act(j.id, 'pause')}><Pause size={18} /></button>}
          {(j.state === 'paused' || j.state === 'failed') && <button className="icon-btn" aria-label="Повторить" onClick={() => act(j.id, 'retry')}><ArrowClockwise size={18} /></button>}
          <button className="icon-btn" aria-label="Отменить" onClick={() => act(j.id, 'cancel')}><X size={18} /></button>
        </div>
      </div>)}
    </section>}

    <section className="section">
      <h2 className="section-title">Скачано · {pinned.length}</h2>
      {!pinned.length && <p className="muted">Пока ничего. В меню трека или результата поиска выберите «Скачать».</p>}
      {pinned.map((t, i) => <div key={t.id} className="download-row">
        <button className="download-main" onClick={() => void controller.playTracks(pinned.map((x) => x.id), i, { type: 'library', label: 'Загрузки' })} aria-label={`Слушать: ${t.title}`}>
          <Cover url={t.coverUrl} seed={t.album || t.id} size={44} />
          <span className="download-text"><strong className="ellipsis">{t.title}</strong><span className="small muted ellipsis">{t.artist} · {t.codec ?? 'аудио'}{t.bitrate ? ` ${Math.round(t.bitrate / 1000)} кбит/с` : ''} · {fmtTime(t.duration)} · {t.analysis.status === 'done' ? 'готов к AutoMix' : 'анализ в фоне'}</span></span>
          <Play size={18} weight="fill" className="download-play" />
        </button>
        <button className="icon-btn" aria-label={`Удалить загрузку: ${t.title}`} title="Удалить загрузку (файл станет обычным кэшем)" onClick={() => void api.removeDownload(t.id).then(() => { useApp.getState().patchTrack(t.id, { pinned: false }); refresh(); })}><Trash size={18} /></button>
      </div>)}
    </section>

    {usage && <section className="section downloads-usage">
      <h2 className="section-title">Место на диске</h2>
      <div className="setting"><div><strong>Скачанное</strong><p className="small muted">Не удаляется автоматически</p></div><span className="tnum">{mb(usage.pinnedBytes)}</span></div>
      <div className="setting"><div><strong>Кэш прослушанного</strong><p className="small muted">Старое удаляется само, когда превышен предел. Текущий и следующий трек защищены.</p></div>
        <span className="tnum">{mb(usage.cacheBytes)} из</span>
        <select className="select" aria-label="Предел кэша" value={String(Math.round(usage.limitBytes / MB))} onChange={(e) => void api.setCacheLimit(Number(e.target.value)).then((r) => setUsage(r.usage))}>
          {[512, 1024, 2048, 5120, 10240, 20480].map((v) => <option key={v} value={v}>{mb(v * MB)}</option>)}
        </select>
        <button className="btn btn-ghost btn-sm" onClick={() => void api.clearAudioCache().then((r) => { setUsage(r.usage); toast(r.removed ? `Удалено файлов: ${r.removed}` : 'Нечего очищать'); })}>Очистить кэш</button></div>
      {usage.freeBytes !== null && <p className="small muted">Свободно на диске: {mb(usage.freeBytes)}</p>}
    </section>}
  </div>;
}
