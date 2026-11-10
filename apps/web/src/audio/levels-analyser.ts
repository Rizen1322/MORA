import { FFT } from '@automix/core/dsp/fft.ts';

/** Spectrum for existing visuals from native band levels (iOS mixes natively; no Web Audio analyser). */
export class LevelsAnalyser {
  readonly fftSize = 2048;
  private waveform = new Float32Array(2048);
  private bins = new Float32Array(1024).fill(-Infinity);
  constructor(readonly context: { sampleRate: number; currentTime: number; baseLatency?: number }) {}
  /** Native band levels: `rms` of the output block and 16 mean dB values over 40·2^(i/2)…40·2^((i+1)/2) Hz (see `bandLevels`). */
  levels(rms: number, bands: number[]) {
    if (!Number.isFinite(rms) || bands.length !== 16 || !bands.every(Number.isFinite)) return;
    this.waveform.fill(rms); // a constant block keeps the RMS that MusicMotion measures
    for (let i = 1; i < this.bins.length; i++) {
      const band = Math.floor(2 * Math.log2(i * this.context.sampleRate / this.fftSize / 40));
      this.bins[i] = bands[Math.max(0, Math.min(15, band))];
    }
  }
  getFloatFrequencyData(out: Float32Array) { out.fill(-Infinity); out.set(this.bins.subarray(0, out.length)); }
  getFloatTimeDomainData(out: Float32Array) { out.fill(0); out.set(this.waveform.subarray(0, out.length)); }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(0);
    for (let i = 0; i < Math.min(out.length, this.bins.length); i++) out[i] = Math.round(Math.max(0, Math.min(255, (this.bins[i] + 100) / 70 * 255)));
  }
}

/** Reference for the Swift port (NativeLevelMeter): Blackman window, 2048-point FFT, dB = 20·log10(|X|/N), averaged per band. */
export function bandLevels(samples: ArrayLike<number>, sampleRate: number): { rms: number; bands: number[] } {
  const n = 2048, fft = new FFT(n), re = new Float64Array(n), im = new Float64Array(n);
  let rms = 0;
  for (let i = 0; i < n; i++) { const x = samples[i] ?? 0; rms += x * x; re[i] = x * (.42 - .5 * Math.cos(2 * Math.PI * i / n) + .08 * Math.cos(4 * Math.PI * i / n)); }
  fft.forward(re, im);
  const bands = Array.from({ length: 16 }, (_, b) => {
    const lo = Math.max(1, Math.ceil(40 * 2 ** (b / 2) * n / sampleRate)), hi = Math.min(n / 2 - 1, Math.floor(40 * 2 ** ((b + 1) / 2) * n / sampleRate));
    let sum = 0, count = 0;
    for (let i = lo; i <= hi; i++) { sum += 20 * Math.log10(Math.max(1e-12, Math.hypot(re[i], im[i]) / n)); count++; }
    return count ? sum / count : -120;
  });
  return { rms: Math.sqrt(rms / n), bands };
}
