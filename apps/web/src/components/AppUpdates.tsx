import { useEffect, useState } from 'react';
import { desktop, type AppUpdateStatus } from '../lib/desktop.ts';

export function AppUpdates() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!desktop?.onAppUpdate) return;
    let active = true;
    let received = false;
    const unsubscribe = desktop.onAppUpdate((value) => { received = true; if (active) setStatus(value); });
    void desktop.appUpdateStatus().then((value) => { if (active && !received) setStatus(value); }).catch(() => {
      if (active) setError('Не удалось получить статус обновления');
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  const bridge = desktop;
  if (!bridge?.appUpdateCheck) return null;
  const act = async (action: 'check' | 'download' | 'cancel' | 'install') => {
    setError('');
    try {
      await ({ check: bridge.appUpdateCheck, download: bridge.appUpdateDownload,
        cancel: bridge.appUpdateCancel, install: bridge.appUpdateInstall })[action]();
    } catch { setError('Не удалось выполнить действие. Повторите попытку после окончания других операций.'); }
  };
  const phase = status?.phase;
  const message = phase === 'disabled' ? 'Обновления доступны в установленной версии MORA для Windows.'
    : phase === 'checking' ? 'Проверяем новую версию…'
    : phase === 'current' ? 'Установлена актуальная версия.'
    : phase === 'available' ? `Доступна MORA ${status?.version}${status?.size ? ` · ${Math.ceil(status.size / 1048576)} МБ` : ''}.`
    : phase === 'downloading' ? `Загружаем MORA ${status?.version} · ${status?.percent} %`
    : phase === 'downloaded' ? `MORA ${status?.version} скачана и проверена. Можно установить, когда закончите слушать.`
    : phase === 'installing' ? 'Устанавливаем обновление…'
    : 'Проверяем обновления автоматически. Загрузка и перезапуск — по вашему выбору.';
  return <div className="setting">
    <div>
      <div style={{ fontWeight: 600 }}>Обновление MORA</div>
      <div className="desc" role="status" aria-live="polite">{status?.error || error || message}</div>
      {phase === 'downloading' && <progress max={100} value={status?.percent} aria-label="Загрузка обновления MORA" />}
      <a className="context-link" href="https://github.com/Rizen1322/MORA/releases" target="_blank" rel="noreferrer">Что нового</a>
    </div>
    <div className="setting-control">
      {phase === 'available' ? <button className="btn btn-secondary btn-sm" onClick={() => void act('download')}>Скачать обновление</button>
        : phase === 'downloading' ? <button className="btn btn-ghost btn-sm" onClick={() => void act('cancel')}>Отменить загрузку</button>
        : phase === 'downloaded' ? <button className="btn btn-secondary btn-sm" onClick={() => void act('install')}>Установить и перезапустить</button>
        : <button className="btn btn-ghost btn-sm" disabled={!status || phase === 'disabled' || phase === 'checking' || phase === 'installing'} onClick={() => void act('check')}>Проверить обновления</button>}
    </div>
  </div>;
}
