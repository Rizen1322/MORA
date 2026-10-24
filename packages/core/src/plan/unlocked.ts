import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { pointValue } from './timing.ts';
import { applyVocalHandoff, vocalMean } from './vocals.ts';

const r = (x: number) => Math.round(x * 1000) / 1000;
/** Below this octave-normalized gap the existing unlocked blends stay (research: echo out for >~30 %). */
export const ECHO_OUT_MIN_STRETCH = 25;
const SUNG = 0.28;

/** Power mean (dB) of a curve; NaN when unmeasured. */
function level(an: TrackAnalysis, c: number[], a: number, b: number): number {
  const rate = an.curves.rate, lo = Math.floor(a * rate), hi = Math.ceil(b * rate);
  if (!(rate > 0) || lo < 0 || hi > c.length || hi <= lo) return NaN;
  let p = 0;
  for (let i = lo; i < hi; i++) { if (!Number.isFinite(c[i])) return NaN; p += 10 ** (c[i] / 10); }
  return 10 * Math.log10(Math.max(1e-12, p / (hi - lo)));
}

/** Voice activity measured (finite) over [a, b]. */
function voiceKnown(an: TrackAnalysis, a: number, b: number): boolean {
  const v = an.vocalActivity;
  if (!v || !(v.rate > 0) || a < 0 || Math.ceil(b * v.rate) > v.values.length) return false;
  for (let i = Math.floor(a * v.rate); i < Math.ceil(b * v.rate); i++) if (!Number.isFinite(v.values[i])) return false;
  return true;
}

const sung = (an: TrackAnalysis, t: number) => vocalMean(an, t - 0.05, t + 0.05) >= SUNG;

/** Seconds from `from` until the deck is within 12 dB of its body level (its own quiet intro). */
function quietFor(an: TrackAnalysis, from: number, to: number): number {
  for (let t = from; t < to; t += 0.25) if (level(an, an.curves.rmsDb, t, t + 0.5) >= an.bodyRmsDb - 12) return t - from;
  return to - from;
}

/** Seconds before `to` (at most 8) that the deck already spends 12 dB under its body level (its own outro). */
function quietBefore(an: TrackAnalysis, to: number): number {
  for (let t = to - 0.5; t >= to - 8; t -= 0.25) if (level(an, an.curves.rmsDb, t, t + 0.5) >= an.bodyRmsDb - 12) return to - t - 0.5;
  return 8;
}

/**
 * Echo out for grooves whose tempos cannot be locked, not even at 2:1 (DJ practice for gaps over
 * ~30 %): A finishes a sung phrase, its next bar is thrown into a one-beat echo (bass removed first),
 * A stops on the downbeat, and B starts on its own start/downbeat under the echo tail, late enough
 * that at least a bar of instrumental separates A's last line from B's first (silent pre-roll in B's
 * skipped intro, else bDelay; a B that sings at once may instead start over A's beatless tail). The
 * two grooves never play together. Unmeasured voice or level curves, unsteady grids, or any plan
 * whose vocal handoff would mask A's last or B's first words return null (caller keeps its blend).
 */
export function planEchoOut(base: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, s: AutoMixSettings, stretchPercent: number): TransitionPlan | null {
  const ga = A.beat, gb = B.beat;
  if (stretchPercent < ECHO_OUT_MIN_STRETCH || !ga || !gb || !ga.stable || !gb.stable || ga.confidence < 0.6 || gb.confidence < 0.45
    || ga.downbeatConfidence < 0.3 || A.rhythmStrength <= 0.45 || B.rhythmStrength <= 0.45 || !A.vocalActivity || !B.vocalActivity) return null;
  const beat = ga.period, bar = 4 * beat, need = Math.max(bar, 2);
  // B: its audible start, or a later downbeat that skips only instrumental intro (never a sung word)
  const skip = s.entryMode === 'preserve' ? 0 : Math.min(s.maxEntrySkipSeconds ?? 45, (B.audibleEnd - B.audibleStart) * 0.45);
  const look = Math.min(B.audibleEnd, B.audibleStart + skip + 12);
  if (!voiceKnown(B, B.audibleStart, look)) return null;
  let voiceB = Infinity;
  for (let t = B.audibleStart; t < look; t += 0.02) if (sung(B, t)) { voiceB = t; break; }
  const entries = [B.audibleStart, ...gb.downbeats.filter(t => t > B.audibleStart && t <= B.audibleStart + skip && t <= voiceB - 0.15)]
    .map(entry => ({ entry, lead: voiceB - entry, quiet: quietFor(B, entry, entry + 8) }))
    .filter(e => e.quiet < 8);
  // A: a downbeat in the last 40 s where A is not singing; the bar before it goes into the echo
  const options: { cost: number; d: number; lastA: number; lostA: number; entry: number; lead: number; bDelay: number; valley: number }[] = [];
  for (const d of ga.downbeats) {
    if (d < Math.max(A.audibleStart + 30, A.audibleEnd - 40) || d > A.audibleEnd - 0.5) continue;
    const start = d - bar;
    if (!voiceKnown(A, start - 10, A.audibleEnd) || Number.isNaN(level(A, A.curves.rmsDb, start, d))
      || vocalMean(A, d - 0.1, d + 0.25) >= 0.18) continue;
    const lostA = vocalMean(A, d, A.audibleEnd) * (A.audibleEnd - d);
    if (lostA > 3) continue;
    let lastA = -Infinity;
    for (let t = d; t >= start - 10; t -= 0.02) if (sung(A, t)) { lastA = t - start; break; }
    const quietA = quietBefore(A, d);
    for (const e of entries) {
      const bDelay = Math.max(bar + beat, lastA + need - e.lead);
      if (bDelay > 2 * bar + 1e-6) continue;
      const valley = quietA + (bDelay - bar) + e.quiet;
      if (valley > 5) continue;
      options.push({ cost: lostA + 0.03 * (A.audibleEnd - d) + 0.3 * valley, d, lastA, lostA, entry: e.entry, lead: e.lead, bDelay, valley });
    }
  }
  options.sort((x, y) => x.cost - y.cost);
  for (const best of options.slice(0, 8)) {
    const p = build(best);
    // finishPlan applies the shared vocal handoff; keep a candidate only if it keeps both decks' words
    const h = applyVocalHandoff(p, A, B, s), shift = p.bDelay ?? 0;
    let ok = true;
    for (let t = 0; t < bar && ok; t += 0.05) if (sung(A, p.aExit + t) && pointValue(h.vocalA ?? [[0, 1]], t) < 0.5) ok = false;
    for (let t = 0; t < p.duration - shift && ok; t += 0.05)
      if (pointValue(p.automation[3].points, t) > 0.5 && sung(B, p.bEntry + t) && pointValue(h.vocalB ?? [[0, 1]], t) < 0.5) ok = false;
    if (ok) return p;
  }
  return tailSegue();

  /** B sings from its first moment, so it cannot wait silently: when A's ending after its last line is
   * already a quiet beatless tail, B starts at its beginning over that tail while A fades into the echo. */
  function tailSegue(): TransitionPlan | null {
    const from = Math.max(A.audibleStart, A.audibleEnd - 40);
    if (!voiceKnown(A, from, A.audibleEnd)) return null;
    let lastA = -Infinity, quiet = A.audibleEnd;
    for (let t = A.audibleEnd; t >= from; t -= 0.02) if (sung(A, t)) { lastA = t; break; }
    // A's own ending: clearly under its body and without its bass/kick (no second groove under B)
    const bodyLow = level(A, A.curves.lowDb, A.audibleStart, A.audibleEnd);
    for (let t = A.audibleEnd - 0.5; t >= from && level(A, A.curves.rmsDb, t, t + 0.5) < A.bodyRmsDb - 6
      && level(A, A.curves.lowDb, t, t + 0.5) < bodyLow - 15; t -= 0.25) quiet = t;
    const bEntry = Math.max(0, B.audibleStart - 0.5), lead = voiceB - bEntry;
    const aExit = Math.max(quiet, lastA + 0.3, lastA + need - lead), fade = Math.min(bar, A.audibleEnd - aExit);
    if (aExit > A.audibleEnd - 1.5 || aExit - Math.max(quiet, lastA) > 4 || quietFor(B, bEntry, bEntry + 8) > 4) return null;
    const D = r(Math.max(6, fade + 2));
    const p: TransitionPlan = {
      ...base, aExit: r(aExit), bEntry: r(bEntry), duration: D, swapAt: 0, tempoB: [[0, 1]],
      echo: { delay: r(echoDelay()), feedback: 0.55 },
      automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [r(fade / 2), 0.7], [r(fade), 0], [D, 0]] },
        { deck: 'A', lane: 'echo', points: [[0, 0.5], [r(fade), 0.5], [r(fade + 0.02), 0], [D, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [0.02, 1], [D, 1]] },
      ],
      confidence: r(Math.min(0.6, ga!.confidence, gb!.confidence)),
      reasons: [`эхо-выход: темпы ${ga!.bpm.toFixed(0)} и ${gb!.bpm.toFixed(0)} BPM не сводятся по битам — текущий трек допевает и уходит своим тихим окончанием в эхо, следующий начинается с начала поверх него`,
        'ритмы двух треков не звучат одновременно; между последней строкой текущего и первой строкой следующего — не меньше такта инструментала'],
      debug: { ...base.debug, variant: 'echo-tail', echoOut: { quietFrom: r(quiet), lastVoiceA: r(lastA), voiceLeadB: r(lead), voiceGap: r(aExit + lead - lastA) } },
    };
    const h = applyVocalHandoff(p, A, B, s);
    for (let t = 0; t < D; t += 0.05) if (sung(B, bEntry + t) && pointValue(h.vocalB ?? [[0, 1]], t) < 0.5) return null;
    return p;
  }

  function echoDelay(): number {
    let delay = beat;
    while (delay < 0.3) delay *= 2;
    while (delay > 0.8) delay /= 2;
    return delay;
  }

  function build(best: typeof options[number]): TransitionPlan {
    const cut = r(bar), start = r(best.bDelay), D = r(Math.max(6, start + 1, cut + 2 * bar));
    // B rolls silently from earlier in its skipped intro when it can: one clock for every lane and
    // mask. Only a B that must start at its very beginning waits with bDelay.
    const preroll = best.entry - start >= 0;
    return {
      ...base,
      aExit: r(best.d - bar), bEntry: r(preroll ? best.entry - start : best.entry), duration: D, swapAt: cut, tempoB: [[0, 1]],
      ...(preroll ? {} : { bDelay: start }),
      echo: { delay: r(echoDelay()), feedback: 0.55 },
      automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [r(cut - 0.03), 1], [cut, 0], [D, 0]] },
        // the echo repeats A's last beat without its bass (808 tails would boom under B)
        { deck: 'A', lane: 'low', points: [[0, 1], [r(cut - beat), 1], [r(cut - 0.05), 0], [D, 0]] },
        // pre-fader send: closed at the cut so A's music after it never feeds the echo
        { deck: 'A', lane: 'echo', points: [[0, 0], [r(cut - 2 * beat), 0], [r(cut - beat), 0.7], [cut, 0.7], [r(cut + 0.02), 0], [D, 0]] },
        { deck: 'B', lane: 'gain', points: preroll ? [[0, 0], [start, 0], [r(start + 0.02), 1], [D, 1]] : [[0, 0], [0.02, 1], [r(D - start), 1]] },
      ],
      confidence: r(Math.min(0.7, ga!.confidence, gb!.confidence)),
      reasons: [`эхо-выход: темпы ${ga!.bpm.toFixed(0)} и ${gb!.bpm.toFixed(0)} BPM не сводятся по битам — текущий трек заканчивает фразу, его последний такт уходит в эхо, следующий входит со своей сильной доли под хвост эха`,
        'ритмы двух треков не звучат одновременно; между последней строкой текущего и первой строкой следующего — не меньше такта инструментала'],
      debug: { ...base.debug, variant: 'echo-out', echoOut: { cutSource: r(best.d), bStartsAt: start, bSource: r(best.entry), preroll,
        lastVoiceA: r(best.lastA), voiceLeadB: r(best.lead), voiceGap: r(start + best.lead - best.lastA), lostA: r(best.lostA), valley: r(best.valley), cost: r(best.cost) } },
    };
  }
}
