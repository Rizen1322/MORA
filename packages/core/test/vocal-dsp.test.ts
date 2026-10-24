import { describe, expect, it } from 'vitest';
import { ArraySource, Wsola, type PcmSource } from '../src/dsp/wsola.ts';
import { vocalSourceMap, VocalPcmSource } from '../src/engine/vocals.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type ArmedTransition, type MixerEvent } from '../src/engine/mixer.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import type { TransitionPlan } from '../src/types.ts';

const SR = 44100;

function music(seconds = 4) {
  const n = SR * seconds;
  const voice = Float32Array.from({ length: n }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 880 * i / SR));
  const drums = Float32Array.from({ length: n }, (_, i) => {
    const age = i % Math.round(SR * 0.4);
    return 0.1 * Math.sin(2 * Math.PI * 113 * i / SR) + 0.2 * Math.exp(-age / 500) * Math.sin(age * 0.18);
  });
  const original = Float32Array.from(drums, (x, i) => x + voice[i]);
  return { voice, drums, original };
}

function error(a: Float32Array, b: Float32Array, start = 0): number {
  let result = 0;
  for (let i = start; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i]));
  return result;
}

describe('aligned vocal subtraction before one stretcher', () => {
  it('maps voice envelopes through the exact integral of a ramping tempo', () => {
    const map = vocalSourceMap(100, [[0, 1], [100, 1.2], [200, 0.8]], [[0, 1], [75, 0], [150, 0], [200, 1]])!;
    expect(map.map(([frame]) => frame)).toEqual([100, 180.625, 210, 265, 310]);
    expect(map.map(([, gain]) => gain)).toEqual([1, 0, 0, 0, 1]);
  });

  it('keeps exact original PCM at unity without reading an optional stem', () => {
    const { original } = music(1);
    const forbiddenRead: PcmSource = { totalFrames: original.length, read: () => { throw new Error('unity must not read stem'); } };
    const source = new VocalPcmSource(new ArraySource(original), forbiddenRead, 4096);
    source.setMap([[0, 1], [original.length, 1]]);
    const L = new Float32Array(3000), R = new Float32Array(3000);
    expect(source.read(500, L.length, L, R, 0)).toBe(true);
    expect(error(L, original.subarray(500, 3500))).toBe(0);
    expect(source.needs(0, original.length)).toBe(false);
  });

  it.each([1, 0.88, 1.12])('removes singing while retaining the same stretched drums at ratio %f', (ratio) => {
    const { original, voice, drums } = music();
    const originalR = Float32Array.from(original, (x) => -x);
    const voiceR = Float32Array.from(voice, (x) => -x);
    const drumsR = Float32Array.from(drums, (x) => -x);
    const source = new VocalPcmSource(new ArraySource(original, originalR), new ArraySource(voice, voiceR), 4096);
    source.setMap([[0, 0], [original.length, 0]]);
    const shared = new Wsola(SR, source);
    const reference = new Wsola(SR, new ArraySource(drums, drumsR));
    shared.reset(0); reference.reset(0);
    const L = new Float32Array(SR * 2), R = new Float32Array(L.length);
    const expectedL = new Float32Array(L.length), expectedR = new Float32Array(L.length);
    for (let i = 0; i < L.length; i += 128) {
      const n = Math.min(128, L.length - i);
      expect(shared.render(L, R, i, n, () => ratio)).toBe(n);
      expect(reference.render(expectedL, expectedR, i, n, () => ratio)).toBe(n);
    }
    expect(error(L, expectedL, shared.H)).toBeLessThan(1e-5);
    expect(error(R, expectedR, shared.H)).toBeLessThan(1e-5);
    expect(shared.position()).toBe(reference.position());
  });

  it('removes only the voice in a rendered two-deck transition using aligned stem PCM', () => {
    const { original, voice, drums } = music();
    const silence = new Float32Array(original.length);
    const plan: TransitionPlan = {
      id: 'voice-audible', version: 'test', method: 'crossfade', fromTrackId: 'a', toTrackId: 'b',
      confidence: 1, reasons: [], debug: {}, aExit: 0.5, bEntry: 0, duration: 1.5, gap: 0, swapAt: 1.5,
      tempoB: [[0, 1]], gainA: 0, gainB: 0, vocalA: [[0, 0], [1.5, 0]],
      automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [1.3, 1], [1.5, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0]] }],
    };
    const muted = renderTransitionOffline({ L: original, R: original, sampleRate: SR, vocals: { L: voice, R: voice } }, { L: silence, R: silence, sampleRate: SR }, plan, 0.5, 0.2);
    const reference = renderTransitionOffline({ L: drums, R: drums, sampleRate: SR }, { L: silence, R: silence, sampleRate: SR }, { ...plan, vocalA: undefined }, 0.5, 0.2);
    // Ignore the intentional overlap/filter settling at the initial mask change.
    expect(error(muted.L.subarray(SR), reference.L.subarray(SR))).toBeLessThan(1e-5);
    expect(muted.events.some((e) => e.type === 'transitionEnd')).toBe(true);
    expect(muted.metrics.underruns).toBe(0);
    expect(() => renderTransitionOffline({ L: original, R: original, sampleRate: SR }, { L: silence, R: silence, sampleRate: SR }, plan)).toThrow(/vocal PCM/);
  });
});

describe('vocal chunk lifecycle in the real two-deck mixer', () => {
  const transition = (extra: Partial<ArmedTransition> = {}): ArmedTransition => ({
    planId: 'vocals', method: 'beatmatch_blend', fromToken: 'A', toToken: 'B',
    triggerFrame: SR, entryFrame: 0, durationFrames: SR * 2, gapFrames: 0, swapFrame: SR,
    tempoB: [[0, 1]],
    lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [SR * 2, 0]] }, { deck: 'B', lane: 0, points: [[0, 0], [SR * 2, 1]] }],
    vocalA: [[0, 1], [SR / 4, 0], [SR * 2, 0]],
    vocalB: [[0, 0], [SR * 2, 0], [SR * 2.5, 1]],
    ...extra,
  });
  const setup = (seconds = 6) => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(SR, (e) => events.push(e));
    const pcm = music(seconds);
    for (let deck = 0; deck < 2; deck++) {
      const token = deck ? 'B' : 'A';
      m.load(deck, token, pcm.original.length, 0);
      for (let c = 0; c * CHUNK_FRAMES < pcm.original.length; c++) {
        m.feed(deck, token, c, pcm.original.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES), pcm.original.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES));
      }
    }
    m.start(0, 'A', 0);
    return { m, events, pcm };
  };
  const render = (m: MixerCore, frames: number) => {
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < frames; i += 128) m.process(L, R, Math.min(128, frames - i));
  };
  const feedVoice = (m: MixerCore, pcm: ReturnType<typeof music>) => {
    for (let deck = 0; deck < 2; deck++) for (let c = 0; c * CHUNK_FRAMES < pcm.voice.length; c++) {
      m.feedVocal(deck, deck ? 'B' : 'A', c, pcm.voice.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES), pcm.voice.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES));
    }
  };

  it('requests stems only for a voice-aware plan and never stalls the outgoing track before its trigger', () => {
    const { m, events } = setup();
    render(m, SR / 4);
    expect(events.some((e) => e.type === 'need' && e.part === 'vocals')).toBe(false);
    m.arm(transition());
    expect(events.some((e) => e.type === 'need' && e.part === 'vocals' && e.token === 'A')).toBe(true);
    render(m, SR);
    expect(events.some((e) => e.type === 'transitionStart')).toBe(false);
    expect(events.some((e) => e.type === 'underrun')).toBe(false);
    expect(m.decks[0].position()).toBe(SR * 1.25);
  });

  it('runs a buffered voice handoff and retains the B release after the decks stop overlapping', () => {
    const { m, events, pcm } = setup();
    feedVoice(m, pcm);
    m.arm(transition());
    render(m, SR * 3);
    expect(events.some((e) => e.type === 'transitionEnd' && !e.forced)).toBe(true);
    expect(m.decks[1].vocalSource.gainAt(SR * 2.25)).toBeCloseTo(0.5, 5);
    expect(m.decks[1].vocalSource.gainAt(SR * 3)).toBe(1);
    render(m, SR);
    expect(events.some((e) => e.type === 'underrun')).toBe(false);
    m.seek('B', SR);
    expect(m.decks[1].vocalSource.gainAt(SR)).toBe(1);
  });

  it('preserves prefetched voice chunks for a future A exit and ignores stale stem tokens', () => {
    const { m, pcm } = setup(40);
    feedVoice(m, pcm);
    m.arm(transition({ triggerFrame: SR * 30 }));
    render(m, SR);
    expect(m.decks[0].vocalStore.has(Math.floor(SR * 30 / CHUNK_FRAMES))).toBe(true);
    m.load(1, 'C', pcm.original.length, 0);
    m.feedVocal(1, 'B', 0, pcm.voice.slice(0, CHUNK_FRAMES), pcm.voice.slice(0, CHUNK_FRAMES));
    expect(m.decks[1].vocalStore.has(0)).toBe(false);
  });

  it('restores original playback on optional stem failure without resetting tempo or play position', () => {
    const { m, events, pcm } = setup();
    feedVoice(m, pcm);
    m.arm(transition({ tempoB: [[0, 0.95], [SR * 3, 1]] }));
    render(m, SR * 2);
    const before = m.decks[1].position();
    const tempo = m.decks[1].tempo;
    m.disableVocals(1, 'B');
    expect(m.decks[1].position()).toBe(before);
    expect(m.decks[1].tempo).toBe(tempo);
    expect(m.decks[1].vocalSource.gainAt(before)).toBe(1);
    render(m, SR);
    expect(events.some((e) => e.type === 'underrun')).toBe(false);
    expect(events.some((e) => e.type === 'transitionEnd')).toBe(true);
  });

  it('replaces a stem generation while keeping the original playing PCM and clock intact',()=>{
    const {m,events,pcm}=setup();
    feedVoice(m,pcm);
    m.arm(transition({triggerFrame:SR*3}));
    render(m,SR/4);
    const d=m.decks[0],original=d.store,position=d.position(),tempo=d.tempo,lanes=d.lanes;
    d.vocalSource.scale=1.15;
    d.fitNum=20;d.fitDen=10;d.fitFrames=SR;d.fitDone.add(0);
    const old=d.vocalStore;
    expect(old.has(0)).toBe(true);
    expect(m.resetVocals(0,'stale-token')).toBe(false);
    expect(m.resetVocals(3,'A')).toBe(false);
    expect(d.vocalStore).toBe(old);
    expect(m.getArmed()).not.toBeNull();
    expect(m.resetVocals(0,'A')).toBe(true);
    expect(d.store).toBe(original);
    expect(d.position()).toBe(position);
    expect(d.tempo).toBe(tempo);
    expect(d.lanes).toBe(lanes);
    expect(d.playing).toBe(true);
    expect(d.vocalStore).not.toBe(old);
    expect(d.vocalStore.has(0)).toBe(false);
    expect(d.vocalSource.getMap()).toBeNull();
    expect(d.pendingVocalSource).toBeNull();
    expect(d.vocalSource.scale).toBe(1);
    expect(d.fitFrames).toBe(0);
    expect(d.fitDone.size).toBe(0);
    expect(d.wsola.hasSide()).toBe(false);
    expect(m.getArmed()).toBeNull();
    expect(events.some(e=>e.type==='disarmed'&&e.reason==='vocal_generation_changed')).toBe(true);
    // A fresh generation can now occupy exactly the same track/token/chunk.
    const fresh=Float32Array.from(pcm.voice.subarray(0,CHUNK_FRAMES),x=>x*.5);
    m.feedVocal(0,'A',0,fresh,fresh);
    expect(d.vocalStore.get(0)?.L[100]).toBe(fresh[100]);
    render(m,SR/2);
    expect(d.position()).toBeGreaterThan(position);
    expect(events.some(e=>e.type==='underrun')).toBe(false);
  });

  it('rejects generation resets during an active vocal blend',()=>{
    const {m,pcm}=setup();feedVoice(m,pcm);m.arm(transition());render(m,SR*1.5);
    expect(m.isTransitionActive()).toBe(true);
    const d=m.decks[0],store=d.vocalStore,map=d.vocalSource.getMap(),armed=m.getArmed(),position=d.position();
    expect(m.resetVocals(0,'A')).toBe(false);
    expect(d.vocalStore).toBe(store);
    expect(d.vocalSource.getMap()).toBe(map);
    expect(m.getArmed()).toBe(armed);
    expect(d.position()).toBe(position);
    expect(m.isTransitionActive()).toBe(true);
  });
});

describe('region-local vocal subtraction calibration', () => {
  const runFit = (m: MixerCore, calls = 100) => {
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < calls; i++) m.process(L, R, 128);
  };
  const prepare = (frames: number) => {
    const m = new MixerCore(SR, () => {});
    m.load(0, 'fit', frames, 0);
    return m;
  };
  const feed = (m: MixerCore, chunk: number, original: Float32Array, voice: Float32Array) => {
    // Anti-phase stereo must retain the same fit, rather than collapse to mono.
    m.feed(0, 'fit', chunk, original, Float32Array.from(original, x => -x));
    m.feedVocal(0, 'fit', chunk, voice, Float32Array.from(voice, x => -x));
  };

  it('does not turn a correctly separated quiet phrase into inverted ghost vocals because its neighbour is loud', () => {
    const n = CHUNK_FRAMES * 2, lo = 10000, hi = 40000;
    const m = prepare(n), d = m.decks[0];
    const voice = Float32Array.from({ length: n }, (_, i) => .1 * Math.sin(2 * Math.PI * 880 * i / SR));
    const original = Float32Array.from(voice, (v, i) => v * (i >= lo && i < hi ? 1 : 2));
    for (let c = 0; c < 2; c++) feed(m, c, original.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES), voice.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES));
    d.vocalSource.setMap([[0, 1], [lo, 1], [lo + 1, 0], [hi - 1, 0], [hi, 1], [n, 1]]);
    runFit(m);
    expect(d.fitFrames).toBe(hi - lo);
    expect(d.voiceScale(SR)).toBeCloseTo(1, 10);
    d.vocalSource.scale = d.voiceScale(SR);
    const L = new Float32Array(1024), R = new Float32Array(1024);
    expect(d.vocalSource.read(lo + 100, L.length, L, R, 0)).toBe(true);
    expect(Math.max(...L.map(Math.abs), ...R.map(Math.abs))).toBeLessThan(1e-7);
  });

  it('fits both disjoint masked regions in one chunk exactly once, excluding the gap', () => {
    const n = CHUNK_FRAMES, m = prepare(n), d = m.decks[0];
    const voice = new Float32Array(n).fill(.1);
    const original = Float32Array.from(voice, (v, i) => v * (i < 12000 || (i >= 18000 && i < 30000) ? 1.1 : 3));
    feed(m, 0, original, voice);
    d.vocalSource.setMap([[0, 0], [11999, 0], [12000, 1], [18000, 1], [18001, 0], [29999, 0], [30000, 1], [n, 1]]);
    runFit(m);
    expect(d.fitFrames).toBe(24000);
    expect(d.voiceScale(SR)).toBeCloseTo(1.06, 6);
    const den = d.fitDen;
    runFit(m);
    expect(d.fitFrames).toBe(24000);
    expect(d.fitDen).toBe(den);
  });

  it('does not double-count a partly fitted chunk when an earlier chunk arrives late', () => {
    const n = CHUNK_FRAMES * 2, m = prepare(n), d = m.decks[0];
    const voice = new Float32Array(CHUNK_FRAMES).fill(.1);
    const original = new Float32Array(CHUNK_FRAMES).fill(.11);
    d.vocalSource.setMap([[0, 0], [n, 0]]);
    feed(m, 1, original, voice);
    runFit(m, 3); // 6144 frames of chunk 1, while chunk 0 is absent.
    expect(d.fitFrames).toBe(6144);
    feed(m, 0, original, voice);
    runFit(m);
    expect(d.fitFrames).toBe(n);
    expect(d.voiceScale(SR)).toBeCloseTo(1.06, 6);
    d.resetFit();
    expect(d.fitCursors.size).toBe(0);
  });
});
