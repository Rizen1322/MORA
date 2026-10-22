import { useEffect, useState } from 'react';
import { api, type Track } from '../lib/api.ts';
import { controller, useApp } from '../store/app.ts';
import { Modal, Cover } from './common.tsx';

export function PlaylistMix({ name, rows, onClose }: { name: string; rows: { entryId: number; track: Track }[]; onClose: () => void }) {
  const [mode, setMode] = useState<'smooth' | 'build'>('smooth');
  const [order, setOrder] = useState<number[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useApp(s => s.toast);
  useEffect(() => {
    setOrder(null); setError('');
    const worker = new Worker(new URL('../lib/mix-set.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      if (event.data.error) setError(event.data.error);
      else setOrder(event.data.entryIds);
    };
    worker.onerror = () => setError('Не удалось составить микс. Повторите попытку.');
    worker.postMessage({ mode, items: rows.map(({ entryId, track: t }) => ({ entryId, artist: t.artist, bpm: t.analysis.bpm, camelot: t.analysis.camelot, energy: t.analysis.energy, mixingAllowed: t.mixingAllowed })) });
    return () => worker.terminate();
  }, [rows, mode]);
  const byId = new Map(rows.map(row => [row.entryId, row.track]));
  const tracks = (order ?? []).map(id => byId.get(id)).filter((t): t is Track => !!t);
  const analysed = rows.filter(({ track }) => !!track.analysis.bpm).length;
  return <Modal title="Собрать микс" onClose={onClose} actions={<>
    <button className="btn btn-secondary" disabled={!order || saving} onClick={async () => {
      setSaving(true);
      try { await api.createPlaylist(`${name} · Микс`, tracks.map(t => t.id)); await useApp.getState().loadPlaylists(); toast('Копия микса сохранена', 'success'); onClose(); }
      catch (e) { setError((e as Error).message); } finally { setSaving(false); }
    }}>Сохранить копию</button>
    <button className="btn btn-primary" disabled={!tracks.length} onClick={() => {
      if (controller.state.shuffle) controller.toggleShuffle();
      void controller.playTracks(tracks.map(t => t.id), 0, { type: 'playlist', label: `${name} · Микс` }); onClose();
    }}>Слушать микс</button>
  </>}>
    <p className="small muted">Подберём порядок по измеренным BPM, тональности и энергии. Первый трек остаётся первым. Исходный плейлист сохраняется.</p>
    <div className="tabs" role="group" aria-label="Характер микса">
      <button className="chip" aria-pressed={mode === 'smooth'} onClick={() => setMode('smooth')}>Плавно</button>
      <button className="chip" aria-pressed={mode === 'build'} onClick={() => setMode('build')}>Нарастание энергии</button>
    </div>
    <p className="caption muted">С анализом: {analysed} из {rows.length}. Без анализа — в конце, в прежнем относительном порядке. Это подбор совместимости, не гарантия каждого перехода.</p>
    {error ? <p role="alert">{error}</p> : !order ? <p role="status">Собираем порядок…</p> : <div className="mix-set-preview" aria-label="Порядок микса">
      {tracks.slice(0, 30).map((t, i) => <div key={order[i]} className="mix-set-row"><span className="caption muted">{i + 1}</span><Cover url={t.coverUrl} seed={t.id} size={36} /><span><strong className="ellipsis">{t.title}</strong><span className="caption muted ellipsis">{t.artist}</span></span><span className="caption muted">{t.analysis.bpm ? `${Math.round(t.analysis.bpm)} BPM` : 'Без анализа'}</span></div>)}
      {tracks.length > 30 && <p className="caption muted">Ещё {tracks.length - 30} треков в миксе</p>}
    </div>}
  </Modal>;
}
