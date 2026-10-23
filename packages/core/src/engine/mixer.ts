import { StereoIsolator } from '../dsp/crossover.ts';
import { Limiter } from '../dsp/limiter.ts';
import { MasterTone, type ToneSettings } from '../dsp/tone.ts';
import { MasterReverb } from '../dsp/reverb.ts';
import { StereoSweep } from '../dsp/sweep.ts';
import { PlaybackTransform, type PlaybackSettings } from '../dsp/playback.ts';
import { Wsola, type PcmSource } from '../dsp/wsola.ts';
import { CHUNK_FRAMES, ChunkStore } from './chunks.ts';
import { VocalPcmSource, vocalSourceMap } from './vocals.ts';
import { LoopPcmSource, type SourceLoop, type SourceTapeStop } from './loop.ts';

/** Lane order: gain, low, mid, high, echo send, voice-echo send, bipolar filter. */
export type LaneIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const LANE_INDEX = { gain: 0, low: 1, mid: 2, high: 3, echo: 4, voiceEcho: 5, filter: 6 } as const;
type Lanes = [number, number, number, number, number, number, number];
const unity = (): Lanes => [1, 1, 1, 1, 0, 0, 0];

/** A transition plan converted to frames for one AudioContext sample rate. */
export interface ArmedTransition {
  planId: string;
  method: string;
  fromToken: string;
  toToken: string;
  /** A input frame where the transition starts. */
  triggerFrame: number;
  /** B input frame that plays at transition start. */
  entryFrame: number;
  /** Overlap length in output frames. */
  durationFrames: number;
  /** Silence between A stop and B start (gapless with gap). */
  gapFrames: number;
  /** Output frames from start when now-playing switches to B. */
  swapFrame: number;
  /** Output frames before B starts inside the overlap; B's lanes, tempo and voice map run on B's own clock. */
  bDelayFrames?: number;
  /** B speed (input/output) over output frames from transition start. */
  tempoB: [number, number][];
  /** Optional A speed over output frames from transition start (tempo glide). */
  tempoA?: [number, number][];
  loopA?: SourceLoop;
  tapeStopA?:SourceTapeStop;
  /** Vocal retention envelopes over output frames (1 = original, 0 = accompaniment). */
  vocalA?: [number, number][];
  vocalB?: [number, number][];
  lanes: { deck: 'A' | 'B'; lane: LaneIndex; points: [number, number][] }[];
  /** Echo delay (frames) and feedback for the echo send lane. */
  echoDelayFrames?: number;
  echoFeedback?: number;
  /** Delay/feedback of the separate echo fed only by A's audible voice (lane 5). */
  voiceEchoDelayFrames?: number;
  voiceEchoFeedback?: number;
  voiceEchoClearFrame?: number;
}

export interface DeckSnapshot {
  token: string | null;
  /** Input position, frames. */
  position: number;
  totalFrames: number;
  playing: boolean;
  starved: boolean;
  ratio: number;
  bufferedAhead: number;
}

export type MixerEvent =
  | {
      type: 'tick';
      clock: number;
      paused: boolean;
      main: number;
      decks: DeckSnapshot[];
      transition: { planId: string; t: number; active: boolean; late: boolean } | null;
      limiterDb: number;
      peak: number;
    }
  | { type: 'need'; deck: number; token: string; chunks: number[]; part?: 'vocals' }
  | { type: 'vocalsReset'; deck: number; token: string; applied: boolean }
  | { type: 'audioHealth'; maxRenderMs: number; slowBlocks: number }
  | { type: 'transitionStart'; planId: string; late: boolean; clock: number }
  | { type: 'swap'; planId: string; token: string }
  | { type: 'transitionEnd'; planId: string; token: string; forced: boolean }
  | { type: 'transitionAborted'; planId: string; reason: string }
  | { type: 'disarmed'; planId: string; reason: string }
  | { type: 'ended'; deck: number; token: string }
  | { type: 'underrun'; deck: number; token: string; position: number }
  | { type: 'fallback'; planId: string; reason: string };

/** First output frame from which a voice envelope stays at zero, or null. */
export function voiceOffFrame(points: [number, number][] | undefined): number | null {
  if (!points?.length) return null;
  let off: number | null = null;
  for (const [t, v] of points) {
    if (v <= 1e-3) {
      if (off === null) off = t;
    } else off = null;
  }
  return off;
}

export function evalPoints(points: [number, number][], t: number): number {
  const n = points.length;
  if (n === 0) return 1;
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = points[lo];
  const [t1, v1] = points[hi];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/**
 * Tempo-synced feedback echo for DJ-style "echo out": the outgoing track's
 * last beats repeat and decay over the incoming one. The feedback path is
 * band-limited (no bass build-up, softened highs).
 */
class Echo {
  private readonly L: Float32Array;
  private readonly R: Float32Array;
  private pos = 0;
  delay = 1;
  feedback = 0.5;
  private hpL = 0;
  private hpR = 0;
  private hpXL = 0;
  private hpXR = 0;
  private lpL = 0;
  private lpR = 0;
  private readonly hpA: number;
  private readonly lpA: number;

  constructor(sampleRate: number) {
    const n = Math.ceil(sampleRate * 2.5);
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
    this.hpA = Math.exp((-2 * Math.PI * 250) / sampleRate);
    this.lpA = 1 - Math.exp((-2 * Math.PI * 6000) / sampleRate);
  }

  private out = 1;
  private outStep = 0;
  private deadline: number | null = null;
  private deadlineFadeFrames = 1;

  /** Absolute output-clock deadline for a voice-only echo. Feedback estimates
   * alone cannot guarantee silence: the repeated word has a finite length. */
  limitTailAt(frame: number, fadeFrames: number): void {
    this.deadline = frame;
    this.deadlineFadeFrames = Math.max(1, fadeFrames);
  }

  /** Fades the echo output to silence, then clears it (no click when cut short). */
  fadeOut(frames: number): void {
    this.outStep = 1 / Math.max(1, frames);
  }

  configure(delayFrames: number, feedback: number): void {
    this.reset();
    this.delay = Math.max(1, Math.min(this.L.length - 1, Math.round(delayFrames)));
    this.feedback = Math.max(0, Math.min(0.75, feedback));
  }

  /** Adds the echo of `inL/inR` (send signal) into outL/outR. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number, clock = 0): void {
    // Keep advancing through silent input/output blocks: a delayed attack can
    // still be waiting in the ring even when this entire block is silent.
    const N = this.L.length;
    for (let i = 0; i < n; i++) {
      const tailGain = this.deadline === null ? 1 : Math.max(0, Math.min(1, (this.deadline-clock-i)/this.deadlineFadeFrames));
      // Keep the deadline closed until configure/reset; a surviving send can
      // never repopulate the ring and bring the outgoing singer back.
      if(tailGain===0)return;
      const rp = (this.pos - this.delay + N) % N;
      const yL = this.L[rp];
      const yR = this.R[rp];
      if (this.outStep > 0) {
        this.out = Math.max(0, this.out - this.outStep);
        if (this.out === 0) {
          this.reset();
          return;
        }
      }
      outL[i] += yL * this.out * tailGain;
      outR[i] += yR * this.out * tailGain;
      // band-limit the feedback: one-pole high-pass then low-pass
      const hL = this.hpA * (this.hpL + yL - this.hpXL);
      const hR = this.hpA * (this.hpR + yR - this.hpXR);
      this.hpXL = yL;
      this.hpXR = yR;
      this.hpL = hL;
      this.hpR = hR;
      this.lpL += this.lpA * (hL - this.lpL);
      this.lpR += this.lpA * (hR - this.lpR);
      this.L[this.pos] = inL[i] + this.lpL * this.feedback;
      this.R[this.pos] = inR[i] + this.lpR * this.feedback;
      this.pos = this.pos + 1 === N ? 0 : this.pos + 1;
    }
  }

  reset(): void {
    this.L.fill(0);
    this.R.fill(0);
    this.pos = 0;
    this.hpL = this.hpR = this.hpXL = this.hpXR = this.lpL = this.lpR = 0;
    this.out = 1;
    this.outStep = 0;
    this.deadline = null;
  }
}

interface TempoMap {
  origin: number;
  points: [number, number][];
}

class Deck {
  lastRawL = 0; lastRawR = 0; tailLeft = 0; tailL = 0; tailR = 0;
  clearTail(): void { this.lastRawL = this.lastRawR = this.tailLeft = this.tailL = this.tailR = 0; }
  token: string | null = null;
  store = new ChunkStore(0);
  vocalStore = new ChunkStore(0);
  readonly vocalSource: VocalPcmSource;
  readonly loopSource: LoopPcmSource;
  /** The separated voice as currently heard (voice stem x mask), for the vocal throw. */
  readonly heardVoice: PcmSource;
  pendingVocalSource: VocalPcmSource | null = null;
  readonly wsola: Wsola;
  readonly iso: StereoIsolator;
  readonly filter: StereoSweep;
  playing = false;
  starved = false;
  normGain = 1;
  /** Gain changes on a playing deck are ramped (never stepped). */
  normGainTarget = 1;
  lanes: Lanes = unity();
  /** Lanes glide here outside a transition (an aborted blend never steps its EQ/gain). */
  laneTarget: Lanes | null = null;
  tempo: TempoMap | null = null;
  cueFrame = 0;
  fade = 1;
  fadeTarget = 1;
  fadeStep = 1;
  stopWhenSilent = false;
  pendingSeek: number | null = null;
  requested = new Set<number>();
  vocalRequested = new Set<number>();
  endedNotified = false;
  /**
   * This deck's voice is meant to be removed by a stem mask during the current
   * transition. While true, nothing that may still contain the voice is fed
   * into the echo (its feedback would replay old singing under the next track).
   */
  voiceExpected = false;
  /** Smoothed 0..1 gate on the echo send (opens only once the voice is gone). */
  echoGate = 1;
  /** Least-squares fit of the original onto the voice stem (voiced blocks of the masked region). */
  fitNum = 0;
  fitDen = 0;
  fitFrames = 0;
  fitDone = new Set<number>();
  /** Progress is per chunk: late network arrivals must not restart another fit. */
  fitCursors = new Map<number, number>();

  resetFit(): void {
    this.fitNum = this.fitDen = this.fitFrames = 0;
    this.fitDone.clear();
    this.fitCursors.clear();
  }

  /**
   * Over-subtraction for the stem, shrunk towards 1 and capped. Out of sample
   * on 44 library tracks (k = 0.6, cap 1.15) it lowered the voice-correlated
   * residue in the accompaniment from -21.6 to -28.7 dB (150-2500 Hz) and
   * from -16.1 to -19.4 dB (2.5-16 kHz), with no track getting worse.
   */
  voiceScale(sampleRate: number): number {
    if (this.fitFrames < sampleRate * 0.5 || this.fitDen <= 0) return 1;
    return Math.max(1, Math.min(1.15, 1 + 0.6 * (this.fitNum / this.fitDen - 1)));
  }

  constructor(readonly index: number, sampleRate: number) {
    const self = this;
    const source: PcmSource = {
      get totalFrames() {
        return self.store.totalFrames;
      },
      read(start, len, outL, outR, offset) {
        return self.store.read(start, len, outL, outR, offset);
      },
    };
    const vocalPcm: PcmSource = {
      get totalFrames() { return self.vocalStore.totalFrames; },
      read(start, len, outL, outR, offset) { return self.vocalStore.read(start, len, outL, outR, offset); },
    };
    this.vocalSource = new VocalPcmSource(source, vocalPcm, Math.ceil(sampleRate * 0.064) + 64);
    this.heardVoice = {
      get totalFrames() { return self.vocalStore.totalFrames; },
      read(start, len, outL, outR, offset) {
        if (!self.vocalStore.read(start, len, outL, outR, offset)) return false;
        const vs = self.vocalSource;
        if (!vs.getMap()) return true;
        for (let i = 0; i < len; i++) {
          const g = vs.gainAt(start + i);
          outL[offset + i] *= g;
          outR[offset + i] *= g;
        }
        return true;
      },
    };
    this.loopSource = new LoopPcmSource(this.vocalSource, sampleRate);
    this.wsola = new Wsola(sampleRate, this.loopSource);
    this.iso = new StereoIsolator(sampleRate);
    this.filter = new StereoSweep(sampleRate);
  }

  position(): number {
    return this.wsola.position();
  }
}

export class MixerCore {
  readonly decks: [Deck, Deck];
  main = 0;
  paused = false;
  clock = 0;
  private transport = 1;
  private transportTarget = 1;
  private silentTransportFrames = 0;
  private readonly transportStep: number;
  private volume = 1;
  private volumeTarget = 1;
  private armed: ArmedTransition | null = null;
  private active = false;
  private late = false;
  private lateNotified = false;
  private swapped = false;
  private forced = false;
  private t = 0;
  private bufL = new Float32Array(1024);
  private bufR = new Float32Array(1024);
  private readonly limiter: Limiter;
  /** Listener EQ/balance/mono on the summed mix, before volume and the limiter. */
  private readonly tone: MasterTone;
  private readonly reverb: MasterReverb;
  private readonly playback: PlaybackTransform;
  private readonly echo: Echo;
  private echoInL = new Float32Array(1024);
  private echoInR = new Float32Array(1024);
  private readonly voiceEcho: Echo;
  private voiceInL = new Float32Array(1024);
  private voiceInR = new Float32Array(1024);
  private sideL = new Float32Array(1024);
  private sideR = new Float32Array(1024);
  private peak = 0;
  private sinceTick = 0;
  private sinceNeed = 0;
  readonly tickFrames: number;
  /** Seconds of audio requested ahead of the playhead. */
  aheadSeconds = 24;

  constructor(
    readonly sampleRate: number,
    private readonly emit: (e: MixerEvent) => void,
  ) {
    this.decks = [new Deck(0, sampleRate), new Deck(1, sampleRate)];
    this.limiter = new Limiter(sampleRate);
    this.tone = new MasterTone(sampleRate);
    this.reverb = new MasterReverb(sampleRate);
    this.playback = new PlaybackTransform(sampleRate, (L, R, n) => this.renderMusical(L, R, n));
    this.echo = new Echo(sampleRate);
    this.voiceEcho = new Echo(sampleRate);
    this.transportStep = 1 / Math.round(sampleRate * 0.012);
    this.tickFrames = Math.round(sampleRate * 0.05);
  }

  // ---------------------------------------------------------------- commands

  load(deck: number, token: string, totalFrames: number, gainDb: number, cueFrame = 0): void {
    const d = this.decks[deck];
    d.loopSource.setLoop(null);
    if (this.armed && (this.armed.toToken === d.token || this.armed.fromToken === d.token) && d.token !== token) {
      this.detachDeck(d, 'deck_reloaded');
    }
    d.token = token;
    d.clearTail();
    d.store = new ChunkStore(totalFrames);
    d.vocalStore = new ChunkStore(totalFrames);
    d.vocalSource.setMap(null);
    d.vocalSource.scale = 1;
    d.pendingVocalSource = null;
    d.vocalRequested.clear();
    d.resetFit();
    d.voiceExpected = false;
    d.echoGate = 1;
    d.normGain = Math.pow(10, gainDb / 20);
    d.normGainTarget = d.normGain;
    d.playing = false;
    d.starved = false;
    d.tempo = null;
    d.lanes = unity();
    d.laneTarget = null;
    d.cueFrame = Math.max(0, Math.round(cueFrame));
    d.fade = 1;
    d.fadeTarget = 1;
    d.stopWhenSilent = false;
    d.pendingSeek = null;
    d.requested.clear();
    d.endedNotified = false;
    d.iso.reset(); d.filter.reset();
    d.wsola.reset(d.cueFrame);
    this.requestData(d);
  }

  /** The decode finished: its exact length replaces the duration estimate given to load(). The
   * end of the track (and 'ended') follow the real audio, not padding or a cut-off estimate. */
  setLength(deck: number, token: string, totalFrames: number): void {
    const d = this.decks[deck];
    if (d.token !== token || !Number.isSafeInteger(totalFrames) || totalFrames <= 0 || totalFrames === d.store.totalFrames) return;
    for (const c of d.store.resize(totalFrames)) d.requested.delete(c);
    for (const c of d.vocalStore.resize(totalFrames)) d.vocalRequested.delete(c);
  }

  unload(deck: number): void {
    const d = this.decks[deck];
    this.detachDeck(d, 'deck_unloaded');
    d.loopSource.setLoop(null);
    d.token = null;
    d.playing = false;
    d.store = new ChunkStore(0);
    d.vocalStore = new ChunkStore(0);
    d.vocalSource.setMap(null);
    d.pendingVocalSource = null;
    d.vocalRequested.clear();
    d.requested.clear();
  }

  setCue(deck: number, cueFrame: number): void {
    const d = this.decks[deck];
    d.cueFrame = Math.max(0, Math.round(cueFrame));
    if (!d.playing) d.wsola.reset(d.cueFrame);
    this.requestData(d);
  }

  setGain(deck: number, gainDb: number): void {
    const d = this.decks[deck];
    d.normGainTarget = Math.pow(10, gainDb / 20);
    if (!d.playing) d.normGain = d.normGainTarget;
  }

  feed(deck: number, token: string, chunk: number, L: Float32Array, R: Float32Array): void {
    const d = this.decks[deck];
    if (d.token !== token) return;
    d.store.put(chunk, L, R);
    d.requested.delete(chunk);
  }

  feedVocal(deck: number, token: string, chunk: number, L: Float32Array, R: Float32Array): void {
    const d = this.decks[deck];
    if (d.token !== token) return;
    d.vocalStore.put(chunk, L, R);
    d.vocalRequested.delete(chunk);
  }

  /**
   * Optional stem failure. The incoming deck simply keeps its original mix.
   * The outgoing deck must not get its old voice back while it is still
   * audible: its mask cannot continue without stem PCM, so the whole outgoing
   * deck leaves by the moment its voice was meant to end (or right now, if that
   * moment has passed) with a short musical fade instead of a hard cut.
   */
  disableVocals(deck: number, token: string): void {
    const d = this.decks[deck];
    if (d.token !== token) return;
    const tr = this.armed;
    if (tr && tr.fromToken === token && (!!tr.vocalA || d.voiceExpected)) this.retireOutgoingVoice(tr, d);
    // Existing Hann overlap restores the original signal without a hard cut.
    // A fade using the missing stem itself could stall again halfway through.
    d.vocalSource.setMap(null);
    d.pendingVocalSource = null;
    d.vocalRequested.clear();
  }

  /** Replace a prepared stem generation without touching the original song.
   * The controller cancels old stem requests before sending this command.
   * An active blend must finish with the generation it started with. */
  resetVocals(deck: number, token: string): boolean {
    const d = this.decks[deck];
    if (!d || d.token !== token || this.active) return false;
    if (this.armed && (this.armed.fromToken === token || this.armed.toToken === token)) this.disarm('vocal_generation_changed');
    d.vocalSource.setMap(null);
    d.vocalSource.scale = 1;
    d.pendingVocalSource = null;
    d.vocalStore = new ChunkStore(d.store.totalFrames);
    d.vocalRequested.clear();
    d.resetFit();
    d.voiceExpected = false;
    d.echoGate = 1;
    // Preserve the shared stretcher's original PCM history and source position;
    // only its optional vocal side channel belongs to the retired generation.
    d.wsola.setSide(null);
    this.voiceEcho.reset();
    this.echo.reset();
    return true;
  }

  /**
   * Replaces the outgoing voice mask by a fade of the whole A deck: A (now an
   * unmasked full mix) is gone by the planned voice-end time, so the old singer
   * is never heard after it. A's echo send is closed as well.
   */
  private retireOutgoingVoice(tr: ArmedTransition, a: Deck): void {
    const now = this.active ? this.t : 0;
    const fadeFrames = Math.max(1, Math.round(this.sampleRate * 0.18));
    let end = voiceOffFrame(tr.vocalA);
    // the mask may already be silencing the voice: then leave right away
    if (end === null || end <= now + fadeFrames) end = now + fadeFrames;
    const start = Math.max(now, end - fadeFrames);
    const gainLane = tr.lanes.find((l) => l.deck === 'A' && l.lane === 0)?.points ?? [[0, 1]];
    const head: [number, number][] = this.active
      ? [[now, a.lanes[0]]]
      : gainLane.filter(([t]) => t < start);
    const atStart = this.active ? a.lanes[0] : evalPoints(gainLane, start);
    const points: [number, number][] = [...head];
    if (!points.length || points[points.length - 1][0] < start) points.push([start, atStart]);
    points.push([Math.max(end, start + 1), 0]);
    const lanes = tr.lanes.filter((l) => !(l.deck === 'A' && (l.lane === 0 || l.lane === 4 || l.lane === 5)));
    a.wsola.setSide(null);
    this.voiceEcho.fadeOut(Math.round(this.sampleRate * 0.15));
    lanes.push({ deck: 'A', lane: 0, points });
    lanes.push({ deck: 'A', lane: 4, points: [[0, 0]] });
    this.armed = { ...tr, lanes, vocalA: undefined };
    a.voiceExpected = false;
    a.echoGate = 0;
  }

  /** Data for a chunk could not be fetched; allow it to be requested again later. */
  nack(deck: number, token: string, chunk: number, part?: 'vocals'): void {
    const d = this.decks[deck];
    if (d.token === token) (part === 'vocals' ? d.vocalRequested : d.requested).delete(chunk);
  }

  /** Makes `deck` the only audible deck, playing from `frame`. */
  start(deck: number, token: string, frame: number): void {
    const d = this.decks[deck];
    if (d.token !== token) return;
    this.playback.reset();
    d.clearTail();
    if (this.active) this.abortTransition('restart');
    this.disarm('restart');
    const other = this.decks[1 - deck];
    if (other.playing) this.fadeOutAndStop(other, 0.03);
    this.main = deck;
    this.echo.reset();
    this.voiceEcho.reset();
    d.iso.reset(); d.filter.reset();
    d.loopSource.setLoop(null);
    d.vocalSource.setMap(null);
    d.pendingVocalSource = null;
    d.voiceExpected = false;
    d.wsola.setSide(null);
    d.wsola.reset(Math.max(0, Math.round(frame)));
    d.playing = true;
    d.starved = false;
    d.tempo = null;
    d.lanes = unity();
    d.laneTarget = null;
    d.fade = 1;
    d.fadeTarget = 1;
    d.stopWhenSilent = false;
    d.pendingSeek = null;
    d.endedNotified = false;
    this.requestData(d);
  }

  stopAll(): void {
    this.playback.reset();
    if (this.active) this.abortTransition('stop');
    else this.disarm('stop');
    for (const d of this.decks) {
      d.playing = false;
      d.loopSource.setLoop(null);
      d.vocalSource.setMap(null);
      d.pendingVocalSource = null;
    }
    this.echo.reset();
    this.voiceEcho.reset();
    this.tone.reset();
    this.reverb.reset();
    this.limiter.reset();
  }

  setPaused(p: boolean): void {
    if (p === this.paused && this.transportTarget === (p ? 0 : 1)) return;
    if (p) {
      this.transportTarget = 0;
    } else {
      this.paused = false;
      this.transportTarget = 1;
    }
  }

  setVolume(v: number): void {
    this.volumeTarget = Math.max(0, Math.min(1.5, v));
  }

  setTone(s: ToneSettings, preDb?: number): void {
    this.tone.set(s, preDb);
    this.reverb.setMix(s.enabled ? s.reverbMix ?? 0 : 0);
  }

  setPlayback(settings: PlaybackSettings): void { this.playback.set(settings); }

  seek(token: string, frame: number): void {
    const di = this.decks.findIndex((d) => d.token === token);
    if (di < 0) return;
    this.playback.reset();
    const d = this.decks[di];
    if (this.active) {
      const other = this.decks[1 - di];
      this.fadeOutAndStop(other, 0.25);
      const planId = this.armed?.planId ?? '';
      this.active = false;
      this.armed = null;
      for (const deck of this.decks) deck.pendingVocalSource = null;
      this.emit({ type: 'transitionAborted', planId, reason: 'seek' });
    } else {
      this.disarm('seek');
    }
    this.main = di;
    this.echo.reset();
    this.voiceEcho.reset();
    const target = Math.max(0, Math.min(d.store.totalFrames - 1, Math.round(frame)));
    d.tempo = null;
    d.vocalSource.setMap(null);
    d.pendingVocalSource = null;
    d.voiceExpected = false;
    for (const deck of this.decks) deck.wsola.setSide(null);
    d.endedNotified = false;
    d.stopWhenSilent = false;
    if (this.paused || !d.playing) {
      d.loopSource.setLoop(null);
      d.wsola.reset(target);
      d.clearTail();
      d.iso.reset(); d.filter.reset();
      d.pendingSeek = null;
      d.lanes = unity();
      d.laneTarget = null;
      d.playing = true;
      d.fade = 1;
      d.fadeTarget = 1;
    } else {
      d.pendingSeek = target;
      d.fadeTarget = 0;
      d.fadeStep = 1 / Math.round(this.sampleRate * 0.006);
    }
    d.cueFrame = target;
    this.requestData(d, target);
  }

  arm(tr: ArmedTransition): void {
    // Replanning is allowed before the trigger. A controller response arriving
    // during a running blend must not reset both decks halfway through it.
    if (this.active) return;
    for (const d of this.decks) d.loopSource.setLoop(null);
    this.armed = tr;
    this.active = false;
    this.late = false;
    this.lateNotified = false;
    this.swapped = false;
    this.forced = false;
    this.t = 0;
    for (const [token, cue, tempo, gains] of [
      [tr.fromToken, tr.triggerFrame, tr.tempoA, tr.vocalA],
      [tr.toToken, tr.entryFrame, tr.tempoB, tr.vocalB],
    ] as const) {
      const d = this.deckByToken(token);
      if (!d) continue;
      const map = vocalSourceMap(cue, tempo, gains);
      d.pendingVocalSource = map ? new VocalPcmSource(d.store, d.vocalStore, 0) : null;
      d.pendingVocalSource?.setMap(map);
      d.resetFit();
      this.requestData(d);
    }
  }

  disarm(reason: string): void {
    if (this.armed && !this.active) {
      const id = this.armed.planId;
      this.armed = null;
      for (const d of this.decks) { d.pendingVocalSource = null; d.loopSource.setLoop(null); }
      this.emit({ type: 'disarmed', planId: id, reason });
    }
  }

  /** Completes a running transition quickly (used when the user skips during a blend). */
  finishTransitionNow(fadeSeconds = 0.6): void {
    if (!this.armed || !this.active) return;
    const tr = this.armed;
    const a = this.deckByToken(tr.fromToken);
    const b = this.deckByToken(tr.toToken);
    const duration = Math.max(1, Math.round(this.sampleRate * fadeSeconds));
    const lanes: ArmedTransition['lanes'] = [];
    for (const [role, d] of [['A', a], ['B', b]] as const) {
      if (!d) continue;
      for (let lane = 0; lane < 7; lane++) {
        const target = lane >= 4 || (role === 'A' && lane === 0) ? 0 : 1;
        lanes.push({ deck: role, lane: lane as LaneIndex, points: [[0, d.lanes[lane]], [duration, target]] });
      }
    }
    // Finish on the audio clock, keeping B's stretcher and tempo-map origin.
    // Emitting transitionEnd here used to let the controller reuse A's deck
    // before its fade was audible, and stepped B's gain/EQ straight to unity.
    this.armed = { ...tr, durationFrames: duration, gapFrames: 0, swapFrame: 0, bDelayFrames: 0, lanes };
    this.t = 0;
    this.forced = true;
    // the incoming voice opens during this fade: the old singer's echo leaves first
    a?.wsola.setSide(null);
    this.voiceEcho.fadeOut(Math.round(this.sampleRate * 0.12));
    // A forced finish releases only B's voice (in source coordinates, keeping
    // the shared WSOLA history). The outgoing voice keeps going away together
    // with A; re-opening it here used to bring the old singer back for the
    // length of the fade.
    if (b) {
      const position = b.position();
      const gain = b.vocalSource.gainAt(position);
      const span = duration * this.ratioFor(b, this.clock);
      const covered = gain === 1 || b.vocalStore.covers(position - 4096, position + span + 4096);
      b.vocalSource.setMap(gain === 1 || !covered ? null : [[position, gain], [position + span, 1]]);
      b.voiceExpected = false;
    }
    if (a) {
      const masked = !!a.vocalSource.getMap() || a.voiceExpected;
      const position = a.position();
      const gain = a.vocalSource.gainAt(position);
      const rate = this.ratioFor(a, this.clock);
      const voiceFrames = Math.min(duration, Math.round(this.sampleRate * 0.2));
      const span = (voiceFrames + Math.round(this.sampleRate * 0.1)) * rate;
      if (masked && gain > 0 && a.vocalStore.covers(position - 4096, position + span + 4096)) {
        a.vocalSource.setMap([[position, gain], [position + voiceFrames * rate, 0]]);
      } else if (masked && gain > 0) {
        // no stem PCM at this spot: the whole outgoing deck leaves with its voice
        const fast = Math.max(1, Math.round(this.sampleRate * 0.15));
        const gainLane = lanes.find((l) => l.deck === 'A' && l.lane === 0);
        if (gainLane) gainLane.points = [[0, a.lanes[0]], [fast, 0]];
        a.vocalSource.setMap(null);
      }
      a.voiceExpected = masked;
    }
    if (!this.swapped && b) {
      this.swapped = true;
      this.main = b.index;
      this.emit({ type: 'swap', planId: tr.planId, token: tr.toToken });
    }
  }

  getArmed(): ArmedTransition | null {
    return this.armed;
  }

  isTransitionActive(): boolean {
    return this.active;
  }

  /** Current meters since the last telemetry tick, without resetting them. */
  getMetering(): { peak: number; limiterDb: number } {
    return { peak: this.peak, limiterDb: this.limiter.getStats().minGainDb };
  }

  // ----------------------------------------------------------------- render

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    if (this.paused) {
      outL.fill(0, 0, n); outR.fill(0, 0, n); this.tickMaybe(n); return;
    }
    if (!this.playback.engaged) {
      this.renderMusical(outL, outR, n);
      this.applyMaster(outL, outR, n);
    } else {
      // Bounded quanta keep the pull buffers fixed even for large offline renders.
      if (n <= 128) {
        this.playback.process(outL, outR, n);
        this.applyMaster(outL, outR, n);
      } else {
        for (let off = 0; off < n; off += 128) {
          const size = Math.min(128, n - off), L = outL.subarray(off, off + size), R = outR.subarray(off, off + size);
          if (this.paused) { L.fill(0); R.fill(0); continue; }
          this.playback.process(L, R, size);
          this.applyMaster(L, R, size);
        }
      }
    }
    this.checkEnded();
    this.tickMaybe(n);
  }

  private renderMusical(outL: Float32Array, outR: Float32Array, n: number): void {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    if (this.paused) {
      return;
    }
    if (this.bufL.length < n) {
      this.bufL = new Float32Array(n);
      this.bufR = new Float32Array(n);
    }
    if (this.echoInL.length < n) {
      this.echoInL = new Float32Array(n);
      this.echoInR = new Float32Array(n);
      this.voiceInL = new Float32Array(n);
      this.voiceInR = new Float32Array(n);
    }
    this.fitVoices();
    this.echoInL.fill(0, 0, n);
    this.echoInR.fill(0, 0, n);
    this.voiceInL.fill(0, 0, n);
    this.voiceInR.fill(0, 0, n);
    let off = 0;
    while (off < n) {
      let len = n - off;
      const tr = this.armed;
      if (tr && !this.active) {
        const a = this.deckByToken(tr.fromToken);
        if (!a || !a.playing) {
          // nothing to transition from; wait for controller
        } else {
          const pA = a.position();
          if (pA >= tr.triggerFrame || this.late) {
            if (!this.tryStartTransition(tr, a)) {
              // stays armed; checked again next sub-block
            }
          } else {
            const rA = this.ratioFor(a, this.clock);
            const framesTo = Math.ceil((tr.triggerFrame - pA) / Math.max(0.25, rA));
            if (framesTo < len) len = Math.max(1, framesTo);
          }
        }
      }
      if (this.active && this.armed) {
        const current = this.armed;
        const end = current.durationFrames + current.gapFrames;
        const rem = end - this.t;
        if (rem > 0 && rem < len) len = rem;
        // Linear interpolation is exact only inside one automation segment.
        // Crossing a knot in a render quantum used to smear cuts/fades by up
        // to a whole block (and could fill an intentional silent gap).
        for (const lane of current.lanes) {
          if (lane.deck === 'B' && current.gapFrames > 0) continue;
          const shift = lane.deck === 'B' ? current.bDelayFrames ?? 0 : 0;
          for (const [p0] of lane.points) {
            const point = p0 + shift;
            if (point > this.t && point - this.t < len) len = point - this.t;
          }
        }
        if (!this.swapped && current.swapFrame > this.t && current.swapFrame - this.t < len) len = current.swapFrame - this.t;
        const delay = current.bDelayFrames ?? 0;
        if (delay > this.t && delay - this.t < len) len = delay - this.t;
      }
      this.renderSub(outL, outR, off, len);
      this.clock += len;
      if (this.active && this.armed) {
        this.t += len;
        const tr2 = this.armed;
        if (!this.swapped && this.t >= tr2.swapFrame) {
          this.swapped = true;
          this.main = this.deckByToken(tr2.toToken)?.index ?? this.main;
          this.emit({ type: 'swap', planId: tr2.planId, token: tr2.toToken });
        }
        if (this.t >= tr2.durationFrames + tr2.gapFrames) this.endTransition();
      }
      off += len;
    }
    this.echo.process(this.echoInL, this.echoInR, outL, outR, n);
    this.voiceEcho.process(this.voiceInL, this.voiceInR, outL, outR, n, this.clock-n);
  }

  private renderSub(outL: Float32Array, outR: Float32Array, off: number, len: number): void {
    const tr = this.active ? this.armed : null;
    for (const d of this.decks) {
      if (!d.playing) continue;
      let role: 'A' | 'B' | null = null;
      if (tr) {
        if (d.token === tr.fromToken) role = 'A';
        else if (d.token === tr.toToken) role = 'B';
      }
      // B holds at its cue (silent, not advancing) until its delayed start
      if (role === 'B' && tr && (tr.gapFrames > 0 || this.t < (tr.bDelayFrames ?? 0))) continue;
      let from: Lanes;
      let to: Lanes;
      if (tr && role) {
        const t0 = Math.max(0, this.t - (tr.gapFrames + (tr.bDelayFrames ?? 0)) * (role === 'B' ? 1 : 0));
        from = this.evalLanes(tr, role, role === 'B' ? t0 : this.t);
        to = this.evalLanes(tr, role, (role === 'B' ? t0 : this.t) + len);
        d.lanes = to;
      } else if (d.laneTarget) {
        from = d.lanes;
        to = this.glide(d.lanes, d.laneTarget, len);
        d.lanes = to;
        if (to.every((v, i) => v === d.laneTarget![i])) d.laneTarget = null;
      } else {
        from = d.lanes;
        to = d.lanes;
      }
      this.renderDeck(d, outL, outR, off, len, from, to);
    }
  }

  private renderDeck(
    d: Deck,
    outL: Float32Array,
    outR: Float32Array,
    off: number,
    len: number,
    from: Lanes,
    to: Lanes,
  ): void {
    const bl = this.bufL;
    const br = this.bufR;
    const clock = this.clock;
    const posStart = d.position();
    const throwing = d.wsola.hasSide();
    if (throwing && this.sideL.length < len) {
      this.sideL = new Float32Array(len);
      this.sideR = new Float32Array(len);
    }
    const produced = throwing
      ? d.wsola.render(bl, br, 0, len, (k) => this.ratioFor(d, clock + k), this.sideL, this.sideR)
      : d.wsola.render(bl, br, 0, len, (k) => this.ratioFor(d, clock + k));
    if (throwing && produced < len) {
      this.sideL.fill(0, produced, len);
      this.sideR.fill(0, produced, len);
    }
    if (produced < len) {
      bl.fill(0, produced, len);
      br.fill(0, produced, len);
      if (!d.starved && d.token) {
        d.tailL = produced ? bl[produced - 1] : d.lastRawL;
        d.tailR = produced ? br[produced - 1] : d.lastRawR;
        d.tailLeft = Math.max(1, Math.round(this.sampleRate * .003));
        d.starved = true;
        this.emit({ type: 'underrun', deck: d.index, token: d.token, position: d.position() });
        this.requestData(d);
      }
      // A missing render window used to jump from the last sample straight to
      // zero. Drain a short smooth tail while waiting, instead of a sharp click.
      const tailFrames = Math.max(1, Math.round(this.sampleRate * .003));
      for (let i = produced; i < len && d.tailLeft > 0; i++, d.tailLeft--) {
        const gain = .5 - .5 * Math.cos(Math.PI * (d.tailLeft - 1) / tailFrames);
        bl[i] = d.tailL * gain; br[i] = d.tailR * gain;
      }
    } else if (d.starved) {
      d.starved = false;
      d.fade = 0;
      d.fadeTarget = 1;
      d.fadeStep = 1 / Math.round(this.sampleRate * 0.008);
    }
    if (produced) { d.lastRawL = bl[produced - 1]; d.lastRawR = br[produced - 1]; }
    d.iso.processBlock(bl, br, 0, len, [from[1], from[2], from[3]], [to[1], to[2], to[3]]);
    d.filter.processBlock(bl, br, len, from[6], to[6]);
    const n0 = d.normGain;
    if (n0 !== d.normGainTarget) {
      // ~2 s linear ramp towards the new normalization gain
      const step = (len / (this.sampleRate * 2)) * Math.max(Math.abs(d.normGainTarget - n0), 0.05);
      d.normGain = n0 < d.normGainTarget ? Math.min(d.normGainTarget, n0 + step) : Math.max(d.normGainTarget, n0 - step);
    }
    const g0 = from[0] * n0;
    const g1 = to[0] * d.normGain;
    const dg = (g1 - g0) / len;
    let g = g0;
    let fade = d.fade;
    const target = d.fadeTarget;
    const step = d.fadeStep;
    const sending = from[4] > 0 || to[4] > 0;
    let send = from[4];
    const ds = (to[4] - from[4]) / len;
    const eL = this.echoInL;
    const eR = this.echoInR;
    // Echo gate: a deck whose voice is being removed may feed the echo only
    // once its mask is zero for every source frame the stretcher can still
    // overlap (one window plus ~45 ms settling). Otherwise the feedback buffer
    // keeps the old phrase and repeats it under the next track.
    let gateTarget = 1;
    if (d.voiceExpected) {
      if (!d.vocalSource.getMap()) gateTarget = 0;
      else {
        const settle = this.sampleRate * 0.045 * Math.max(0.25, this.ratioFor(d, clock));
        gateTarget = d.vocalSource.maxGain(posStart - settle - d.wsola.W, d.position() + d.wsola.W) <= 1e-3 ? 1 : 0;
      }
    }
    let gate = sending ? d.echoGate : gateTarget;
    const gateStep = 1 / Math.max(1, Math.round(this.sampleRate * 0.015));
    for (let i = 0; i < len; i++) {
      if (fade !== target) {
        fade = fade < target ? Math.min(target, fade + step) : Math.max(target, fade - step);
      }
      const k = g * fade;
      const l = bl[i] * k;
      const r = br[i] * k;
      outL[off + i] += l;
      outR[off + i] += r;
      if (sending) {
        if (gate !== gateTarget) gate = gate < gateTarget ? Math.min(gateTarget, gate + gateStep) : Math.max(gateTarget, gate - gateStep);
        // the echo is fed with the signal before the gain lane, so it can
        // keep repeating the last beats after the deck itself has faded
        const pre = d.normGain * fade * send * gate;
        eL[off + i] += bl[i] * pre;
        eR[off + i] += br[i] * pre;
        send += ds;
      }
      g += dg;
    }
    if (throwing && (from[5] > 0 || to[5] > 0)) {
      // vocal throw: only the voice that is still heard reaches its own echo
      let v = from[5] * n0;
      const dv = (to[5] * d.normGain - v) / len;
      const k0 = d.fade;
      const dk = (fade - k0) / len;
      for (let i = 0; i < len; i++) {
        const k = v * (k0 + dk * i);
        this.voiceInL[off + i] += this.sideL[i] * k;
        this.voiceInR[off + i] += this.sideR[i] * k;
        v += dv;
      }
    }
    d.fade = fade;
    d.echoGate = gate;
    if (fade === 0 && target === 0) {
      if (d.pendingSeek !== null) {
        d.loopSource.setLoop(null);
        d.wsola.reset(d.pendingSeek);
        d.clearTail();
        d.iso.reset(); d.filter.reset();
        d.pendingSeek = null;
        d.lanes = unity();
        d.laneTarget = null;
        d.fade = 1;
        d.fadeTarget = 1;
      } else if (d.stopWhenSilent) {
        d.loopSource.setLoop(null);
        d.playing = false;
        d.stopWhenSilent = false;
        d.fade = 1;
        d.fadeTarget = 1;
      }
    }
  }

  private applyMaster(outL: Float32Array, outR: Float32Array, n: number): void {
    // Order: DJ mix → room → listener tone → transport/volume → true-peak limiter. No gain after the limiter.
    this.reverb.process(outL, outR, n);
    this.tone.process(outL, outR, n);
    let tg = this.transport;
    const tgt = this.transportTarget;
    const vol0 = this.volume;
    const vol1 = this.volumeTarget;
    const dv = (vol1 - vol0) / n;
    let v = vol0;
    for (let i = 0; i < n; i++) {
      if (tg !== tgt) tg = tg < tgt ? Math.min(tgt, tg + this.transportStep) : Math.max(tgt, tg - this.transportStep);
      const k = tg * v;
      outL[i] *= k;
      outR[i] *= k;
      this.silentTransportFrames = tg === 0 && tgt === 0 ? this.silentTransportFrames + 1 : 0;
      v += dv;
    }
    this.transport = tg;
    this.volume = vol1;
    this.limiter.processBlock(outL, outR, 0, n);
    let pk = this.peak;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(outL[i]);
      const b = Math.abs(outR[i]);
      if (a > pk) pk = a;
      if (b > pk) pk = b;
    }
    this.peak = pk;
    // Drain the lookahead delay before freezing. Otherwise pause truncates the
    // final 5 ms of the fade and resume replays those stale delayed samples.
    if (tg === 0 && tgt === 0 && this.silentTransportFrames >= this.limiter.lookahead) this.paused = true;
  }

  // -------------------------------------------------------------- transitions

  private tryStartTransition(tr: ArmedTransition, a: Deck): boolean {
    const b = this.deckByToken(tr.toToken);
    if (!b || b === a) {
      this.emit({ type: 'fallback', planId: tr.planId, reason: 'deck_missing' });
      this.armed = null;
      return false;
    }
    const needFrames = Math.min(tr.durationFrames + this.sampleRate, this.sampleRate * 3) * 1.15 + 4096;
    const loop = tr.loopA;
    const tape=tr.tapeStopA;
    const loopReady = (!loop || a.store.covers(loop.start - loop.fade, loop.end))
      &&(!tape||a.store.covers(tape.start-2,tape.end+2));
    const ready = b.store.covers(tr.entryFrame - 4096, tr.entryFrame + needFrames) && loopReady;
    const vocalReady = this.vocalsReady(a, tr.triggerFrame - 4096, tr.triggerFrame + needFrames)
      && this.vocalsReady(b, tr.entryFrame - 4096, tr.entryFrame + needFrames);
    if (!ready || !vocalReady) {
      if (!this.lateNotified) {
        this.lateNotified = true;
        this.late = true;
        this.emit({ type: 'fallback', planId: tr.planId, reason: ready ? 'vocal_buffer_not_ready' : 'buffer_not_ready' });
        b.cueFrame = tr.entryFrame;
        this.requestData(a);
        this.requestData(b);
      }
      return false;
    }
    if (this.late) {
      // Started late: beat alignment is lost, so turn the plan into a short equal-power fade.
      const D = Math.round(this.sampleRate * 2);
      const pts = (f: (x: number) => number): [number, number][] =>
        Array.from({ length: 9 }, (_, i) => [Math.round((D * i) / 8), f(i / 8)] as [number, number]);
      this.armed = tr = {
        ...tr,
        method: 'fallback_crossfade',
        durationFrames: D,
        gapFrames: 0,
        swapFrame: Math.round(D / 2),
        tempoB: [[0, 1]],
        tempoA: undefined,
        loopA: undefined,
        tapeStopA:undefined,
        vocalA: undefined,
        vocalB: undefined,
        lanes: [
          { deck: 'A', lane: 0, points: pts((x) => Math.cos((x * Math.PI) / 2)) },
          { deck: 'B', lane: 0, points: pts((x) => Math.sin((x * Math.PI) / 2)) },
        ],
      };
      a.pendingVocalSource = b.pendingVocalSource = null;
    }
    a.vocalSource.setMap(a.pendingVocalSource?.getMap() ?? null);
    if (!a.loopSource.setLoop(tr.loopA ?? null)) this.emit({ type: 'fallback', planId: tr.planId, reason: 'invalid_loop' });
    if(!a.loopSource.setTapeStop(tr.tapeStopA??null))this.emit({type:'fallback',planId:tr.planId,reason:'invalid_tape_stop'});
    b.vocalSource.setMap(b.pendingVocalSource?.getMap() ?? null);
    // frozen for the whole blend: a moving subtraction gain would modulate the bed
    a.vocalSource.scale = a.voiceScale(this.sampleRate);
    b.vocalSource.scale = b.voiceScale(this.sampleRate);
    a.voiceExpected = !!tr.vocalA;
    b.voiceExpected = !!tr.vocalB;
    a.echoGate = a.voiceExpected ? 0 : 1;
    b.echoGate = b.voiceExpected ? 0 : 1;
    a.pendingVocalSource = b.pendingVocalSource = null;
    b.wsola.reset(tr.entryFrame);
    b.clearTail();
    b.playing = true;
    b.starved = false;
    b.fade = 1;
    b.fadeTarget = 1;
    b.stopWhenSilent = false;
    b.pendingSeek = null;
    b.endedNotified = false;
    if (tr.echoDelayFrames) this.echo.configure(tr.echoDelayFrames, tr.echoFeedback ?? 0.5);
    const throwLane = tr.lanes.some((l) => l.deck === 'A' && l.lane === 5 && l.points.some(([, v]) => v > 0));
    if (throwLane && tr.voiceEchoDelayFrames && a.vocalSource.getMap()) {
      this.voiceEcho.configure(tr.voiceEchoDelayFrames, tr.voiceEchoFeedback ?? 0.4);
      // The incoming mask opens in source space before a shared WSOLA window
      // has completely passed its knot. Leave 80 ms of acoustic clearance.
      const opening=tr.vocalB?.findIndex(([,gain])=>gain>0)??-1;
      if(tr.voiceEchoClearFrame !== undefined || opening>=0){
        const starts=tr.voiceEchoClearFrame ?? tr.vocalB![Math.max(0,opening-1)][0]+(tr.bDelayFrames??0);
        this.voiceEcho.limitTailAt(this.clock+Math.max(0,starts-Math.round(this.sampleRate*0.08)),Math.round(this.sampleRate*0.12));
      }
      a.wsola.setSide(a.heardVoice);
    }
    b.tempo = { origin: this.clock + (tr.gapFrames > 0 ? tr.durationFrames + tr.gapFrames : tr.bDelayFrames ?? 0), points: tr.tempoB };
    if (tr.tempoA && tr.tempoA.length) a.tempo = { origin: this.clock, points: tr.tempoA };
    b.lanes = this.evalLanes(tr, 'B', 0);
    a.laneTarget = b.laneTarget = null;
    this.active = true;
    this.t = 0;
    this.swapped = false;
    this.emit({ type: 'transitionStart', planId: tr.planId, late: this.late, clock: this.clock });
    return true;
  }

  private endTransition(): void {
    const tr = this.armed;
    if (!tr) return;
    const a = this.deckByToken(tr.fromToken);
    const b = this.deckByToken(tr.toToken);
    if (a) {
      a.playing = false;
      a.loopSource.setLoop(null);
      a.lanes = unity();
      a.wsola.setSide(null);
      a.vocalSource.setMap(null);
      a.pendingVocalSource = null;
      a.voiceExpected = false;
    }
    if (b) {
      b.lanes = unity();
      b.voiceExpected = false;
      this.main = b.index;
    }
    this.active = false;
    this.armed = null;
    for (const d of this.decks) d.pendingVocalSource = null;
    if (!this.swapped) this.emit({ type: 'swap', planId: tr.planId, token: tr.toToken });
    this.emit({ type: 'transitionEnd', planId: tr.planId, token: tr.toToken, forced: this.forced });
  }

  private abortTransition(reason: string): void {
    const id = this.armed?.planId ?? '';
    this.active = false;
    this.armed = null;
    for (const d of this.decks) {
      d.pendingVocalSource = null;
      d.loopSource.setLoop(null);
      d.vocalSource.setMap(null);
      d.voiceExpected = false;
      d.wsola.setSide(null);
    }
    this.voiceEcho.fadeOut(Math.round(this.sampleRate * 0.15));
    this.emit({ type: 'transitionAborted', planId: id, reason });
  }

  /** A removed/replaced participant must never leave a live plan behind. */
  private detachDeck(d: Deck, reason: string): void {
    const tr = this.armed;
    if (!tr || (tr.fromToken !== d.token && tr.toToken !== d.token)) return;
    if (!this.active) {
      this.disarm(reason);
      return;
    }
    const other = this.decks[1 - d.index];
    if (other.playing) {
      // the survivor keeps its current EQ/gain and glides back to unity
      other.laneTarget = unity();
      const ratio = this.ratioFor(other, this.clock);
      other.tempo = { origin: this.clock, points: [[0, ratio], [Math.round(this.sampleRate * 0.6), 1]] };
      this.main = other.index;
    }
    this.echo.reset();
    this.voiceEcho.reset();
    this.abortTransition(reason);
  }

  /** Moves every lane at most a full range per 0.3 s towards its target. */
  private glide(from: Lanes, target: Lanes, len: number): Lanes {
    const step = len / (this.sampleRate * 0.3);
    return from.map((v, i) => v + Math.max(-step, Math.min(step, target[i] - v))) as Lanes;
  }

  private evalLanes(tr: ArmedTransition, role: 'A' | 'B', t: number): Lanes {
    const v: Lanes = unity();
    for (const l of tr.lanes) if (l.deck === role) v[l.lane] = evalPoints(l.points, t);
    return v;
  }

  // ---------------------------------------------------------------- helpers

  private fadeOutAndStop(d: Deck, seconds: number): void {
    d.fadeTarget = 0;
    d.fadeStep = 1 / Math.max(1, Math.round(this.sampleRate * seconds));
    d.stopWhenSilent = true;
    d.pendingSeek = null;
  }

  private ratioFor(d: Deck, clock: number): number {
    if (!d.tempo) return 1;
    const r = evalPoints(d.tempo.points, clock - d.tempo.origin);
    const last = d.tempo.points[d.tempo.points.length - 1];
    if (clock - d.tempo.origin >= last[0] && Math.abs(last[1] - 1) < 1e-9) d.tempo = null;
    return r;
  }

  private deckByToken(token: string): Deck | null {
    for (const d of this.decks) if (d.token === token) return d;
    return null;
  }

  private checkEnded(): void {
    for (const d of this.decks) {
      if (!d.playing || !d.token || d.endedNotified) continue;
      if (d.position() - this.playback.bufferedMusicalFrames * this.ratioFor(d, this.clock) >= d.store.totalFrames) {
        const isA = this.armed && d.token === this.armed.fromToken;
        if (this.active && isA) continue;
        d.endedNotified = true;
        d.playing = false;
        if (this.armed && !this.active && isA) {
          const id = this.armed.planId;
          this.armed = null;
          this.emit({ type: 'fallback', planId: id, reason: 'a_ended_before_transition' });
        }
        this.emit({ type: 'ended', deck: d.index, token: d.token });
      }
    }
  }

  private requestData(d: Deck, around?: number): void {
    if (!d.token || d.store.totalFrames <= 0) return;
    const pos = around ?? (d.playing ? d.position() : d.cueFrame);
    const ahead = Math.round(this.aheadSeconds * this.sampleRate * 1.1);
    const from = Math.max(0, pos - 4096);
    const to = Math.min(d.store.totalFrames, pos + ahead);
    const missing = d.store.missing(from, to).filter((c) => !d.requested.has(c));
    // A playing deck's initial cue is historical, not a permanent PCM pin.
    // During a seek the old position remains audible until its fade finishes;
    // keep both windows, but never retain every chunk between distant cues.
    const window = (center: number): [number, number] => [center - CHUNK_FRAMES * 4, center + ahead + CHUNK_FRAMES * 2];
    const keep: [number, number][] = [window(pos)];
    const loop = d.token === this.armed?.fromToken ? this.armed.loopA : d.loopSource.getLoop();
    const tape=d.token===this.armed?.fromToken?this.armed.tapeStopA:d.loopSource.getTapeStop();
    if(tape){
      const from=Math.max(0,tape.start-CHUNK_FRAMES),to=Math.min(d.store.totalFrames,tape.end+CHUNK_FRAMES);
      keep.push([from,to]);
      for(const chunk of d.store.missing(from,to))if(!d.requested.has(chunk)&&!missing.includes(chunk))missing.push(chunk);
      this.requestVocals(d,d.vocalSource,from,to);
      if(d.pendingVocalSource)this.requestVocals(d,d.pendingVocalSource,from,to);
    }
    if (loop) {
      const from = Math.max(0, loop.start - loop.fade), to = Math.min(d.store.totalFrames, loop.end);
      keep.push([from, to]);
      for (const chunk of d.store.missing(from, to)) if (!d.requested.has(chunk) && !missing.includes(chunk)) missing.push(chunk);
      this.requestVocals(d, d.vocalSource, from, to);
      if (d.pendingVocalSource) this.requestVocals(d, d.pendingVocalSource, from, to);
    }
    if (d.playing && d.position() !== pos) keep.push(window(d.position()));
    if (d.pendingSeek !== null && d.pendingSeek !== pos) keep.push(window(d.pendingSeek));
    d.store.evictOutsideRanges(keep);
    const pendingCue = d.pendingVocalSource && this.armed
      ? d.token === this.armed.fromToken ? this.armed.triggerFrame : this.armed.entryFrame : pos;
    d.vocalStore.evictOutsideRanges(d.pendingVocalSource ? [...keep, window(pendingCue)] : keep);
    this.requestVocals(d, d.vocalSource, from, to);
    if (d.pendingVocalSource && this.armed) {
      const cue = d.token === this.armed.fromToken ? this.armed.triggerFrame : this.armed.entryFrame;
      this.requestVocals(d, d.pendingVocalSource, Math.max(0, cue - 4096), Math.min(d.store.totalFrames, cue + ahead));
    }
    if (missing.length) {
      for (const c of missing) d.requested.add(c);
      this.emit({ type: 'need', deck: d.index, token: d.token, chunks: missing });
    }
  }

  /**
   * Fits the stem scale on loaded chunks of the region that will be masked,
   * at most 2048 source frames per deck per render call (about 16x real time and
   * a few microseconds per quantum). Only blocks where the stem is within
   * -10 dB of the mix count as voiced.
   */
  private fitVoices(): void {
    const B = 2048;
    for (const d of this.decks) {
      const source = d.pendingVocalSource ?? (d.vocalSource.getMap() ? d.vocalSource : null);
      if (!d.token || !source) continue;
      let budget = B;
      for (const [from, to] of source.getSpans()) {
        const first = Math.max(0, Math.floor(from / CHUNK_FRAMES));
        const last = Math.min(d.store.chunkCount - 1, Math.floor((Math.min(to, d.store.totalFrames) - 1) / CHUNK_FRAMES));
        for (let c = first; c <= last && budget > 0; c++) {
          if (d.fitDone.has(c)) continue;
          const o = d.store.get(c);
          const v = d.vocalStore.get(c);
          if (!o || !v) continue;
          const n = Math.min(o.L.length, v.L.length);
          const base = c * CHUNK_FRAMES;
          // A cache chunk can straddle an entirely different phrase. Calibrate
          // only the samples actually used by the attenuation, not its loud
          // neighbour. Keep disjoint mask spans in the same chunk independent.
          const start = Math.max(d.fitCursors.get(c) ?? 0, Math.ceil(from) - base, 0);
          const end = Math.min(n, Math.ceil(to) - base, start + budget);
          if (end <= start) continue;
          let cross = 0, voice = 0, mix = 0;
          for (let i = start; i < end; i++) {
            const vl = v.L[i], vr = v.R[i], ol = o.L[i], or = o.R[i];
            cross += ol * vl + or * vr;
            voice += vl * vl + vr * vr;
            mix += ol * ol + or * or;
          }
          if (voice >= 0.1 * mix && voice > 1e-6 * (end - start)) {
            d.fitNum += cross;
            d.fitDen += voice;
            d.fitFrames += end - start;
          }
          budget -= end - start;
          d.fitCursors.set(c, end);
          if (end >= n || !source.needs(base + end, base + n)) d.fitDone.add(c);
        }
        if (budget <= 0) break;
      }
    }
  }

  private vocalsReady(d: Deck, from: number, to: number): boolean {
    if (!d.pendingVocalSource) return true;
    return d.vocalStore.missing(from, to).every((c) => !d.pendingVocalSource!.needs(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES));
  }

  private requestVocals(d: Deck, source: VocalPcmSource, from: number, to: number): void {
    if (!d.token || !source.needs(from, to)) return;
    const chunks = d.vocalStore.missing(from, to).filter((c) => !d.vocalRequested.has(c) && source.needs(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES));
    if (!chunks.length) return;
    for (const chunk of chunks) d.vocalRequested.add(chunk);
    this.emit({ type: 'need', deck: d.index, token: d.token, chunks, part: 'vocals' });
  }

  private tickMaybe(n: number): void {
    this.sinceTick += n;
    this.sinceNeed += n;
    if (this.sinceNeed >= this.sampleRate * 0.25) {
      this.sinceNeed = 0;
      for (const d of this.decks) if (d.token) this.requestData(d);
    }
    if (this.sinceTick < this.tickFrames) return;
    this.sinceTick = 0;
    const stats = this.limiter.takeStats();
    this.emit({
      type: 'tick',
      clock: this.clock,
      paused: this.paused,
      main: this.main,
      decks: this.decks.map((d) => {
        const pos = d.position();
        let ahead = 0;
        if (d.token) {
          const start = Math.floor(pos / CHUNK_FRAMES);
          let c = start;
          while (c < d.store.chunkCount && d.store.has(c)) c++;
          ahead = Math.max(0, c * CHUNK_FRAMES - pos);
        }
        return {
          token: d.token,
          position: Math.max(0, pos - this.playback.bufferedMusicalFrames * this.ratioFor(d, this.clock)),
          totalFrames: d.store.totalFrames,
          playing: d.playing,
          starved: d.starved,
          ratio: (d.tempo ? evalPoints(d.tempo.points, this.clock - d.tempo.origin) : 1) * this.playback.speedRatio,
          bufferedAhead: ahead,
        };
      }),
      transition: this.armed ? { planId: this.armed.planId, t: this.t, active: this.active, late: this.late } : null,
      limiterDb: stats.minGainDb,
      peak: this.peak,
    });
    this.peak = 0;
  }
}
