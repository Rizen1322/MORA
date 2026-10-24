import { memo, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Info, Play, WarningCircle } from '@phosphor-icons/react';
import { keyNameRu, type TrackAnalysis, type TransitionPlan } from '@automix/core';
import { api, type HealthStatus, type TransitionLogItem } from '../lib/api.ts';
import { fmtDate, fmtTime, plural } from '../lib/format.ts';
import { diagnosticBeatGrid } from '../lib/diagnostics.ts';
import { useRoute } from '../lib/router.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { TransitionSummary, type RatingTarget } from '../components/TransitionSummary.tsx';
import '../styles/prefs.css';
import { PlaybackDiagnostics } from '../components/PlaybackDiagnostics.tsx';

const PRE = 8;
const POST = 8;
const W = 1000;

/** Exact integral of the piecewise-linear speed map used by both decks. */
function trackTime(cue: number, points: [number, number][] | undefined, t: number): number {
  if (t <= 0 || !points?.length) return cue + t;
  let position = cue;
  let previousTime = 0;
  let previousRate = points[0][1];
  for (const [time, rate] of points) {
    if (time <= previousTime) { previousRate = rate; continue; }
    const end = Math.min(time, t);
    const endRate = previousRate + (rate - previousRate) * (end - previousTime) / (time - previousTime);
    position += (previousRate + endRate) * 0.5 * (end - previousTime);
    if (t <= time) return position;
    previousTime = time;
    previousRate = rate;
  }
  return position + (t - previousTime) * previousRate;
}

function pointVal(p: [number, number][] | undefined, t: number): number | null {
  if (!p?.length) return null;
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (t <= p[i][0]) return p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * (t - p[i - 1][0])) / Math.max(1e-9, p[i][0] - p[i - 1][0]);
  return p[p.length - 1][1];
}

function laneVal(plan: TransitionPlan, deck: 'A' | 'B', lane: string, t: number): number | null {
  return pointVal(plan.automation.find((x) => x.deck === deck && x.lane === lane)?.points, t);
}

const TransitionSvg = memo(function TransitionSvg({ plan, a, b }: { plan: TransitionPlan; a: TrackAnalysis | null; b: TrackAnalysis | null }) {
  // With an intentional pause the incoming deck starts only after A's fade
  // and the whole gap. In a normal overlap it starts at output time zero.
  const bOffset = plan.gap > 0 ? plan.duration + plan.gap : 0;
  const tMin = -PRE;
  const tMax = plan.duration + plan.gap + POST;
  const x = (t: number) => ((t - tMin) / (tMax - tMin)) * W;
  const rowH = 120;
  const H = rowH * 2 + 70;
  const yA = 30;
  const yB = 30 + rowH + 20;
  const N = 500;
  const ts = Array.from({ length: N + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / N);
  const peaksAt = (an: TrackAnalysis, sec: number) => {
    if (sec < 0 || sec > an.duration) return 0;
    const i = Math.round(sec * an.curves.rate);
    return an.peaks[i] ?? 0;
  };
  const area = (an: TrackAnalysis, map: (t: number) => number | null, y0: number) => {
    let d = '';
    for (const t of ts) {
      const s = map(t);
      const v = s === null ? 0 : peaksAt(an, s);
      d += `${d ? 'L' : 'M'}${x(t).toFixed(1)},${(y0 + rowH / 2 - (v * rowH) / 2).toFixed(1)}`;
    }
    for (let i = ts.length - 1; i >= 0; i--) {
      const s = map(ts[i]);
      const v = s === null ? 0 : peaksAt(an, s);
      d += `L${x(ts[i]).toFixed(1)},${(y0 + rowH / 2 + (v * rowH) / 2).toFixed(1)}`;
    }
    return d + 'Z';
  };
  const curve = (deck: 'A' | 'B', lane: string, y0: number, from: number) => {
    let d = '';
    for (const t of ts) {
      if (t < from) continue;
      const v = laneVal(plan, deck, lane, Math.max(0, t));
      if (v === null) return '';
      d += `${d ? 'L' : 'M'}${x(t).toFixed(1)},${(y0 + rowH - v * rowH).toFixed(1)}`;
    }
    return d;
  };
  const mapA = (t: number) => {
    const position = trackTime(plan.aExit, plan.tempoA, t), loop = plan.loopA;
    if (!loop || position < loop.start) return position;
    if (position >= loop.until) return null;
    return loop.start + (position - loop.start) % (loop.end - loop.start);
  };
  const mapB = (t: number) => (t < bOffset ? null : trackTime(plan.bEntry, plan.tempoB, t - bOffset));
  const vocalCurve = (deck: 'A' | 'B', y0: number) => ts.filter((t) => t >= (deck === 'A' ? 0 : bOffset)).map((t, i) => {
    const value = pointVal(deck === 'A' ? plan.vocalA : plan.vocalB, t - (deck === 'B' ? bOffset : 0));
    return value === null ? '' : `${i ? 'L' : 'M'}${x(t).toFixed(1)},${(y0 + rowH - Math.max(0, Math.min(1, value)) * rowH).toFixed(1)}`;
  }).join('');
  const vocalActivity = (an: TrackAnalysis | null, map: (t: number) => number | null, y0: number) => {
    const activity = an?.vocalActivity;
    if (!activity) return '';
    let d = '';
    for (const t of ts) {
      const position = map(t);
      if (position === null || position < 0 || position > an.duration) continue;
      const value = activity.values[Math.round(position * activity.rate)] ?? 0;
      d += `${d ? 'L' : 'M'}${x(t).toFixed(1)},${(y0 + rowH - Math.max(0, Math.min(1, value)) * rowH).toFixed(1)}`;
    }
    return d;
  };
  // Invert each deck's speed map so the waveform and beat markers agree.
  const outputTime = (sec: number, deck: 'A' | 'B') => {
    let lo = deck === 'A' ? tMin : 0;
    let hi = tMax - (deck === 'B' ? bOffset : 0);
    const timeAt = (time: number) => deck === 'A' ? trackTime(plan.aExit, plan.tempoA, time) : trackTime(plan.bEntry, plan.tempoB, time);
    if (sec < timeAt(lo)) return -Infinity;
    if (sec > timeAt(hi)) return Infinity;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (timeAt(mid) < sec) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2 + (deck === 'B' ? bOffset : 0);
  };
  const markers = (an: TrackAnalysis | null, deck: 'A' | 'B', y0: number) => {
    if (!an) return null;
    const grid = diagnosticBeatGrid(an, plan, deck);
    if (!grid) return null;
    const toT = (s: number) => deck === 'B' && s < plan.bEntry ? null : outputTime(s, deck);
    const phr = new Set(grid.phrases.map((p) => Math.round(p * 1000)));
    const out: React.ReactNode[] = [];
    const positions = (s: number) => {
      const loop = deck === 'A' ? plan.loopA : undefined;
      if (!loop || s < loop.start) return [s];
      if (s >= loop.end) return [];
      return [0, 1, 2, 3].map(i => s + i * (loop.end - loop.start)).filter(p => p < loop.until);
    };
    for (const original of grid.downbeats) for (const s of positions(original)) {
      const t = toT(s);
      if (t === null || t < tMin || t > tMax) continue;
      const isP = phr.has(Math.round(original * 1000));
      out.push(<line key={`d${deck}${s}`} x1={x(t)} x2={x(t)} y1={y0} y2={y0 + rowH} stroke={isP ? '#c9a7ff' : 'rgba(255,255,255,0.28)'} strokeWidth={isP ? 2 : 1} />);
    }
    for (const original of grid.beats) for (const s of positions(original)) {
      const t = toT(s);
      if (t === null || t < tMin || t > tMax) continue;
      out.push(<line key={`b${deck}${s}`} x1={x(t)} x2={x(t)} y1={y0 + rowH - 8} y2={y0 + rowH} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />);
    }
    return out;
  };
  return (
    <svg className="wave-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Две волновые формы перехода с точками входа и выхода">
      <rect x={x(0)} y={0} width={x(plan.duration + plan.gap) - x(0)} height={H} fill="rgba(245,200,110,0.08)" />
      <text x={8} y={20} fill="#b3c9bb" fontSize={12}>
        A · выход {fmtTime(plan.aExit)}
      </text>
      <text x={8} y={yB - 6} fill="#b3c9bb" fontSize={12}>
        B · вход {fmtTime(plan.bEntry)}
      </text>
      {a && <path d={area(a, mapA, yA)} fill="rgba(253,252,254,0.55)" />}
      {b && <path d={area(b, mapB, yB)} fill="rgba(201,167,255,0.6)" />}
      {markers(a, 'A', yA)}
      {markers(b, 'B', yB)}
      <path d={curve('A', 'gain', yA, 0)} stroke="#fff" strokeWidth={2} fill="none" />
      <path d={curve('A', 'low', yA, 0)} stroke="#4ade9a" strokeWidth={1.5} fill="none" strokeDasharray="4 3" />
      <path d={curve('B', 'gain', yB, bOffset)} stroke="#fff" strokeWidth={2} fill="none" />
      <path d={curve('B', 'low', yB, bOffset)} stroke="#4ade9a" strokeWidth={1.5} fill="none" strokeDasharray="4 3" />
      <path d={curve('B', 'mid', yB, bOffset)} stroke="#ffb86b" strokeWidth={1.2} fill="none" strokeDasharray="2 3" />
      <path d={vocalActivity(a, mapA, yA)} stroke="#c9a7ff" strokeWidth={1.3} opacity={0.75} fill="none" />
      <path d={vocalActivity(b, mapB, yB)} stroke="#c9a7ff" strokeWidth={1.3} opacity={0.75} fill="none" />
      <path d={vocalCurve('A', yA)} stroke="#c9a7ff" strokeWidth={2.5} fill="none" strokeDasharray="8 4" />
      <path d={vocalCurve('B', yB)} stroke="#c9a7ff" strokeWidth={2.5} fill="none" strokeDasharray="8 4" />
      {[
        [0, 'старт'],
        [plan.swapAt, 'смена'],
        [plan.duration + plan.gap, 'конец'],
      ].map(([t, l]) => (
        <g key={String(l)}>
          <line x1={x(Number(t))} x2={x(Number(t))} y1={0} y2={H - 20} stroke="#f5c86e" strokeWidth={2} />
          <text x={x(Number(t)) + 4} y={H - 6} fill="#f5c86e" fontSize={12}>
            {String(l)}
          </text>
        </g>
      ))}
      {Array.from({ length: Math.floor(tMax - tMin) + 1 }, (_, i) => Math.ceil(tMin) + i)
        .filter((s) => s % 4 === 0)
        .map((s) => (
          <text key={s} x={x(s)} y={H - 22} fill="#93ad9f" fontSize={10} textAnchor="middle">
            {s > 0 ? `+${s}` : s} с
          </text>
        ))}
    </svg>
  );
});

function PlanInfo({ plan }: { plan: TransitionPlan }) {
  const ba = plan.beatAlign;
  const bridgeRateA = plan.tempoA?.at(-1)?.[1] ?? 1;
  const bridgeRateB = plan.tempoB[0]?.[1] ?? 1;
  const speedChange = (rate: number) => `${rate >= 1 ? '+' : ''}${((rate - 1) * 100).toFixed(2)} %`;
  return (
    <div className="panel">
      <h3>Параметры перехода</h3>
      <dl className="kv">
        {plan.debug.requested === true && <><dt>Запуск</dt><dd>По кнопке «Следующий»</dd></>}
        <dt>Уверенность</dt>
        <dd>{Math.round(plan.confidence * 100)} %</dd>
        <dt>Выход A / вход B</dt>
        <dd>
          {fmtTime(plan.aExit)} ({plan.aExit.toFixed(3)} с) / {fmtTime(plan.bEntry)} ({plan.bEntry.toFixed(3)} с)
        </dd>
        <dt>Длительность</dt>
        <dd>
          {plan.duration.toFixed(2)} с{plan.gap ? `, пауза ${plan.gap.toFixed(2)} с` : ''}
        </dd>
        {ba && (
          <>
            <dt>Темп</dt>
            <dd>
              {ba.bpmA.toFixed(2)} → {ba.bpmB.toFixed(2)} BPM{ba.relation !== 1 ? ` (×${ba.relation})` : ''}
            </dd>
            <dt>{ba.bridge ? 'Изменение темпа A / B' : 'Изменение темпа B'}</dt>
            <dd>
              {ba.bridge ? `${speedChange(bridgeRateA)} / ${speedChange(bridgeRateB)}` : `${ba.stretchPercent.toFixed(2)} % (×${ba.ratio.toFixed(4)})`}, высота тона сохраняется
            </dd>
            {ba.bridge && <><dt>Общий темп</dt><dd>{ba.bridge.commonBpm.toFixed(2)} BPM через {ba.bridge.lockAt.toFixed(2)} с; высота тона сохраняется</dd></>}
            <dt>Смена темпа</dt>
            <dd>{ba.bridge ? `Оба трека сходятся в общем темпе. После перехода B возвращается к исходному темпу за ${ba.bridge.recoverySeconds.toFixed(2)} с` : ba.masterDeck === 'A' ? `Текущий вокал сохраняет свой темп. B подстраивается и возвращается к исходному темпу за ${(ba.recoverySeconds ?? 0).toFixed(2)} с после сведения` : ba.glide ? 'Оба трека плавно меняют темп вместе' : 'Синхронизация входящего трека'}</dd>
            <dt>Наложение</dt>
            <dd>
              {ba.overlapBeats} {plural(ba.overlapBeats,'доля','доли','долей')} ({ba.overlapBeats / 4} {plural(ba.overlapBeats/4,'такт','такта','тактов')}){ba.phraseAligned ? ', по фразам' : ''}
            </dd>
          </>
        )}
        {plan.keyInfo && (
          <>
            <dt>Тональность</dt>
            <dd>
              {plan.keyInfo.a} → {plan.keyInfo.b}: {plan.keyInfo.label}
            </dd>
          </>
        )}
        <dt>Громкость</dt>
        <dd>
          A {plan.gainA > 0 ? '+' : ''}
          {plan.gainA.toFixed(1)} дБ, B {plan.gainB > 0 ? '+' : ''}
          {plan.gainB.toFixed(1)} дБ
        </dd>
        <dt>Карта темпа B</dt>
        <dd>{plan.tempoB.map(([t, r]) => `${t.toFixed(1)} с: ×${r.toFixed(4)}`).join(' → ')}</dd>
        {plan.tempoA && <><dt>Карта темпа A</dt><dd>{plan.tempoA.map(([t, r]) => `${t.toFixed(1)} с: ×${r.toFixed(4)}`).join(' → ')}</dd></>}
        {plan.loopA && <><dt>Инструментальная петля A</dt><dd>{fmtTime(plan.loopA.start)}–{fmtTime(plan.loopA.end)}, до конца перехода. Стык {Math.round(plan.loopA.crossfade * 1000)} мс; волна показывает повторяемый участок.</dd></>}
        {!!(plan.vocalA?.length || plan.vocalB?.length) && <><dt>Вокальная партия</dt><dd>Вокал передаётся отдельно от инструментала; используются подготовленные партии локальной модели.</dd></>}
        {!!plan.vocalA?.length && <><dt>Вокал A</dt><dd>{plan.vocalA!.map(([t, gain]) => `${t.toFixed(1)} с: ${Math.round(gain * 100)} %`).join(' → ')}</dd></>}
        {!!plan.vocalB?.length && <><dt>Вокал B</dt><dd>{plan.vocalB!.map(([t, gain]) => `${t.toFixed(1)} с: ${Math.round(gain * 100)} %`).join(' → ')}</dd></>}
      </dl>
      <ul className="notes" style={{ marginTop: 12 }}>
        {plan.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {plan.fallbackReason && (
        <p className="small" style={{ color: 'var(--danger)', marginBottom: 0 }}>
          Упрощено: {plan.fallbackReason}
        </p>
      )}
      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>
          TransitionPlan (JSON)
        </summary>
        <pre className="json">{JSON.stringify(plan, null, 2)}</pre>
      </details>
    </div>
  );
}

function useAnalysis(trackId: string | undefined) {
  const [a, setA] = useState<TrackAnalysis | null>(null);
  const [status, setStatus] = useState('…');
  const revision = useApp((s) => trackId ? s.tracks.get(trackId)?.analysis : undefined);
  useEffect(() => { setA(null); setStatus('…'); }, [trackId]);
  useEffect(() => {
    if (!trackId) return;
    let alive = true;
    void api
      .analysis(trackId)
      .then((r) => {
        if (!alive) return;
        setA(r.analysis);
        setStatus(r.status === 'done' ? 'готов' : r.status === 'error' ? `ошибка: ${r.error}` : 'ещё не готов');
      })
      .catch((e) => alive && setStatus((e as Error).message));
    return () => {
      alive = false;
    };
  }, [trackId, revision]);
  return { a, status };
}

function TransitionView({ plan, outcome, active = false, rate }: { plan: TransitionPlan; outcome?: Record<string, unknown>; active?: boolean; rate?: RatingTarget }) {
  const A = useAnalysis(plan.fromTrackId);
  const B = useAnalysis(plan.toTrackId);
  const ta = trackOf(plan.fromTrackId);
  const tb = trackOf(plan.toTrackId);
  return (
    <div className="diag-grid">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <TransitionSummary plan={plan} active={active} completed={!!outcome} rate={rate} />
        <div className="small">
          <strong>{ta?.title ?? 'A'}</strong> <span className="dim">→</span> <strong>{tb?.title ?? 'B'}</strong>
          {outcome && (
            <span className="dim">
              {' '}
              · {outcome.forced ? 'завершён вручную' : 'выполнен'}
              {outcome.late ? ', с опозданием буфера' : ''}
              {typeof outcome.limiterDb === 'number' ? `, лимитер ${Number(outcome.limiterDb).toFixed(1)} дБ` : ''}
            </span>
          )}
        </div>
        <div className="wave-scroll"><TransitionSvg plan={plan} a={A.a} b={B.a} /></div>
        <div className="legend">
          <span>
            <i style={{ background: '#fff' }} />
            громкость
          </span>
          <span>
            <i style={{ background: '#4ade9a' }} />
            бас (EQ)
          </span>
          <span>
            <i style={{ background: '#ffb86b' }} />
            середина B
          </span>
          <span>
            <i style={{ background: '#c9a7ff' }} />
            граница фразы
          </span>
          <span>
            <i style={{ background: 'rgba(255,255,255,0.4)' }} />
            сильная доля / доли
          </span>
          {!!(plan.vocalA?.length || plan.vocalB?.length) && <span><i className="legend-vocal-gain" /> громкость вокальной партии</span>}
          {(A.a?.vocalActivity || B.a?.vocalActivity) && <span><i style={{ background: '#c9a7ff' }} /> измеренная доля вокала</span>}
        </div>
        <p className="caption dim" style={{ margin: 0 }}>
          Волновые формы и сетка битов взяты из анализа файлов (A: {A.status}, B: {B.status}). Ось времени: секунды выхода звука относительно начала перехода; обе волны учитывают карты темпа.
          {plan.beatAlign?.regions && ' Доли показаны по локальным участкам, выбранным для этого перехода.'}
          {(A.a?.vocalActivity || B.a?.vocalActivity) && ' Доля вокала измерена после разделения звука; пунктир показывает, как меняется громкость выделенной партии.'}
        </p>
      </div>
      <PlanInfo plan={plan} />
    </div>
  );
}

function TrackAnalysisView({ trackId }: { trackId: string }) {
  const { a, status } = useAnalysis(trackId);
  const t = trackOf(trackId);
  const svg = useMemo(() => {
    if (!a) return null;
    const H = 160;
    const activity = a.vocalActivity;
    const vocalHeight = activity ? 42 : 0;
    const dur = a.duration || 1;
    const x = (s: number) => (s / dur) * W;
    const n = a.peaks.length;
    let d = '';
    const stepN = Math.max(1, Math.floor(n / 800));
    for (let i = 0; i < n; i += stepN) d += `${d ? 'L' : 'M'}${x(i / a.curves.rate).toFixed(1)},${(H / 2 - (a.peaks[i] * H) / 2).toFixed(1)}`;
    for (let i = n - 1; i >= 0; i -= stepN) d += `L${x(i / a.curves.rate).toFixed(1)},${(H / 2 + (a.peaks[i] * H) / 2).toFixed(1)}`;
    const activityLine = activity?.values.map((value, i) => `${i ? 'L' : 'M'}${x(i / activity.rate).toFixed(1)},${(H + 8 + (1 - Math.max(0, Math.min(1, value))) * 28).toFixed(1)}`).join('') ?? '';
    return (
      <svg className="wave-svg" viewBox={`0 0 ${W} ${H + 24 + vocalHeight}`} role="img" aria-label={`Волновая форма трека с фразами и точками перехода${activity ? ', ниже измеренная доля вокала' : ''}`}>
        <rect x={x(a.intro.start)} width={Math.max(0, x(a.intro.end) - x(a.intro.start))} y={0} height={H} fill="rgba(74,222,154,0.10)" />
        <rect x={x(a.outro.start)} width={Math.max(0, x(a.outro.end) - x(a.outro.start))} y={0} height={H} fill="rgba(255,184,107,0.12)" />
        <path d={d + 'Z'} fill="rgba(253,252,254,0.6)" />
        {a.phrases.map((p) => (
          <line key={p} x1={x(p)} x2={x(p)} y1={0} y2={H} stroke="#c9a7ff" strokeWidth={1.5} />
        ))}
        {a.cues.exit.slice(0, 3).map((c) => (
          <circle key={`e${c.time}`} cx={x(c.time)} cy={H - 6} r={5} fill="#ffb86b" />
        ))}
        {a.cues.entry.slice(0, 3).map((c) => (
          <circle key={`n${c.time}`} cx={x(c.time)} cy={6} r={5} fill="#4ade9a" />
        ))}
        <line x1={x(a.audibleStart)} x2={x(a.audibleStart)} y1={0} y2={H} stroke="#4ade9a" />
        <line x1={x(a.audibleEnd)} x2={x(a.audibleEnd)} y1={0} y2={H} stroke="#ffb86b" />
        {activity && <><rect x={0} y={H + 7} width={W} height={30} fill="rgba(201,167,255,0.08)" /><path d={activityLine} stroke="#c9a7ff" strokeWidth={1.5} fill="none" /></>}
        {Array.from({ length: Math.floor(dur / 30) + 1 }, (_, i) => i * 30).map((s) => (
          <text key={s} x={x(s)} y={H + 16 + vocalHeight} fill="#93ad9f" fontSize={10} textAnchor="middle">
            {fmtTime(s)}
          </text>
        ))}
      </svg>
    );
  }, [a]);
  return (
    <div className="diag-grid">
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="small">
          <strong>{t?.title}</strong> <span className="dim">· {t?.artist}</span>
        </div>
        {svg ?? <p className="muted">Анализ: {status}</p>}
        <div className="legend">
          <span>
            <i style={{ background: '#c9a7ff' }} />
            фразы
          </span>
          <span>
            <i style={{ background: '#4ade9a' }} />
            вступление и точки входа
          </span>
          <span>
            <i style={{ background: '#ffb86b' }} />
            концовка и точки выхода
          </span>
          {a?.vocalActivity && <span><i style={{ background: '#c9a7ff' }} /> доля вокала после разделения звука</span>}
        </div>
      </div>
      {a && (
        <div className="panel">
          <h3>Анализ</h3>
          <dl className="kv">
            <dt>Темп</dt>
            <dd>{a.beat ? `${a.beat.bpm.toFixed(2)} BPM, уверенность ${Math.round(a.beat.confidence * 100)} %` : 'устойчивого ритма нет'}</dd>
            {a.beat && (
              <>
                <dt>Сетка</dt>
                <dd>
                  {a.beat.stable ? 'постоянный темп' : 'плавающий темп'}, разброс {a.beat.jitterMs} мс, долей {a.beat.beats.length}
                </dd>
                <dt>Сильные доли</dt>
                <dd>уверенность {Math.round(a.beat.downbeatConfidence * 100)} %</dd>
              </>
            )}
            <dt>Фразы</dt>
            <dd>
              {a.phrases.length} (уверенность {Math.round(a.phraseConfidence * 100)} %)
            </dd>
            <dt>Тональность</dt>
            <dd>
              {keyNameRu(a.key)}
              {a.key.camelot ? ` (${a.key.camelot}), уверенность ${Math.round(a.key.confidence * 100)} %` : ''}
            </dd>
            <dt>Громкость</dt>
            <dd>
              {a.loudness.integratedLufs.toFixed(1)} LUFS, пик {a.loudness.truePeakDb.toFixed(1)} dBTP
            </dd>
            <dt>Звук</dt>
            <dd>
              {fmtTime(a.audibleStart)}–{fmtTime(a.audibleEnd)} из {fmtTime(a.duration)}
            </dd>
            <dt>Энергия</dt>
            <dd>{Math.round(a.features.energy * 100)} %</dd>
            <dt>Плотность середины</dt>
            <dd>{Math.round(a.features.midDensity * 100)} % (эвристика, не детектор голоса)</dd>
            {a.beatRegions && <><dt>Локальный ритм</dt><dd>{a.beatRegions.length ? `${a.beatRegions.length} ${plural(a.beatRegions.length, 'устойчивый участок', 'устойчивых участка', 'устойчивых участков')}` : 'устойчивых участков не найдено'}</dd></>}
            <dt>Вокальная партия</dt>
            <dd>{a.vocalActivity ? `Подготовлена локально · Demucs (${a.vocalActivity.model})` : 'Ещё не подготовлена; плотность середины не заменяет разделение вокала'}</dd>
            <dt>Анализ занял</dt>
            <dd>{(a.elapsedMs / 1000).toFixed(1)} с · {a.version}</dd>
          </dl>
          {a.warnings.length > 0 && <p className="caption dim">Пометки: {a.warnings.join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

type Check = { level: 'ok' | 'info' | 'warn'; text: string };

/** Plain-language checks for the top of the page; numbers stay in the details below. */
function healthChecks(health: HealthStatus | null, offline: boolean, audio: { pcmUnderruns: number } | undefined, plan: TransitionPlan | undefined, automixOn: boolean): Check[] {
  const out: Check[] = [];
  if (offline) out.push({ level: 'warn', text: 'Нет связи со встроенным сервером MORA. Перезапустите приложение, если это не пройдёт.' });
  if (health && !health.ffmpeg) out.push({ level: 'warn', text: 'Декодер звука не найден — файлы не воспроизводятся.' });
  if (!automixOn) out.push({ level: 'info', text: 'AutoMix выключен в настройках: треки играют подряд без переходов.' });
  if (audio) out.push(audio.pcmUnderruns > 0
    ? { level: 'warn', text: `Звук прерывался: ${audio.pcmUnderruns} ${plural(audio.pcmUnderruns, 'раз', 'раза', 'раз')} с запуска. Обычно это нехватка памяти или медленный диск.` }
    : { level: 'ok', text: 'Звук идёт без пропусков.' });
  if (health) {
    const pending = health.analysis.running + health.analysis.queued;
    out.push(pending > 0
      ? { level: 'info', text: `Анализируем треки: осталось ${pending}. Пока анализ не готов, переходы проще.` }
      : { level: 'ok', text: 'Все треки проанализированы.' });
  }
  if (plan) out.push(plan.fallbackReason
    ? { level: 'info', text: `Переход упрощён: ${plan.fallbackReason}` }
    : { level: 'ok', text: `Переход рассчитан, уверенность ${Math.round(plan.confidence * 100)} %.` });
  return out;
}

function HealthSummary({ checks }: { checks: Check[] }) {
  const worst = checks.some((c) => c.level === 'warn') ? 'warn' : checks.some((c) => c.level === 'info') ? 'info' : 'ok';
  const Icon = { ok: CheckCircle, info: Info, warn: WarningCircle };
  const Big = Icon[worst];
  return (
    <section className={`diag-summary ${worst}`} aria-label="Итог проверки">
      <div className="diag-summary-head">
        <Big size={30} weight="fill" aria-hidden="true" />
        <div>
          <h2>{worst === 'warn' ? 'Есть что проверить' : worst === 'info' ? 'Всё работает' : 'Всё в порядке'}</h2>
          <p>{checks.length ? 'Коротко о звуке и переходах прямо сейчас.' : 'Проверяем…'}</p>
        </div>
      </div>
      {checks.length > 0 && <ul>
        {checks.map((c) => { const I = Icon[c.level]; return <li key={c.text} className={c.level}><I size={18} weight="fill" aria-hidden="true" /><span>{c.text}</span></li>; })}
      </ul>}
    </section>
  );
}

export function DiagnosticsPage() {
  const { query } = useRoute();
  const trackId = query.get('track');
  const p = useApp((s) => s.player);
  const [log, setLog] = useState<TransitionLogItem[]>([]);
  const [sel, setSel] = useState<string>('next');
  const [showHistory, setShowHistory] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const automixOn = useApp((s) => s.settings?.automix.enabled !== false);
  useEffect(() => {
    void api.transitions(30).then((r) => setLog(r.items)).catch(() => {});
    void api.health().then((h) => { setHealth(h); setOffline(false); }, () => setOffline(true));
  }, [p.lastTransition]);
  if (trackId)
    return (
      <div className="main-inner">
        <h1 className="page-title">Анализ трека</h1>
        <TrackAnalysisView trackId={trackId} />
      </div>
    );
  const livePlan = p.transition?.plan ?? p.nextPlan;
  const lastCompleted=p.lastTransition??(log[0]?{plan:log[0].plan,outcome:log[0].outcome,logId:log[0].id}:null);
  const chosen: { plan: TransitionPlan; outcome?: Record<string, unknown>; logId?: number } | null =
    sel === 'next' ? (livePlan ? { plan: livePlan } : lastCompleted) : (() => {
      const item = log.find((l) => String(l.id) === sel);
      return item ? { plan: item.plan, outcome: item.outcome, logId: item.id } : null;
    })();
  const rate: RatingTarget | undefined = chosen?.logId === undefined ? undefined : (() => {
    const logId = chosen.logId, row = log.find((l) => l.id === logId), last = p.lastTransition?.logId === logId ? p.lastTransition : null;
    return { logId, rating: row?.rating ?? last?.rating ?? null, reason: row?.ratingReason ?? last?.ratingReason ?? null,
      onRated: (rating, reason) => setLog((items) => items.map((l) => l.id === logId ? { ...l, rating, ratingReason: reason } : l)) };
  })();
  return (
    <div className="main-inner prefs-page diag-page">
      <h1 className="page-title">Диагностика AutoMix</h1>
      <PlaybackDiagnostics />
      <HealthSummary checks={healthChecks(health, offline, p.audioHealth, chosen?.plan, automixOn)} />
      <h2 className="pref-group-title">Переходы</h2>
      <div className="tabs diag-picker" aria-label="Какой переход показать">
        <button className="chip" aria-pressed={sel === 'next'} onClick={() => setSel('next')}>
          {p.transition?.active ? 'Идёт сейчас' : livePlan ? 'Запланирован' : 'Последний'}
        </button>
        {log.slice(0, showHistory ? 30 : 3).map((l) => (
          <button key={l.id} className="chip" aria-pressed={sel === String(l.id)} onClick={() => setSel(String(l.id))} title={fmtDate(l.executedAt)}>
            {trackOf(l.fromTrackId)?.title ?? '?'} → {trackOf(l.toTrackId)?.title ?? '?'}
          </button>
        ))}
        {log.length>3 && <button className="chip" aria-expanded={showHistory} onClick={()=>setShowHistory(!showHistory)}>{showHistory?'Свернуть историю':`Ещё ${log.length-3}`}</button>}
      </div>
      {chosen && <div className="transition-preview">
        <button className="btn btn-primary" disabled={previewing} aria-busy={previewing} onClick={async () => {
          if (previewing) return;
          setPreviewing(true);
          try {
            await controller.previewPair(chosen.plan.fromTrackId, chosen.plan.toTrackId);
            setSel('next');
          } catch (error) { useApp.getState().toast(`Не удалось включить переход: ${(error as Error).message}`, 'error'); }
          finally { setPreviewing(false); }
        }}><Play size={17} weight="fill" aria-hidden="true" />{previewing ? 'Готовим прослушивание…' : 'Послушать переход'}</button>
        <p>Рассчитывает пару по текущим настройкам и начинает музыку перед переходом. Очередь заменится этими двумя треками.</p>
      </div>}
      {chosen ? <TransitionView plan={chosen.plan} outcome={chosen.outcome} active={sel==='next'&&p.transition?.active} rate={rate} /> : <div className="empty"><h2>Послушайте пару треков</h2><p>Выберите музыку в медиатеке и включите AutoMix. Здесь появятся выбранные точки входа и выхода, реальные волны и причины перехода.</p><a href="#/library" className="btn btn-primary">Открыть медиатеку</a></div>}
      <details className="pref-more">
        <summary>
          <span className="pref-title">Технические подробности</span>
          <span className="pref-desc">Счётчики звука и версии анализа</span>
        </summary>
        <div className="pref-card">
          {p.audioHealth ? <>
            <div className="pref-row"><div className="pref-text"><div className="pref-title">Нехватка звука</div><div className="pref-desc">Сколько раз плееру не хватило готового звука</div></div><div className="pref-control tnum">{p.audioHealth.pcmUnderruns}</div></div>
            <div className="pref-row"><div className="pref-text"><div className="pref-title">Долгие блоки</div><div className="pref-desc">Задержка вычисления, не обязательно слышимая</div></div><div className="pref-control tnum">{p.audioHealth.slowBlocks} · до {p.audioHealth.maxRenderMs.toFixed(1)} мс</div></div>
            <div className="pref-row"><div className="pref-text"><div className="pref-title">Буфер устройства</div></div><div className="pref-control tnum">{p.audioHealth.latencyMs.toFixed(0)} мс</div></div>
          </> : <div className="pref-row"><div className="pref-text"><div className="pref-desc">Счётчики появятся после начала воспроизведения.</div></div></div>}
          {health && <div className="pref-row"><div className="pref-text"><div className="pref-title">Анализ</div><div className="pref-desc">Анализатор {health.analyzer}, планировщик {health.planner}</div></div><div className="pref-control tnum">потоков {health.analysis.workers}</div></div>}
        </div>
        <p className="pref-footer">Счётчики относятся к текущему запуску плеера.</p>
      </details>
    </div>
  );
}
