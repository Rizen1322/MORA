import { useState } from 'react';
import { TRANSITION_RATING_REASONS, type TransitionPlan, type TransitionRating, type TransitionRatingReason } from '@automix/core';
import { ArrowRight, ThumbsDown, ThumbsUp, Waveform } from '@phosphor-icons/react';
import { fmtTime, methodShort } from '../lib/format.ts';
import { controller, trackOf, useApp } from '../store/app.ts';

export interface RatingTarget { logId: number; rating: TransitionRating | null; reason: TransitionRatingReason | null; onRated?: (rating: TransitionRating | null, reason: TransitionRatingReason | null) => void }

/** The actual scheduled cue points, rather than a decorative waveform. */
export function TransitionSummary({ plan, active = false, completed = false, details = false, rate }: { plan: TransitionPlan; active?: boolean; completed?: boolean; details?: boolean; rate?: RatingTarget }) {
  const from = trackOf(plan.fromTrackId);
  const to = trackOf(plan.toTrackId);
  const beat = plan.beatAlign;
  const bridge = beat?.bridge;
  const requested = plan.debug.requested === true;
  const label=completed?'Выполненный переход':active?'Сейчас сводится':requested?'Переход по кнопке':'Следующий переход';
  return (
    <section className="transition-summary" aria-label={label}>
      <div className="transition-heading">
        <span className="transition-label"><Waveform size={16} aria-hidden="true" /> {label}</span>
        <span className="caption muted tnum">{plan.duration > 0 ? `${plan.duration.toFixed(1)} с` : 'Без наложения'}</span>
      </div>
      <div className="transition-method">{methodShort(plan)}</div>
      <div className="transition-source">{plan.vocalA || plan.vocalB || plan.voiceEcho ? 'План с отдельными вокальными партиями' : 'План по исходному звуку треков'}</div>
      <div className="transition-cues">
        <div className="transition-cue">
          <span className="caption muted">Выход из трека</span>
          <strong className="tnum">{fmtTime(plan.aExit)}</strong>
          <span className="small ellipsis" title={from?.title}>{from?.title ?? 'Текущий трек'}</span>
        </div>
        <ArrowRight className="transition-arrow" size={20} aria-hidden="true" />
        <div className="transition-cue incoming">
          <span className="caption muted">{plan.entrySelection?.kind === 'section' ? 'Вход по структуре' : plan.entrySelection?.kind === 'intro-trim' ? 'Вход после вступления' : 'Вход в следующий'}</span>
          <strong className="tnum">{fmtTime(plan.bEntry)}</strong>
          <span className="small ellipsis" title={to?.title}>{to?.title ?? 'Следующий трек'}</span>
        </div>
      </div>
      {beat && (bridge ? (
        <div className="transition-bridge">
          <div className="transition-tempo tnum">
            <span>{beat.bpmA.toFixed(0)} / {beat.bpmB.toFixed(0)} BPM</span>
            <ArrowRight size={14} aria-hidden="true" />
            <strong>{bridge.commonBpm.toFixed(0)} BPM</strong>
            <span className="muted">общий темп</span>
          </div>
        </div>
      ) : (
        <div className="transition-tempo tnum">{beat.bpmA.toFixed(0)} <ArrowRight size={12} aria-hidden="true" /> {beat.bpmB.toFixed(0)} BPM <span className="muted">· {beat.relation !== 1 ? 'с учётом половинного / двойного темпа' : beat.glide ? 'плавная смена темпа' : 'совмещение битов'}</span></div>
      ))}
      {completed && rate && <RateTransition key={rate.logId} {...rate} />}
      {requested && active && <p className="transition-hint">Нажмите «Следующий» ещё раз, чтобы переключить сразу.</p>}
      {details && (
        <details className="transition-details">
          <summary>Почему выбран этот переход</summary>
          <ul className="notes">{plan.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
          {plan.fallbackReason && <p className="transition-hint">{plan.fallbackReason}</p>}
        </details>
      )}
    </section>
  );
}

/** Listener verdict for an executed transition; a second press on the active choice clears it. */
function RateTransition({ logId, rating, reason, onRated }: RatingTarget) {
  const [value, setValue] = useState({ rating, reason });
  const [busy, setBusy] = useState(false);
  const save = async (next: TransitionRating | null, why: TransitionRatingReason | null = null) => {
    if (busy) return;
    setBusy(true);
    try {
      await controller.rateTransition(logId, next, why);
      setValue({ rating: next, reason: next === 'bad' ? why : null });
      onRated?.(next, next === 'bad' ? why : null);
    } catch (e) {
      useApp.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-label="Оценка перехода" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span className="caption muted">Как прозвучало?</span>
      <button className="chip" aria-pressed={value.rating === 'good'} aria-label="Хорошо" title="Хорошо" disabled={busy} onClick={() => void save(value.rating === 'good' ? null : 'good')}>
        <ThumbsUp size={16} weight={value.rating === 'good' ? 'fill' : 'regular'} aria-hidden="true" />
      </button>
      <button className="chip" aria-pressed={value.rating === 'bad'} aria-label="Плохо" title="Плохо" disabled={busy} onClick={() => void save(value.rating === 'bad' ? null : 'bad')}>
        <ThumbsDown size={16} weight={value.rating === 'bad' ? 'fill' : 'regular'} aria-hidden="true" />
      </button>
      {value.rating === 'bad' && TRANSITION_RATING_REASONS.map((r) => (
        <button key={r} className="chip" aria-pressed={value.reason === r} disabled={busy} onClick={() => void save('bad', value.reason === r ? null : r)}>{r}</button>
      ))}
    </div>
  );
}
