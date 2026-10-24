import { useEffect, useMemo, useState } from 'react';
import { FloppyDisk, Trash, X } from '@phosphor-icons/react';
import { BUILTIN_PRESETS, EQ_BANDS, EQ_MAX_DB, FLAT_TONE, eqPeakDb, type ToneSettings } from '@automix/core';
import { controller, useApp } from '../store/app.ts';
import { PromptModal, Switch } from './common.tsx';

const bandLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));
const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}`;

/**
 * "Звук": 10-band EQ, presets, pre-gain with measured headroom, balance, mono,
 * loudness normalisation and the output device. Applies to the final mix, before
 * the limiter; transition EQ and track analysis are untouched.
 */
export function SoundPanel() {
  const settings = useApp((s) => s.settings);
  const setTone = useApp((s) => s.setTone);
  const setPlayback = useApp((s) => s.setPlayback);
  const save = useApp((s) => s.saveSettings);
  const setPanel = useApp((s) => s.setPanel);
  const sampleRate = useApp((s) => s.player.sampleRate) || 48000;
  const [naming, setNaming] = useState(false);
  if (!settings) return null;
  const tone = settings.sound.tone;
  const presets = settings.sound.presets;
  const update = (patch: Partial<ToneSettings>) => setTone({ ...tone, ...patch });
  const setBand = (i: number, v: number) => update({ enabled: true, gains: tone.gains.map((g, j) => (j === i ? Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Math.round(v * 2) / 2)) : g)) });
  const peak = eqPeakDb(tone.gains, sampleRate);
  const all = [...BUILTIN_PRESETS, ...presets];
  const current = all.find((p) => p.gains.every((g, i) => Math.abs(g - tone.gains[i]) < 0.05))?.name ?? '';

  return (
    <aside className="queue-panel sound-panel" aria-label="Звук">
      <div className="queue-head">
        <div><h2 className="section-title">Звук</h2><p className="caption dim queue-subtitle">Работает поверх переходов AutoMix</p></div>
        <button className="icon-btn" aria-label="Закрыть" onClick={() => setPanel(null)}><X size={20} /></button>
      </div>
      <div className="queue-scroll sound-scroll">
        <div className="sound-field">
          <div className="sound-row"><span>Скорость</span><span className="tnum small">{settings.sound.playback.speed.toFixed(2).replace('.', ',')}×</span></div>
          <input className="range" type="range" min={.8} max={1.2} step={.01} value={settings.sound.playback.speed} aria-label="Скорость воспроизведения" onChange={(e) => setPlayback({ ...settings.sound.playback, speed: Number(e.target.value) })} onDoubleClick={() => setPlayback({ ...settings.sound.playback, speed: 1 })} />
          <div className="sound-row"><span>Высота тона</span><span className="tnum small">{settings.sound.playback.semitones > 0 ? '+' : ''}{settings.sound.playback.semitones} пт</span></div>
          <input className="range" type="range" min={-6} max={6} step={.5} value={settings.sound.playback.semitones} aria-label="Высота тона" onChange={(e) => setPlayback({ ...settings.sound.playback, semitones: Number(e.target.value) })} onDoubleClick={() => setPlayback({ ...settings.sound.playback, semitones: 0 })} />
          <div className="sound-row"><span className="caption muted">Независимые настройки · вместе с AutoMix</span><button className="btn btn-ghost btn-sm" onClick={() => setPlayback({ speed: 1, semitones: 0 })}>Сбросить</button></div>
        </div>
        <div className="sound-row"><span>Эквалайзер</span><Switch checked={tone.enabled} onChange={(v) => update({ enabled: v })} label="Эквалайзер" /></div>
        <div className="sound-presets">
          <select className="select" aria-label="Пресет" value={current} onChange={(e) => { const p = all.find((x) => x.name === e.target.value); if (p) update({ enabled: true, gains: [...p.gains] }); }}>
            {!current && <option value="">Свой вариант</option>}
            {all.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button className="icon-btn" aria-label="Сохранить как пресет" title="Сохранить как пресет" onClick={() => setNaming(true)}><FloppyDisk size={18} /></button>
          {presets.some((p) => p.name === current) && <button className="icon-btn" aria-label="Удалить пресет" title="Удалить пресет" onClick={() => void save({ sound: { ...settings.sound, presets: presets.filter((p) => p.name !== current) } })}><Trash size={18} /></button>}
        </div>
        <div className={`eq ${tone.enabled ? '' : 'off'}`} role="group" aria-label="Полосы эквалайзера">
          {EQ_BANDS.map((f, i) => {
            const usable = f < 0.45 * sampleRate;
            return <div className="eq-band" key={f}>
              <input className="eq-value tnum" aria-label={`${bandLabel(f)} Гц, дБ`} type="number" min={-EQ_MAX_DB} max={EQ_MAX_DB} step={0.5} value={tone.gains[i]} disabled={!usable}
                onChange={(e) => setBand(i, Number(e.target.value))} />
              <input className="eq-slider" type="range" min={-EQ_MAX_DB} max={EQ_MAX_DB} step={0.5} value={tone.gains[i]} disabled={!usable}
                aria-label={`${bandLabel(f)} Гц`} aria-valuetext={`${fmtDb(tone.gains[i])} дБ`} title="Двойной щелчок — сбросить"
                onChange={(e) => setBand(i, Number(e.target.value))} onDoubleClick={() => setBand(i, 0)} />
              <span className="eq-freq">{bandLabel(f)}</span>
            </div>;
          })}
        </div>
        <div className="sound-row"><button className="btn btn-ghost btn-sm" onClick={() => update({ gains: [...FLAT_TONE.gains] })}>Сбросить в ровный</button></div>
        <div className="sound-field">
          <div className="sound-row"><span>Предусиление</span><span className="tnum small">{fmtDb(tone.preampDb)} дБ</span></div>
          <input className="range" type="range" min={-12} max={6} step={0.5} value={tone.preampDb} aria-label="Предусиление" onChange={(e) => update({ preampDb: Number(e.target.value) })} onDoubleClick={() => update({ preampDb: 0 })} />
        </div>
        <div className="sound-row"><span>Автоматический запас<br /><span className="caption muted">{tone.autoHeadroom && peak > 0.05 ? `снижает на ${peak.toFixed(1).replace('.', ',')} дБ — по измеренной кривой` : 'перед финальным ограничителем'}</span></span>
          <Switch checked={tone.autoHeadroom} onChange={(v) => update({ autoHeadroom: v })} label="Автоматический запас" /></div>
        <div className="sound-field">
          <div className="sound-row"><span>Баланс</span><span className="small tnum">{tone.balance === 0 ? 'центр' : tone.balance < 0 ? `левее ${Math.round(-tone.balance * 100)}%` : `правее ${Math.round(tone.balance * 100)}%`}</span></div>
          <input className="range" type="range" min={-1} max={1} step={0.05} value={tone.balance} aria-label="Баланс" onChange={(e) => update({ enabled: true, balance: Number(e.target.value) })} onDoubleClick={() => update({ balance: 0 })} />
        </div>
        <div className="sound-row"><span>Моно</span><Switch checked={tone.mono} onChange={(v) => update({ enabled: true, mono: v })} label="Моно" /></div>
        <div className="sound-field">
          <div className="sound-row"><span>Пространство</span><span className="small tnum">{Math.round((tone.reverbMix ?? 0) * 100)} %</span></div>
          <input className="range" type="range" min={0} max={.35} step={.01} value={tone.reverbMix ?? 0} aria-label="Реверберация" onChange={(e) => update({ enabled: true, reverbMix: Number(e.target.value) })} onDoubleClick={() => update({ reverbMix: 0 })} />
          <p className="caption muted">Небольшая стереокомната. На нуле исходный звук; ограничитель пиков остаётся последним в цепи.</p>
        </div>
        <div className="sound-row"><span>Выравнивание громкости</span>
          <select className="select" aria-label="Выравнивание громкости" value={settings.automix.loudnessTarget === null ? 'off' : String(settings.automix.loudnessTarget)}
            onChange={(e) => void save({ automix: { ...settings.automix, loudnessTarget: e.target.value === 'off' ? null : Number(e.target.value) } })}>
            <option value="off">Выключено</option><option value="-14">−14 LUFS</option><option value="-16">−16 LUFS</option><option value="-18">−18 LUFS</option>
          </select></div>
        <OutputDevice />
        <p className="caption muted">Обработка не восстанавливает потерянные частоты и не улучшает исходное качество записи. После неё всегда стоит ограничитель пиков.</p>
      </div>
      {naming && <PromptModal title="Новый пресет" label="Название" confirm="Сохранить" onClose={() => setNaming(false)}
        onSubmit={async (name) => { await save({ sound: { ...settings.sound, presets: [...presets.filter((p) => p.name !== name), { name, gains: [...tone.gains] }] } }); }} />}
    </aside>
  );
}

/** Output device via AudioContext.setSinkId where the platform offers it; otherwise the system default. */
function OutputDevice() {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [current, setCurrent] = useState(controller.outputDevice);
  const supported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype && !!navigator.mediaDevices?.enumerateDevices;
  useEffect(() => {
    if (!supported) return;
    const load = () => void navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audiooutput')));
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, [supported]);
  const named = useMemo(() => (devices ?? []).filter((d) => d.deviceId && d.deviceId !== 'default' && d.label), [devices]);
  if (!supported) return <div className="sound-row"><span>Устройство вывода</span><span className="small muted">как в Windows</span></div>;
  return <div className="sound-row"><span>Устройство вывода</span>
    {named.length ? <select className="select" aria-label="Устройство вывода" value={current} onChange={async (e) => { await controller.setOutputDevice(e.target.value); setCurrent(controller.outputDevice); }}>
      <option value="">Как в Windows</option>
      {named.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
    </select> : <span className="small muted">как в Windows</span>}
  </div>;
}
