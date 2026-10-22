import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';

/** Conservative outro support: repeat a measured quiet bar only when the
 * original tail loses energy before B's structural arrival. No cue changes,
 * no invented silence detection and no extension of either track duration. */
export function withInstrumentalLoop(p: TransitionPlan, A: TrackAnalysis | null, B: TrackAnalysis | null, s: AutoMixSettings, requestedAt?: number): TransitionPlan {
  const g = A?.beat, v = A?.vocalActivity, arrival = p.entrySelection?.arrivalTime;
  if (!A || !B || !g || !v?.vocalRmsDb || !v.accompanimentRmsDb || !v.rate || requestedAt !== undefined
    || !s.enabled || !s.eqHandoff || s.loopBridges === false || s.stemMixing === false || s.style === 'tight' || p.debug.processingAllowed === false
    || p.method !== 'crossfade' || p.duration < 4 || p.duration > 24 || p.voiceEcho || p.echo
    || p.tempoA?.some(([, r]) => Math.abs(r - 1) > .0001) || p.tempoB.some(([, r]) => Math.abs(r - 1) > .0001)
    || !g.stable || g.confidence < .8 || g.downbeatConfidence < .75 || g.jitterMs > 12
    || A.structure?.gridCheck?.periodHint || arrival === undefined) return p;
  const until = p.aExit + p.duration;
  if (until > A.audibleEnd + .001 || until > A.duration || arrival - p.bEntry < p.duration * .4 || arrival - p.bEntry > p.duration) return p;
  const startIndex = g.downbeats.findIndex(t => t >= p.aExit && t <= p.aExit + Math.min(1.5, p.duration / 4));
  if (startIndex < 0) return p;
  const start = g.downbeats[startIndex], crossfade = .006;
  // Include every measured bin touched by preroll and the entire removed tail.
  const lo = Math.max(0, Math.floor((p.aExit - crossfade) * v.rate)), hi = Math.ceil(A.audibleEnd * v.rate);
  if (hi > v.vocalRmsDb.length || hi > v.accompanimentRmsDb.length) return p;
  for (let i = lo; i < hi; i++) {
    const voice = v.vocalRmsDb[i], bed = v.accompanimentRmsDb[i];
    if (!Number.isFinite(voice) || !Number.isFinite(bed) || voice + p.gainA > -42 || voice > bed - 25) return p;
  }
  const mean = (from: number, to: number): number => {
    const a = Math.max(0, Math.floor(from * A.curves.rate)), b = Math.ceil(to * A.curves.rate);
    if (b <= a || b > A.curves.rmsDb.length) return NaN;
    let power = 0;
    for (let i = a; i < b; i++) { const x = A.curves.rmsDb[i]; if (!Number.isFinite(x)) return NaN; power += 10 ** (x / 10); }
    return 10 * Math.log10(Math.max(1e-12, power / (b - a)));
  };
  for (const bars of [1, 2]) {
    const end = g.downbeats[startIndex + bars], length = end - start;
    if (!Number.isFinite(end) || length < 1.2 || length > 8 || Math.abs(length - g.period * 4 * bars) > .015
      || until - start < length * 1.4 || until - start > length * 3.5 || start < crossfade) continue;
    const level = mean(start, end), tail = mean(Math.max(end, until - 1), until);
    if (!Number.isFinite(level) || !Number.isFinite(tail) || level < A.bodyRmsDb - 5 || level - tail < 5
      || Math.abs(mean(start, start + length / 2) - mean(start + length / 2, end)) > 2) continue;
    // Shorten only at complete loop boundaries; the finite stop stays unchanged.
    const roll = s.djPhrasing !== false && s.style === 'auto' && length >= 1.6 && until - start >= length * 1.875
      ? [{ at: end, length: length / 2 }, { at: end + length / 2, length: length / 4 }] : undefined;
    return { ...p, id: `${p.id}_loop`, loopA: { start, end, until, crossfade, roll },
      reasons: [...p.reasons, 'инструментальный такт удерживает пульс затухающего финала до прихода следующей музыкальной части; уровень вокала проверен по отделённой партии'],
      debug: { ...p.debug, loopBridge: { bars, cycles: (until - start) / length, originalDropDb: level - tail, measuredVoice: true, roll: !!roll } } };
  }
  return p;
}
