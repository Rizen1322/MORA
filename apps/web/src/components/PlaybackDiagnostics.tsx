import { useEffect, useState } from 'react';
import { nativePlaybackControls, playbackDiagnostics, type NavigationRoute, type NativeProbeState } from '../lib/playback-trace.ts';

export function PlaybackDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(playbackDiagnostics);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [autoResume, setAutoResume] = useState(false);
  const [route, setRoute] = useState<NavigationRoute>('webkit');
  const [probeState, setProbeState] = useState<NativeProbeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const ready = () => setDiagnostics(playbackDiagnostics());
    window.addEventListener('mora-diagnostics-ready', ready);
    return () => window.removeEventListener('mora-diagnostics-ready', ready);
  }, []);
  useEffect(() => { if (diagnostics) setAutoResume(diagnostics.allowAutoResume); }, [diagnostics]);
  useEffect(() => {
    if (!diagnostics) return;
    let cancelled = false;
    const update = async () => {
      if (document.hidden) return;
      try {
        const state = await nativePlaybackControls()?.probe?.state();
        if (!cancelled && state) setProbeState(state);
      } catch { /* Older shell has no native baseline. */ }
    };
    void update();
    const timer = setInterval(() => { if (nativePlaybackControls()?.probeActive) void update(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [diagnostics]);
  if (!diagnostics) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); setReport(await diagnostics.report()); }
    catch { setError('Не удалось выполнить действие. Повторите после разблокировки iPhone.'); }
    finally { setRoute(nativePlaybackControls()?.route ?? 'webkit'); setBusy(false); }
  };
  const events = Array.isArray(report?.events) ? report.events : [];
  const controls = nativePlaybackControls();
  const probeActive = !!controls?.probeActive;
  return <section className="pref-card playback-diagnostics" aria-label="Диагностика управления iOS">
    <h2>Управление на экране блокировки · диагностическая сборка</h2>
    <p>Версия 1.0.9: отдельная проверка настоящего нативного плеера. Журнал записывается постоянно,
      метка сохраняет предыдущие события.</p>
    <div className="pref-card" style={{ padding: 14 }}>
      <h3>Нативный плеер · две тестовые мелодии</h3>
      <p>Нажмите «Запустить нативный тест»: обычная музыка остановится, начнётся тихая тестовая мелодия.
        Это проверка кнопок iOS без AutoMix. Две мелодии A/B по 90 секунд переключаются самим iPhone.</p>
      <p>Заблокируйте экран и проверьте Pause → Play, Next → Previous и перемотку на 60 секунд.
        Проверьте Play после паузы дольше 3 минут. Затем разблокируйте и сохраните JSON.</p>
      <div className="playback-diagnostics-actions">
        <button className="btn btn-primary" disabled={busy || probeActive || !controls?.probe} onClick={() => void run(async () => {
          setProbeState(await controls!.probe!.start()); await diagnostics.mark();
        })}>Запустить нативный тест</button>
        <button className="btn" disabled={busy || !probeActive} onClick={() => void run(async () => {
          await controls!.probe!.stop(); setProbeState(null); await diagnostics.mark();
        })}>Остановить тест и вернуться к музыке</button>
        <button className="btn" disabled={busy || !probeActive} onClick={() => void run(async () => {
          setProbeState(await controls!.probe!.command('seekto', 60));
        })}>Тест: перейти на 60 с</button>
      </div>
      {probeState?.active && <p role="status">Мелодия {probeState.index === 0 ? 'A' : 'B'} · {Math.floor(probeState.position)} / {Math.floor(probeState.duration)} с · {probeState.playing ? 'играет' : 'пауза'}</p>}
      <p>Для возврата остановите тест здесь и включите музыку обычной кнопкой Play.</p>
    </div>
    <label className="playback-diagnostics-option">
      <input type="checkbox" checked={autoResume} disabled={busy || probeActive} onChange={(e) => {
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
        <select value={route} disabled={busy || probeActive} onChange={(e) => {
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
      <p>{probeActive ? 'Эти кнопки управляют нативным тестовым плеером.' : 'Эти кнопки проверяют путь iOS → JS → аудиодвижок.'}
        Они не воспроизводят нажатие системной кнопки.</p>
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
