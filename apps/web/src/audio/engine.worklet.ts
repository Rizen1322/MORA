/// <reference lib="webworker" />
/**
 * AudioWorklet processor: runs the shared MixerCore on the audio thread.
 * All timing (transition triggers, tempo maps, automation) is evaluated per
 * sample frame here, never with setTimeout.
 */
import { MixerCore, type ArmedTransition } from '@automix/core/engine/mixer.ts';
import type { ToneSettings } from '@automix/core/dsp/tone.ts';
import type { PlaybackSettings } from '@automix/core/dsp/playback.ts';
import type { MixerEvent } from '@automix/core';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
const audioNow = typeof performance !== 'undefined' ? performance.now.bind(performance) : Date.now;

export type EngineCommand = (
  | { cmd: 'load'; deck: number; token: string; totalFrames: number; gainDb: number; cueFrame: number }
  | { cmd: 'length'; deck: number; token: string; totalFrames: number }
  | { cmd: 'unload'; deck: number }
  | { cmd: 'feed'; deck: number; token: string; chunk: number; L: Float32Array; R: Float32Array }
  | { cmd: 'feedVocal'; deck: number; token: string; chunk: number; L: Float32Array; R: Float32Array }
  | { cmd: 'disableVocals'; deck: number; token: string }
  | { cmd: 'resetVocals'; deck: number; token: string }
  | { cmd: 'nack'; deck: number; token: string; chunk: number; part?: 'vocals' }
  | { cmd: 'start'; deck: number; token: string; frame: number }
  | { cmd: 'seek'; token: string; frame: number }
  | { cmd: 'pause'; paused: boolean }
  | { cmd: 'volume'; value: number }
  | { cmd: 'tone'; settings: ToneSettings; preDb: number }
  | { cmd: 'playback'; settings: PlaybackSettings }
  | { cmd: 'gain'; deck: number; gainDb: number }
  | { cmd: 'cue'; deck: number; frame: number }
  | { cmd: 'arm'; transition: ArmedTransition }
  | { cmd: 'disarm' }
  | { cmd: 'finish'; fade: number }
  | { cmd: 'tickRate'; seconds: number }
  | { cmd: 'stop' }) & { diagnostic?: { id: string; seq: number } };

export type EngineEvent = MixerEvent | {
  type: 'diagnostic'; stage: 'engine.ack' | 'engine.render'; id: string; seq: number;
  command: string; paused: boolean; clock: number; peak?: number;
};

class AutoMixProcessor extends AudioWorkletProcessor {
  private maxRenderMs = 0;
  private slowBlocks = 0;
  private healthFrames = 0;
  private core: MixerCore;
  private observations: { id: string; seq: number; command: string; waitPaused: boolean; frames: number }[] = [];
  constructor() {
    super();
    this.core = new MixerCore(sampleRate, (e) => this.port.postMessage(e));
    this.port.onmessage = (ev: MessageEvent<EngineCommand>) => this.handle(ev.data);
  }

  private handle(m: EngineCommand): void {
    const c = this.core;
    switch (m.cmd) {
      case 'load':
        c.load(m.deck, m.token, m.totalFrames, m.gainDb, m.cueFrame);
        break;
      case 'length':
        c.setLength(m.deck, m.token, m.totalFrames);
        break;
      case 'unload':
        c.unload(m.deck);
        break;
      case 'feed':
        c.feed(m.deck, m.token, m.chunk, m.L, m.R);
        break;
      case 'feedVocal':
        c.feedVocal(m.deck, m.token, m.chunk, m.L, m.R);
        break;
      case 'disableVocals':
        c.disableVocals(m.deck, m.token);
        break;
      case 'resetVocals':
        this.port.postMessage({type:'vocalsReset',deck:m.deck,token:m.token,applied:c.resetVocals(m.deck,m.token)});
        break;
      case 'nack':
        c.nack(m.deck, m.token, m.chunk, m.part);
        break;
      case 'start':
        c.start(m.deck, m.token, m.frame);
        break;
      case 'seek':
        c.seek(m.token, m.frame);
        break;
      case 'pause':
        c.setPaused(m.paused);
        break;
      case 'volume':
        c.setVolume(m.value);
        break;
      case 'tone':
        c.setTone(m.settings, m.preDb);
        break;
      case 'playback':
        c.setPlayback(m.settings);
        break;
      case 'gain':
        c.setGain(m.deck, m.gainDb);
        break;
      case 'cue':
        c.setCue(m.deck, m.frame);
        break;
      case 'arm':
        c.arm(m.transition);
        break;
      case 'disarm':
        c.disarm('controller');
        break;
      case 'finish':
        c.finishTransitionNow(m.fade);
        break;
      case 'stop':
        c.stopAll();
        break;
      case 'tickRate':
        c.setTickSeconds(m.seconds);
        break;
    }
    if (m.diagnostic) {
      this.port.postMessage({ type: 'diagnostic', stage: 'engine.ack', ...m.diagnostic, command: m.cmd, paused: c.paused, clock: c.clock });
      if (this.observations.length >= 16) this.observations.shift();
      this.observations.push({ ...m.diagnostic, command: m.cmd, waitPaused: m.cmd === 'pause' && m.paused, frames: 0 });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const began = audioNow();
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    const wasPaused = this.core.paused;
    this.core.process(L, R, L.length);
    if (this.observations.length) {
      // Pause uses a short fade. Observe rendered output after it settles, or after 0.5 s.
      // This is a render snapshot, not a promise that a seek/transition has finished.
      for (let i = this.observations.length - 1; i >= 0; i--) {
        const o = this.observations[i];
        o.frames += L.length;
        if (o.waitPaused && !(wasPaused && this.core.paused) && o.frames < sampleRate / 2) continue;
        let peak = 0;
        for (let j = 0; j < L.length; j++) peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
        this.port.postMessage({ type: 'diagnostic', stage: 'engine.render', id: o.id, seq: o.seq, command: o.command, paused: this.core.paused, clock: this.core.clock, peak });
        this.observations.splice(i, 1);
      }
    }
    const elapsed = Math.max(0, audioNow() - began);
    this.maxRenderMs = Math.max(this.maxRenderMs, elapsed);
    if (elapsed > L.length / sampleRate * 1000) this.slowBlocks++;
    this.healthFrames += L.length;
    if (this.healthFrames >= sampleRate) {
      this.healthFrames = 0;
      this.port.postMessage({ type: 'audioHealth', maxRenderMs: this.maxRenderMs, slowBlocks: this.slowBlocks });
    }
    return true;
  }
}

registerProcessor('automix-engine', AutoMixProcessor);
