import { useEffect, useState, type CSSProperties } from 'react';
import { ClockCounterClockwise, GearSix, Plugs, ChartLine, Waveform } from '@phosphor-icons/react';
import { desktop } from '../lib/desktop.ts';
import { api, type StemGpu, type StemHealth } from '../lib/api.ts';
import { plural } from '../lib/format.ts';
import { useApp } from '../store/app.ts';
import { ConfirmModal, Switch } from '../components/common.tsx';
import { TransitionSummary } from '../components/TransitionSummary.tsx';
import { PlaylistBackup } from '../components/PlaylistBackup.tsx';
import { AppUpdates } from '../components/AppUpdates.tsx';
import '../styles/prefs.css';

// iPhone app: no vocal separation model, so no vocal switch (the phone keeps stemMixing on, see apps/mobile worker),
// and no hardware keyboard to list shortcuts for.
const mobileApp = typeof document !== 'undefined' && document.documentElement.classList.contains('mora-mobile');

/** One line of a grouped list: label and short explanation on the left, the control on the right.
 *  `wide` controls (sliders, menus, several buttons) move under the text on a phone. */
function Row({ title, desc, children, wide = false }: { title: string; desc?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`pref-row${wide ? ' wide' : ''}`}>
      <div className="pref-text">
        <div className="pref-title">{title}</div>
        {desc && <div className="pref-desc">{desc}</div>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  );
}

/** A titled card of rows, as in iOS Settings; the footer explains the whole group. */
function Group({ title, footer, children }: { title: string; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="pref-group" aria-label={title}>
      <h2 className="pref-group-title">{title}</h2>
      <div className="pref-card">{children}</div>
      {footer && <p className="pref-footer">{footer}</p>}
    </section>
  );
}

function Slider({ value, min, max, step, onChange, format, label, disabled = false }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; label: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <>
      <input
        className="range"
        type="range"
        aria-label={label}
        aria-valuetext={format(v)}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={v}
        style={{ '--fill': `${((v - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => onChange(v)}
        onKeyUp={() => onChange(v)}
        onBlur={() => v !== value && onChange(v)}
      />
      <output className="setting-value tnum small">
        {format(v)}
      </output>
    </>
  );
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1).replace('.', ',')} ГБ`;

/** Optional NVIDIA runtime: nothing is downloaded until the user confirms the shown size. */
function GpuAcceleration({ gpu, onChange }: { gpu: StemGpu; onChange: () => void }) {
  const toast = useApp((st) => st.toast);
  const [ask, setAsk] = useState<'install' | 'remove' | null>(null);
  if (!gpu.gpu) return null;
  const busy = gpu.status === 'downloading' || gpu.status === 'installing';
  return <div className="vocal-gpu">
    <div className="vocal-preparation-heading">
      <strong>Ускорение на видеокарте</strong>
      <span className={`tag ${gpu.status === 'ready' ? gpu.fallback ? 'warn' : 'ok' : gpu.status === 'error' ? 'warn' : busy ? 'accent' : ''}`}>
        {gpu.status === 'ready' ? gpu.fallback ? 'CPU' : 'Включено' : gpu.status === 'downloading' ? `${Math.round((gpu.progress ?? 0) * 100)} %` : gpu.status === 'installing' ? 'Проверка' : gpu.status === 'error' ? 'Ошибка' : 'Выключено'}
      </span>
    </div>
    {gpu.status === 'ready' ? <p>{gpu.fallback ? `Видеокарта сейчас не работает, вокал готовится на процессоре: ${gpu.fallback}` : `Вокал готовится на ${gpu.gpu.name}, в 3–4 раза быстрее. Результат тот же, что на процессоре.`}</p>
      : busy ? <>
        <progress className="vocal-preparation-progress" max={1} value={gpu.status === 'downloading' ? gpu.progress ?? 0 : undefined} aria-label="Загрузка пакета для видеокарты" />
        <p>{gpu.status === 'downloading' ? `Скачиваем пакет CUDA: ${gb((gpu.progress ?? 0) * gpu.downloadBytes)} из ${gb(gpu.downloadBytes)}.` : 'Распаковываем и проверяем на видеокарте.'} Пока вокал готовится на процессоре.</p>
      </>
      : <p>{gpu.status === 'error' ? `Не удалось установить: ${gpu.error ?? 'неизвестная ошибка'}. ` : ''}{gpu.gpu.name} может готовить вокал в 3–4 раза быстрее. Для этого нужен пакет CUDA: загрузка {gb(gpu.downloadBytes)}, на диске около {gb(gpu.diskBytes)}.</p>}
    {!busy && <button type="button" className="btn btn-ghost" onClick={() => setAsk(gpu.status === 'ready' ? 'remove' : 'install')}>
      {gpu.status === 'ready' ? `Удалить пакет (${gb(gpu.diskBytes)})` : gpu.status === 'error' ? 'Повторить' : 'Скачать пакет CUDA'}
    </button>}
    {ask && <ConfirmModal
      title={ask === 'install' ? 'Скачать пакет для видеокарты?' : 'Удалить пакет для видеокарты?'}
      text={ask === 'install'
        ? `Будет загружено ${gb(gpu.downloadBytes)} с download.pytorch.org, на диске пакет займёт около ${gb(gpu.diskBytes)}. Если видеокарта не справится, вокал по-прежнему готовится на процессоре.`
        : `Освободится около ${gb(gpu.diskBytes)}. Вокал будет готовиться на процессоре, уже готовые партии сохранятся.`}
      confirm={ask === 'install' ? `Скачать ${gb(gpu.downloadBytes)}` : 'Удалить'}
      danger={ask === 'remove'}
      onConfirm={async () => {
        try { await (ask === 'install' ? api.installStemGpu(gpu.downloadBytes) : api.removeStemGpu()); }
        catch (e) { toast((e as Error).message, 'error'); }
        onChange();
      }}
      onClose={() => setAsk(null)}
    />}
  </div>;
}

function VocalPreparation({ stems, offline, loading, onChange }: { stems?: StemHealth; offline: boolean; loading: boolean; onChange: () => void }) {
  const job = stems?.running[0];
  const progress = typeof job?.progress === 'number' && Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : undefined;
  const busy = !!job || !!stems?.queued;
  const unavailable = !stems?.available;
  const failed = !!stems?.errors && !busy;
  let title = 'Вокальные партии ещё не подготовлены';
  if (offline) title = 'Статус подготовки недоступен';
  else if (!stems) title = loading ? 'Проверяем подготовку вокала' : 'Подготовка вокала недоступна';
  else if (unavailable) title = stems.ready ? 'Готовые вокальные партии доступны' : 'Локальная модель недоступна';
  else if (busy) title = 'Готовим вокальные партии';
  else if (failed) title = stems.ready ? 'Часть вокальных партий подготовлена' : 'Не удалось подготовить вокал';
  else if (stems.ready) title = 'Вокальные партии подготовлены';
  return <div className="vocal-preparation">
    {stems?.runtime === 'bundled-cpu' && <p className="caption muted">Модель внутри приложения · обработка на этом компьютере · {stems.gpu?.status === 'ready' && !stems.gpu.fallback ? 'видеокарта' : 'CPU'}</p>}
    <div className="vocal-preparation-heading">
      <strong>{title}</strong>
      {stems && !offline && <span className={`tag ${unavailable || failed ? 'warn' : busy ? 'accent' : stems.ready ? 'ok' : ''}`}>{unavailable ? stems.ready ? 'Из кэша' : 'Недоступно' : busy ? progress === undefined ? 'В работе' : `${Math.round(progress * 100)} %` : failed ? stems.ready ? 'Частично' : 'Ошибка' : stems.ready ? 'Готово' : 'Ожидание'}</span>}
    </div>
    {offline ? <p>Проверьте соединение с приложением. Статус обновится автоматически.</p> : !stems ? <p>{loading ? 'Статус появится после ответа сервера.' : 'Сервер не сообщил статус локальной модели. Остальные способы AutoMix доступны.'}</p> : unavailable ? <p>{stems.ready ? `Подготовлено: ${stems.ready} ${plural(stems.ready, 'трек', 'трека', 'треков')}. Для подготовки новых партий нужна локальная модель разделения звука.` : 'Для отдельной передачи вокала нужна локальная модель разделения звука. Остальные способы AutoMix доступны.'}</p> : <>
      {busy && <progress className="vocal-preparation-progress" max={1} value={progress} aria-label="Подготовка вокальной партии" />}
      <p className="tnum">Подготовлено: {stems.ready} {plural(stems.ready, 'трек', 'трека', 'треков')}{stems.queued > 0 ? ` · в очереди ${stems.queued}` : ''}{stems.errors > 0 ? ` · не удалось подготовить ${stems.errors}` : ''}.</p>
      {busy && <p>Обработка идёт на этом компьютере. Первый запуск модели и подготовка новых треков занимают время; слушать музыку можно уже сейчас.</p>}
      {!busy && stems.ready === 0 && <p>{failed ? 'Для этих треков доступны остальные способы AutoMix. Новые треки будут подготовлены отдельно.' : 'Подготовка начинается для доступных локальных треков. Результат сохраняется для следующих переходов.'}</p>}
    </>}
    {stems?.gpu && !offline && <GpuAcceleration gpu={stems.gpu} onChange={onChange} />}
  </div>;
}

/** Windows app options: tray behaviour, library folder and import of an existing library. */
function DesktopSettings() {
  const toast = useApp((st) => st.toast);
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof desktop>['getSettings']>> | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [resolver, setResolver] = useState<Awaited<ReturnType<NonNullable<typeof desktop>['resolverStatus']>> | null>(null);
  const [updating, setUpdating] = useState(false);
  const [resolverMessage, setResolverMessage] = useState('');
  const [resolverError, setResolverError] = useState('');
  const resolverAction = async (action: 'check' | 'install' | 'rollback') => {
    setUpdating(true); setResolverError(''); setResolverMessage('');
    try {
      const next = await (action === 'check' ? desktop!.resolverCheck() : action === 'install' ? desktop!.resolverInstall() : desktop!.resolverRollback());
      setResolver(next);
      setResolverMessage(action === 'check' ? (next.latest === next.selected ? 'Установлена актуальная версия' : `Доступна версия ${next.latest}`) : 'Изменение сохранено. Оно включится при следующем запуске MORA.');
    } catch (e) { setResolverError((e as Error).message); }
    finally { setUpdating(false); }
  };
  useEffect(() => {
    void desktop!.getSettings().then(setInfo);
    void desktop!.resolverStatus().then(setResolver).catch(() => setResolverError('Не удалось проверить компонент источников'));
    return desktop!.onImport((p) => setProgress(p.total ? p.done / p.total : null));
  }, []);
  if (!info) return null;
  return (
    <Group title="Приложение" footer={resolverError ? <span role="alert" className="error-text">{resolverError}</span> : resolverMessage ? <span role="status">{resolverMessage}</span> : undefined}>
      <Row title="Закрывать окно в трей" desc="Музыка играет и после закрытия окна. Выйти можно через значок в области уведомлений.">
        <Switch checked={info.closeToTray} onChange={(v) => void desktop!.setCloseToTray(v).then((r) => setInfo({ ...info, ...r }))} label="Закрывать окно в трей" />
      </Row>
      <Row title="Папка медиатеки" desc={<span className="pref-path">{info.dataDir}</span>}>
        <button className="btn btn-ghost btn-sm" onClick={() => void desktop!.openDataFolder()}>Открыть</button>
      </Row>
      <Row title="Перенести медиатеку" desc={progress !== null ? `Копируем… ${Math.round(progress * 100)} %` : 'Скопировать треки, плейлисты, историю и вокальные партии из другой папки MORA или AutoMix. Исходная папка не меняется.'}>
        <button
          className="btn btn-ghost btn-sm"
          disabled={progress !== null}
          onClick={async () => {
            setProgress(0);
            try {
              const r = await desktop!.importLibrary();
              if (r.status === 'done') toast('Медиатека перенесена', 'success');
              else if (r.status === 'error') toast(r.message ?? 'Не удалось перенести медиатеку', 'error');
            } finally {
              setProgress(null);
            }
          }}
        >
          Выбрать папку…
        </button>
      </Row>
      <Row title="Версия" desc={`MORA ${info.version} для Windows`}><span /></Row>
      <AppUpdates />
      <Row wide title="Компонент для YouTube и SoundCloud" desc={`yt-dlp: ${resolver?.selected === 'bundled' ? 'из комплекта MORA' : resolver?.selected ?? 'проверяем'}. Обновляется с официального GitHub с проверкой файла, музыка не прерывается.`}>
        <button className="btn btn-ghost btn-sm" disabled={updating} onClick={() => void resolverAction('check')}>{updating ? 'Подождите…' : 'Проверить обновление'}</button>
        {resolver?.latest && resolver.latest !== resolver.selected && <button className="btn btn-secondary btn-sm" disabled={updating} onClick={() => void resolverAction('install')}>Обновить до {resolver.latest}</button>}
        {resolver?.canRollback && <button className="btn btn-ghost btn-sm" disabled={updating} onClick={() => void resolverAction('rollback')}>Вернуть предыдущую</button>}
      </Row>
    </Group>
  );
}

const SHORTCUTS = [
  ['Пробел', 'пауза и продолжение'],
  ['← / →', 'перемотка на 5 с'],
  ['Shift + ← / →', 'предыдущий / следующий трек'],
  ['↑ / ↓', 'громкость'],
  ['M', 'без звука'],
  ['L', 'нравится'],
  ['Q', 'очередь'],
  ['F', 'полноэкранный плеер'],
  ['/', 'поиск в медиатеке'],
  ['Alt + ↑ / ↓', 'переместить трек в очереди'],
];

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} МБ`;

export function SettingsPage() {
  const s = useApp((st) => st.settings);
  const save = useApp((st) => st.saveSettings);
  const toast = useApp((st) => st.toast);
  const player = useApp((st) => st.player);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [healthOffline, setHealthOffline] = useState(false);
  // Vocal separation needs a configured local model; the iPhone and desktop apps ship none.
  const vocalModel = !mobileApp && !!health?.stems?.available;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      let busy = false;
      try {
        const next = await api.health();
        if (!alive) return;
        setHealth(next); setHealthOffline(false);
        busy = !!next.stems?.running.length || !!next.stems?.queued || next.stems?.gpu?.status === 'downloading' || next.stems?.gpu?.status === 'installing';
      } catch { if (alive) setHealthOffline(true); }
      if (alive) timer = setTimeout(() => void refresh(), busy ? 3000 : 10000);
    };
    void refresh();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  if (!s) return <div className="main-inner" />;
  const a = s.automix;
  const set = (patch: Partial<typeof a>) => void save({ automix: { ...a, ...patch } });
  const off = !a.enabled;
  return (
    <div className="main-inner prefs-page">
      <h1 className="page-title">Настройки</h1>
      <p className="page-intro">Как звучат переходы, что играет после конца очереди и какая музыка хранится на устройстве.</p>
      <div className="settings-layout">
      <div className="prefs">
        <Group title="Переходы" footer={off ? 'AutoMix выключен: треки играют подряд без наложения.' : 'AutoMix ищет в следующем треке подходящую фразу и сводит песни в темп.'}>
          <Row title="AutoMix" desc="Плавные музыкальные переходы между треками.">
            <Switch checked={a.enabled} onChange={(v) => set({ enabled: v })} label="AutoMix" />
          </Row>
          <Row title="Сводить по кнопке «Следующий»" desc="Первое нажатие — короткий переход, второе переключает сразу.">
            <Switch checked={a.mixOnNext ?? true} disabled={off} onChange={(v) => set({ mixOnNext: v })} label="Сводить по кнопке «Следующий»" />
          </Row>
          <Row wide title="Характер переходов" desc="В режиме «Авто» способ и длина зависят от музыки.">
            <select className="select" aria-label="Характер переходов" value={a.style} onChange={(e) => set({ style: e.target.value as typeof a.style })} disabled={off}>
              <option value="auto">Авто · рекомендуется</option>
              <option value="smooth">Длинные и плавные</option>
              <option value="tight">Короткие, по фразе</option>
            </select>
          </Row>
          <Row wide title="Начало следующего трека" desc="«Умный вход» может пропустить часть вступления ради лучшего перехода.">
            <select className="select" aria-label="Начало следующего трека" value={a.entryMode ?? 'smart'} disabled={off} onChange={(e) => set({ entryMode: e.target.value as 'smart' | 'preserve' })}>
              <option value="smart">Умный вход</option>
              <option value="preserve">Сохранять начало</option>
            </select>
          </Row>
        </Group>

        <Group title="Воспроизведение">
          <Row title="Продолжать радио после конца очереди" desc="Когда альбом или плейлист доиграл, дальше без паузы звучит похожая музыка по мотивам последних дослушанных треков. Без сети — «Моя волна» из медиатеки. Не включается при повторе.">
            <Switch checked={s.wave.continueRadio !== false} onChange={(v) => void save({ wave: { ...s.wave, continueRadio: v } })} label="Продолжать радио после конца очереди" />
          </Row>
          <Row title="Альбомы без наложения" desc="Соседние треки одного альбома играют подряд, как задумал автор.">
            <Switch checked={a.respectAlbums} disabled={off} onChange={(v) => set({ respectAlbums: v })} label="Альбомы без наложения" />
          </Row>
          <Row wide title="Выравнивание громкости" desc="Треки звучат одинаково громко, без перегрузки.">
            <select
              className="select"
              aria-label="Выравнивание громкости"
              value={a.loudnessTarget === null ? 'off' : String(a.loudnessTarget)}
              onChange={(e) => set({ loudnessTarget: e.target.value === 'off' ? null : Number(e.target.value) })}
            >
              <option value="off">Выключено</option>
              <option value="-14">Громче (−14 LUFS)</option>
              <option value="-16">Обычно (−16 LUFS) · рекомендуется</option>
              <option value="-18">Тише, больше запаса (−18 LUFS)</option>
            </select>
          </Row>
        </Group>

        <Group title="Офлайн" footer={<>Загрузка идёт через любое подключение, в том числе мобильное: встроенный браузер iPhone не сообщает приложению тип сети. Скачанное — в разделе <a href="#/downloads">Загрузки</a>.</>}>
          <Row title="Скачивать лайкнутые треки" desc="Треки из YouTube, SoundCloud и Яндекс Музыки с отметкой «Нравится» сохраняются на устройство. Снятие отметки скачанное не удаляет.">
            <Switch checked={!!s.downloads?.autoLiked} onChange={(v) => void save({ downloads: { autoLiked: v } })} label="Скачивать лайкнутые треки" />
          </Row>
        </Group>

        <Group title="DJ-приёмы" footer={off ? 'Включите AutoMix, чтобы использовать DJ-приёмы.' : undefined}>
          <Row title="Обмен басом" desc="Бас двух треков не звучит одновременно, середина приглушается при конфликте мелодий.">
            <Switch checked={a.eqHandoff} disabled={off} onChange={(v) => set({ eqHandoff: v })} label="Обмен басом и EQ" />
          </Row>
          {vocalModel && <Row title="Передача вокала" desc="Вокал меняется отдельно от инструментала. Партии готовятся заранее на этом компьютере.">
            <Switch checked={a.stemMixing ?? true} disabled={off} onChange={(v) => set({ stemMixing: v })} label="DJ-передача вокала" />
          </Row>}
          <Row title="DJ-подводки" desc="Фильтр, передача баса на сильной доле и короткое эхо — только там, где не режут вокальную фразу.">
            <Switch checked={a.djPhrasing ?? true} disabled={off || !a.eqHandoff || a.stemMixing === false} onChange={(v) => set({ djPhrasing: v })} label="DJ-подводки" />
          </Row>
          <Row title="Стабильный темп вокала" desc="При небольшой разнице темпа подстраивается следующий трек, а не текущий голос.">
            <Switch checked={a.masterTempo ?? true} disabled={off || a.stemMixing === false} onChange={(v) => set({ masterTempo: v })} label="Стабильный темп вокала" />
          </Row>
          <Row title="Инструментальные петли" desc="Затухающий финал поддерживается повтором подходящего такта без вокала.">
            <Switch checked={a.loopBridges ?? true} disabled={off || !a.eqHandoff || a.stemMixing === false} onChange={(v) => set({ loopBridges: v })} label="Инструментальные петли" />
          </Row>
          {vocalModel && (a.stemMixing ?? true) && <VocalPreparation stems={health?.stems} offline={healthOffline} loading={!health} onChange={() => void api.health().then(setHealth, () => {})} />}
        </Group>

        <Group title="Оформление">
          <Row wide title="Анимации" desc="По умолчанию — как в настройках системы.">
            <select className="select" aria-label="Анимации" value={s.ui.motion ?? 'system'} onChange={(e) => void save({ ui: { ...s.ui, motion: e.target.value as 'system' | 'full' | 'reduced' } })}>
              <option value="system">Как в системе</option><option value="full">Полные анимации</option><option value="reduced">Минимум движения</option>
            </select>
          </Row>
          <Row wide title="Графика волны" desc="Совместимый режим помогает на старых видеокартах.">
            <select className="select" aria-label="Графика волны" value={s.ui.graphics ?? 'auto'} onChange={(e) => void save({ ui: { ...s.ui, graphics: e.target.value as 'auto' | 'canvas' } })}>
              <option value="auto">Автоматически</option><option value="canvas">Совместимый режим</option>
            </select>
          </Row>
        </Group>

        <Group title="Медиатека">
          <Row title="Проверить файлы" desc="Найти треки, файлы которых перемещены или удалены.">
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const r = await api.verify();
                await useApp.getState().loadLibrary();
                toast(r.missing ? `Не найдено файлов: ${r.missing}` : 'Все файлы на месте', r.missing ? 'error' : 'success');
              }}
            >
              Проверить
            </button>
          </Row>
        </Group>
        <PlaylistBackup />

        {desktop && <DesktopSettings />}

        <details className="pref-more">
          <summary>
            <span className="pref-title">Дополнительно</span>
            <span className="pref-desc">Тонкая настройка переходов, кэш и служебные сведения</span>
          </summary>
          <Group title="Тонкая настройка переходов" footer="Это пределы: точные точки и длину AutoMix выбирает по анализу музыки.">
            {(a.entryMode ?? 'smart') === 'smart' && <Row wide title="Пропуск вступления" desc="Насколько глубоко можно войти в следующий трек.">
              <Slider label="Максимальный пропуск вступления" value={a.maxEntrySkipSeconds ?? 45} min={0} max={75} step={1} disabled={off} onChange={(v) => set({ maxEntrySkipSeconds: v })} format={(v) => `${v} с`} />
            </Row>}
            <Row wide title="Изменение темпа" desc="Предел для каждого трека, высота тона сохраняется.">
              <Slider label="Максимальное изменение темпа трека" value={a.maxStretchPercent} min={0} max={16} step={0.5} disabled={off} onChange={(v) => set({ maxStretchPercent: v })} format={(v) => `${v.toFixed(1)} %`} />
            </Row>
            <Row wide title="Длина перехода" desc="Сколько максимум звучат два трека вместе.">
              <Slider label="Максимальная длина перехода" value={a.maxBlendSeconds} min={8} max={48} step={1} disabled={off} onChange={(v) => set({ maxBlendSeconds: v })} format={(v) => `${v} с`} />
            </Row>
            <Row wide title="Резервный кроссфейд" desc="Пока анализ трека не готов.">
              <Slider label="Резервный кроссфейд" value={a.fallbackSeconds} min={1} max={12} step={1} disabled={off} onChange={(v) => set({ fallbackSeconds: v })} format={(v) => `${v} с`} />
            </Row>
          </Group>
          {health && <Group title="Служебные сведения">
            <Row title="Декодер" desc={health.ffmpeg ?? 'ffmpeg не найден: установите его или укажите FFMPEG_PATH в .env'}>
              <span className={`tag ${health.ffmpeg ? 'ok' : 'warn'}`}>{health.ffmpeg ? 'Готов' : 'Нет'}</span>
            </Row>
            <Row title="Анализ звука" desc={`Анализатор ${health.analyzer}, планировщик ${health.planner}, потоков ${health.analysis.workers}.`}>
              <span className="small tnum muted">в работе {health.analysis.running} · в очереди {health.analysis.queued}</span>
            </Row>
            <Row title="Кэш звука" desc={`${mb(health.pcmCacheBytes)} из ${mb(health.pcmCacheLimit)}${health.pcmCacheProtectedBytes ? `, сейчас используется ${mb(health.pcmCacheProtectedBytes)}` : ''}. Старое удаляется само; текущий и следующий трек сохраняются.`}>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)}>Очистить</button>
            </Row>
          </Group>}
          {!mobileApp && <Group title="Клавиши">
            <dl className="pref-keys">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt><kbd>{k}</kbd></dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Group>}
        </details>
      </div>
      <aside className="settings-context">
        {player.transition?.plan || player.nextPlan ? <TransitionSummary plan={(player.transition?.plan ?? player.nextPlan)!} active={player.transition?.active} details /> : <div className="mix-explainer"><Waveform size={26} aria-hidden="true" /><h2>Переход начинается с музыки</h2><p>AutoMix ищет подходящий участок следующего трека и может начать с него, пропустив часть вступления.</p><p>Включите несколько треков — здесь появятся реальные точки входа и выхода.</p></div>}
        <a className="context-link" href="#/diagnostics"><ChartLine size={17} aria-hidden="true" /> Посмотреть, как сводятся треки</a>
      </aside>
      </div>
      {confirm && (
        <ConfirmModal
          title="Очистить кэш звука?"
          text="Декодированный звук и сохранённые планы переходов будут удалены и созданы заново при воспроизведении. Медиатека, анализ и история не затрагиваются."
          confirm="Очистить"
          onConfirm={async () => {
            await api.clearCache();
            setHealth(await api.health());
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

export function MorePage() {
  const items = [
    { href: '#/wave', label: 'Моя волна', hint: 'Бесконечный поток под ваше настроение', Icon: Waveform },
    { href: '#/history', label: 'История', hint: 'Что звучало и как сменялись треки', Icon: ClockCounterClockwise },
    { href: '#/sources', label: 'Источники музыки', hint: 'Файлы, серверы и Яндекс Музыка', Icon: Plugs },
    { href: '#/diagnostics', label: 'Диагностика AutoMix', hint: 'Всё ли в порядке со звуком и переходами', Icon: ChartLine },
    { href: '#/settings', label: 'Настройки', hint: 'Переходы, громкость и офлайн', Icon: GearSix },
  ];
  const playlists = useApp((s) => s.playlists);
  return (
    <div className="main-inner">
      <h1 className="page-title">Ещё</h1>
      <div className="more-grid">
        {items.map(({ href, label, hint, Icon }) => (
          <a key={href} href={href} className="more-tile">
            <span className="more-icon" aria-hidden="true"><Icon size={22} weight="duotone" /></span>
            <span className="more-label">{label}</span>
            <span className="more-hint">{hint}</span>
          </a>
        ))}
      </div>
      {playlists.length > 0 && (
        <section className="section">
          <h2 className="section-title">Плейлисты</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {playlists.map((p) => (
              <a key={p.id} href={`#/playlist/${p.id}`} className="side-item" style={{ padding: 12, color: 'var(--text)' }}>
                {p.name} <span className="meta" style={{ marginLeft: 'auto' }}>{p.count}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
