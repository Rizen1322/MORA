import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MixerCore, type ArmedTransition } from '../packages/core/src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../packages/core/src/engine/chunks.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'data-bench-results/rust-audio');
fs.mkdirSync(out, { recursive: true });
const exe = process.env.MORA_AUDIO_EXE || path.join(root, 'packages/audio-rust/target/release/mora-audio.exe');
type Op = Record<string, any>;
const encode = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const decode = (s: string) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] ?? 3);
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
function fixture(sr: number, kind: string): Op[] {
  const ops: Op[] = [], deferred: Op[] = [];
  for (let deck = 0; deck < 2; deck++) {
    const total = sr * 12;
    ops.push({ cmd: 'load', deck, token: `T${deck}`, totalFrames: kind === 'growth' && deck === 0 ? sr * 2 : total, gainDb: kind === 'limiter' && deck === 0 ? 18 : deck ? -3 : -2, cueFrame: 0 });
    for (let start = 0; start < total; start += CHUNK_FRAMES) {
      const n = Math.min(CHUNK_FRAMES, total - start), l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = start + i, t = p / sr, f = deck ? 233 : 197;
        const beat = (p % Math.round(sr * .5)) / sr;
        const kick = Math.exp(-beat * 65) * Math.sin(2 * Math.PI * 65 * t);
        l[i] = .2 * Math.sin(2 * Math.PI * f * t) + .1 * Math.sin(2 * Math.PI * 57 * t) + kick * .3;
        r[i] = .18 * Math.sin(2 * Math.PI * f * t + .2) + .12 * Math.sin(2 * Math.PI * 71 * t) + kick * .3;
      }
      const feed = { cmd: 'feed', deck, token: `T${deck}`, chunk: start / CHUNK_FRAMES, L: encode(l), R: encode(r) };
      if ((kind === 'starvation' && deck === 0 && start > 0) || (kind === 'late' && deck === 1)) deferred.push(feed);
      else { ops.push(feed); if (kind === 'growth' && deck === 0) deferred.push(feed); }
    }
  }
  ops.push({ cmd: 'start', deck: 0, token: 'T0', frame: 0 });
  const render = (seconds: number) => ops.push({ cmd: 'render', frames: Math.round(seconds * sr / 128) * 128 });
  if (kind === 'tone') ops.push({ cmd: 'tone', settings: { enabled: true, gains: [1, 3, -2, 0, 2, -1, 0, 1, 2, -2], preampDb: -2, autoHeadroom: true, balance: .2, mono: true, reverbMix: .2 } });
  if (kind === 'playback') ops.push({ cmd: 'playback', settings: { speed: 1.08, semitones: 2 } });
  if (['transition', 'gap', 'loop', 'tape', 'forced', 'delayed', 'knots', 'detach', 'late', 'gapless'].includes(kind)) {
    const duration = sr * 2;
    const tr: ArmedTransition = {
      planId: kind, method: kind, fromToken: 'T0', toToken: 'T1', triggerFrame: sr, entryFrame: sr,
      durationFrames: duration, gapFrames: kind === 'gap' ? sr / 4 : 0, swapFrame: sr,
      tempoB: kind === 'transition' ? [[0, 1.08], [duration, 1]] : [[0, 1]],
      tempoA: kind === 'transition' ? [[0, 1], [duration, 1.04]] : undefined,
      bDelayFrames: kind === 'delayed' ? sr / 2 : 0,
      lanes: [
        { deck: 'A', lane: 0, points: [[0, 1], [duration, 0]] },
        { deck: 'B', lane: 0, points: [[0, 0], [duration, 1]] },
        { deck: 'A', lane: 1, points: [[0, 1], [sr, 0], [duration, 0]] },
        { deck: 'B', lane: 1, points: [[0, 0], [sr, 1]] },
        { deck: 'A', lane: 4, points: [[0, 0], [sr, .3], [duration, 0]] },
        { deck: 'A', lane: 6, points: [[0, 0], [duration, .4]] },
      ], echoDelayFrames: sr / 4, echoFeedback: .4,
    };
    if (kind === 'loop') tr.loopA = { start: sr, end: sr * 2, until: sr * 4, fade: Math.round(sr * .005), roll: [{ at: sr * 3, length: sr / 2 }] };
    if (kind === 'tape') tr.tapeStopA = { start: sr, end: sr * 2, fade: Math.round(sr / 8) };
    if (kind === 'knots') tr.lanes[0].points = [[0, 1], [113, 1], [229, .2], [duration, 0]];
    if (kind === 'gapless') { tr.durationFrames = 1; tr.swapFrame = 0; tr.lanes = [{ deck: 'A', lane: 0, points: [[0, 1], [1, 0]] }, { deck: 'B', lane: 0, points: [[0, 1]] }]; }
    ops.push({ cmd: 'arm', transition: tr });
    if (kind === 'forced') { render(1.5); ops.push({ cmd: 'finish', fade: .25 }); }
    if (kind === 'detach') { render(1.5); ops.push({ cmd: 'unload', deck: 0 }); }
  }
  if (kind === 'late' || kind === 'starvation') { render(1.5); ops.push(...deferred); }
  if (kind === 'length') { render(.5); ops.push({ cmd: 'length', deck: 0, token: 'T0', totalFrames: sr * 2 }); }
  if (kind === 'growth') { render(.5); ops.push({ cmd: 'length', deck: 0, token: 'T0', totalFrames: sr * 12 }, ...deferred); }
  if (kind === 'transport') {
    render(.5); ops.push({ cmd: 'pause', paused: true }); render(.2);
    ops.push({ cmd: 'seek', token: 'T0', frame: sr * 3 }); render(.1); ops.push({ cmd: 'pause', paused: false });
    render(.4); ops.push({ cmd: 'seek', token: 'T0', frame: sr * 2 }); render(.2);
    ops.push({ cmd: 'gain', deck: 0, gainDb: -7 }, { cmd: 'volume', value: .5 });
  }
  render(5);
  ops.push({ cmd: 'stop' }); render(.05);
  return ops;
}
function metrics(times: number[], frames: number, sr: number) {
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.round((times.length - 1) * q)] ?? 0;
  return { blocks: times.length, audioSeconds: frames / sr, renderMs: times.reduce((a, b) => a + b, 0), p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: p(1) };
}
function reference(ops: Op[], sr: number) {
  const events: unknown[] = [], core = new MixerCore(sr, e => events.push(e)), buffers: Buffer[] = [], times: number[] = [];
  const l = new Float32Array(128), r = new Float32Array(128);
  let frames = 0;
  for (const op of ops) {
    const { cmd } = op;
    if (cmd === 'render') {
      for (let at = 0; at < op.frames; at += 128) {
        const n = Math.min(128, op.frames - at), start = performance.now();
        core.process(l, r, n); times.push(performance.now() - start);
        const b = Buffer.alloc(n * 8);
        for (let i = 0; i < n; i++) { b.writeFloatLE(l[i], i * 8); b.writeFloatLE(r[i], i * 8 + 4); }
        buffers.push(b); frames += n;
      }
    } else if (cmd === 'load') core.load(op.deck, op.token, op.totalFrames, op.gainDb, op.cueFrame);
    else if (cmd === 'feed') core.feed(op.deck, op.token, op.chunk, decode(op.L), decode(op.R));
    else if (cmd === 'start') core.start(op.deck, op.token, op.frame);
    else if (cmd === 'arm') core.arm(op.transition);
    else if (cmd === 'pause') core.setPaused(op.paused);
    else if (cmd === 'seek') core.seek(op.token, op.frame);
    else if (cmd === 'gain') core.setGain(op.deck, op.gainDb);
    else if (cmd === 'volume') core.setVolume(op.value);
    else if (cmd === 'tone') core.setTone(op.settings);
    else if (cmd === 'playback') core.setPlayback(op.settings);
    else if (cmd === 'stop') core.stopAll();
    else if (cmd === 'finish') core.finishTransitionNow(op.fade);
    else if (cmd === 'unload') core.unload(op.deck);
    else if (cmd === 'length') core.setLength(op.deck, op.token, op.totalFrames);
    else throw new Error(`Missing reference command: ${cmd}`);
  }
  return { pcm: Buffer.concat(buffers), events, metrics: metrics(times, frames, sr) };
}
function compare(actual: any, expected: any, at = 'event'): void {
  if (typeof expected === 'number') { assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 2e-5, `${at}: ${actual} != ${expected}`); return; }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', at);
    const keys = Object.keys(expected).filter(k => expected[k] !== undefined);
    assert.deepEqual(Object.keys(actual).sort(), keys.sort(), `${at} keys`);
    for (const k of keys) compare(actual[k], expected[k], `${at}.${k}`);
  } else assert.equal(actual, expected, at);
}
assert.throws(() => compare({ x: .01 }, { x: 0 }), 'Comparator must detect a changed sample');
const results: any[] = [];
for (const sr of [44100, 48000]) for (const kind of ['solo', 'tone', 'transition', 'gap', 'loop', 'tape', 'forced', 'delayed', 'knots', 'detach', 'playback', 'transport', 'limiter', 'starvation', 'late', 'length', 'growth', 'gapless']) {
  if (only && !only.split(',').includes(kind)) continue;
  const name = `${sr}-${kind}`, ops = fixture(sr, kind), input = path.join(out, `${name}.json`);
  fs.writeFileSync(input, JSON.stringify({ sampleRate: sr, ops }));
  reference(ops, sr); // Warm the V8 code; setup, I/O and process startup are excluded from render timings.
  for (let run = 0; run < runs; run++) {
    const ref = reference(ops, sr), pcm = path.join(out, `${name}.f32`), report = path.join(out, `${name}-rust.json`);
    const child = spawnSync(exe, ['--offline', input, pcm, report], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${name}: ${child.error ?? child.stdout + child.stderr}`);
    const rust = JSON.parse(fs.readFileSync(report, 'utf8')), actual = fs.readFileSync(pcm);
    assert.equal(actual.length, ref.pcm.length);
    let maxError = 0, peak = 0;
    for (let at = 0; at < actual.length; at += 4) {
      const a = actual.readFloatLE(at), e = ref.pcm.readFloatLE(at);
      if (!Number.isFinite(a)) assert.fail(`${name}: non-finite PCM`);
      maxError = Math.max(maxError, Math.abs(a - e)); peak = Math.max(peak, Math.abs(a));
      if (Math.abs(a - e) > 2e-5) assert.fail(`${name} sample ${at / 4}: ${a} != ${e}, delta ${Math.abs(a - e)}`);
    }
    assert.ok(peak > .01 && peak <= 1, `${name}: silence or clipping`);
    compare(rust.events.filter((e: any) => e.type !== 'need'), ref.events.filter((e: any) => e.type !== 'need'));
    results.push({ name, run, maxError, peak, typescript: ref.metrics, rust: rust.metrics, speedup: ref.metrics.renderMs / rust.metrics.renderMs });
  }
  console.log(`${name}: parity OK`);
}
const report = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, platform: `${process.platform}-${process.arch}`, runs, tolerance: 2e-5, note: 'Offline render timings; not Electron callback, device latency, process RAM, or a listening test.', results };
fs.writeFileSync(path.join(out, only ? `summary-${only}.json` : 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(results.map(r => ({ name: r.name, run: r.run, speedup: +r.speedup.toFixed(2), maxError: r.maxError, tsP99: r.typescript.p99Ms, rustP99: r.rust.p99Ms })), null, 2));
