import { CHUNK_FRAMES } from '../../../../packages/core/src/engine/chunks.ts';
import { MixerCore, type ArmedTransition, type MixerEvent } from '../../../../packages/core/src/engine/mixer.ts';

// The Node reference for the Swift port (test/native-dsp/main.swift repeats these steps).
export function run() {
  return [44100, 48000].flatMap(sr => ['transport', 'transition', 'effects', 'tape'].map(kind => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(sr, e => { if (e.type !== 'need') events.push(e); });
    const pcm: number[] = [];
    const phases: { name: string; paused: boolean; main: number; clock: number }[] = [];
    function source(deck: number, token: string, seed: number) {
      const count = sr * 6;
      const left = new Float32Array(count), right = new Float32Array(count);
      let state = seed;
      for (let i = 0; i < count; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        // Smooth nonperiodic stereo signal; integer input generation is portable.
        const noise = (state / 4294967296 - .5) * .03;
        left[i] = (i ? left[i - 1] * .98 : 0) + noise + ((i % 233) / 233 - .5) * .012;
        right[i] = (i ? right[i - 1] * .97 : 0) - noise + ((i % 317) / 317 - .5) * .015;
      }
      m.load(deck, token, count, 0);
      for (let i = 0; i < count; i += CHUNK_FRAMES) {
        m.feed(deck, token, i / CHUNK_FRAMES, left.slice(i, i + CHUNK_FRAMES), right.slice(i, i + CHUNK_FRAMES));
      }
    }
    function render(seconds: number, name: string) {
      const left = new Float32Array(128), right = new Float32Array(128);
      for (let block = 0; block < Math.ceil(seconds * sr / 128); block++) {
        m.process(left, right, 128);
        for (let i = 0; i < 128; i++) pcm.push(left[i], right[i]);
      }
      phases.push({ name, paused: m.paused, main: m.main, clock: m.clock });
    }
    source(0, 'A', 123);
    m.start(0, 'A', 0);
    if (kind === 'transport') {
      render(.25, 'playing');
      m.setPaused(true);
      render(.12, 'paused');
      m.seek('A', Math.round(1.25 * sr));
      render(.06, 'seekPaused');
      m.setPaused(false);
      render(.25, 'resumed');
      m.setPlayback({ speed: 1.08, semitones: 1 });
      render(.25, 'speedPitch');
      m.stopAll();
      render(.06, 'stopped');
    } else if (kind === 'effects' || kind === 'tape') {
      // Listener tone and room on the master, a looped or tape-stopped outgoing deck, then speed/pitch.
      source(1, 'B', 456);
      m.setTone({ enabled: true, gains: [3, 2, 0, -1, 0, 1.5, 2, -2, 1, 0], preampDb: -1, autoHeadroom: true, balance: .2, mono: false, reverbMix: .2 });
      const duration = Math.round(1.5 * sr);
      const plan: ArmedTransition = {
        planId: `native-${kind}`, method: kind === 'tape' ? 'tape_stop' : 'loop_out', fromToken: 'A', toToken: 'B',
        triggerFrame: Math.round(.6 * sr), entryFrame: Math.round(.3 * sr),
        durationFrames: duration, gapFrames: 0, swapFrame: Math.round(duration / 2), bDelayFrames: Math.round(.1 * sr),
        tempoB: [[0, .985], [duration, 1]], tempoA: [[0, 1], [duration, 1.01]],
        ...(kind === 'tape'
          ? { tapeStopA: { start: Math.round(.9 * sr), end: Math.round(1.5 * sr), fade: Math.round(.05 * sr) } }
          : { loopA: { start: Math.round(.5 * sr), end: sr, until: Math.round(1.5 * sr), fade: Math.round(.005 * sr) } }),
        lanes: [
          { deck: 'A', lane: 0, points: [[0, 1], [duration * .8, 0]] },
          { deck: 'B', lane: 0, points: [[0, 0], [duration, 1]] },
          { deck: 'A', lane: 3, points: [[0, 1], [duration / 2, .3]] },
          { deck: 'B', lane: 2, points: [[0, .5], [duration, 1]] },
          { deck: 'A', lane: 6, points: [[0, 0], [duration, -.6]] },
        ],
      };
      m.arm(plan);
      render(2.3, 'afterTransition');
      m.setPlayback({ speed: .92, semitones: -2 });
      render(.3, 'slower');
    } else {
      source(1, 'B', 456);
      const duration = Math.round(1.2 * sr);
      const plan: ArmedTransition = {
        planId: 'native-parity', method: 'beatmatch_blend', fromToken: 'A', toToken: 'B',
        triggerFrame: Math.round(.25 * sr), entryFrame: Math.round(.4 * sr),
        durationFrames: duration, gapFrames: 0, swapFrame: Math.round(duration / 2),
        tempoB: [[0, 1.016], [duration, 1]],
        echoDelayFrames: Math.round(sr * .125), echoFeedback: .25,
        lanes: [
          { deck: 'A', lane: 0, points: [[0, 1], [duration, 0]] },
          { deck: 'B', lane: 0, points: [[0, 0], [duration, 1]] },
          { deck: 'A', lane: 1, points: [[0, 1], [duration / 2, .2]] },
          { deck: 'B', lane: 1, points: [[0, .2], [duration, 1]] },
          { deck: 'A', lane: 4, points: [[0, 0], [duration / 2, .3], [duration, 0]] },
          { deck: 'B', lane: 6, points: [[0, .3], [duration, 0]] },
        ],
      };
      m.arm(plan);
      render(1.9, 'afterTransition');
    }
    return { sr, kind, pcm, phases, events };
  }));
}
