/** CPU cost of the listening path, as % of one core per second of 48 kHz audio (Node, single thread).
 *   npx tsx --expose-gc tools/bench-cpu.ts [--quick]
 * Realtime parts run in 128-frame quanta, exactly like the AudioWorklet. Synthetic tracks only:
 * the numbers are relative costs of this machine's core, not a phone measurement (scale by
 * the ratio of single-core speed; WKWebView JIT is typically 2-4x slower than desktop V8). */
import { MixerCore, type MixerEvent } from '../packages/core/src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../packages/core/src/engine/chunks.ts';
import { planToArmed, renderTransitionOffline } from '../packages/core/src/engine/arm.ts';
import { renderMetrics, finalistSpans } from '../packages/core/src/engine/render-check.ts';
import { Limiter } from '../packages/core/src/dsp/limiter.ts';
import { MasterTone, FLAT_TONE } from '../packages/core/src/dsp/tone.ts';
import { MasterReverb } from '../packages/core/src/dsp/reverb.ts';
import { StereoIsolator } from '../packages/core/src/dsp/crossover.ts';
import { StereoSweep } from '../packages/core/src/dsp/sweep.ts';
import { Wsola, ArraySource } from '../packages/core/src/dsp/wsola.ts';
import { synthesize } from '../packages/core/src/synth/synth.ts';
import { analyzePcm } from '../packages/core/src/mir/analyzePcm.ts';
import { planFinalists, planTransition } from '../packages/core/src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack } from '../packages/core/src/types.ts';

const SR = 48000, Q = 128, quick = process.argv.includes('--quick');
const SECONDS = quick ? 10 : 30;
const results: { part: string; pct: number; note?: string }[] = [];

/** Runs `step(quantumIndex)` for `seconds` of audio, best of 3 after a warm-up; returns % of one core. */
function realtime(part: string, seconds: number, step: (q: number) => void, note?: string): number {
  const quanta = Math.round((seconds * SR) / Q);
  for (let q = 0; q < Math.min(quanta, 2000); q++) step(q);
  let best = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const t0 = performance.now();
    for (let q = 0; q < quanta; q++) step(q);
    best = Math.min(best, performance.now() - t0);
  }
  const pct = (best / 1000 / seconds) * 100;
  results.push({ part, pct, note });
  return pct;
}

function once(part: string, run: () => void, audioSeconds: number, note?: string): void {
  run();
  let best = Infinity;
  for (let rep = 0; rep < (quick ? 1 : 3); rep++) {
    const t0 = performance.now(); run(); best = Math.min(best, performance.now() - t0);
  }
  results.push({ part, pct: (best / 1000 / audioSeconds) * 100, note: `${best.toFixed(0)} ms for ${audioSeconds.toFixed(0)} s of audio${note ? '; ' + note : ''}` });
}

// --------------------------------------------------------------- fixtures
const A = synthesize({ style: 'house', bpm: 120, tonic: 9, mode: 'minor', bars: 64, seed: 11, sampleRate: SR });
const B = synthesize({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 64, seed: 12, sampleRate: SR, introBars: 8 });
const music = (n: number) => { const L = new Float32Array(n), R = new Float32Array(n); L.set(A.L.subarray(0, n)); R.set(A.R.subarray(0, n)); return { L, R }; };
const L = new Float32Array(Q), R = new Float32Array(Q);
const src = music(SR * 60);
const fill = (q: number) => { const o = (q * Q) % (src.L.length - Q); L.set(src.L.subarray(o, o + Q)); R.set(src.R.subarray(o, o + Q)); };

// ---------------------------------------------------------- master parts
realtime('copy of input (baseline of the harness)', SECONDS, fill);
const base = results[0].pct;
{
  const lim = new Limiter(SR);
  realtime('Limiter.processBlock (true-peak 4x)', SECONDS, (q) => { fill(q); lim.processBlock(L, R, 0, Q); });
}
{
  const t = new MasterTone(SR);
  realtime('MasterTone, never enabled', SECONDS, (q) => { fill(q); t.process(L, R, Q); });
  const t2 = new MasterTone(SR); t2.set(FLAT_TONE);
  realtime('MasterTone, disabled after a set() (idle once glided)', SECONDS, (q) => { fill(q); t2.process(L, R, Q); });
  const t3 = new MasterTone(SR); t3.set({ ...FLAT_TONE, enabled: true });
  realtime('MasterTone, enabled with flat gains', SECONDS, (q) => { fill(q); t3.process(L, R, Q); });
  const t4 = new MasterTone(SR); t4.set({ ...FLAT_TONE, enabled: true, gains: [3, 2, 1, 0, -1, 0, 1, 2, 3, 2] });
  realtime('MasterTone, enabled, 9 bands active', SECONDS, (q) => { fill(q); t4.process(L, R, Q); });
}
{
  const r0 = new MasterReverb(SR);
  realtime('MasterReverb, mix 0', SECONDS, (q) => { fill(q); r0.process(L, R, Q); });
  const r1 = new MasterReverb(SR); r1.setMix(0.15);
  realtime('MasterReverb, mix 0.15', SECONDS, (q) => { fill(q); r1.process(L, R, Q); });
}
// ------------------------------------------------------------ deck parts
{
  const iso = new StereoIsolator(SR);
  const u: [number, number, number] = [1, 1, 1];
  realtime('StereoIsolator at unity, three-band chain (transition armed)', SECONDS, (q) => { fill(q); iso.processBlock(L, R, 0, Q, u, u); });
  const idle = new StereoIsolator(SR); idle.idle = true;
  realtime('StereoIsolator at unity, idle deck (allpass equivalent)', SECONDS, (q) => { fill(q); idle.processBlock(L, R, 0, Q, u, u); });
  const sw = new StereoSweep(SR);
  realtime('StereoSweep at 0 (bypass)', SECONDS, (q) => { fill(q); sw.processBlock(L, R, Q, 0, 0); });
  const sw2 = new StereoSweep(SR);
  realtime('StereoSweep sweeping', SECONDS, (q) => { fill(q); sw2.processBlock(L, R, Q, 0.3, 0.3); });
}
{
  const s = new ArraySource(src.L, src.R);
  const w = new Wsola(SR, s); w.reset(0);
  let pos = 0;
  realtime('WSOLA ratio 1 (plain OLA)', SECONDS, () => {
    if (w.position() > src.L.length - SR) w.reset(0);
    w.render(L, R, 0, Q, () => 1); pos++;
  });
  const w2 = new Wsola(SR, s); w2.reset(0);
  realtime('WSOLA ratio 1.033 (search + transient check)', SECONDS, () => {
    if (w2.position() > src.L.length - SR) w2.reset(0);
    w2.render(L, R, 0, Q, () => 1.033);
  });
}

// --------------------------------------------------------- whole mixer
let underruns = 0;
/** Both synth tracks loaded; 'need' is answered at once, like an always-fast network. */
function loadedMixer(events?: MixerEvent[]): MixerCore {
  const pcms = [A, B];
  const feed = (deck: number, c: number) => {
    const pcm = pcms[deck], a = c * CHUNK_FRAMES, b = Math.min(pcm.L.length, a + CHUNK_FRAMES);
    m.feed(deck, deck ? 'b' : 'a', c, pcm.L.slice(a, b), pcm.R.slice(a, b));
  };
  const m: MixerCore = new MixerCore(SR, (e) => {
    events?.push(e);
    if (e.type === 'need' && !e.part) for (const c of e.chunks) feed(e.deck, c);
    if (e.type === 'underrun') underruns++;
  });
  for (const deck of [0, 1]) m.load(deck, deck ? 'b' : 'a', pcms[deck].L.length, 0);
  return m;
}
{
  const m = loadedMixer();
  m.start(0, 'a', 0);
  realtime('MixerCore.process, one deck playing', SECONDS, () => {
    if (m.decks[0].position() > A.L.length - SR * 2) m.start(0, 'a', 0);
    m.process(L, R, Q);
  });
}
{
  const m = loadedMixer();
  m.start(0, 'a', 0); m.setPaused(true);
  realtime('MixerCore.process, paused', SECONDS, () => m.process(L, R, Q));
}
{
  const m = loadedMixer();
  m.start(0, 'a', 0);
  const g = m as unknown as { requestData(d: unknown): void };
  let k = 0;
  realtime('requestData x2 decks every 0.25 s', SECONDS, (q) => { if (q % Math.round(SR * 0.25 / Q) === 0) { g.requestData(m.decks[0]); g.requestData(m.decks[1]); k++; } });
}

// planner fixtures at 44.1 kHz analysis (what the server stores)
const tA = synthesize({ style: 'house', bpm: 120, tonic: 9, mode: 'minor', bars: 64, seed: 11 });
const tB = synthesize({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 64, seed: 12, introBars: 8 });
const anA = analyzePcm(tA.L, tA.R), anB = analyzePcm(tB.L, tB.R);
const track = (id: string, pcm: typeof tA, an: typeof anA): PlannerTrack => ({ id, duration: pcm.L.length / pcm.sampleRate, mixingAllowed: true, analysis: an });
const pa = track('a', tA, anA), pb = track('b', tB, anB);
const plan = planTransition(pa, pb, S);

{
  // transition at 48 kHz: arm the same plan (seconds) on the 48 kHz synth renders
  const blend = planTransition(pa, pb, { ...S, stemMixing: false });
  const m = loadedMixer();
  const armed = planToArmed(blend, SR, 'a', 'b');
  const pre = Math.round(SR * 0.5);
  const start = () => { m.start(0, 'a', Math.max(0, armed.triggerFrame - pre)); m.arm(armed); };
  start();
  const quanta = Math.ceil((armed.durationFrames + armed.gapFrames + pre) / Q);
  realtime(`MixerCore.process during a transition (${blend.method}, ${blend.duration.toFixed(1)} s)`, Math.min(SECONDS, (quanta * Q) / SR), (q) => {
    if (q % quanta === 0) start();
    m.process(L, R, Q);
  }, 'both decks + stretch on B; repeated over the overlap only');
}

const anaSeconds = tA.L.length / tA.sampleRate;
once('analyzePcm (full MIR of one track)', () => analyzePcm(tA.L, tA.R), anaSeconds, 'one-off per track, worker');
once('planTransition (one pair)', () => planTransition(pa, pb, S), anaSeconds, 'one-off per pair; % relative to track length');
const finals = planFinalists(pa, pb, S);
once(`planFinalists (${finals.length} finalists)`, () => planFinalists(pa, pb, S), anaSeconds, 'one-off per pair');
{
  const spans = finalistSpans(finals);
  const cut = (pcm: typeof tA, [s, e]: [number, number]) => ({ pcm: { L: pcm.L.slice(Math.floor(s * pcm.sampleRate), Math.ceil(e * pcm.sampleRate)), R: pcm.R.slice(Math.floor(s * pcm.sampleRate), Math.ceil(e * pcm.sampleRate)), sampleRate: pcm.sampleRate }, start: Math.floor(s * pcm.sampleRate) / pcm.sampleRate });
  const a = cut(tA, spans.a), b = cut(tB, spans.b);
  once(`renderMetrics x${finals.length} (render check)`, () => { for (const f of finals) renderMetrics(f, a, b); }, anaSeconds, 'one-off per pair');
}
once('renderTransitionOffline (one plan, 2+2 s pads)', () => renderTransitionOffline(tA, tB, plan, 2, 2), anaSeconds);

console.log(`\nCPU, % of one core per second of audio (48 kHz, ${Q}-frame quanta, ${SECONDS} s runs, best of 3; first row = cost of the harness copy itself; mixer underruns: ${underruns})\n`);
for (const r of results) console.log(`${r.part.padEnd(66)} ${r.pct.toFixed(3).padStart(8)} %${r.note ? '   ' + r.note : ''}`);
