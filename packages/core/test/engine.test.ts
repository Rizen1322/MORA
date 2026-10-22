import { describe, expect, it } from 'vitest';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type ArmedTransition, type MixerEvent } from '../src/engine/mixer.ts';
import { planTransition, planSkip } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type TransitionPlan } from '../src/types.ts';
import { attackLagMs, countClicks, fixture, peakAbs, plannerTrack } from './helpers.ts';

const S = DEFAULT_AUTOMIX_SETTINGS;
const SR = 44100;
const LIMIT = Math.pow(10, -1 / 20);
const clean = (style: 'house' | 'techno' | 'pop' | 'hiphop' | 'dnb', bpm: number, seed: number, bars = 48) =>
  fixture({ style, bpm, tonic: (seed * 5) % 12, mode: seed % 2 ? 'minor' : 'major', bars, seed, clean: true });

function feedAll(m: MixerCore, deck: number, token: string, L: Float32Array, R: Float32Array, skip?: (c: number) => boolean) {
  const n = Math.ceil(L.length / CHUNK_FRAMES);
  for (let c = 0; c < n; c++) {
    if (skip?.(c)) continue;
    const a = c * CHUNK_FRAMES;
    const b = Math.min(L.length, a + CHUNK_FRAMES);
    m.feed(deck, token, c, L.slice(a, b), R.slice(a, b));
  }
}

/** Simulated controller: answers the engine's data requests like the web app does. */
const sources = new WeakMap<MixerCore, { events: MixerEvent[]; pcm: Map<string, { L: Float32Array; R: Float32Array }>; seen: number }>();
function attach(m: MixerCore, events: MixerEvent[], pcm: Record<string, { L: Float32Array; R: Float32Array }>) {
  sources.set(m, { events, pcm: new Map(Object.entries(pcm)), seen: 0 });
}
function serve(m: MixerCore) {
  const src = sources.get(m);
  if (!src) return;
  for (; src.seen < src.events.length; src.seen++) {
    const e = src.events[src.seen];
    if (e.type !== 'need') continue;
    const p = src.pcm.get(e.token);
    if (!p) continue;
    for (const c of e.chunks) {
      const a = c * CHUNK_FRAMES;
      m.feed(e.deck, e.token, c, p.L.slice(a, a + CHUNK_FRAMES), p.R.slice(a, a + CHUNK_FRAMES));
    }
  }
}

function run(m: MixerCore, seconds: number, block = 128, sink?: { L: number[]; R: number[] }) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(block);
  const R = new Float32Array(block);
  for (let i = 0; i < n; i += block) {
    serve(m);
    m.process(L, R, block);
    if (sink) for (let k = 0; k < block; k++) {
      sink.L.push(L[k]);
      sink.R.push(R[k]);
    }
  }
}

/** Only one deck audible, EQ automation removed so kicks of both decks stay measurable. */
function solo(p: TransitionPlan, deck: 'A' | 'B'): TransitionPlan {
  const other = deck === 'A' ? 'B' : 'A';
  return {
    ...p,
    automation: [
      { deck, lane: 'gain', points: [[0, 1]] },
      { deck: other, lane: 'gain', points: [[0, 0]] },
    ],
  };
}

describe('offline render of a beatmatched transition', () => {
  const A = clean('house', 124, 31, 64);
  const B = clean('techno', 126, 32, 64);
  const plan = planTransition(plannerTrack('a', A), plannerTrack('b', B), S);
  const pcmA = { L: A.pcm.L, R: A.pcm.R, sampleRate: SR };
  const pcmB = { L: B.pcm.L, R: B.pcm.R, sampleRate: SR };

  it('plans a beatmatched blend with time stretching', () => {
    expect(plan.method).toBe('beatmatch_blend');
    expect(plan.beatAlign!.stretchPercent).toBeGreaterThan(1);
  });

  it('does not clip and has no clicks', () => {
    const r = renderTransitionOffline(pcmA, pcmB, plan, 6, 12);
    expect(peakAbs(r.L, r.R)).toBeLessThanOrEqual(LIMIT + 1e-5);
    expect(countClicks(r.L)).toBe(0);
    expect(countClicks(r.R)).toBe(0);
    expect(r.events.some((e) => e.type === 'transitionStart')).toBe(true);
    expect(r.events.some((e) => e.type === 'transitionEnd')).toBe(true);
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });

  it('keeps the beats of both tracks aligned during the overlap', () => {
    // Engine-reported deck positions are compared against the synthesizer's
    // ground-truth beat grids: the beat phase of A and of B must coincide.
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    m.load(0, 'A', A.pcm.L.length, plan.gainA);
    m.load(1, 'B', B.pcm.L.length, plan.gainB, Math.round(plan.bEntry * SR));
    m.start(0, 'A', Math.round((plan.aExit - 1) * SR));
    m.arm(planToArmed(plan, SR, 'A', 'B'));
    attach(m, events, { A: A.pcm, B: B.pcm });
    run(m, 1 + plan.duration);
    const phaseMs = (pos: number, beats: number[]) => {
      let prev = beats[0];
      for (const b of beats) if (b <= pos) prev = b;
      const idx = beats.indexOf(prev);
      const period = (beats[idx + 1] ?? prev + 0.5) - prev;
      return { frac: (pos - prev) / period };
    };
    const errs: number[] = [];
    for (const e of events) {
      if (e.type !== 'tick' || !e.transition?.active) continue;
      const a = e.decks.find((d) => d.token === 'A')!;
      const b = e.decks.find((d) => d.token === 'B')!;
      if (!a.playing || !b.playing) continue;
      const pa = phaseMs(a.position / SR, A.pcm.beats).frac;
      const pb = phaseMs(b.position / SR, B.pcm.beats).frac;
      let d = pa - pb;
      d -= Math.round(d);
      errs.push(Math.abs(d) * (60 / 124) * 1000);
    }
    expect(errs.length).toBeGreaterThan(50);
    errs.sort((x, y) => x - y);
    expect(errs[Math.floor(errs.length / 2)]).toBeLessThan(6);
    expect(errs[Math.floor(errs.length * 0.95)]).toBeLessThan(12);
  });

  it('continues B from where the transition left it (no duplicated audio)', () => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    m.load(0, 'A', A.pcm.L.length, plan.gainA);
    feedAll(m, 0, 'A', A.pcm.L, A.pcm.R);
    m.load(1, 'B', B.pcm.L.length, plan.gainB, Math.round(plan.bEntry * SR));
    feedAll(m, 1, 'B', B.pcm.L, B.pcm.R);
    m.start(0, 'A', Math.round((plan.aExit - 1) * SR));
    m.arm(planToArmed(plan, SR, 'A', 'B'));
    attach(m, events, { A: A.pcm, B: B.pcm });
    run(m, 1 + plan.duration + 0.5);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
    const ticks = events.filter((e): e is Extract<MixerEvent, { type: 'tick' }> => e.type === 'tick');
    const last = ticks[ticks.length - 1];
    const b = last.decks.find((d) => d.token === 'B')!;
    const a = last.decks.find((d) => d.token === 'A')!;
    expect(a.playing).toBe(false);
    expect(b.playing).toBe(true);
    // B position = entry + integral of the tempo map over output time
    const tOut = last.clock / SR - 1; // output seconds since transition start
    const rAt = (t: number) => {
      const pts = plan.tempoB;
      if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
      for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (t - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
      return 1;
    };
    let expected = plan.bEntry;
    for (let t = 0; t < tOut; t += 0.001) expected += rAt(t + 0.0005) * Math.min(0.001, tOut - t);
    expect(Math.abs(b.position / SR - expected)).toBeLessThan(0.03);
    expect(last.main).toBe(1);
  });
});

describe('mixer state machine', () => {
  const A = clean('house', 124, 41, 32);
  const B = clean('house', 124, 42, 32);
  const plan = planTransition(plannerTrack('a', A), plannerTrack('b', B), S);

  function setup(opts: { feedB?: (c: number) => boolean } = {}) {
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    m.load(0, 'A', A.pcm.L.length, 0);
    feedAll(m, 0, 'A', A.pcm.L, A.pcm.R);
    m.load(1, 'B', B.pcm.L.length, 0, Math.round(plan.bEntry * SR));
    feedAll(m, 1, 'B', B.pcm.L, B.pcm.R, opts.feedB ? (c) => !opts.feedB!(c) : undefined);
    m.start(0, 'A', Math.round((plan.aExit - 0.5) * SR));
    m.arm(planToArmed(plan, SR, 'A', 'B'));
    if (!opts.feedB) attach(m, events, { A: A.pcm, B: B.pcm });
    else attach(m, events, { A: A.pcm });
    return { m, events };
  }
  const lastTick = (ev: MixerEvent[]) => ev.filter((e): e is Extract<MixerEvent, { type: 'tick' }> => e.type === 'tick').pop()!;

  it('pauses and resumes in the middle of a transition without losing position', () => {
    const { m, events } = setup();
    run(m, 0.5 + plan.duration / 2);
    m.setPaused(true);
    run(m, 0.1);
    const before = lastTick(events);
    const sink = { L: [] as number[], R: [] as number[] };
    run(m, 1, 128, sink);
    expect(Math.max(...sink.L.map(Math.abs))).toBe(0);
    const during = lastTick(events);
    expect(during.paused).toBe(true);
    expect(during.decks[1].position).toBe(before.decks[1].position);
    m.setPaused(false);
    run(m, plan.duration / 2 + 1);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
  });

  it('seek during a transition aborts it and keeps only the sought deck', () => {
    const { m, events } = setup();
    run(m, 0.5 + plan.duration / 3);
    m.seek('B', Math.round(60 * SR));
    run(m, 1);
    expect(events.some((e) => e.type === 'transitionAborted')).toBe(true);
    const t = lastTick(events);
    expect(t.decks[0].playing).toBe(false);
    expect(t.decks[1].playing).toBe(true);
    expect(Math.abs(t.decks[1].position / SR - 61)).toBeLessThan(0.1);
  });

  it('skip during a transition finishes it quickly', () => {
    const { m, events } = setup();
    run(m, 0.5 + 1);
    m.finishTransitionNow(0.4);
    run(m, 0.6);
    const end = events.find((e) => e.type === 'transitionEnd');
    expect(end && end.type === 'transitionEnd' && end.forced).toBe(true);
    const t = lastTick(events);
    expect(t.decks[0].playing).toBe(false);
    expect(t.main).toBe(1);
  });

  it('falls back to a late crossfade when B is not buffered in time', () => {
    const missing = new Set([Math.floor((plan.bEntry * SR) / CHUNK_FRAMES)]);
    const { m, events } = setup({ feedB: (c) => !missing.has(c) });
    run(m, 1);
    expect(events.some((e) => e.type === 'fallback' && e.reason === 'buffer_not_ready')).toBe(true);
    expect(events.some((e) => e.type === 'transitionStart')).toBe(false);
    // data arrives late
    for (const c of missing) {
      const a = c * CHUNK_FRAMES;
      m.feed(1, 'B', c, B.pcm.L.slice(a, a + CHUNK_FRAMES), B.pcm.R.slice(a, a + CHUNK_FRAMES));
    }
    run(m, 3);
    const st = events.find((e) => e.type === 'transitionStart');
    expect(st && st.type === 'transitionStart' && st.late).toBe(true);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
  });

  it('emits ended when A finishes before B could start', () => {
    const missing = new Set(Array.from({ length: 200 }, (_, i) => i));
    const { m, events } = setup({ feedB: (c) => !missing.has(c) });
    run(m, A.pcm.L.length / SR - plan.aExit + 1);
    expect(events.some((e) => e.type === 'ended' && e.token === 'A')).toBe(true);
    expect(events.some((e) => e.type === 'fallback' && e.reason === 'a_ended_before_transition')).toBe(true);
  });

  it('disarms when the queued next track changes before the transition', () => {
    const { m, events } = setup();
    m.load(1, 'C', B.pcm.L.length, 0, 0);
    expect(events.some((e) => e.type === 'disarmed')).toBe(true);
    expect(m.getArmed()).toBeNull();
  });

  it('applies a manual skip fade immediately', () => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    m.load(0, 'A', A.pcm.L.length, 0);
    feedAll(m, 0, 'A', A.pcm.L, A.pcm.R);
    m.load(1, 'B', B.pcm.L.length, 0, 0);
    feedAll(m, 1, 'B', B.pcm.L, B.pcm.R);
    m.start(0, 'A', SR * 10);
    attach(m, events, { A: A.pcm, B: B.pcm });
    run(m, 1);
    const pos = lastTick(events).decks[0].position / SR;
    const skip = planSkip(plannerTrack('a', A), plannerTrack('b', B), pos + 0.05, S);
    m.arm(planToArmed(skip, SR, 'A', 'B'));
    const sink = { L: [] as number[], R: [] as number[] };
    run(m, 1, 128, sink);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
    expect(countClicks(Float32Array.from(sink.L))).toBe(0);
  });
});

describe('audio-clock boundaries and sparse programme material', () => {
  const tone = (seconds: number, hz: number, amp = 0.2) => {
    const L = Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
    return { L, R: L, sampleRate: SR };
  };
  const armed = (extra: Partial<ArmedTransition> = {}): ArmedTransition => ({
    planId: 'boundary', method: 'crossfade', fromToken: 'A', toToken: 'B',
    triggerFrame: 1371, entryFrame: 0, durationFrames: SR, gapFrames: 0,
    swapFrame: SR / 2, tempoB: [[0, 1]],
    lanes: [
      { deck: 'A', lane: 0, points: [[0, 1], [SR, 0]] },
      { deck: 'B', lane: 0, points: [[0, 0], [SR, 1]] },
    ],
    ...extra,
  });
  const rawSetup = (tr: ArmedTransition, a = tone(6, 220), b = tone(6, 330)) => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    m.load(0, 'A', a.L.length, 0);
    m.load(1, 'B', b.L.length, 0, tr.entryFrame);
    feedAll(m, 0, 'A', a.L, a.R);
    feedAll(m, 1, 'B', b.L, b.R);
    m.start(0, 'A', 0);
    m.arm(tr);
    return { m, events };
  };
  const frames = (m: MixerCore, n: number, block = 257) => {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i += block) {
      const take = Math.min(block, n - i);
      m.process(L.subarray(i, i + take), R.subarray(i, i + take), take);
    }
    return L;
  };

  it('starts exactly on its trigger sample, independently of render-block size', () => {
    for (const block of [128, 257, 1024]) {
      const { m, events } = rawSetup(armed());
      frames(m, SR / 2, block);
      const start = events.find((e) => e.type === 'transitionStart');
      expect(start?.type === 'transitionStart' && start.clock).toBe(1371);
    }
  });

  it('keeps audible percussion attacks aligned through a 120 to 132 BPM tempo glide', () => {
    const pulseTrain = (bpm: number) => {
      const L = new Float32Array(SR * 20);
      const width = Math.round(SR * 0.035);
      for (let beat = 0; beat * 60 / bpm < 20; beat++) {
        const start = Math.round((beat * 60 / bpm) * SR);
        for (let k = 0; k < width && start + k < L.length; k++) {
          const envelope = Math.sin(Math.PI * k / width) ** 2;
          L[start + k] = 0.4 * envelope * Math.sin(2 * Math.PI * 150 * k / SR);
        }
      }
      return { L, R: L, sampleRate: SR };
    };
    const a = pulseTrain(120);
    const b = pulseTrain(132);
    const duration = 12;
    const tr = armed({
      triggerFrame: SR / 2, durationFrames: duration * SR, swapFrame: duration * SR / 2,
      tempoA: [[0, 1], [duration * SR, 1.1]],
      tempoB: [[0, 120 / 132], [duration * SR, 1]],
    });
    const renderSolo = (deck: 'A' | 'B') => {
      const { m } = rawSetup({ ...tr, lanes: [
        { deck: 'A', lane: 0, points: [[0, deck === 'A' ? 1 : 0]] },
        { deck: 'B', lane: 0, points: [[0, deck === 'B' ? 1 : 0]] },
      ] }, a, b);
      return frames(m, Math.round((duration + 0.5) * SR), 128);
    };
    const outA = renderSolo('A');
    const outB = renderSolo('B');
    const center = (x: Float32Array, t: number) => {
      let energy = 0;
      let moment = 0;
      for (let i = Math.round((t - 0.06) * SR); i < Math.round((t + 0.09) * SR); i++) {
        const e = x[i] * x[i];
        energy += e;
        moment += e * i;
      }
      expect(energy).toBeGreaterThan(5);
      return moment / energy / SR;
    };
    const errors: number[] = [];
    for (let beat = 2; beat <= 23; beat++) {
      // Integral of the shared beat rate: 2*t + (0.1/duration)*t^2.
      const t = 0.5 + 2 * beat / (2 + Math.sqrt(4 + 0.4 * beat / duration));
      errors.push(Math.abs(center(outA, t) - center(outB, t)) * 1000);
    }
    errors.sort((x, y) => x - y);
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(8);
    expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThan(15);
    expect(errors[errors.length - 1]).toBeLessThan(20);
  });

  it('holds B until the complete outgoing fade and intentional gap have elapsed', () => {
    const fade = 1323;
    const gap = 5292;
    const tr = armed({
      triggerFrame: 1371, durationFrames: fade, gapFrames: gap,
      entryFrame: 2000, swapFrame: fade,
      lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [fade, 0]] }],
    });
    for (const block of [128, 257, 1024]) {
      const { m, events } = rawSetup(tr);
      const end = tr.triggerFrame + fade + gap;
      const L = frames(m, end, block);
      expect(m.decks[1].position()).toBe(tr.entryFrame);
      expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
      // Leave room for the limiter's 5 ms delay after A's final sample.
      expect(peakAbs(L.subarray(tr.triggerFrame + fade + 300))).toBeLessThan(1e-7);
      frames(m, 1000, block);
      expect(m.decks[1].position()).toBe(tr.entryFrame + 1000);
    }
  });

  it('finishes a manual skip on the audio clock while smoothly opening B', () => {
    const duration = SR * 4;
    const tr = armed({
      triggerFrame: 0, durationFrames: duration, swapFrame: duration / 2,
      lanes: [
        { deck: 'A', lane: 0, points: [[0, 1], [duration, 0]] },
        { deck: 'B', lane: 0, points: [[0, 0], [duration, 1]] },
      ],
    });
    const { m, events } = rawSetup(tr);
    frames(m, SR);
    const before = m.decks[1].position();
    m.finishTransitionNow(0.4);
    expect(m.isTransitionActive()).toBe(true);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(false);
    expect(m.decks[1].lanes[0]).toBeCloseTo(0.25, 3);
    const first = frames(m, Math.round(SR * 0.2));
    expect(m.decks[1].lanes[0]).toBeCloseTo(0.625, 3);
    expect(m.decks[1].position()).toBe(before + Math.round(SR * 0.2));
    const second = frames(m, Math.round(SR * 0.2));
    expect(events.filter((e) => e.type === 'transitionEnd' && e.forced)).toHaveLength(1);
    expect(m.decks[0].playing).toBe(false);
    expect(m.decks[1].playing).toBe(true);
    const joined = new Float32Array(first.length + second.length);
    joined.set(first);
    joined.set(second, first.length);
    expect(countClicks(joined)).toBe(0);
  });

  it('plays a delayed echo even when silent blocks precede its first repeat', () => {
    const a = tone(3, 440, 0);
    const burst = tone(0.02, 440, 0.2).L;
    a.L.set(burst, Math.round(0.05 * SR));
    const b = tone(3, 330, 0);
    const tr = armed({
      triggerFrame: 0, durationFrames: SR, echoDelayFrames: Math.round(0.25 * SR), echoFeedback: 0.4,
      lanes: [
        { deck: 'A', lane: 0, points: [[0, 0]] },
        { deck: 'A', lane: 4, points: [[0, 1]] },
        { deck: 'B', lane: 0, points: [[0, 0]] },
      ],
    });
    const { m } = rawSetup(tr, a, b);
    const L = frames(m, Math.round(SR * 0.9), 128);
    const energy = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) sum += L[i] * L[i];
      return sum;
    };
    expect(energy(0.1, 0.28)).toBe(0);
    const first = energy(0.30, 0.35);
    const second = energy(0.55, 0.60);
    expect(first).toBeGreaterThan(5);
    expect(second).toBeGreaterThan(first * 0.03);
    expect(second).toBeLessThan(first * 0.3);
    m.stopAll();
    expect(peakAbs(frames(m, SR))).toBe(0);
  });

  it('aborts a plan when a participating deck is unloaded or replaced', () => {
    for (const replace of [false, true]) {
      const { m, events } = rawSetup(armed({ triggerFrame: 0 }));
      frames(m, SR / 4);
      if (replace) m.load(1, 'C', SR * 4, 0);
      else m.unload(1);
      expect(m.getArmed()).toBeNull();
      expect(m.isTransitionActive()).toBe(false);
      expect(events.filter((e) => e.type === 'transitionAborted')).toHaveLength(1);
      frames(m, SR);
      expect(events.some((e) => e.type === 'transitionEnd')).toBe(false);
      expect(m.decks[0].playing).toBe(true);
      expect(m.main).toBe(0);
    }
  });

  it('the surviving deck glides back to unity when its blend is aborted (no gain/EQ step)', () => {
    // B is at gain 0.25 with its bass removed when A disappears mid-blend.
    const tr = armed({
      triggerFrame: 0,
      lanes: [
        { deck: 'A', lane: 0, points: [[0, 1], [SR, 0]] },
        { deck: 'B', lane: 0, points: [[0, 0], [SR, 1]] },
        { deck: 'B', lane: 1, points: [[0, 0], [SR, 0]] },
      ],
    });
    const { m } = rawSetup(tr, tone(6, 220), tone(6, 60, 0.3));
    frames(m, SR / 4);
    m.unload(0);
    const L = frames(m, SR / 2, 128);
    // 60 Hz amplitude (bass band of B only) over exactly one cycle, every 5 ms
    const amp = (a: number) => {
      const n = 735, w = (2 * Math.PI * 60) / SR;
      let c = 0, s = 0;
      for (let i = 0; i < n; i++) { c += L[a + i] * Math.cos(w * (a + i)); s += L[a + i] * Math.sin(w * (a + i)); }
      return (2 * Math.hypot(c, s)) / n;
    };
    let worst = 0;
    for (let a = 0; a + 220 + 735 < L.length; a += 220) worst = Math.max(worst, Math.abs(amp(a + 220) - amp(a)));
    expect(amp(L.length - 735)).toBeGreaterThan(0.2);
    // a 0.3 s glide moves the 60 Hz level by ~0.01 per 5 ms; the old instant
    // 0 -> 1 bass and 0.25 -> 1 gain step moved it by several times that
    expect(worst).toBeLessThan(0.02);
  });

  it('drains the limiter before pausing and resumes without a stale audio tail', () => {
    const { m } = rawSetup(armed({ triggerFrame: SR * 10 }));
    const before = frames(m, SR);
    m.setPaused(true);
    const fade = frames(m, Math.round(SR * 0.1), 128);
    expect(m.paused).toBe(true);
    expect(peakAbs(fade.subarray(Math.round(SR * 0.03)))).toBe(0);
    const position = m.decks[0].position();
    expect(peakAbs(frames(m, SR / 4))).toBe(0);
    expect(m.decks[0].position()).toBe(position);
    m.setPaused(false);
    const resume = frames(m, SR / 2, 128);
    const joined = new Float32Array(before.length + fade.length + resume.length);
    joined.set(before);
    joined.set(fade, before.length);
    joined.set(resume, before.length + fade.length);
    expect(countClicks(joined)).toBe(0);
  });

  it('refills evicted PCM throughout long offline transitions and reports their exact start', () => {
    const a = tone(2, 220);
    const b = tone(45, 330);
    const plan: TransitionPlan = {
      id: 'long-offline', version: 'test', fromTrackId: 'a', toTrackId: 'b',
      method: 'crossfade', confidence: 1, reasons: [], aExit: 0.1, bEntry: 0,
      duration: 35, gap: 0, swapAt: 0.5, tempoB: [[0, 1]], gainA: 0, gainB: 0,
      automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [0.5, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [0.5, 1]] },
      ], debug: {},
    };
    const r = renderTransitionOffline(a, b, plan, 0.07, 2);
    expect(r.transitionStartFrame).toBe(Math.round(0.07 * SR));
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
    expect(r.metrics.underruns).toBe(0);
    expect(r.metrics.peak).toBe(peakAbs(r.L, r.R));
    expect(peakAbs(r.L.subarray(30 * SR))).toBeGreaterThan(0.19);
  });

  it('reports actual limiter attenuation rather than a constant placeholder', () => {
    const a = tone(1, 997, 3);
    const b = tone(1, 997, 3);
    const plan: TransitionPlan = {
      id: 'limiter-metrics', version: 'test', fromTrackId: 'a', toTrackId: 'b',
      method: 'crossfade', confidence: 1, reasons: [], aExit: 0.1, bEntry: 0,
      duration: 0.1, gap: 0, swapAt: 0.05, tempoB: [[0, 1]], gainA: 0, gainB: 0,
      automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [0.1, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [0.1, 1]] },
      ], debug: {},
    };
    const r = renderTransitionOffline(a, b, plan, 0.1, 0.2);
    expect(r.metrics.peak).toBe(peakAbs(r.L, r.R));
    expect(r.metrics.peak).toBeLessThanOrEqual(LIMIT + 1e-6);
    expect(r.metrics.maxLimiterReductionDb).toBeGreaterThan(10);
    expect(r.metrics.underruns).toBe(0);
  });
});

describe('long chain of transitions', () => {
  it('plays 8 tracks back to back with AutoMix, no gaps, no clipping, no clicks', () => {
    const tracks = [
      clean('house', 122, 51, 40),
      clean('house', 124, 52, 40),
      clean('techno', 127, 53, 40),
      clean('pop', 118, 54, 40),
      clean('hiphop', 88, 55, 32),
      clean('dnb', 174, 56, 64),
      clean('house', 124, 57, 40),
      clean('pop', 140, 58, 40),
    ];
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    const token = (i: number) => `t${i}`;
    const deckOf = (i: number) => i % 2;
    const methods: string[] = [];
    let current = 0;
    const loadTrack = (i: number) => {
      const t = tracks[i];
      m.load(deckOf(i), token(i), t.pcm.L.length, 0, 0);
      feedAll(m, deckOf(i), token(i), t.pcm.L, t.pcm.R);
    };
    const prepare = (i: number) => {
      if (i + 1 >= tracks.length) return;
      const plan = planTransition(plannerTrack(token(i), tracks[i]), plannerTrack(token(i + 1), tracks[i + 1]), S);
      methods.push(plan.method);
      m.load(deckOf(i + 1), token(i + 1), tracks[i + 1].pcm.L.length, plan.gainB, Math.round(plan.bEntry * SR));
      feedAll(m, deckOf(i + 1), token(i + 1), tracks[i + 1].pcm.L, tracks[i + 1].pcm.R);
      m.setGain(deckOf(i), plan.gainA);
      m.arm(planToArmed(plan, SR, token(i), token(i + 1)));
    };
    loadTrack(0);
    m.start(0, token(0), 0);
    prepare(0);
    const block = 1024;
    const L = new Float32Array(block);
    const R = new Float32Array(block);
    let peak = 0;
    let clicks = 0;
    let silentRun = 0;
    let maxSilentRun = 0;
    let playing = true;
    let guard = 0;
    const all: Float32Array[] = [];
    const pcmMap: Record<string, { L: Float32Array; R: Float32Array }> = {};
    tracks.forEach((t, i) => (pcmMap[token(i)] = t.pcm));
    attach(m, events, pcmMap);
    const maxBlocks = Math.ceil((tracks.reduce((a, t) => a + t.pcm.L.length, 0) / block) * 1.2);
    while (playing && guard++ < maxBlocks) {
      const before = events.length;
      serve(m);
      m.process(L, R, block);
      for (let k = 0; k < block; k++) {
        peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
        if (Math.abs(L[k]) < 1e-4) silentRun++;
        else {
          maxSilentRun = Math.max(maxSilentRun, silentRun);
          silentRun = 0;
        }
      }
      all.push(L.slice());
      for (let i = before; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'transitionEnd') {
          current++;
          prepare(current);
        }
        if (e.type === 'ended' && e.token === token(tracks.length - 1)) playing = false;
      }
    }
    const total = new Float32Array(all.length * block);
    all.forEach((b, i) => total.set(b, i * block));
    clicks = countClicks(total);
    expect(current).toBe(tracks.length - 1);
    expect(methods).toHaveLength(tracks.length - 1);
    expect(methods.filter((x) => x === 'beatmatch_blend').length).toBeGreaterThanOrEqual(3);
    expect(peak).toBeLessThanOrEqual(LIMIT + 1e-5);
    // the detector may flag at most one -46 dBFS >14 kHz spike where attacks of both decks coincide
    expect(clicks).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === 'underrun')).toBe(false);
    expect(events.filter((e) => e.type === 'ended').length).toBe(1);
    // no unplanned silence longer than 300 ms between tracks
    expect(maxSilentRun / SR).toBeLessThan(0.3);
  });
});
