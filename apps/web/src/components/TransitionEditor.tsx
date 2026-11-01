import { useEffect, useMemo, useState } from 'react';
import { compilePhraseMix, createPhraseMixRecipe, humanTransitionScenarios, phraseMixGrid, type PhraseMixRecipe, type TrackAnalysis, type TransitionPlan } from '@automix/core';
import { api, type Track, type TransitionRecipeContext } from '../lib/api.ts';
import { previewPhraseDraft, stopPreview, usePreview } from '../lib/transition-preview.ts';
import { phraseGridTimes, phraseMarker, phrasePreset, phraseScenario, phraseTiming, phraseWaveform } from '../lib/phrase-editor.ts';
import { controller, useApp } from '../store/app.ts';
import { Modal } from './common.tsx';
import './TransitionEditor.css';

type EditableLane = 'gain' | 'low' | 'mid' | 'high' | 'filter';
const presets = { bass_swap: 'Передача баса', drop_in: 'Вход на дроп', tail_to_start: 'Хвост → начало' } as const;
const scenarioLabels: Record<string, string> = { 'section-handoff': 'Передача у завершения фразы', 'natural-tail-start': 'Естественный хвост → начало', 'arrival-build': 'Подводка к приходу энергии', 'clean-out': 'Убрать хвост A после входа B', 'sequential-relay': 'Сначала завершить A, затем включить B', 'complementary-handoff': 'Встречная передача громкости у смены' };

export function TransitionEditor({ from, to, edge, onClose }: { from: Track; to: Track; edge: TransitionRecipeContext; onClose: () => void }) {
  const [base, setBase] = useState<TransitionPlan | null>(null);
  const [draft, setDraft] = useState<PhraseMixRecipe | null>(null);
  const [analyses, setAnalyses] = useState<[TrackAnalysis | null, TrackAnalysis | null]>([null, null]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'volume' | 'eq' | 'filter'>('volume');
  const [deck, setDeck] = useState<'A' | 'B'>('A');
  const [eq, setEq] = useState<'low' | 'mid' | 'high'>('low');
  const [marker, setMarker] = useState<'handoff' | 'bDelay' | null>(null);
  const [dragNode, setDragNode] = useState<number | null>(null);
  const preview = usePreview();
  const automix = useApp(state => state.settings?.automix);
  const scenarios = useMemo(() => base && analyses[0] && analyses[1] && automix
    ? humanTransitionScenarios(base, analyses[0], analyses[1], automix) : [], [base, analyses, automix]);
  const lane: EditableLane = tab === 'volume' ? 'gain' : tab === 'filter' ? 'filter' : eq;
  useEffect(() => {
    let active = true;
    void (async () => {
      const before = await api.phraseRecipe(edge);
      const [automatic, a, b] = await Promise.all([api.phrasePlan(from.id, to.id), api.analysis(from.id), api.analysis(to.id)]);
      const saved = await api.phraseRecipe(edge);
      if (!active) return;
      if (before.audioHashes.a !== saved.audioHashes.a || before.audioHashes.b !== saved.audioHashes.b) {
        setError('Запись аудио изменилась во время загрузки. Закройте и откройте редактор снова.'); return;
      }
      setBase(automatic.plan); setAnalyses([a.analysis, b.analysis]);
      setDraft({ ...(saved.recipe ?? createPhraseMixRecipe(automatic.plan, a.analysis, b.analysis)), audioHashes: saved.audioHashes });
      if (saved.stale) setMessage('Запись аудио изменилась. Сохранённый сценарий нужно выбрать заново.');
    })().catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; stopPreview(); };
  }, [from.id, to.id, edge.playlistId, edge.fromItemId, edge.toItemId]);
  const compiled = useMemo(() => {
    if (!base || !draft) return { plan: null, issue: '' };
    try { return { plan: compilePhraseMix(base, draft, ...analyses), issue: '' }; }
    catch (e) { return { plan: null, issue: (e as Error).message }; }
  }, [base, draft, analyses]);
  const plan = compiled.plan;
  const grid = base ? phraseMixGrid({ ...base, aExit: draft?.aExit ?? base.aExit }, analyses[0]) : null;
  const edit = (patch: Partial<PhraseMixRecipe>) => { stopPreview(); setDraft(d => d && ({ ...d, ...patch })); setMessage(''); };
  const points = plan?.automation.find(l => l.deck === deck && l.lane === lane)?.points ?? [];
  const span = plan ? plan.duration - (deck === 'B' ? plan.bDelay ?? 0 : 0) : 1;
  const setPoints = (next: [number, number][]) => {
    if (!draft) return;
    edit({ curves: [...(draft.curves ?? []).filter(c => c.deck !== deck || c.lane !== lane), { deck, lane, points: next }] });
  };
  const normalized: [number, number][] = points.map(([t, v]) => [t / span, v]);
  const cursor = preview.playing?.endsWith(':draft') && preview.position !== undefined ? preview.position - (preview.transitionStart ?? 0) : null;
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const close = () => { stopPreview(); onClose(); };
  return <Modal title="Переход по фразам" onClose={close} actions={<>
    <button className="btn btn-secondary" disabled={busy || !base} onClick={() => void execute(async () => {
      stopPreview(); await api.resetPhraseRecipe(edge); setDraft({ ...createPhraseMixRecipe(base!, ...analyses), audioHashes: draft?.audioHashes }); await controller.refreshPlaylistTransitions(edge.playlistId); setMessage('Автоматический переход восстановлен');
    })}>Вернуть авто</button>
    <button className="btn btn-primary" disabled={busy || !plan || !draft} onClick={() => void execute(async () => {
      const saved = await api.savePhraseRecipe(edge, draft!); setDraft(saved.recipe); await controller.refreshPlaylistTransitions(edge.playlistId); setMessage('Сохранено для этой пары в плейлисте'); useApp.getState().toast('Переход сохранён', 'success');
    })}>Сохранить для этой пары</button>
  </>}>
    <div className="phrase-editor">
      <p className="small muted">A · {from.title} → B · {to.title}</p>
      {base?.method === 'gapless' && <p className="caption muted">Авто сохраняет стык альбомных треков без наложения. Сохранение этого варианта заменит стык ручным переходом только для этой пары.</p>}
      {!draft && !error && <p role="status">Готовим переход и волны…</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {draft && <>
        {scenarios.length > 0 && <div>
          <p className="small">Сценарии по музыке</p>
          <div className="phrase-presets" role="group" aria-label="Сценарии по музыке">{scenarios.map(scenario => <button key={scenario.name} className="chip" title={scenario.plan.reasons.join('. ')} onClick={() => {
            edit({ ...phraseScenario(scenario.plan, scenario.name), audioHashes: draft.audioHashes });
            const remaining = (scenario.plan.debug.humanScenario as { remainingASeconds?: number } | undefined)?.remainingASeconds;
            const cut = typeof remaining === 'number' && remaining >= 2 ? ` Первый трек заканчивается на ${remaining.toFixed(1)} с раньше своего звучащего конца.` : '';
            const caveat = scenario.name === 'complementary-handoff' ? ' Кривые меняют только общую громкость A и B; слова и безопасный момент смены автоматически не определяются.' : '';
            setMessage(`${scenarioLabels[scenario.name] ?? scenario.name}.${cut}${caveat} Прослушайте вариант перед сохранением.`);
          }}>{scenarioLabels[scenario.name] ?? scenario.name}{scenario.auditionOnly ? ' · пробный' : ''}</button>)}</div>
          <p className="caption muted">Прослушайте выбранный сценарий целиком перед сохранением. Более ранний уход A может обрезать его последнюю фразу.</p>
        </div>}
        <div className="phrase-presets" role="group" aria-label="Пресет перехода">{Object.entries(presets).map(([key, label]) => <button key={key} className="chip" aria-pressed={draft.preset === key} onClick={() => edit(phrasePreset(draft, key as PhraseMixRecipe['preset'], plan?.duration ?? 6))}>{label}</button>)}</div>
        <div className="phrase-fields">
          <label>Длительность<select aria-label="Единица длительности" value={draft.timing.unit === 'bars' ? String(draft.timing.bars) : 'seconds'} onChange={e => edit(phraseTiming(draft, e.target.value === 'seconds' ? { unit: 'seconds', seconds: plan?.duration ?? 6 } : { unit: 'bars', bars: Number(e.target.value) as 4 | 8 | 16 }, base!, analyses[0], plan?.duration ?? 6))}><option value="seconds">Секунды</option>{[4, 8, 16].map(n => <option key={n} value={n} disabled={!grid}>{n} тактов · 4/4</option>)}</select></label>
          {draft.timing.unit === 'seconds' && <label>Секунды<input type="number" min="0.5" max="64" step="0.1" value={draft.timing.seconds} onChange={e => edit(phraseTiming(draft, { unit: 'seconds', seconds: Number(e.target.value) }, base!, analyses[0], plan?.duration ?? 6))} /></label>}
          {(['aExit', 'bEntry', 'bDelay', 'handoff'] as const).map((key, i) => <label key={key}>{['Точка A, с', 'Точка B, с', 'Старт B, с', 'Передача, с'][i]}<input type="number" min="0" max={i === 0 ? from.duration : i === 1 ? to.duration : plan?.duration ?? 64} step="0.1" value={draft[key]} onChange={e => { if (e.target.value === '') return; const value = Number(e.target.value); if (key === 'bDelay' || key === 'handoff') edit(phraseMarker(draft, plan?.duration ?? 6, key, value)); else edit({ [key]: Math.max(0, Math.min(key === 'aExit' ? from.duration : to.duration, value)), locks: { aExit: draft.locks?.aExit ?? false, bEntry: draft.locks?.bEntry ?? false, handoff: draft.locks?.handoff ?? false, [key]: true } }); }} /></label>)}
        </div>
        {!grid && <p className="caption muted">Надёжная сетка 4/4 отсутствует. Редактирование в секундах.</p>}
        {compiled.issue && <p role="alert">{compiled.issue}</p>}
        {plan && <>
          <div className="phrase-waves" aria-label="Волны A и B на общей шкале времени">
            {(['A', 'B'] as const).map((d, i) => <div className={`phrase-wave phrase-wave-${d}`} key={d}><span>{d}</span><svg viewBox="0 0 600 60" role="img" aria-label={`Волна ${d}${analyses[i] ? '' : ' недоступна'}`} onPointerMove={e => {
              if (!marker) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const time = Math.max(0, Math.min(plan.duration, (e.clientX - rect.left) / rect.width * plan.duration));
              edit(phraseMarker(draft, plan.duration, marker, time));
            }} onPointerUp={() => setMarker(null)} onPointerCancel={() => setMarker(null)} onLostPointerCapture={() => setMarker(null)}>
              {(grid ? phraseGridTimes(analyses[0], plan) : Array.from({ length: Math.floor(plan.duration) + 1 }, (_, k) => k)).map(t => <line key={t} x1={t / plan.duration * 600} x2={t / plan.duration * 600} y1="0" y2="60" className="phrase-grid" />)}
              <path d={phraseWaveform(analyses[i], plan, d)} />
              <line x1={plan.swapAt / plan.duration * 600} x2={plan.swapAt / plan.duration * 600} y1="0" y2="60" className="phrase-handoff" />
              <line x1={plan.swapAt / plan.duration * 600} x2={plan.swapAt / plan.duration * 600} y1="0" y2="60" className="phrase-marker-hit" onPointerDown={e => { e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); setMarker('handoff'); }} />
              {d === 'B' && <><line x1={(plan.bDelay ?? 0) / plan.duration * 600} x2={(plan.bDelay ?? 0) / plan.duration * 600} y1="0" y2="60" className="phrase-entry" /><line x1={(plan.bDelay ?? 0) / plan.duration * 600} x2={(plan.bDelay ?? 0) / plan.duration * 600} y1="0" y2="60" className="phrase-marker-hit" onPointerDown={e => { e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); setMarker('bDelay'); }} /></>}
              {cursor !== null && cursor >= 0 && cursor <= plan.duration && <line x1={cursor / plan.duration * 600} x2={cursor / plan.duration * 600} y1="0" y2="60" className="phrase-cursor" />}
            </svg></div>)}
            <div className="phrase-ruler"><span>0 с</span><span>Передача {plan.swapAt.toFixed(1)} с</span><span>{plan.duration.toFixed(1)} с</span></div>
          </div>
          <div className="tabs" role="group" aria-label="Автоматизация">{(['volume', 'eq', 'filter'] as const).map((t, i) => <button key={t} className="chip" aria-pressed={tab === t} onClick={() => setTab(t)}>{['Громкость', 'EQ', 'Фильтр'][i]}</button>)}</div>
          <div className="phrase-lane-controls"><label>Дорожка<select value={deck} onChange={e => setDeck(e.target.value as 'A' | 'B')}><option>A</option><option>B</option></select></label>{tab === 'eq' && <label>Полоса<select value={eq} onChange={e => setEq(e.target.value as typeof eq)}><option value="low">Низ</option><option value="mid">Середина</option><option value="high">Верх</option></select></label>}</div>
          <svg className="phrase-curve" viewBox="0 0 600 100" role="img" aria-label="Исполняемая кривая автоматизации" onPointerMove={e => {
            if (dragNode === null) return;
            const i = dragNode, rect = e.currentTarget.getBoundingClientRect();
            const at = ((e.clientX - rect.left) / rect.width * plan.duration - (deck === 'B' ? plan.bDelay ?? 0 : 0)) / span;
            const value = Math.max(0, Math.min(1, (90 - (e.clientY - rect.top) / rect.height * 100) / 80));
            const fixedValue = (i === 0 && (deck === 'A' || lane === 'gain')) || (i === normalized.length - 1 && (deck === 'B' || lane === 'gain'));
            setPoints(normalized.map((p, j) => j !== i ? p : [i === 0 || i === normalized.length - 1 ? p[0] : Math.max(normalized[i - 1][0] + (normalized[i + 1][0] - normalized[i - 1][0]) * 0.0001, Math.min(normalized[i + 1][0] - (normalized[i + 1][0] - normalized[i - 1][0]) * 0.0001, at)), fixedValue ? p[1] : lane === 'filter' ? value * 2 - 1 : value]));
          }} onPointerUp={() => setDragNode(null)} onPointerCancel={() => setDragNode(null)} onLostPointerCapture={() => setDragNode(null)}>
            <polyline points={points.map(([t, v]) => `${(t + (deck === 'B' ? plan.bDelay ?? 0 : 0)) / plan.duration * 600},${90 - (lane === 'filter' ? (v + 1) / 2 : v) * 80}`).join(' ')} />
            {points.map(([t, v], i) => <circle key={i} cx={(t + (deck === 'B' ? plan.bDelay ?? 0 : 0)) / plan.duration * 600} cy={90 - (lane === 'filter' ? (v + 1) / 2 : v) * 80} r="5" onPointerDown={e => { e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); setDragNode(i); }} />)}
          </svg>
          <div className="phrase-nodes" aria-label="Узлы автоматизации">{normalized.map(([x, y], i) => <div key={`${deck}-${lane}-${i}`}>
            <label>Позиция %<input type="number" min="0" max="100" step="0.1" value={Number((x * 100).toFixed(2))} disabled={i === 0 || i === normalized.length - 1} onChange={e => setPoints(normalized.map((p, j) => j === i ? [Math.max(normalized[i - 1][0] + (normalized[i + 1][0] - normalized[i - 1][0]) * 0.0001, Math.min(normalized[i + 1][0] - (normalized[i + 1][0] - normalized[i - 1][0]) * 0.0001, Number(e.target.value) / 100)), p[1]] : p))} /></label>
            <label>Уровень<input type="number" min={lane === 'filter' ? -1 : 0} max="1" step="0.05" value={y} disabled={(i === 0 && (deck === 'A' || lane === 'gain')) || (i === normalized.length - 1 && (deck === 'B' || lane === 'gain'))} onChange={e => setPoints(normalized.map((p, j) => j === i ? [p[0], Math.max(lane === 'filter' ? -1 : 0, Math.min(1, Number(e.target.value)))] : p))} /></label>
            <button className="btn btn-ghost btn-sm" disabled={i === 0 || i === normalized.length - 1} onClick={() => setPoints(normalized.filter((_, j) => j !== i))}>Удалить узел</button>
          </div>)}</div>
          <button className="btn btn-ghost btn-sm" disabled={normalized.length >= 128} onClick={() => { const gaps = normalized.slice(1).map((p, i) => ({ i, gap: p[0] - normalized[i][0] })).sort((a, b) => b.gap - a.gap); const i = gaps[0]?.i ?? 0; const next = [...normalized]; next.splice(i + 1, 0, [(normalized[i][0] + normalized[i + 1][0]) / 2, (normalized[i][1] + normalized[i + 1][1]) / 2]); setPoints(next); }}>Добавить узел</button>
        </>}
        <div className="phrase-preview"><button className="btn btn-secondary" disabled={busy} onClick={() => void previewPhraseDraft(from.id, to.id)}>Слушать авто</button><button className="btn btn-secondary" disabled={busy || !plan} onClick={() => void previewPhraseDraft(from.id, to.id, draft)}>Слушать вариант</button>{(preview.playing || preview.loading) && <button className="btn btn-ghost" onClick={stopPreview}>{preview.loading ? 'Отменить подготовку' : 'Остановить'}</button>}<button className="btn btn-ghost" disabled={!plan} onClick={() => { const keys = Object.keys(presets) as PhraseMixRecipe['preset'][]; edit(phrasePreset(draft, keys[(keys.indexOf(draft.preset) + 1) % keys.length], plan!.duration)); }}>Другой вариант</button></div>
        <p className="caption muted">Прослушивание с контекстом использует тот же план, что и воспроизведение. EQ обрабатывает полный микс; наличие отдельного вокала не предполагается.</p>
      </>}
    </div>
  </Modal>;
}
