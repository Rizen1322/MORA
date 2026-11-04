import { DEFAULT_AUTOMIX_SETTINGS, type AutoMixSettings, type PlannerTrack, type TrackAnalysis } from '../src/types.ts';
import { CREATIVE_TRANSITION_STYLES, type CreativeTransitionStyle } from '../src/plan/creative.ts';

export function creativeTrack(id: string, bpm = 120): PlannerTrack {
  const duration = 128, rate = 20, period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter(t => t < duration);
  const downbeats = beats.filter((_, i) => i % 4 === 0), rmsDb = Array.from({ length: duration * rate }, () => -16);
  const analysis: TrackAnalysis = {
    version: 'creative-measured-fixture', duration, audibleStart: 0, audibleEnd: duration, rhythmStrength: .9,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, stable: true, confidence: .95, downbeatConfidence: .9, jitterMs: 2, beats, downbeats, downbeatPhase: 0, alternatives: [] },
    key: { tonic: -1, mode: 'unknown', name: '', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: .9, sectionBoundaries: [],
    intro: { start: 0, end: 8 }, outro: { start: 104, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map(v => v - 3), midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 10), midDensity: rmsDb.map(() => .15) },
    local: { rate: 1, transients: Array(duration).fill(.6), camelot: Array(duration).fill(''), keyConfidence: Array(duration).fill(0) },
    stereo: { rate: 1, correlation: Array(duration).fill(.8), sideToMidDb: Array(duration).fill(-9) },
    peaks: rmsDb.map(() => .3), cues: { entry: [{ time: 0, score: .9, kind: 'start', tags: [] }], exit: [] },
    features: { energy: .6, brightness: .5, rhythmStrength: .9, onsetRate: .6, bassWeight: .6, midDensity: .15, dynamics: .2, acousticness: .1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}
export function creativePair(style: CreativeTransitionStyle): { from: PlannerTrack; to: PlannerTrack; settings: AutoMixSettings; style: CreativeTransitionStyle; mode: 'creative' } {
  const from = creativeTrack('A'), to = creativeTrack('B', style === 'half-time-handoff' ? 60 : style === 'slowing-echo' ? 80 : 120);
  if (style === 'echo-pickup') to.analysis!.audibleStart = .25;
  if (style === 'natural-break') setLevel(from.analysis!, 112, 114, -38);
  if (style === 'filter-arrival') setLevel(to.analysis!, 0, 4, -25);
  if (style === 'tail-threshold') for (let i = 108 * 20; i < 128 * 20; i++) {
    const an = from.analysis!, level = -16 - (i / 20 - 108) * 1.8;
    for (const [key, offset] of [['rmsDb', 0], ['lowDb', -3], ['midDb', -6], ['highDb', -10]] as const) an.curves[key][i] = level + offset;
  }
  if (style === 'short-brake') { setLevel(from.analysis!, 104, 128, -23); from.analysis!.local!.transients.fill(.12); }
  return { from, to, settings: { ...DEFAULT_AUTOMIX_SETTINGS }, style, mode: 'creative' };
}
export function setLevel(an: TrackAnalysis, from: number, to: number, level: number): void {
  for (const [key, offset] of [['rmsDb', 0], ['lowDb', -3], ['midDb', -6], ['highDb', -10]] as const)
    for (let i = Math.floor(from * an.curves.rate); i < Math.ceil(to * an.curves.rate); i++) an.curves[key][i] = level + offset;
}
export const creativeCases = () => CREATIVE_TRANSITION_STYLES.map(s => creativePair(s.id));
