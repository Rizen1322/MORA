import { CHUNK_FRAMES } from '../../../packages/core/src/engine/chunks.ts';
import { MixerCore, type MixerEvent } from '../../../packages/core/src/engine/mixer.ts';
import type { NativeMixConfig } from '../../web/src/lib/native-mix.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Values = new Uint8Array(128);
for (let i = 0; i < alphabet.length; i++) base64Values[alphabet.charCodeAt(i)] = i;
function decode(s: string): Float32Array {
  if (!s || s.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Missing PCM');
  const size = s.length / 4 * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  if (size % 8) throw new Error('Unaligned PCM');
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < s.length; i += 4) {
    const value = (base64Values[s.charCodeAt(i)] << 18) | (base64Values[s.charCodeAt(i + 1)] << 12)
      | (base64Values[s.charCodeAt(i + 2)] << 6) | base64Values[s.charCodeAt(i + 3)];
    out[at++] = value >>> 16;
    if (at < size) out[at++] = value >>> 8;
    if (at < size) out[at++] = value;
  }
  return new Float32Array(out.buffer);
}
export interface NativeMark { offset: number; index: number; position: number }

/** App-process producer only; this is never evaluated from an audio callback. */
export class NativeMixerRuntime {
  private core: MixerCore;
  private needs: Extract<MixerEvent, { type: 'need' }>[] = [];
  private events: Exclude<MixerEvent, { type: 'tick' } | { type: 'need' }>[] = [];
  private advance = false;
  private done = false;
  private tail = -1;
  constructor(private config: NativeMixConfig, private read: (index: number, chunk: number) => string) {
    if (![44100, 48000].includes(config.sampleRate) || config.tracks.length !== 2) throw new Error('Invalid native pair');
    this.core = new MixerCore(config.sampleRate, event => {
      if (event.type === 'need') this.needs.push(event);
      else if (event.type !== 'tick') {
        if (event.type === 'underrun') throw new Error('Native PCM underrun');
        this.events.push(event);
        if (event.type === 'ended') {
          if (event.deck === 0 && this.core.main === 0) this.advance = true;
          if (event.deck === 1 && this.core.main === 1) this.tail = Math.ceil(config.sampleRate * .1 / 128) * 128;
        }
      }
    });
    // MixerCore's transition admission needs up to 3 s * 1.15 + 4096 frames.
    // requestData adds 10%; four seconds covers that gate even before chunk rounding.
    this.core.aheadSeconds = 4;
    config.tracks.forEach((track, i) => this.core.load(i, i ? 'B' : 'A', track.totalFrames, track.gainDb,
      i === 1 ? config.transition?.entryFrame ?? 0 : 0));
    const index = config.index === 1 ? 1 : 0;
    const position = Math.max(0, Math.min(config.position, config.tracks[index].totalFrames / config.sampleRate));
    this.core.start(index, index ? 'B' : 'A', Math.round(position * config.sampleRate));
    if (config.tone) this.core.setTone(config.tone, config.preDb);
    const plan = config.transition;
    if (index === 0 && plan && position * config.sampleRate < plan.triggerFrame) {
      if (plan.vocalA || plan.vocalB || plan.voiceEchoDelayFrames) throw new Error('Native pair requires full-mix plan');
      this.core.arm({ ...plan, fromToken: 'A', toToken: 'B' });
    }
    this.supply();
  }
  private supply() {
    for (const need of this.needs.splice(0)) {
      if (need.part === 'vocals') throw new Error('Native stems are not prepared');
      for (const chunk of need.chunks) {
        const input = decode(this.read(need.deck, chunk));
        const expected = Math.min(CHUNK_FRAMES, this.config.tracks[need.deck].totalFrames - chunk * CHUNK_FRAMES);
        if (input.length !== expected * 2) throw new Error('Short native PCM');
        const left = new Float32Array(expected), right = new Float32Array(expected);
        for (let i = 0; i < expected; i++) {
          left[i] = input[i * 2]; right[i] = input[i * 2 + 1];
          if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Nonfinite native PCM');
        }
        this.core.feed(need.deck, need.token, chunk, left, right);
      }
    }
  }
  render() {
    const left = new Float32Array(4096), right = new Float32Array(4096);
    const marks: NativeMark[] = [];
    const mark = (offset: number) => marks.push({ offset, index: this.core.main,
      position: this.core.decks[this.core.main].position() / this.config.sampleRate });
    let length = 0;
    while (length < left.length && !this.done) {
      if (this.advance) { this.advance = false; this.core.start(1, 'B', 0); }
      this.supply(); mark(length);
      this.core.process(left.subarray(length, length + 128), right.subarray(length, length + 128), 128);
      for (let i = length; i < length + 128; i++) {
        if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Nonfinite native output');
      }
      length += 128;
      if (this.tail > 0) { this.tail -= 128; if (this.tail <= 0) this.done = true; }
    }
    mark(length);
    const events = this.events.splice(0);
    return { left: left.subarray(0, length), right: right.subarray(0, length), marks, events, done: this.done };
  }
}

declare const moraReadPcm: (index: number, chunk: number) => string;
export function create(config: NativeMixConfig) { return new NativeMixerRuntime(config, moraReadPcm); }
