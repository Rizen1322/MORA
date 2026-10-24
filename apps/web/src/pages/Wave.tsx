import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Play, Pause, Waveform, SkipForward, HeartBreak, Heart, ArrowUpRight, SlidersHorizontal, MusicNotes, Sparkle, Lightning } from '@phosphor-icons/react';
import { controller, trackOf, useApp } from '../store/app.ts';
import { Cover, Swap } from '../components/common.tsx';
import { WaveSculpture } from '../components/WaveSculpture.tsx';
import { YandexWaveTuning } from '../components/YandexWaveTuning.tsx';
import { RadioTuning } from '../components/RadioTuning.tsx';
import { startRadio, useRadio } from '../lib/radio.ts';
import { react } from '../components/TrackList.tsx';
import { methodShort } from '../lib/format.ts';
import './Wave.css';

const MOODS = [
  { id: 'calm', label: 'Спокойнее', caption: 'Выдохнуть и замедлиться' },
  { id: 'normal', label: 'В моём ритме', caption: 'Знакомый ритм вашего дня' },
  { id: 'energetic', label: 'Бодрее', caption: 'Добавить движения' },
] as const;
const DIVERSITY = [
  { id: 'familiar', label: 'Любимое' },
  { id: 'balanced', label: 'Вперемешку' },
  { id: 'discover', label: 'Открытия' },
] as const;

function trackCount(n: number) {
  const mod = n % 100;
  const word = mod >= 11 && mod <= 14 ? 'треков' : n % 10 === 1 ? 'трек' : n % 10 >= 2 && n % 10 <= 4 ? 'трека' : 'треков';
  return `${n} ${word}`;
}

export function WavePage() {
  const radio = useRadio();
  const p = useApp(useShallow((s) => ({
    context: s.player.context, error: s.player.error, index: s.player.index, nextPlan: s.player.nextPlan, queue: s.player.queue,
    status: s.player.status, waveLoading: s.player.waveLoading, waveRefillError: s.player.waveRefillError,
  })));
  const settings = useApp((s) => s.settings);
  const save = useApp((s) => s.saveSettings);
  const providers = useApp((s) => s.providers);
  const count = useApp((s) => s.order.length);
  const tracks = useApp((s) => s.tracks);
  const [source, setSource] = useState<'own' | 'yandex' | 'online'>(radio.active || p.context?.type === 'online-radio' ? 'online' : p.context?.type === 'yandex-wave' ? 'yandex' : 'own');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (radio.active) setSource('online');
    else if (p.context?.type === 'wave' || p.context?.type === 'yandex-wave') setSource(p.context.type === 'yandex-wave' ? 'yandex' : 'own');
  }, [p.context?.type, radio.active]);
  const yandexConnected = providers.some((x) => x.id === 'yandex' && x.status === 'connected');
  const waveOn = radio.active || p.context?.type === 'wave' || p.context?.type === 'yandex-wave';
  const activeSource = radio.active ? 'online' : p.context?.type === 'yandex-wave' ? 'yandex' : 'own';
  const selectedActive = waveOn && activeSource === source;
  const playing = selectedActive && (p.status === 'playing' || p.status === 'buffering');
  const cur = waveOn ? trackOf(p.queue[p.index]?.trackId) : undefined;
  const upcoming = waveOn ? p.queue.slice(p.index + 1, p.index + 6) : [];
  const upcomingCount = waveOn ? Math.max(0, p.queue.length - p.index - 1) : 0;
  const likes = [...tracks.values()].filter((t) => t.reaction > 0).length;
  const mood = settings?.wave.mood ?? 'normal';
  const diversity = settings?.wave.diversity ?? 'balanced';
  const mode = settings?.wave.mode ?? 'normal';
  const moodIndex = Math.max(0, MOODS.findIndex((m) => m.id === mood));
  const unavailable = source === 'own' ? !count : source === 'yandex' ? !yandexConnected : false;
  const update = async (patch: Partial<NonNullable<typeof settings>['wave']>) => {
    setSaving(true);
    try { await save({ wave: { mood, diversity, mode, ...patch } }); }
    finally { setSaving(false); }
  };

  return (
    <div className="main-inner wave-studio">
      <header className="ws-header">
        <a href="#/library" className="ws-library">Медиатека <ArrowUpRight size={16} /></a>
      </header>
      <section className="ws-stage" aria-labelledby="wave-heading">
        <div className="ws-stage-copy">
          <h1 id="wave-heading">Моя<br /><span>волна</span><span className="ws-title-dot">.</span></h1>
          <p className="ws-intro">Музыка, которая чувствует<br />ваш ритм.</p>
          <div className="ws-source" role="group" aria-label="Источник музыки">
            <button aria-pressed={source === 'own'} onClick={() => setSource('own')}><MusicNotes size={16} /> Моя коллекция</button>
            <button aria-pressed={source === 'online'} onClick={() => setSource('online')}><Waveform size={16}/> Онлайн-радио</button>
            <button aria-pressed={source === 'yandex'} disabled={!yandexConnected} title={!yandexConnected ? 'Подключите Яндекс Музыку в настройках' : undefined} onClick={() => setSource('yandex')}>Яндекс Музыка <ArrowUpRight size={14} /></button>
          </div>
          <div className="ws-launch-row">
            <button className="ws-launch" disabled={!selectedActive && (p.waveLoading || radio.loading || unavailable)} onClick={() => selectedActive ? controller.toggle() : source === 'online' ? void startRadio() : void controller.startWave(source)}>
              {playing ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}
              {selectedActive ? playing ? 'Пауза' : 'Продолжить' : p.waveLoading || radio.loading ? 'Подбираю музыку…' : source === 'online' ? 'Включить радио' : 'Поймать волну'}
            </button>
            {selectedActive && <button className="ws-skip" aria-label="Другой трек" onClick={() => void controller.nextTrack()}><SkipForward size={22} weight="fill" /></button>}
          </div>
          {unavailable && !selectedActive && <p className="ws-help">{source === 'own' ? <>Добавьте музыку в <a href="#/library">медиатеку</a>, чтобы начать.</> : <>Подключите Яндекс Музыку в <a href="#/settings">настройках</a>.</>}</p>}
          {p.error && <p className="ws-error" role="alert">{p.error}</p>}
        </div>
        <div className="ws-art">
          <WaveSculpture energy={moodIndex / 2} />
        </div>
      </section>
      <section className="ws-tuning" aria-labelledby="wave-tuning">
        <div className="ws-section-heading"><h2 id="wave-tuning"><SlidersHorizontal size={19} /> Настроить звучание</h2><span aria-live="polite">{saving ? 'Сохраняю…' : 'Для следующих треков'}</span></div>
        {source === 'online' ? <RadioTuning /> : source === 'yandex' ? <YandexWaveTuning /> : <div className="ws-tuning-grid">
          <fieldset className="ws-control" disabled={!settings || saving}>
            <legend>01 <span>Энергия</span></legend>
            <div className="ws-segments ws-moods">{MOODS.map((m, i) => <button key={m.id} aria-pressed={mood === m.id} onClick={() => void update({ mood: m.id })}><span className={`ws-energy-bars bars-${i}`} aria-hidden="true"><i /><i /><i /></span>{m.label}</button>)}</div>
            <p>{MOODS[moodIndex].caption}</p>
          </fieldset>
          <fieldset className="ws-control" disabled={!settings || saving}>
            <legend>02 <span>Характер</span></legend>
            <div className="ws-segments">{DIVERSITY.map((d) => <button key={d.id} aria-pressed={diversity === d.id} onClick={() => void update({ diversity: d.id })}>{d.label}</button>)}</div>
            <p>{diversity === 'discover' ? 'Больше музыки, которую вы ещё не слышали' : diversity === 'familiar' ? 'Ближе к тому, что уже нравится' : 'Знакомые треки и новые находки'}</p>
          </fieldset>
          <fieldset className="ws-control ws-mix-control" disabled={!settings || saving}>
            <legend>03 <span>Подбор для сведения</span></legend>
            <button className="ws-mix-toggle" role="switch" aria-checked={mode === 'mix'} onClick={() => void update({ mode: mode === 'mix' ? 'normal' : 'mix' })}><span><Lightning size={19} weight={mode === 'mix' ? 'fill' : 'regular'} /> Для микса</span><span className="ws-toggle-track"><i /></span></button>
            <p>{mode === 'mix' ? 'Больше совместимых по ритму треков' : 'Подбор прежде всего по вашему вкусу'}</p>
          </fieldset>
        </div>}
      </section>
      <div className="ws-bottom-grid">
        <section className="ws-now" aria-labelledby="wave-now">
          <div className="ws-section-heading"><h2 id="wave-now">{cur ? 'Сейчас в эфире' : 'Ваша частота'}</h2><Waveform size={19} className="ws-muted" /></div>
          {cur ? <>
            <div className="ws-now-track">
              <Swap k={cur.id}><Cover url={cur.coverUrl} seed={cur.album || cur.id} size={88} /></Swap>
              <div className="ws-track-copy"><Swap k={cur.id}><h3>{cur.title}</h3><p>{cur.artist}</p></Swap><span className="ws-current-source">{activeSource === 'online' ? 'Онлайн-радио' : activeSource === 'yandex' ? 'Яндекс Музыка' : 'Моя коллекция'}</span></div>
              <div className="ws-reactions"><button className={`icon-btn ${cur.reaction > 0 ? 'liked' : ''}`} aria-pressed={cur.reaction > 0} aria-label="Нравится" onClick={() => void react(cur, cur.reaction > 0 ? 0 : 1)}><Heart size={23} weight={cur.reaction > 0 ? 'fill' : 'regular'} /></button><button className="icon-btn" aria-label="Не нравится, убрать из волны" onClick={() => void react(cur, -1)}><HeartBreak size={22} /></button></div>
            </div>
            {p.nextPlan && <div className="ws-transition"><span /> Следующий переход: {methodShort(p.nextPlan)}</div>}
          </> : <div className="ws-idle"><div className="ws-idle-mark"><Waveform size={32} /></div><h3>Всё начинается с вас</h3><p>Лайкайте то, что цепляет.<br />Волна подстроится под ваш вкус.</p><span>{likes > 0 ? `${trackCount(likes)} в любимом` : 'Первый лайк — начало знакомства'}</span></div>}
          <details className="ws-about"><summary>Как волна узнаёт мой вкус?</summary><p>Учитываем лайки, дослушивания и пропуски. «Не нравится» исключает трек из подборки. Ваша коллекция использует рекомендации приложения; источник «Яндекс Музыка» — рекомендации вашего аккаунта.</p></details>
        </section>
        <section className="ws-next" aria-labelledby="wave-next">
          <div className="ws-section-heading"><h2 id="wave-next">На подходе</h2><span aria-live="polite">{p.waveLoading ? 'Готовим продолжение…' : upcomingCount > 0 ? trackCount(upcomingCount) : 'Без конца и края'}</span></div>
          {p.waveRefillError && <p className="ws-help" role="status">{p.waveRefillError}</p>}
          {upcoming.length > 0 ? <div className="ws-queue">{upcoming.map((entry, index) => {
            const t = trackOf(entry.trackId);
            if (!t) return null;
            return <button key={entry.entryId} onClick={() => controller.jumpTo(p.index + 1 + index)} aria-label={`Слушать ${t.title}, ${t.artist}`}><span className="ws-queue-number">{String(index + 1).padStart(2, '0')}</span><Cover url={t.coverUrl} seed={t.album || t.id} size={44} /><span className="ws-queue-copy"><strong>{t.title}</strong><span>{t.artist}</span></span><Play size={17} weight="fill" className="ws-queue-play" /></button>;
          })}</div> : <div className="ws-queue-empty"><Sparkle size={27} weight="duotone" /><p>Оставьте выбор музыке</p><span>Запустите волну — здесь появятся<br />следующие треки вашей подборки.</span></div>}
          {upcomingCount > upcoming.length && <button className="btn btn-ghost" onClick={() => useApp.getState().setQueueOpen(true)}>Вся очередь <ArrowUpRight size={15} /></button>}
        </section>
      </div>
    </div>
  );
}
