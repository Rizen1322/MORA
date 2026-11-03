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
type Track = NativeMixConfig['tracks'][number];

/** App-process producer only; this is never evaluated from an audio callback.
 * Track i plays on deck i % 2 with token `T${i}`; `current` is the outgoing/main track. */
export class NativeMixerRuntime {
  private core: MixerCore;
  private needs: Extract<MixerEvent, { type: 'need' }>[] = [];
  private events: Exclude<MixerEvent, { type: 'tick' } | { type: 'need' }>[] = [];
  private tracks: Track[];
  private current: number;
  private advance = false;
  private promote = false;
  private endedLast = false;
  private done = false;
  private tail = -1;
  constructor(private config: NativeMixConfig, private read: (file: number, chunk: number) => string) {
    if (![44100, 48000].includes(config.sampleRate) || !config.tracks.length) throw new Error('Invalid native queue');
    this.tracks = [...config.tracks];
    this.core = new MixerCore(config.sampleRate, event => {
      if (event.type === 'need') this.needs.push(event);
      else if (event.type !== 'tick') {
        if (event.type === 'underrun') throw new Error('Native PCM underrun');
        this.events.push(event);
        if (event.type === 'transitionEnd') this.promote = true;
        if (event.type === 'ended' && event.deck === this.current % 2 && this.core.main === event.deck) {
          if (this.current + 1 < this.tracks.length) this.advance = true;
          else { this.endedLast = true; this.tail = Math.ceil(config.sampleRate * .1 / 128) * 128; }
        }
      }
    });
    // MixerCore's transition admission needs up to 3 s * 1.15 + 4096 frames.
    // requestData adds 10%; four seconds covers that gate even before chunk rounding.
    this.core.aheadSeconds = 4;
    const index = Math.max(0, Math.min(this.tracks.length - 1, config.index ?? 0));
    this.current = index;
    const position = Math.max(0, Math.min(config.position, this.tracks[index].totalFrames / config.sampleRate));
    this.loadTrack(index, 0);
    this.core.start(index % 2, `T${index}`, Math.round(position * config.sampleRate));
    if (config.tone) this.core.setTone(config.tone, config.preDb);
    if (config.playback) this.core.setPlayback(config.playback);
    if (config.volume !== undefined) this.core.setVolume(config.volume);
    this.loadNext();
    this.supply();
  }
  private loadTrack(i: number, cue: number) {
    const t = this.tracks[i];
    this.core.load(i % 2, `T${i}`, t.totalFrames, t.gainDb, cue);
  }
  /** Loads the track after `current` on the free deck and arms its transition when still ahead. */
  private loadNext() {
    this.core.disarm('queue');
    const n = this.current + 1, next = this.tracks[n];
    if (!next) { this.core.unload(n % 2); return; }
    const plan = next.transition;
    this.loadTrack(n, plan?.entryFrame ?? 0);
    // Stem plans need vocal PCM the native store does not hold: play those gaplessly.
    if (plan && !plan.vocalA && !plan.vocalB && !plan.voiceEchoDelayFrames
      && this.core.decks[this.current % 2].position() < plan.triggerFrame) {
      this.core.arm({ ...plan, fromToken: `T${this.current}`, toToken: `T${n}` });
    }
  }
  /** Replaces tracks from `from`; false while that track is already audible or blending in. */
  update(from: number, tracks: Track[]): boolean {
    const blending = this.core.isTransitionActive() || this.promote || this.core.main !== this.current % 2;
    if (this.done || from <= this.current || (from === this.current + 1 && blending)) return false;
    this.tracks.splice(from, Infinity, ...tracks);
    if (from === this.current + 1) {
      this.loadNext();
      if (this.endedLast && this.tracks[from]) { this.endedLast = false; this.tail = -1; this.advance = true; }
    }
    return true;
  }
  private supply() {
    for (const need of this.needs.splice(0)) {
      if (need.part === 'vocals') throw new Error('Native stems are not prepared');
      const i = Number(need.token.slice(1)), track = this.tracks[i];
      if (!track || need.deck !== i % 2) continue;
      for (const chunk of need.chunks) {
        const input = decode(this.read(track.file ?? i, chunk));
        const expected = Math.min(CHUNK_FRAMES, track.totalFrames - chunk * CHUNK_FRAMES);
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
    const mark = (offset: number) => {
      const main = this.core.main;
      marks.push({ offset, index: main === this.current % 2 ? this.current : this.current + 1,
        position: this.core.decks[main].position() / this.config.sampleRate });
    };
    let length = 0;
    while (length < left.length && !this.done) {
      if (this.advance) {
        this.advance = false; this.current++;
        this.core.start(this.current % 2, `T${this.current}`, 0); this.loadNext();
      }
      if (this.promote) { this.promote = false; this.current++; this.loadNext(); }
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

declare const moraReadPcm: (file: number, chunk: number) => string;
export function create(config: NativeMixConfig) { return new NativeMixerRuntime(config, moraReadPcm); }
