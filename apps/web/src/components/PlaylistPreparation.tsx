import { useEffect, useState } from 'react';
import { api, type ListeningPreparation } from '../lib/api.ts';
import { useApp } from '../store/app.ts';

export function PlaylistPreparation({ id }: { id: string }) {
  const [job, setJob] = useState<ListeningPreparation | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const toast = useApp(s => s.toast);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const next = await api.listeningPreparation(id); if (alive) { setJob(next); setOffline(false); } }
      catch { if (alive) setOffline(true); }
      if (alive) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);
  const active = job && !job.cancelled && !job.complete;
  const act = async () => {
    setBusy(true);
    try { setJob(active ? await api.cancelListeningPreparation(id) : await api.prepareListening(id)); setOffline(false); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return <section className="playlist-preparation" aria-label="Подготовка к прослушиванию">
    <div><strong>Подготовить к прослушиванию</strong><p className="caption muted">Скачать оригиналы для офлайна, проанализировать музыку и рассчитать переходы. Звук перехода проверяется перед воспроизведением.</p></div>
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act()}>{active ? 'Отменить подготовку' : job?.complete ? 'Проверить ещё раз' : 'Подготовить'}</button>
    {offline && <p role="status" className="caption">Сервер недоступен — статус обновится после подключения.</p>}
    {job && <div role="status" className="preparation-progress"><progress value={job.ready + job.unavailable} max={job.total} aria-label="Подготовлено треков" /><span>{job.cancelled ? 'Отменено' : job.complete ? 'Подготовка завершена' : 'Подготавливается'} · готово {job.ready} из {job.total}{job.unavailable ? ` · недоступно ${job.unavailable}` : ''} · переходы {job.plansReady} из {job.plansTotal}{job.plansFailed ? ` · без подготовки ${job.plansFailed}` : ''}</span></div>}
    {job?.unavailable ? <details><summary>Недоступные треки</summary>{job.tracks.filter(t => t.state === 'unavailable' || t.analysis === 'error').map(t => <p key={t.trackId} className="caption">{useApp.getState().tracks.get(t.trackId)?.title ?? t.trackId}: {t.analysis === 'error' ? 'Не удалось проанализировать; можно слушать без AutoMix' : t.message}</p>)}<a href="#/downloads">Открыть загрузки и повторить</a></details> : null}
    {job?.cancelled && <p className="caption muted">Готовые скачанные треки сохранены. Уже начатый анализ завершится; новые треки не подготавливаются.</p>}
  </section>;
}
