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
  constructor(readonly context: DesktopAudioContext) {}
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

export async function createDesktopEngine(bridge: DesktopBridge, onEvent: (event: EngineEvent) => void, onError: (message: string) => void, device = '') {
  let analyser: DesktopAnalyser | undefined;
  let failed: string | undefined;
  const fail = (message: string) => { if (failed === undefined) { failed = message; onError(message); } };
  const unsubscribe = bridge.onAudio!(event => {
    if (event.type === 'fatal') fail(event.error);
    else if (event.type === 'waveform') analyser?.feed(event.samples);
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
