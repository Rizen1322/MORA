import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Heart, Pause, Play } from '@phosphor-icons/react';
import { api, type YandexLikesJob } from '../lib/api.ts';
import { useApp } from '../store/app.ts';

export function YandexLikesImport() {
  const [job, setJob] = useState<YandexLikesJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const next = await api.yandexLikesJob(); if (!disposed) { setJob(next); setOffline(false); } }
      catch { if (!disposed) setOffline(true); }
      if (!disposed) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, []);
  const act = async (kind: 'start' | 'pause' | 'resume' | 'retry' | 'cancel') => {
    setBusy(true); setError('');
    try {
      const next = await (kind === 'start' ? api.startYandexLikes() : kind === 'pause' ? api.pauseYandexLikes() : kind === 'cancel' ? api.cancelYandexLikes() : api.resumeYandexLikes(kind === 'retry'));
      if (alive.current) setJob(next);
      void useApp.getState().loadLibrary();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  };
  const active = job?.state === 'running' || job?.state === 'listing';
  const processed = job ? job.done + job.failed + job.skipped : 0;
  return <section className="yandex-likes-import" aria-label="Импорт всех лайков Яндекса">
    <div><Heart size={22} weight="duotone" /><h3>Вся любимая музыка</h3></div>
    <p className="small muted">Перенесите всю коллекцию лайков в «Любимое» MORA. Треки готовятся по два, новые остаются сверху. Страницу можно закрыть; после выхода из приложения импорт можно продолжить.</p>
    {job && <div className="likes-import-progress">
      <div className="small" role="status">{job.state === 'listing' ? 'Получаем коллекцию…' : `${job.state === 'done' ? 'Готово' : job.state === 'cancelled' ? 'Остановлен' : job.state === 'paused' ? 'На паузе' : job.state === 'error' ? 'Нужен повтор' : 'Подготавливаем'} · ${processed} из ${job.total}`}</div>
      {job.total > 0 && <progress aria-label="Прогресс импорта лайков" max={job.total} value={processed} />}
      <p className="caption muted">В Любимом: {job.done}{job.failed ? ` · Не удалось: ${job.failed}` : ''}{job.skipped ? ` · Пропущено после изменения оценки: ${job.skipped}` : ''}</p>
      {job.message && <p className="small muted">{job.message}</p>}
    </div>}
    <div className="likes-import-actions">
      {(!job || ['done', 'cancelled'].includes(job.state)) && <button className="btn btn-secondary btn-sm" disabled={busy || job?.busy} onClick={() => void act('start')}><Heart size={16} />{job ? 'Обновить коллекцию' : 'Добавить все лайки в Любимое'}</button>}
      {active && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act('pause')}><Pause size={16} />Приостановить</button>}
      {job && !active && !['done', 'cancelled'].includes(job.state) && <button className="btn btn-secondary btn-sm" disabled={busy || job.busy} onClick={() => void act('resume')}><Play size={16} />Продолжить</button>}
      {job && !active && job.state !== 'cancelled' && job.failed > 0 && <button className="btn btn-ghost btn-sm" disabled={busy || job.busy} onClick={() => void act('retry')}><ArrowClockwise size={16} />Повторить ошибки</button>}
      {job && !['done', 'cancelled'].includes(job.state) && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act('cancel')} title="Добавленные треки останутся">Завершить импорт</button>}
      {job?.done ? <a className="btn btn-ghost btn-sm" href="#/liked">Открыть Любимое</a> : null}
    </div>
    {error && <p className="small error-text" role="alert">{error}</p>}
    {offline && <p className="small muted" role="status">Нет связи с приложением. Последний прогресс сохранён; обновим его после подключения.</p>}
  </section>;
}
