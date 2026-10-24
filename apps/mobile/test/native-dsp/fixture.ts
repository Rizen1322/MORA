import { CHUNK_FRAMES } from '../../../../packages/core/src/engine/chunks.ts';
import { MixerCore, type ArmedTransition, type MixerEvent } from '../../../../packages/core/src/engine/mixer.ts';

// The same entry runs in bare Node VM and native JSContext, without WebKit,
// timers, DOM, audio APIs, polyfills or a different implementation of the DSP.
export function run() {
  return [44100, 48000].flatMap(sr => ['transport', 'transition'].map(kind => {
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
