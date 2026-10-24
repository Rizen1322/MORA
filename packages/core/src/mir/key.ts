import type { KeyInfo } from '../types.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_NAMES_RU = ['до', 'до-диез', 'ре', 'ре-диез', 'ми', 'фа', 'фа-диез', 'соль', 'соль-диез', 'ля', 'ля-диез', 'си'];

// Krumhansl-Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

export function camelotOf(tonic: number, mode: 'major' | 'minor'): string {
  return mode === 'minor' ? `${CAMELOT_MINOR[tonic]}A` : `${CAMELOT_MAJOR[tonic]}B`;
}

export function keyName(tonic: number, mode: 'major' | 'minor'): string {
  return `${NOTE_NAMES[tonic]} ${mode}`;
}

export function keyNameRu(k: KeyInfo): string {
  if (k.tonic < 0 || k.mode === 'unknown') return 'не определена';
  return `${NOTE_NAMES_RU[k.tonic]} ${k.mode === 'major' ? 'мажор' : 'минор'}`;
}

export function parseCamelot(code: string): { n: number; letter: 'A' | 'B' } | null {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return null;
  return { n: Number(m[1]), letter: m[2] as 'A' | 'B' };
}

/**
 * Harmonic compatibility of two Camelot codes, 0..1.
 * Same key 1, ±1 on the wheel or relative major/minor 0.85, ±2 or diagonal 0.55,
 * everything else drops off. Unknown keys return 0.5 (neutral).
 */
export function camelotCompatibility(a: string, b: string): { score: number; label: string } {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return { score: 0.5, label: 'тональность неизвестна' };
  const diff = Math.min((pa.n - pb.n + 12) % 12, (pb.n - pa.n + 12) % 12);
  if (pa.letter === pb.letter) {
    if (diff === 0) return { score: 1, label: 'та же тональность' };
    if (diff === 1) return { score: 0.85, label: 'соседняя тональность' };
    if (diff === 2) return { score: 0.55, label: 'близкая тональность' };
    if (diff === 7) return { score: 0.45, label: 'энергетический сдвиг' };
    return { score: Math.max(0.05, 0.4 - diff * 0.06), label: 'конфликт тональностей' };
  }
  if (diff === 0) return { score: 0.85, label: 'параллельный мажор/минор' };
  if (diff === 1) return { score: 0.55, label: 'диагональный переход' };
  return { score: Math.max(0.05, 0.35 - diff * 0.05), label: 'конфликт тональностей' };
}

function correlate(x: number[], profile: number[], shift: number): number {
  const n = 12;
  let mx = 0;
  let mp = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    mp += profile[i];
  }
  mx /= n;
  mp /= n;
  let num = 0;
  let dx = 0;
  let dp = 0;
  for (let i = 0; i < n; i++) {
    const a = x[(i + shift) % n] - mx;
    const b = profile[i] - mp;
    num += a * b;
    dx += a * a;
    dp += b * b;
  }
  return num / Math.sqrt(Math.max(1e-12, dx * dp));
}

/**
 * Key estimation from an averaged chroma vector.
 * Confidence measures how much better the best key is than the best key that
 * would NOT be considered compatible for mixing (relative keys are near ties
 * by construction, which is fine for Camelot mixing).
 */
export function estimateKey(chroma: number[]): KeyInfo {
  const total = chroma.reduce((a, b) => a + b, 0);
  const unknown: KeyInfo = { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 };
  if (!(total > 0)) return unknown;
  const mean = total / 12;
  const varc = chroma.reduce((a, b) => a + (b - mean) ** 2, 0) / 12;
  const cv = Math.sqrt(varc) / mean;
  const cands: { tonic: number; mode: 'major' | 'minor'; r: number }[] = [];
  for (let t = 0; t < 12; t++) {
    cands.push({ tonic: t, mode: 'major', r: correlate(chroma, MAJOR, t) });
    cands.push({ tonic: t, mode: 'minor', r: correlate(chroma, MINOR, t) });
  }
  cands.sort((a, b) => b.r - a.r);
  const best = cands[0];
  const bestCode = camelotOf(best.tonic, best.mode);
  const rival = cands.find((c) => camelotCompatibility(bestCode, camelotOf(c.tonic, c.mode)).score < 0.8);
  const margin = rival ? best.r - rival.r : best.r;
  // flat chroma (drums, noise) carries no key information
  const flatPenalty = Math.min(1, cv / 0.25);
  const confidence = Math.max(0, Math.min(1, (margin / 0.25) * Math.min(1, Math.max(0, (best.r - 0.3) / 0.4)) * flatPenalty));
  if (best.r < 0.35 || confidence < 0.08) return { ...unknown, confidence };
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: keyName(best.tonic, best.mode),
    camelot: bestCode,
    confidence,
  };
}
