import { FFT } from '@automix/core/dsp/fft.ts';
import type { DesktopBridge } from '../lib/desktop.ts';
import type { EngineCommand, EngineEvent } from './engine.worklet.ts';

/** Native timing adapter; it creates no Web Audio output or browser audio thread. */
export class DesktopAudioContext {
  state: AudioContextState = 'running';
  readonly baseLatency: number;
  constructor(readonly sampleRate: number, queueFrames: number, private bridge: DesktopBridge) { this.baseLatency = queueFrames / sampleRate; }
  get currentTime() { return performance.now() / 1000; }
  async resume() { await this.bridge.audioCommand!({ cmd: 'resume' }); this.state = 'running'; }
  async suspend() { await this.bridge.audioCommand!({ cmd: 'suspend' }); this.state = 'suspended'; }
  async setSinkId(device: string) { await this.bridge.audioCommand!({ cmd: 'output', device }); }
}

/** Spectrum for existing visuals, calculated from the native device's output samples. */
export class DesktopAnalyser {
  readonly fftSize = 2048;
  private waveform = new Float32Array(2048);
  private bins = new Float32Array(1024).fill(-Infinity);
  private fft = new FFT(2048);
  private re = new Float64Array(2048);
  private im = new Float64Array(2048);
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
  feed(samples: number[]) {
    if (samples.length !== this.fftSize || !samples.every(Number.isFinite)) return;
    this.waveform.set(samples);
    for (let i = 0; i < this.fftSize; i++) this.re[i] = samples[i] * (.42 - .5 * Math.cos(2 * Math.PI * i / this.fftSize) + .08 * Math.cos(4 * Math.PI * i / this.fftSize));
    this.im.fill(0);
    this.fft.forward(this.re, this.im);
    for (let i = 0; i < this.bins.length; i++) this.bins[i] = 20 * Math.log10(Math.max(1e-12, Math.hypot(this.re[i], this.im[i]) / this.fftSize));
  }
  getFloatFrequencyData(out: Float32Array) { out.fill(-Infinity); out.set(this.bins.subarray(0, out.length)); }
  getFloatTimeDomainData(out: Float32Array) { out.fill(0); out.set(this.waveform.subarray(0, out.length)); }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(0);
    for (let i = 0; i < Math.min(out.length, this.bins.length); i++) out[i] = Math.round(Math.max(0, Math.min(255, (this.bins[i] + 100) / 70 * 255)));
  }
}

/** Reference for the native ports: Blackman window, 2048-point FFT, dB = 20·log10(|X|/N), averaged per band. */
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

export async function createDesktopEngine(bridge: DesktopBridge, onEvent: (event: EngineEvent) => void, onError: (message: string) => void, device = '') {
  let analyser: DesktopAnalyser | undefined;
  let failed: string | undefined;
  const fail = (message: string) => { if (failed === undefined) { failed = message; onError(message); } };
  const unsubscribe = bridge.onAudio!(event => {
    if (event.type === 'fatal') fail(event.error);
    else if (event.type === 'waveform') analyser?.feed(event.samples);
    else if (event.type === 'levels') analyser?.levels(event.rms, event.bands);
    else onEvent(event);
  });
  try {
    const ready = await bridge.audioStart!(device);
    if (failed !== undefined) throw new Error(failed);
    const context = new DesktopAudioContext(ready.sampleRate, ready.queueFrames, bridge);
    analyser = new DesktopAnalyser(context);
    const node = { port: { postMessage(command: EngineCommand, _transfer?: Transferable[]) {
      if (failed === undefined) void bridge.audioCommand!(command).catch(error => fail((error as Error).message));
    } } };
    return { context, analyser, node, unsubscribe };
  } catch (error) { unsubscribe(); throw error; }
}
