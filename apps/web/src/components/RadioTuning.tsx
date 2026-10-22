import { Lightning } from '@phosphor-icons/react';
import { useApp } from '../store/app.ts';

export function RadioTuning() {
  const settings = useApp(s => s.settings), save = useApp(s => s.saveSettings);
  if (!settings) return <p className="caption muted">Загружаем настройки…</p>;
  const wave = settings.wave;
  const update = (patch: Partial<typeof wave>) => void save({ wave: { ...wave, ...patch } });
  return <div className="radio-tuning">
    <p className="caption muted">Лайки помогают выбирать исполнителей и основу радио. Дизлайки исключаются; новые реакции учитываются при пополнении.</p>
    <div className="ws-tuning-grid">
      <fieldset className="ws-control"><legend>Знакомое и новое</legend><div className="ws-segments">{[['familiar','Ближе к любимому'],['balanced','Вперемешку'],['discover','Открытия']].map(([id,label]) => <button key={id} aria-pressed={wave.diversity===id} onClick={() => update({ diversity:id as typeof wave.diversity })}>{label}</button>)}</div></fieldset>
      <fieldset className="ws-control"><legend>Энергия</legend><div className="ws-segments">{[['calm','Спокойнее'],['normal','В моём ритме'],['energetic','Бодрее']].map(([id,label]) => <button key={id} aria-pressed={wave.mood===id} onClick={() => update({ mood:id as typeof wave.mood })}>{label}</button>)}</div><p>Энергия учитывается у уже проанализированных записей.</p></fieldset>
      <fieldset className="ws-control"><legend>Для AutoMix</legend><button className="ws-mix-toggle" role="switch" aria-checked={wave.mode==='mix'} onClick={() => update({mode:wave.mode==='mix'?'normal':'mix'})}><span><Lightning size={18}/>Для микса</span><span className="ws-toggle-track"><i/></span></button><p>Близкие BPM и тональности получают приоритет, когда есть анализ. Новые треки анализируются при подготовке.</p></fieldset>
    </div>
  </div>;
}
