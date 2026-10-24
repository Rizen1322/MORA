import { useEffect, useState } from 'react';
import { playbackDiagnostics } from '../lib/playback-trace.ts';

export function PlaybackDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(playbackDiagnostics);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [autoResume, setAutoResume] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const ready = () => setDiagnostics(playbackDiagnostics());
    window.addEventListener('mora-diagnostics-ready', ready);
    return () => window.removeEventListener('mora-diagnostics-ready', ready);
  }, []);
  useEffect(() => { if (diagnostics) setAutoResume(diagnostics.allowAutoResume); }, [diagnostics]);
  if (!diagnostics) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); setReport(await diagnostics.report()); }
    catch { setError('Не удалось выполнить действие. Повторите после разблокировки iPhone.'); }
    finally { setBusy(false); }
  };
  const events = Array.isArray(report?.events) ? report.events : [];
  return <section className="pref-card playback-diagnostics" aria-label="Диагностика управления iOS">
    <h2>Управление на экране блокировки · диагностическая сборка</h2>
    <p>1. Включите музыку и нажмите «Начать запись». Заблокируйте iPhone, подождите 10 секунд,
      нажмите паузу, воспроизведение, следующий трек и перемотку с интервалом 3–5 секунд.
      Разблокируйте телефон и сохраните отчёт.</p>
    <p>2. Выключите «Автовозобновление звука», начните новую запись и повторите проверку.
      Сохраните второй отчёт. Для сравнения используйте те же два трека в очереди.</p>
    <label className="playback-diagnostics-option">
      <input type="checkbox" checked={autoResume} disabled={busy} onChange={(e) => {
        diagnostics.setAutoResume(e.target.checked); setAutoResume(e.target.checked);
      }} /> Автовозобновление звука (AudioContext)
    </label>
    <p>При выключении звук после блокировки может остановиться. Кнопка Play в приложении продолжает работать.
      После перезапуска приложения автовозобновление снова включено.</p>
    <div className="playback-diagnostics-actions">
      <button className="btn" disabled={busy} onClick={() => void run(() => diagnostics.clear())}>Начать запись</button>
      <button className="btn" disabled={busy} onClick={() => void run(async () => {})}>Обновить журнал</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => diagnostics.share())}>Сохранить / поделиться JSON</button>
    </div>
    <details>
      <summary>Проверить доставку команды внутри приложения</summary>
      <p>Эти кнопки проверяют путь iOS → JS → аудиодвижок. Они не воспроизводят нажатие системной кнопки.</p>
      <div className="playback-diagnostics-actions">
        {([['pause', 'Пауза'], ['play', 'Play'], ['nexttrack', 'Следующий'], ['previoustrack', 'Предыдущий'], ['seekforward', '+10 с']] as const).map(([action, label]) =>
          <button className="btn" key={action} disabled={busy} onClick={() => void run(() => diagnostics.test(action))}>{label}</button>)}
      </div>
    </details>
    <p>Журнал хранится на телефоне, до 1200 событий. Названия треков, ссылки и токены не записываются.
      Отправка происходит только через открытое вами меню «Поделиться».</p>
    {error && <p role="alert">{error}</p>}
    {report && <details><summary>Последние события ({events.length}) · версия {String(report.version ?? '')}, сборка {String(report.build ?? '')}</summary>
      <pre className="playback-diagnostics-log">{JSON.stringify({ ...report, events: events.slice(-16) }, null, 2)}</pre>
    </details>}
  </section>;
}
