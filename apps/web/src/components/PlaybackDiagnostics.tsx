import { useEffect, useState } from 'react';
import { nativePlaybackControls, playbackDiagnostics, type NavigationRoute } from '../lib/playback-trace.ts';

export function PlaybackDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(playbackDiagnostics);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [autoResume, setAutoResume] = useState(false);
  const [route, setRoute] = useState<NavigationRoute>('webkit');
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
    finally { setRoute(nativePlaybackControls()?.route ?? 'webkit'); setBusy(false); }
  };
  const events = Array.isArray(report?.events) ? report.events : [];
  return <section className="pref-card playback-diagnostics" aria-label="Диагностика управления iOS">
    <h2>Управление на экране блокировки · диагностическая сборка</h2>
    <p>В сборке 1.0.8 журнал записывается постоянно. Метка теста сохраняет предыдущие события.</p>
    <p>1. Оставьте маршрут WebKit. Включите музыку, дождитесь 15 секунд и нажмите «Поставить метку теста».
      Заблокируйте iPhone, подождите 10 секунд,
      нажмите паузу, воспроизведение, следующий трек и перемотку с интервалом 3–5 секунд.
      Разблокируйте телефон и сохраните отчёт.</p>
    <p>2. Сохраните отчёт после проверки. Для сравнения выберите прежний маршрут Native,
      поставьте новую метку и повторите на тех же двух треках. Сохраните второй JSON отдельно.</p>
    <label className="playback-diagnostics-option">
      <input type="checkbox" checked={autoResume} disabled={busy} onChange={(e) => {
        diagnostics.setAutoResume(e.target.checked); setAutoResume(e.target.checked);
      }} /> Эксперимент: принудительное автовозобновление звука
    </label>
    <p>Автовозобновление выключено по умолчанию: оно могло отменять системную паузу.
      Для сравнения маршрутов оставьте его выключенным. После перезапуска оно снова выключено.</p>
    <div className="playback-diagnostics-actions">
      <button className="btn" disabled={busy} onClick={() => void run(() => diagnostics.mark())}>Поставить метку теста</button>
      <button className="btn" disabled={busy} onClick={() => void run(async () => {})}>Обновить журнал</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => diagnostics.share())}>Сохранить / поделиться JSON</button>
    </div>
    <details>
      <summary>Сравнить маршруты системных команд</summary>
      <p>WebKit передаёт все команды через системный веб-плеер. Native — прежняя схема:
        метаданные через WebKit, переключение и перемотка через нативный мост.
        Работа кнопок и доступность перемотки требуют проверки на iPhone.</p>
      <label className="playback-diagnostics-option">Маршрут
        <select value={route} disabled={busy} onChange={(e) => {
          const selected = e.target.value as NavigationRoute;
          void run(async () => { await nativePlaybackControls()?.setRoute(selected); await diagnostics.mark(); });
        }}>
          <option value="webkit">WebKit — проверяемый</option>
          <option value="native">Native — прежний</option>
        </select>
      </label>
    </details>
    <details>
      <summary>Проверить доставку команды внутри приложения</summary>
      <p>Эти кнопки проверяют путь iOS → JS → аудиодвижок. Они не воспроизводят нажатие системной кнопки.</p>
      <div className="playback-diagnostics-actions">
        {([['pause', 'Пауза'], ['play', 'Play'], ['nexttrack', 'Следующий'], ['previoustrack', 'Предыдущий'], ['seekforward', '+10 с']] as const).map(([action, label]) =>
          <button className="btn" key={action} disabled={busy} onClick={() => void run(() => diagnostics.test(action))}>{label}</button>)}
      </div>
    </details>
    <details>
      <summary>Очистка журнала</summary>
      <p>Удалит все сохранённые события. Перед очисткой экспортируйте нужные отчёты.</p>
      <button className="btn" disabled={busy} onClick={() => void run(() => diagnostics.clear())}>Очистить весь журнал</button>
    </details>
    <p>Журнал хранится на телефоне, до 1200 событий. Названия треков, ссылки и токены не записываются.
      Отправка происходит только через открытое вами меню «Поделиться».</p>
    {error && <p role="alert">{error}</p>}
    {report && <details><summary>Последние события ({events.length}) · версия {String(report.version ?? '')}, сборка {String(report.build ?? '')}</summary>
      <pre className="playback-diagnostics-log">{JSON.stringify({ ...report, events: events.slice(-16) }, null, 2)}</pre>
    </details>}
  </section>;
}
