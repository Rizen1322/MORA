import { CURVE_RATE } from '../types.ts';
import { getFFT, hann } from '../dsp/fft.ts';

export const ANALYSIS_RATE = 22050;
export const FRAME = 2048;
export const HOP = 256;
export const CHROMA_FRAME = 4096;
export const CHROMA_EVERY = 4; // hops
export const MEL_BANDS = 24;

export interface SpectralData {
  fps: number;
  frames: number;
  /** Onset strength (spectral flux) per band, per STFT frame. */
  fluxLow: Float32Array;
  fluxMid: Float32Array;
  fluxHigh: Float32Array;
  /** Band power per STFT frame (linear, normalized). */
  powLow: Float32Array;
  powMid: Float32Array;
  powHigh: Float32Array;
  centroid: Float32Array;
  /** Harmonic density heuristic in 250-4000 Hz, 0..1, per frame. */
  midDensity: Float32Array;
  /** 12-bin chroma per chroma frame (row-major). */
  chroma: Float32Array;
  chromaFps: number;
  chromaFrames: number;
  /** Linear power in MEL_BANDS triangular mel bands (40 Hz - 8 kHz) per STFT frame (row-major); timbre for structure. */
  mel: Float32Array;
  /** Time domain curves at CURVE_RATE. */
  rmsDb: Float32Array;
  peaks: Float32Array;
}

const db = (p: number) => 10 * Math.log10(p + 1e-12);

export function computeSpectral(x: Float32Array, sr = ANALYSIS_RATE): SpectralData {
  const fft = getFFT(FRAME);
  const win = hann(FRAME);
  const winSum = FRAME / 2;
  const nBins = FRAME / 2 + 1;
  const frames = Math.max(1, Math.floor((x.length - FRAME) / HOP) + 1);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const prev = new Float64Array(nBins);
  const cur = new Float64Array(nBins);
  const binHz = sr / FRAME;
  const bin = (hz: number) => Math.min(nBins - 1, Math.max(1, Math.round(hz / binHz)));
  const bLow0 = bin(30);
  const bLow1 = bin(150);
  const bMid1 = bin(2500);
  const bHigh1 = bin(10000);
  const bD0 = bin(250);
  const bD1 = bin(4000);

  const fluxLow = new Float32Array(frames);
  const fluxMid = new Float32Array(frames);
  const fluxHigh = new Float32Array(frames);
  const powLow = new Float32Array(frames);
  const powMid = new Float32Array(frames);
  const powHigh = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const midDensity = new Float32Array(frames);
  const mel = new Float32Array(frames * MEL_BANDS);
  // bin k feeds band melBand[k] - 1 with 1 - melFrac[k] and band melBand[k] with melFrac[k]
  const toMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const melLo = toMel(40), melStep = (toMel(8000) - melLo) / (MEL_BANDS + 1);
  const melBand = new Int16Array(nBins).fill(-2);
  const melFrac = new Float32Array(nBins);
  for (let k = 1; k < nBins; k++) {
    const pos = (toMel(k * binHz) - melLo) / melStep;
    if (pos < 0 || pos >= MEL_BANDS + 1) continue;
    melBand[k] = Math.floor(pos);
    melFrac[k] = pos - Math.floor(pos);
  }

  // chroma setup
  const cfft = getFFT(CHROMA_FRAME);
  const cwin = hann(CHROMA_FRAME);
  const cre = new Float64Array(CHROMA_FRAME);
  const cim = new Float64Array(CHROMA_FRAME);
  const cBinHz = sr / CHROMA_FRAME;
  const cMin = Math.ceil(110 / cBinHz);
  const cMax = Math.floor(3520 / cBinHz);
  const pcOf = new Int8Array(cMax + 1);
  const pcW = new Float32Array(cMax + 1);
  for (let k = cMin; k <= cMax; k++) {
    const midi = 69 + 12 * Math.log2((k * cBinHz) / 440);
    const r = Math.round(midi);
    pcOf[k] = ((r % 12) + 12) % 12;
    // triangular weighting: bins far from a semitone centre contribute less
    pcW[k] = Math.max(0, 1 - 2 * Math.abs(midi - r));
  }
  const cmag = new Float64Array(CHROMA_FRAME / 2 + 1);
  const chromaFrames = Math.ceil(frames / CHROMA_EVERY);
  const chroma = new Float32Array(chromaFrames * 12);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (x[off + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    let pL = 0;
    let pM = 0;
    let pH = 0;
    let num = 0;
    let den = 0;
    let fL = 0;
    let fM = 0;
    let fH = 0;
    let dSum = 0;
    let dLog = 0;
    let total = 0;
    for (let k = 1; k < nBins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / winSum;
      const p = mag * mag;
      total += p;
      const c = Math.log1p(100 * mag);
      cur[k] = c;
      const d = c - prev[k];
      if (k >= bLow0 && k < bLow1) {
        pL += p;
        if (d > 0) fL += d;
      } else if (k >= bLow1 && k < bMid1) {
        pM += p;
        if (d > 0) fM += d;
      } else if (k >= bMid1 && k < bHigh1) {
        pH += p;
        if (d > 0) fH += d;
      }
      if (k >= bD0 && k < bD1) {
        dSum += p;
        dLog += Math.log(p + 1e-14);
      }
      num += k * binHz * p;
      den += p;
      const mb = melBand[k];
      if (mb >= 1) mel[f * MEL_BANDS + mb - 1] += p * (1 - melFrac[k]);
      if (mb >= 0 && mb < MEL_BANDS) mel[f * MEL_BANDS + mb] += p * melFrac[k];
    }
    prev.set(cur);
    fluxLow[f] = fL;
    fluxMid[f] = fM / 4;
    fluxHigh[f] = fH / 8;
    powLow[f] = pL;
    powMid[f] = pM;
    powHigh[f] = pH;
    centroid[f] = den > 0 ? num / den : 0;
    const nD = bD1 - bD0;
    const flat = dSum > 0 ? Math.exp(dLog / nD) / (dSum / nD) : 1;
    const share = total > 0 ? dSum / total : 0;
    // tonal (non-flat) energy concentrated in the 250-4000 Hz band
    midDensity[f] = total > 1e-9 ? Math.min(1, (1 - Math.pow(flat, 0.25)) * Math.min(1, share * 1.6)) : 0;

    if (f % CHROMA_EVERY === 0) {
      const cf = f / CHROMA_EVERY;
      const coff = off + FRAME / 2 - CHROMA_FRAME / 2;
      for (let i = 0; i < CHROMA_FRAME; i++) {
        const idx = coff + i;
        cre[i] = (idx >= 0 && idx < x.length ? x[idx] : 0) * cwin[i];
        cim[i] = 0;
      }
      cfft.forward(cre, cim);
      const row = cf * 12;
      for (let k = 1; k <= cMax; k++) cmag[k] = Math.sqrt(cre[k] * cre[k] + cim[k] * cim[k]);
      for (let k = cMin; k <= cMax; k++) {
        const mag = cmag[k];
        // suppress bins that are likely the 3rd or 5th harmonic of a lower note;
        // otherwise overtones bias the chroma a fifth (or third) upwards
        const h3 = Math.max(cmag[Math.round(k / 3)] ?? 0, cmag[Math.round(k / 3) + 1] ?? 0, cmag[Math.round(k / 3) - 1] ?? 0);
        const h5 = Math.max(cmag[Math.round(k / 5)] ?? 0, cmag[Math.round(k / 5) + 1] ?? 0);
        let w = 1;
        if (h3 > mag * 0.6) w *= 0.25;
        if (h5 > mag * 0.6) w *= 0.5;
        chroma[row + pcOf[k]] += Math.log1p(10 * mag) * pcW[k] * w;
      }
    }
  }

  // time domain curves
  // Window edges from the exact rate: a rounded hop (1103 for 1102.5) drifts ~1.6 s per hour.
  const nCurve = Math.ceil((x.length * CURVE_RATE) / sr);
  const rmsDb = new Float32Array(nCurve);
  const peaks = new Float32Array(nCurve);
  for (let c = 0; c < nCurve; c++) {
    let s = 0;
    let pk = 0;
    const a = Math.floor((c * sr) / CURVE_RATE);
    const b = Math.min(x.length, Math.floor(((c + 1) * sr) / CURVE_RATE));
    for (let i = a; i < b; i++) {
      const v = x[i];
      s += v * v;
      const av = Math.abs(v);
      if (av > pk) pk = av;
    }
    rmsDb[c] = db(s / Math.max(1, b - a));
    peaks[c] = pk;
  }

  return {
    fps: sr / HOP,
    frames,
    fluxLow,
    fluxMid,
    fluxHigh,
    powLow,
    powMid,
    powHigh,
    centroid,
    midDensity,
    chroma,
    chromaFps: sr / HOP / CHROMA_EVERY,
    chromaFrames,
    mel,
    rmsDb,
    peaks,
  };
}

/** Resamples a per-frame series (at `fps`, frame centre = i/fps + FRAME/2/sr) onto CURVE_RATE. */
export function toCurve(series: Float32Array, fps: number, nCurve: number, sr = ANALYSIS_RATE, mapper?: (v: number) => number): number[] {
  const out = new Array<number>(nCurve);
  const centre = FRAME / 2 / sr;
  for (let c = 0; c < nCurve; c++) {
    const t0 = c / CURVE_RATE;
    const t1 = (c + 1) / CURVE_RATE;
    const a = Math.max(0, Math.floor((t0 - centre) * fps));
    const b = Math.min(series.length, Math.max(a + 1, Math.ceil((t1 - centre) * fps)));
    let s = 0;
    let n = 0;
    for (let i = a; i < b; i++) {
      s += series[i];
      n++;
    }
    const v = n ? s / n : 0;
    out[c] = mapper ? mapper(v) : v;
  }
  return out;
}

export { db as powerDb };
