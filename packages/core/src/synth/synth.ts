/**
 * Procedural music generator. Produces license-free test and demo material
 * with known ground truth (tempo, beat positions, key, structure).
 */

export type SynthStyle = 'house' | 'techno' | 'hiphop' | 'dnb' | 'ambient' | 'acoustic' | 'pop';

export interface SynthSpec {
  style: SynthStyle;
  bpm: number;
  /** Pitch class of tonic, 0 = C. */
  tonic: number;
  mode: 'major' | 'minor';
  bars: number;
  seed: number;
  sampleRate?: number;
  /** Silence before the music starts, seconds. */
  leadSilence?: number;
  /** Silence after the music, seconds. */
  tailSilence?: number;
  /** Bars of drums-only intro/outro (DJ friendly structure). */
  introBars?: number;
  outroBars?: number;
  /** Overall level, linear. */
  level?: number;
  /** End with a sustained fade instead of a hard stop. */
  fadeOut?: boolean;
  /**
   * Click-free instruments (no noise transients): any discontinuity in a
   * rendered mix of clean tracks is then a real engine artifact.
   */
  clean?: boolean;
}

export interface SynthResult {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  /** Ground truth beat times in seconds. */
  beats: number[];
  downbeats: number[];
  musicStart: number;
  musicEnd: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function chordProgression(tonic: number, mode: 'major' | 'minor'): number[][] {
  // returns chords as pitch-class offsets triads relative to tonic
  if (mode === 'minor') return [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]]; // i VI III VII
  return [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]]; // I V vi IV
}

export function synthesize(spec: SynthSpec): SynthResult {
  const sr = spec.sampleRate ?? 44100;
  const rand = rng(spec.seed);
  const lead = spec.leadSilence ?? 0;
  const tail = spec.tailSilence ?? 0;
  const style = spec.style;
  const rubato = style === 'acoustic';
  const beatsPerBar = 4;
  const totalBeats = spec.bars * beatsPerBar;
  // beat times (rubato: slowly drifting tempo and human timing)
  const beats: number[] = [];
  let t = lead;
  let tempoDrift = 0;
  for (let i = 0; i < totalBeats; i++) {
    beats.push(t);
    let p = 60 / spec.bpm;
    if (rubato) {
      tempoDrift += (rand() - 0.5) * 0.02;
      tempoDrift = Math.max(-0.1, Math.min(0.1, tempoDrift));
      p *= 1 + tempoDrift + (rand() - 0.5) * 0.04;
    }
    t += p;
  }
  const musicEnd = t;
  const total = Math.ceil((musicEnd + tail + (spec.fadeOut ? 0 : 0.6)) * sr);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const level = spec.level ?? 0.5;
  const prog = chordProgression(spec.tonic, spec.mode);
  const root = 36 + spec.tonic; // bass octave
  const intro = spec.introBars ?? (style === 'ambient' || style === 'acoustic' ? 0 : 8);
  const outro = spec.outroBars ?? (style === 'ambient' || style === 'acoustic' ? 0 : 8);
  const hasDrums = style !== 'ambient' && style !== 'acoustic';

  const add = (start: number, buf: Float32Array, gainL: number, gainR: number) => {
    const s0 = Math.round(start * sr);
    for (let i = 0; i < buf.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= total) continue;
      L[j] += buf[i] * gainL;
      R[j] += buf[i] * gainR;
    }
  };

  // ---- instrument renderers (cached where deterministic)
  const kickBuf = (() => {
    const n = Math.round(sr * 0.35);
    const b = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const x = i / sr;
      const f = 45 + 95 * Math.exp(-x * 30);
      ph += (2 * Math.PI * f) / sr;
      const att = spec.clean ? Math.min(1, x / 0.002) : 1;
      b[i] = Math.sin(ph) * Math.exp(-x * 9) * att + (!spec.clean && i < sr * 0.003 ? (rand() - 0.5) * 0.6 : 0);
    }
    return b;
  })();
  const toneBurst = (hz: number, dur: number, decay: number) => {
    const n = Math.round(sr * dur);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / sr;
      const att = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, x / 0.002));
      const rel = Math.min(1, (dur - x) / 0.004);
      b[i] = Math.sin(2 * Math.PI * hz * x) * Math.exp(-x * decay) * att * rel;
    }
    return b;
  };
  const noiseBurst = (dur: number, decay: number, hp: number) => {
    if (spec.clean) return toneBurst(hp * 1.1, dur, decay);
    const n = Math.round(sr * dur);
    const b = new Float32Array(n);
    let prev = 0;
    let y = 0;
    const a = Math.exp((-2 * Math.PI * hp) / sr);
    for (let i = 0; i < n; i++) {
      const x = rand() * 2 - 1;
      y = a * (y + x - prev);
      prev = x;
      b[i] = y * Math.exp((-i / sr) * decay);
    }
    return b;
  };
  const snareBuf = (() => {
    const b = spec.clean ? toneBurst(1800, 0.22, 18) : noiseBurst(0.22, 18, 1200);
    for (let i = 0; i < b.length; i++) b[i] = b[i] * 0.7 + Math.sin((2 * Math.PI * 185 * i) / sr) * Math.exp((-i / sr) * 25) * 0.6;
    return b;
  })();
  const hatBuf = noiseBurst(0.05, 70, 7000);
  const openHat = noiseBurst(0.18, 16, 6000);

  const tone = (freq: number, dur: number, kind: 'saw' | 'sine' | 'tri' | 'pluck', amp: number, attack = 0.005, release = 0.05) => {
    const n = Math.round(sr * dur);
    const b = new Float32Array(n);
    if (kind === 'pluck') {
      // Karplus-Strong string
      const period = Math.max(2, Math.round(sr / freq));
      const ring = new Float32Array(period);
      for (let i = 0; i < period; i++) ring[i] = rand() * 2 - 1;
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const next = (idx + 1) % period;
        const v = 0.497 * (ring[idx] + ring[next]);
        b[i] = ring[idx] * amp;
        ring[idx] = v;
        idx = next;
      }
      return b;
    }
    let ph = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      ph += freq / sr;
      ph -= Math.floor(ph);
      let v: number;
      if (kind === 'saw' && spec.clean) {
        // band-limited saw: no sample-level edges
        v = 0;
        const K = Math.max(1, Math.min(12, Math.floor(6000 / freq)));
        for (let h = 1; h <= K; h++) v += Math.sin(2 * Math.PI * h * ph) / h;
        v *= 0.6;
      } else if (kind === 'saw') v = 2 * ph - 1;
      else if (kind === 'tri' && spec.clean) {
        v = 0;
        for (let h = 1; h <= 7; h += 2) v += ((h % 4 === 1 ? 1 : -1) * Math.sin(2 * Math.PI * h * ph)) / (h * h);
        v *= 0.81;
      } else if (kind === 'tri') v = 4 * Math.abs(ph - 0.5) - 1;
      else v = Math.sin(2 * Math.PI * ph);
      if (kind === 'saw') {
        lp += 0.12 * (v - lp);
        v = lp;
      }
      const x = i / sr;
      const env = Math.min(1, x / attack) * Math.min(1, (dur - x) / release);
      b[i] = v * amp * Math.max(0, env);
    }
    return b;
  };

  const barDur = (bar: number) => (beats[bar * 4 + 4] ?? musicEnd) - beats[bar * 4];

  for (let bar = 0; bar < spec.bars; bar++) {
    const b0 = bar * 4;
    const inIntro = bar < intro;
    const inOutro = bar >= spec.bars - outro;
    const body = !inIntro && !inOutro;
    const chord = prog[Math.floor(bar / 2) % prog.length];
    const phraseStart = bar % 8 === 0;
    const section = Math.floor(bar / 8);
    const breakdown = body && style !== 'hiphop' && section % 4 === 2 && hasDrums;

    // drums
    if (hasDrums && !breakdown) {
      for (let k = 0; k < 4; k++) {
        const bt = beats[b0 + k];
        const nb = beats[b0 + k + 1] ?? bt + 60 / spec.bpm;
        const half = (bt + nb) / 2;
        const accent = k === 0 ? 1.0 : 0.85;
        if (style === 'house' || style === 'techno' || style === 'pop') {
          add(bt, kickBuf, 0.9 * accent, 0.9 * accent);
          if (k === 1 || k === 3) add(bt, snareBuf, 0.32, 0.36);
          add(half, style === 'techno' ? hatBuf : openHat, 0.12, 0.14);
          if (style === 'techno') add(bt, hatBuf, 0.08, 0.07);
        } else if (style === 'hiphop') {
          if (k === 0 || (k === 2 && bar % 2 === 0)) add(bt, kickBuf, 0.95, 0.95);
          if (k === 2 && bar % 2 === 1) add(half, kickBuf, 0.7, 0.7);
          if (k === 1 || k === 3) add(bt, snareBuf, 0.45, 0.45);
          add(bt, hatBuf, 0.1, 0.11);
          add(half, hatBuf, 0.07, 0.08);
        } else if (style === 'dnb') {
          // bpm counted at the fast rate: kick on 1, snare on 2 and 4 of the half-time feel spread over two beats
          if (k === 0 || (k === 2 && bar % 2 === 1)) add(bt, kickBuf, 0.85, 0.85);
          if (k === 1 || k === 3) add(bt, snareBuf, 0.42, 0.42);
          add(bt, hatBuf, 0.08, 0.09);
          add(half, hatBuf, 0.08, 0.07);
        }
        if (phraseStart && k === 0 && bar > 0) add(bt, openHat, 0.3, 0.3);
      }
    }
    // bass
    if (body && style !== 'ambient') {
      for (let k = 0; k < 4; k++) {
        const bt = beats[b0 + k];
        const nb = beats[b0 + k + 1] ?? bt + 60 / spec.bpm;
        const note = root + chord[0] + (spec.mode === 'minor' && chord[0] >= 8 ? -12 : 0);
        const hz = midiHz(note);
        if (style === 'house' || style === 'pop') add((bt + nb) / 2, tone(hz, (nb - bt) * 0.45, 'saw', 0.5), 0.5, 0.5);
        else if (style === 'techno') add(bt + (nb - bt) * 0.25, tone(hz, (nb - bt) * 0.5, 'saw', 0.45), 0.45, 0.45);
        else if (style === 'acoustic') add(bt, tone(hz * 2, (nb - bt) * 0.95, 'pluck', 0.35), 0.4, 0.3);
        else add(bt, tone(hz, (nb - bt) * 0.9, 'sine', 0.55), 0.55, 0.55);
      }
    }
    // chords
    if (!inIntro || style === 'ambient' || style === 'acoustic') {
      const bt = beats[b0];
      const dur = barDur(bar);
      for (const off of chord) {
        const hz = midiHz(60 + spec.tonic + off - (off >= 12 ? 12 : 0));
        if (style === 'acoustic') {
          for (let k = 0; k < 4; k++) add(beats[b0 + k] + k * 0.012, tone(hz, (dur / 4) * 1.4, 'pluck', 0.25), 0.25, 0.3);
        } else {
          const amp = style === 'ambient' ? 0.16 : inOutro ? 0.06 : 0.09;
          const det = 1.003;
          add(bt, tone(hz, dur * 1.02, 'saw', amp, style === 'ambient' ? 0.8 : 0.02, style === 'ambient' ? 0.8 : 0.08), 0.6, 0.4);
          add(bt, tone(hz * det, dur * 1.02, 'saw', amp, style === 'ambient' ? 0.8 : 0.02, style === 'ambient' ? 0.8 : 0.08), 0.4, 0.6);
        }
      }
    }
    // melodic lead in the "vocal" band, only in the body (simulates a vocal line)
    if (body && (section % 2 === 1 || style === 'pop') && style !== 'ambient') {
      const scale = spec.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
      for (let k = 0; k < 8; k++) {
        if (rand() < 0.3) continue;
        const bt = beats[b0 + Math.floor(k / 2)] + (k % 2) * ((beats[b0 + 1] ?? beats[b0] + 0.5) - beats[b0]) * 0.5;
        const deg = scale[Math.floor(rand() * scale.length)];
        const hz = midiHz(72 + spec.tonic + deg);
        add(bt, tone(hz, 60 / spec.bpm / 2, 'tri', 0.14, 0.01, 0.06), 0.5, 0.5);
      }
    }
  }

  // master: level, gentle fade out option, soft clip
  const startS = Math.round(lead * sr);
  const endS = Math.round(musicEnd * sr);
  for (let i = 0; i < total; i++) {
    let g = level;
    if (spec.fadeOut && i > endS - sr * 8) g *= Math.max(0, (endS - i) / (sr * 8));
    if (i < startS) g = 0;
    L[i] = Math.tanh(L[i] * g);
    R[i] = Math.tanh(R[i] * g);
  }
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return { L, R, sampleRate: sr, beats, downbeats, musicStart: lead, musicEnd };
}

/** Mono mix at 22050 Hz by simple 2:1 averaging (inputs at 44100). */
export function toAnalysisMono(L: Float32Array, R: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 22050) {
    const m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2;
    return m;
  }
  if (sampleRate !== 44100) throw new Error('toAnalysisMono expects 44100 Hz');
  const n = Math.floor(L.length / 2);
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (L[2 * i] + R[2 * i] + L[2 * i + 1] + R[2 * i + 1]) / 4;
  return m;
}
