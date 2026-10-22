import { describe, expect, it } from 'vitest';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type ArmedTransition, type MixerEvent } from '../src/engine/mixer.ts';

/**
 * Acoustic regressions for the outgoing voice. The "voice" is an 880 Hz tone
 * that exists only in A's separated vocal stem; the accompaniment is a 110 Hz
 * tone with soft 2 kHz pulses. Every check measures the rendered output (what
 * would be heard), not envelope values.
 */
const SR = 44100;
const VOICE_HZ = 880;

function trackA(seconds: number) {
  const n = SR * seconds;
  const voice = Float32Array.from({ length: n }, (_, i) => 0.15 * Math.sin((2 * Math.PI * VOICE_HZ * i) / SR));
  const inst = Float32Array.from({ length: n }, (_, i) => {
    const age = i % Math.round(SR * 0.25);
    return 0.12 * Math.sin((2 * Math.PI * 110 * i) / SR) + 0.25 * Math.exp(-age / 900) * Math.sin((2 * Math.PI * 2000 * age) / SR);
  });
  const original = Float32Array.from(inst, (x, i) => x + voice[i]);
  return { voice, inst, original };
}

/** Goertzel magnitude (RMS-like) of one frequency in x[a, b). */
function tone(x: Float32Array, a: number, b: number, hz = VOICE_HZ): number {
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    // Hann window keeps leakage from the accompaniment out of the bin
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
    const s0 = x[i] * h + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, p)) / ((b - a) / 4);
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

interface Rig {
  m: MixerCore;
  events: MixerEvent[];
  out: Float32Array;
  rendered: number;
  render(seconds: number): void;
}

/** A plays drums+voice with stems loaded; B is silent so everything heard comes from A or the echo. */
/** `stemGain` < 1 models a separator that underestimates the voice (part of it stays in original - stem). */
function rig(seconds = 8, feedStem = true, stemGain = 1): Rig {
  const events: MixerEvent[] = [];
  const m = new MixerCore(SR, (e) => events.push(e));
  const a = trackA(seconds);
  const silence = new Float32Array(a.original.length);
  m.load(0, 'A', a.original.length, 0);
  m.load(1, 'B', silence.length, 0);
  for (let c = 0; c * CHUNK_FRAMES < a.original.length; c++) {
    const s = c * CHUNK_FRAMES;
    const e = s + CHUNK_FRAMES;
    m.feed(0, 'A', c, a.original.slice(s, e), a.original.slice(s, e));
    m.feed(1, 'B', c, silence.slice(s, e), silence.slice(s, e));
    if (feedStem) {
      const v = a.voice.slice(s, e).map((x) => x * stemGain);
      m.feedVocal(0, 'A', c, v, v);
    }
  }
  m.start(0, 'A', 0);
  const out = new Float32Array(SR * (seconds + 2));
  const r: Rig = {
    m,
    events,
    out,
    rendered: 0,
    render(sec: number) {
      const L = new Float32Array(128);
      const R = new Float32Array(128);
      const end = Math.min(out.length, r.rendered + Math.round(sec * SR));
      while (r.rendered < end) {
        const n = Math.min(128, end - r.rendered);
        m.process(L, R, n);
        out.set(L.subarray(0, n), r.rendered);
        r.rendered += n;
      }
    },
  };
  return r;
}

const f = (s: number) => Math.round(s * SR);

/** Echo-out style transition starting at A=1 s: voice ends at +0.5 s, echo send rises before that. */
function echoPlan(extra: Partial<ArmedTransition> = {}): ArmedTransition {
  return {
    planId: 'echo-voice',
    method: 'echo_out',
    fromToken: 'A',
    toToken: 'B',
    triggerFrame: f(1),
    entryFrame: 0,
    durationFrames: f(3),
    gapFrames: 0,
    swapFrame: f(1.2),
    tempoB: [[0, 1]],
    lanes: [
      { deck: 'A', lane: 0, points: [[0, 1], [f(1.1), 1], [f(1.2), 0]] },
      // the send opens 0.3 s BEFORE the voice is gone: the old bug fed the phrase into the feedback buffer
      { deck: 'A', lane: 4, points: [[0, 0], [f(0.2), 0], [f(0.3), 0.7], [f(1.2), 0.7], [f(1.25), 0]] },
      { deck: 'B', lane: 0, points: [[0, 1]] },
    ],
    echoDelayFrames: f(0.3),
    echoFeedback: 0.55,
    vocalA: [[0, 1], [f(0.4), 1], [f(0.5), 0], [f(3), 0]],
    ...extra,
  };
}

describe('old voice never comes back after the handoff', () => {
  it('the echo tail repeats the accompaniment but not the old voice', () => {
    const r = rig();
    r.m.arm(echoPlan());
    r.render(1);
    const before = tone(r.out, f(0.5), f(0.95));
    r.render(3.5);
    // A is cut at transition+1.2 s; from +1.3 s only the echo tail can be heard
    const tailVoice = tone(r.out, f(1 + 1.3), f(1 + 2.3));
    const tailLevel = rms(r.out, f(1 + 1.3), f(1 + 2.3));
    expect(before).toBeGreaterThan(0.1);
    expect(tailLevel).toBeGreaterThan(0.01); // the instrumental echo is really there
    expect(tailVoice / before).toBeLessThan(0.01); // < -40 dB of the old voice
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });

  it('control: the same echo plan without a voice mask does repeat the voice (the test can see it)', () => {
    const r = rig();
    r.m.arm(echoPlan({ vocalA: undefined }));
    r.render(4.5);
    const before = tone(r.out, f(0.5), f(0.95));
    expect(tone(r.out, f(1 + 1.3), f(1 + 2.3)) / before).toBeGreaterThan(0.05);
  });

  it('a forced finish keeps the outgoing voice going away instead of restoring it', () => {
    const r = rig();
    // a long blend whose voice handoff (at +3 s) has not happened yet
    r.m.arm(
      echoPlan({
        durationFrames: f(6),
        swapFrame: f(3),
        lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [f(6), 0]] }, { deck: 'B', lane: 0, points: [[0, 1]] }],
        vocalA: [[0, 1], [f(2.9), 1], [f(3), 0], [f(6), 0]],
        echoDelayFrames: undefined,
      }),
    );
    r.render(1.5);
    const before = tone(r.out, f(1.05), f(1.45));
    r.m.finishTransitionNow(0.6);
    r.render(1);
    // 0.2 s voice fade: from +0.25 s the old voice is gone while A's music still fades out
    const voiceLate = tone(r.out, f(1.5 + 0.25), f(1.5 + 0.55));
    const instLate = rms(r.out, f(1.5 + 0.25), f(1.5 + 0.45));
    expect(before).toBeGreaterThan(0.1);
    expect(voiceLate / before).toBeLessThan(0.02);
    expect(instLate).toBeGreaterThan(0.005);
    expect(r.events.some((e) => e.type === 'transitionEnd' && e.forced)).toBe(true);
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });

  it('losing the outgoing vocal stem mid-transition does not bring the full old mix back', () => {
    const r = rig();
    r.m.arm(
      echoPlan({
        durationFrames: f(4),
        swapFrame: f(2),
        lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [f(3.5), 1], [f(4), 0]] }, { deck: 'B', lane: 0, points: [[0, 1]] }],
        vocalA: [[0, 1], [f(0.4), 1], [f(0.5), 0], [f(4), 0]],
        echoDelayFrames: undefined,
      }),
    );
    r.render(1.8); // voice already removed
    const voiceMasked = tone(r.out, f(1.6), f(1.8));
    r.m.disableVocals(0, 'A');
    r.render(3.5);
    // without a stem the unmasked A would sing again; it must leave instead (0.18 s)
    const after = tone(r.out, f(1.8 + 0.25), f(1.8 + 1.25));
    const reference = tone(r.out, f(0.5), f(0.95));
    expect(voiceMasked / reference).toBeLessThan(0.02);
    expect(after / reference).toBeLessThan(0.02);
    expect(r.events.some((e) => e.type === 'transitionEnd')).toBe(true);
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });

  it('a vocal throw repeats only the last sung word and dies out by the planned time', () => {
    const r = rig();
    r.m.arm(
      echoPlan({
        method: 'beatmatch_blend',
        durationFrames: f(4),
        swapFrame: f(2),
        // A (music and voice) is gone at +0.55 s: whatever follows is the throw alone
        lanes: [
          { deck: 'A', lane: 0, points: [[0, 1], [f(0.5), 1], [f(0.55), 0]] },
          { deck: 'A', lane: 5, points: [[0, 0], [f(0.2), 0], [f(0.25), 0.5], [f(0.5), 0.5], [f(0.52), 0]] },
          { deck: 'B', lane: 0, points: [[0, 1]] },
        ],
        echoDelayFrames: undefined,
        vocalA: [[0, 1], [f(0.42), 1], [f(0.5), 0], [f(4), 0]],
        voiceEchoDelayFrames: f(0.3),
        voiceEchoFeedback: 0.35,
      }),
    );
    r.render(5);
    const before = tone(r.out, f(0.5), f(0.95));
    const echoVoice = tone(r.out, f(1 + 0.6), f(1 + 0.78));
    const echoInst = tone(r.out, f(1 + 0.6), f(1 + 0.78), 110);
    const instBefore = tone(r.out, f(0.5), f(0.95), 110);
    expect(before).toBeGreaterThan(0.1);
    expect(echoVoice / before).toBeGreaterThan(0.2); // the last word is really repeated
    expect(echoInst / instBefore).toBeLessThan(0.01); // and only the voice, not the band
    expect(tone(r.out, f(1 + 2.3), f(1 + 2.8)) / before).toBeLessThan(0.01); // gone (< -40 dB)
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });

  it('a forced finish fades the vocal throw out before the next voice opens', () => {
    const r = rig();
    r.m.arm(
      echoPlan({
        method: 'beatmatch_blend',
        durationFrames: f(4),
        swapFrame: f(2),
        lanes: [
          { deck: 'A', lane: 0, points: [[0, 1], [f(0.5), 1], [f(0.55), 0]] },
          { deck: 'A', lane: 5, points: [[0, 0], [f(0.2), 0], [f(0.25), 0.5], [f(0.5), 0.5], [f(0.52), 0]] },
          { deck: 'B', lane: 0, points: [[0, 1]] },
        ],
        echoDelayFrames: undefined,
        vocalA: [[0, 1], [f(0.42), 1], [f(0.5), 0], [f(4), 0]],
        voiceEchoDelayFrames: f(0.3),
        voiceEchoFeedback: 0.6,
      }),
    );
    r.render(1.6);
    r.m.finishTransitionNow(0.6);
    r.render(2);
    const before = tone(r.out, f(0.5), f(0.95));
    expect(tone(r.out, f(1.6 + 0.15), f(1.6 + 0.6)) / before).toBeLessThan(0.01);
  });

  it('a long repeated word cannot spill under B even with excessive echo feedback', () => {
    const r=rig();
    r.m.arm(echoPlan({
      method:'beatmatch_blend',durationFrames:f(4),swapFrame:f(1.2),
      lanes:[
        {deck:'A',lane:0,points:[[0,1],[f(0.5),1],[f(0.55),0]]},
        {deck:'A',lane:5,points:[[0,0],[f(0.1),0],[f(0.15),0.6],[f(0.5),0.6],[f(0.52),0]]},
        {deck:'B',lane:0,points:[[0,1]]},
      ],
      echoDelayFrames:undefined,
      vocalA:[[0,1],[f(0.42),1],[f(0.5),0],[f(4),0]],
      vocalB:[[0,0],[f(1.2),0],[f(1.35),1],[f(4),1]],
      voiceEchoDelayFrames:f(0.6),voiceEchoFeedback:0.75,
    }));
    // B's silent test stem is nevertheless required while its mask is closed.
    const silence=new Float32Array(SR*8);
    for(let c=0;c*CHUNK_FRAMES<silence.length;c++){
      const chunk=silence.slice(c*CHUNK_FRAMES,(c+1)*CHUNK_FRAMES);
      r.m.feedVocal(1,'B',c,chunk,chunk);
    }
    r.render(5.5);
    const reference=tone(r.out,f(0.5),f(0.95));
    expect(tone(r.out,f(1.75),f(1.95))/reference).toBeGreaterThan(0.1);
    // The second long repeat would otherwise start at +1.35 s and keep
    // singing for ~0.4 s while the incoming voice is already open.
    expect(tone(r.out,f(2.25),f(3.2))/reference).toBeLessThan(0.01);
    expect(r.events.some(e=>e.type==='underrun')).toBe(false);
  });

  it('losing the outgoing stem before the handoff ends A exactly when its voice was meant to end', () => {
    const r = rig();
    r.m.arm(
      echoPlan({
        durationFrames: f(4),
        swapFrame: f(2),
        lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [f(3.5), 1], [f(4), 0]] }, { deck: 'B', lane: 0, points: [[0, 1]] }],
        vocalA: [[0, 1], [f(1.9), 1], [f(2), 0], [f(4), 0]],
        echoDelayFrames: undefined,
      }),
    );
    r.render(1.5); // transition running, voice still planned to sing until +2 s
    r.m.disableVocals(0, 'A');
    r.render(4);
    const reference = tone(r.out, f(0.5), f(0.95));
    // still the full A (with its voice) right before the planned voice end...
    expect(rms(r.out, f(1 + 1.6), f(1 + 1.75))).toBeGreaterThan(0.05);
    // ...and nothing of the old voice after it
    expect(tone(r.out, f(1 + 2.05), f(1 + 3)) / reference).toBeLessThan(0.02);
    expect(r.events.some((e) => e.type === 'underrun')).toBe(false);
  });
});

describe('ghost voice left by an underestimating stem', () => {
  // A stays fully audible while its voice mask is closed: what remains at
  // 880 Hz is the part of the voice the stem did not contain.
  const plan = (): ArmedTransition => ({
    planId: 'ghost',
    method: 'crossfade',
    fromToken: 'A',
    toToken: 'B',
    triggerFrame: f(1),
    entryFrame: 0,
    durationFrames: f(3),
    gapFrames: 0,
    swapFrame: f(2),
    tempoB: [[0, 1]],
    lanes: [
      { deck: 'A', lane: 0, points: [[0, 1], [f(2.5), 1], [f(3), 0]] },
      { deck: 'B', lane: 0, points: [[0, 1]] },
    ],
    vocalA: [[0, 1], [f(0.4), 1], [f(0.5), 0], [f(3), 0]],
  });
  const ghost = (stemGain: number) => {
    const r = rig(8, true, stemGain);
    r.m.arm(plan());
    r.render(4);
    return tone(r.out, f(1 + 0.8), f(1 + 2.3)) / tone(r.out, f(0.5), f(0.95));
  };

  it('a stem that holds only 80 % of the voice leaves much less than 20 % of it behind', () => {
    // plain subtraction leaves exactly 0.2 (-14 dB); the fitted scale (capped at 1.15) leaves 0.08
    expect(ghost(0.8)).toBeLessThan(0.1);
  });

  it('an exact stem is not over-subtracted (no inverted voice appears)', () => {
    expect(ghost(1)).toBeLessThan(0.01);
  });
});
