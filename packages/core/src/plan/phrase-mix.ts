import { PLANNER_VERSION, type AutomationLane, type PhraseMixRecipe, type TrackAnalysis, type TransitionPlan } from '../types.ts';

export class PhraseMixValidationError extends Error {
  constructor(public issues: string[]) { super(issues.join('; ')); this.name = 'PhraseMixValidationError'; }
}

/** Integral of a piecewise-linear playback rate, with endpoint holding. */
export function phraseSourceTime(points: [number, number][] | undefined, t: number): number {
  if (!points?.length) return t;
  let area = 0, previous = 0, rate = points[0][1];
  for (const [at, next] of points) {
    if (at <= previous) { rate = next; continue; }
    const end = Math.min(t, at), span = end - previous;
    if (span > 0) area += span * (rate + (rate + (next - rate) * span / (at - previous))) / 2;
    if (t <= at) return area;
    previous = at; rate = next;
  }
  return area + Math.max(0, t - previous) * rate;
}

export function phraseMixGrid(base: TransitionPlan, A?: TrackAnalysis | null): { bpm: number; barSeconds: number } | null {
  const beat = A?.beat;
  if (!beat?.stable || beat.confidence < 0.7 || beat.downbeatConfidence < 0.6 || !beat.downbeats.length || !Number.isFinite(beat.period) || beat.period <= 0) return null;
  if (A?.structure?.gridCheck && A.structure.gridCheck.tripleShare > 0.25) return null;
  if (base.aExit < beat.beats[0] || base.aExit > (beat.beats.at(-1) ?? 0)) return null;
  return { bpm: 60 / beat.period, barSeconds: 4 * beat.period };
}

export function createPhraseMixRecipe(base: TransitionPlan, A?: TrackAnalysis | null, B?: TrackAnalysis | null): PhraseMixRecipe {
  // A gapless plan points at EOF. Opening an editable blend must reserve real source
  // audio before that point instead of shrinking an impossible EOF overlap to .5 s.
  const desired = Math.max(0.5, Math.min(64, base.duration || 6));
  const endA = Math.max(0, Math.min(A?.duration ?? Infinity, base.aExit + phraseSourceTime(base.tempoA, Math.max(0, base.duration))));
  const bEntry = B && B.duration - base.bEntry < 0.5 ? 0 : base.bEntry;
  const delayAt = (duration: number) => Math.max(0, Math.min(duration - 0.1, base.duration > 0 ? base.bDelay ?? 0 : 0));
  const fits = (duration: number) => phraseSourceTime(base.tempoA, duration) <= endA && (!B || bEntry + phraseSourceTime(base.tempoB, duration - delayAt(duration)) <= B.duration);
  let duration = desired;
  if (!fits(duration)) {
    let lo = 0, hi = desired;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    duration = Math.max(0.5, lo);
  }
  const aExit = Math.max(0, Math.min(base.aExit, endA - phraseSourceTime(base.tempoA, duration)));
  const bDelay = delayAt(duration);
  return { version: 1, preset: 'bass_swap', timing: { unit: 'seconds', seconds: duration }, aExit, bEntry, bDelay,
    handoff: Math.max(bDelay, Math.min(duration, base.swapAt || duration / 2)),
    tempo: { ...(base.tempoA ? { a: base.tempoA.map(p => [...p] as [number, number]) } : {}), b: base.tempoB.map(p => [...p] as [number, number]) } };
}

export function compilePhraseMix(base: TransitionPlan, recipe: PhraseMixRecipe, A?: TrackAnalysis | null, B?: TrackAnalysis | null): TransitionPlan {
  const issues: string[] = [];
  if (base.debug.processingAllowed === false) throw new PhraseMixValidationError(['Источник не поддерживает обработку перехода']);
  if (!recipe || typeof recipe !== 'object' || recipe.version !== 1) throw new PhraseMixValidationError(['Неизвестная версия сценария']);
  if (!['bass_swap', 'drop_in', 'tail_to_start'].includes(recipe.preset)) issues.push('Неизвестный пресет');
  const native = recipe.preset === 'tail_to_start';
  if (recipe.tempo !== undefined && (!recipe.tempo || typeof recipe.tempo !== 'object' || !Array.isArray(recipe.tempo.b))) issues.push('Некорректная темповая карта');
  const sourceA = recipe.tempo ? recipe.tempo.a : base.tempoA;
  const sourceB = recipe.tempo ? recipe.tempo.b : base.tempoB;
  for (const points of [sourceA, sourceB]) if (points !== undefined && (!Array.isArray(points) || !points.length || points.length > 256
    || points.some((p, i) => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || p[0] < 0 || (i === 0 && p[0] !== 0)
      || !Number.isFinite(p[1]) || p[1] < 0.5 || p[1] > 2 || (i > 0 && p[0] <= points[i - 1][0])))) issues.push('Некорректная темповая карта');
  if (issues.length) throw new PhraseMixValidationError(issues);
  const tempoA = native ? undefined : sourceA?.map(p => [...p] as [number, number]);
  const tempoB: [number, number][] = native ? [[0, 1]] : sourceB.map(p => [...p] as [number, number]);
  let duration = recipe.timing?.unit === 'seconds' ? recipe.timing.seconds : NaN;
  if (recipe.timing?.unit === 'bars') {
    if (![4, 8, 16].includes(recipe.timing.bars)) issues.push('Для тактов нужна надёжная сетка 4/4');
    else if (recipe.timing.resolvedDuration !== undefined) {
      duration = recipe.timing.resolvedDuration;
    } else {
      const grid = phraseMixGrid({ ...base, aExit: recipe.aExit }, A);
      if (!grid) issues.push('Для тактов нужна надёжная сетка 4/4');
      else {
      const target = grid.barSeconds * recipe.timing.bars;
      let lo = 0, hi = 128;
      for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (phraseSourceTime(tempoA, mid) < target) lo = mid; else hi = mid; }
      duration = (lo + hi) / 2;
      }
    }
  }
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 64) issues.push('Длительность должна быть от 0,5 до 64 секунд');
  for (const key of ['aExit', 'bEntry', 'bDelay', 'handoff'] as const) if (!Number.isFinite(recipe[key]) || recipe[key] < 0) issues.push(`Некорректная точка ${key}`);
  if (recipe.bDelay >= duration || recipe.handoff < recipe.bDelay || recipe.handoff > duration) issues.push('Старт B и передача должны находиться внутри перехода');
  if (A && recipe.aExit + phraseSourceTime(tempoA, duration) > A.duration + 0.001) issues.push('Переход выходит за конец A');
  if (B && recipe.bEntry + phraseSourceTime(tempoB, duration - recipe.bDelay) > B.duration + 0.001) issues.push('Переход выходит за конец B');
  if (recipe.curves !== undefined && !Array.isArray(recipe.curves)) issues.push('Некорректные кривые');
  const seen = new Set<string>();
  for (const curve of Array.isArray(recipe.curves) ? recipe.curves : []) {
    if (!curve || typeof curve !== 'object') { issues.push('Некорректная полоса'); continue; }
    const key = `${curve.deck}/${curve.lane}`;
    if (seen.has(key) || !['A', 'B'].includes(curve.deck) || !['gain', 'low', 'mid', 'high', 'filter'].includes(curve.lane)) issues.push('Некорректная или повторная полоса');
    seen.add(key);
    if (!Array.isArray(curve.points) || curve.points.length < 2 || curve.points.length > 128 || curve.points[0]?.[0] !== 0 || curve.points.at(-1)?.[0] !== 1 || curve.points.some((p, i) => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[0] > 1 || p[1] < (curve.lane === 'filter' ? -1 : 0) || p[1] > 1 || (i > 0 && (!Array.isArray(curve.points[i - 1]) || p[0] <= curve.points[i - 1][0])))) { issues.push('Узлы кривой должны идти от 0 до 1 по возрастанию'); continue; }
    const first = curve.points[0][1], last = curve.points.at(-1)![1];
    if (curve.lane === 'gain' && ((curve.deck === 'A' && (first !== 1 || last !== 0)) || (curve.deck === 'B' && (first !== 0 || last !== 1)))) issues.push('Громкость должна плавно соединяться с сольным воспроизведением: A 1→0, B 0→1');
    if (curve.deck === 'B' && curve.lane !== 'gain' && last !== (curve.lane === 'filter' ? 0 : 1)) issues.push('В конце B должен вернуться к исходному EQ/фильтру');
    if (curve.deck === 'A' && curve.lane !== 'gain' && first !== (curve.lane === 'filter' ? 0 : 1)) issues.push('В начале A должен сохранить исходный EQ/фильтр');
  }
  if (issues.length) throw new PhraseMixValidationError(issues);
  const handoff = recipe.handoff, bSpan = duration - recipe.bDelay;
  const automation: AutomationLane[] = [];
  const lane = (deck: 'A' | 'B', name: AutomationLane['lane'], before: number, after: number, center = handoff, width = Math.min(1.5, duration * 0.2)) => {
    const span = deck === 'A' ? duration : bSpan;
    const at = Math.max(0, Math.min(span, center - (deck === 'B' ? recipe.bDelay : 0)));
    const start = Math.max(0, at - width / 2), end = Math.min(span, at + width / 2);
    const points: [number, number][] = [[0, before]];
    if (start > 0) points.push([start, before]);
    if (end > 0) points.push([end, after]);
    if (end < span) points.push([span, after]);
    automation.push({ deck, lane: name, points });
  };
  lane('A', 'gain', 1, 0, native ? handoff : Math.min(duration, handoff + (recipe.preset === 'drop_in' ? 0.15 : 0.7)), native ? Math.min(2, duration) : recipe.preset === 'drop_in' ? 0.6 : Math.min(2, duration * 0.3));
  if (native) lane('B', 'gain', 0, 1, recipe.bDelay + Math.min(0.175, bSpan / 2), Math.min(0.35, bSpan));
  else {
    const at = handoff - recipe.bDelay;
    const width = recipe.preset === 'drop_in' ? Math.min(0.6, bSpan) : Math.min(2, bSpan);
    const intro = Math.min(0.5, bSpan * 0.1);
    const raw: [number, number][] = [[0, 0], [intro, recipe.preset === 'drop_in' ? 0.18 : 0.3], [Math.max(intro, at - width / 2), recipe.preset === 'drop_in' ? 0.18 : 0.3], [Math.min(bSpan, Math.max(intro, at + width / 2)), 1], [bSpan, 1]];
    automation.push({ deck: 'B', lane: 'gain', points: raw.filter(([t], i) => i === raw.length - 1 || raw[i + 1][0] !== t) });
  }
  lane('A', 'low', 1, native ? 1 : 0, handoff, 0.6); lane('B', 'low', native ? 1 : 0, 1, handoff, 0.6);
  lane('A', 'mid', 1, native ? 1 : 0, Math.max(0, handoff - 0.5)); lane('B', 'mid', native ? 1 : 0.15, 1);
  lane('A', 'high', 1, 1); lane('B', 'high', 1, 1);
  lane('A', 'filter', 0, 0); lane('B', 'filter', recipe.preset === 'drop_in' ? -0.65 : 0, 0, handoff, Math.min(4, bSpan));
  for (const curve of recipe.curves ?? []) {
    const idx = automation.findIndex(l => l.deck === curve.deck && l.lane === curve.lane);
    const compiled: AutomationLane = { ...curve, points: curve.points.map(([x, y]) => [x * (curve.deck === 'A' ? duration : bSpan), y]) };
    if (idx >= 0) automation[idx] = compiled; else automation.push(compiled);
  }
  // Strip source-dependent effects and automatic vocal decisions before compiling editable full-mix lanes.
  const { loopA: _loop, tapeStopA: _tape, vocalA: _va, vocalB: _vb, echo: _echo, voiceEcho: _ve, beatAlign: _beat, entrySelection: _entry, ...clean } = base;
  let hash = 2166136261; for (const c of JSON.stringify(recipe)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return { ...clean, id: `${base.id}:phrase:${(hash >>> 0).toString(16)}`, version: PLANNER_VERSION, method: native ? 'crossfade' : 'phrase_cut', aExit: recipe.aExit, bEntry: recipe.bEntry, duration, bDelay: recipe.bDelay, swapAt: handoff, gap: 0, tempoA, tempoB, automation, reasons: ['Ручной переход по фразам'], debug: { phraseMix: { version: 1, preset: recipe.preset, recipe, manual: true } } };
}

