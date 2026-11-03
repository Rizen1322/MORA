import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Swift NativeSpectral (vDSP) against core/mir/spectral.ts on full-length synthetic tracks.
// macOS with swiftc; --reference-only checks and times the TS side alone.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mora-spectral-'));
const referenceOnly = process.argv.includes('--reference-only');
const sr = 22050;
// Field order of the packed native result.
const order = ['fluxLow', 'fluxMid', 'fluxHigh', 'powLow', 'powMid', 'powHigh', 'centroid', 'midDensity', 'chroma', 'mel', 'rmsDb', 'peaks'];
// Tolerances: relative to the value plus absolute relative to the field's peak (FFT rounding on near-zero bins).
const REL = 1e-4, ABS = 1e-6, DB = 1e-3;
function track(seconds, seed, voice) {
  const x = new Float32Array(Math.round(seconds * sr));
  let state = seed;
  for (let i = 0; i < x.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    x[i] = voice(i / sr, state / 4294967296 - .5);
  }
  return x;
}
const cases = [
  // 128 BPM four-on-the-floor, offbeat hats, chords changing every 8 bars.
  ['house-6min', track(360, 1, (t, noise) => {
    const beat = t * 128 / 60, phase = beat % 1, bar = Math.floor(beat / 32) % 4;
    const kick = Math.sin(2 * Math.PI * 50 * phase * 60 / 128) * Math.exp(-phase * 9) * .5;
    const hat = (beat + .5) % 1 < .06 ? noise * .25 : 0;
    const chord = [220, 261.63, 329.63].reduce((s, f) => s + Math.sin(2 * Math.PI * f * [1, 1.335, 0.89, 1.122][bar] * t), 0) * .08;
    return kick + hat + chord + noise * .002;
  })],
  // Digital silence, a 40 Hz - 8 kHz sweep, then a near-full-scale square: dynamic range and edge frames.
  ['gaps-sweep-4min', track(240, 7, (t, noise) => t < 10 || (t > 120 && t < 125) ? 0
    : t < 120 ? Math.sin(2 * Math.PI * 40 * 110 / Math.log(200) * (Math.exp(Math.log(200) * (t - 10) / 110) - 1)) * .6 + noise * 1e-4
      : Math.sign(Math.sin(2 * Math.PI * 110 * t)) * .95)],
  ['shorter-than-frame', track(1500 / sr, 3, (t, noise) => Math.sin(2 * Math.PI * 440 * t) * .5 + noise * .01)],
];
function pack(spectral) {
  const out = new Float32Array(order.reduce((n, key) => n + spectral[key].length, 0));
  let at = 0;
  for (const key of order) { out.set(spectral[key], at); at += spectral[key].length; }
  return out;
}
function compare(name, spectral, actual) {
  assert.equal(actual.length, pack(spectral).length, `${name}: packed length`);
  let at = 0;
  const report = [];
  for (const key of order) {
    const expected = spectral[key], peak = expected.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    let worst = 0;
    for (let i = 0; i < expected.length; i++, at++) {
      const e = expected[i], a = actual[at];
      assert.ok(Number.isFinite(a), `${name}.${key}[${i}]: nonfinite`);
      const err = Math.abs(a - e), limit = key === 'rmsDb' ? DB : REL * Math.abs(e) + ABS * peak;
      assert.ok(err <= limit, `${name}.${key}[${i}]: ${a} != ${e} (limit ${limit})`);
      worst = Math.max(worst, peak > 0 && key !== 'rmsDb' ? err / peak : err);
    }
    report.push(`${key} ${worst.toExponential(1)}`);
  }
  return report.join(', ');
}
try {
  const bundle = join(dir, 'spectral.js');
  await build({ entryPoints: [resolve(root, 'packages/core/src/mir/spectral.ts')], outfile: bundle,
    bundle: true, platform: 'neutral', format: 'iife', globalName: 'MoraSpectral', target: 'es2022' });
  const source = await readFile(bundle, 'utf8');
  let executable;
  if (!referenceOnly) {
    assert.equal(process.platform, 'darwin', 'Native parity needs macOS; --reference-only does not test the Swift port');
    executable = join(dir, 'native-spectral-check');
    const result = spawnSync('swiftc', ['-O', resolve(root, 'apps/mobile/ios/App/App/NativeSpectral.swift'),
      resolve(root, 'apps/mobile/test/native-spectral/main.swift'), '-o', executable], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'swiftc failed');
  }
  for (const [name, x] of cases) {
    const context = { x, sr };
    const started = performance.now();
    const spectral = runInNewContext(`${source}\nMoraSpectral.computeSpectral(x, sr)`, context, { timeout: 600000 });
    const tsMs = performance.now() - started;
    assert.ok(order.every(key => spectral[key].every(Number.isFinite)), `${name}: nonfinite reference`);
    // A broken comparator must not pass simply because both sides produce arrays.
    const perturbed = pack(spectral); perturbed[Math.floor(perturbed.length / 2)] += 1;
    assert.throws(() => compare(name, spectral, perturbed));
    const seconds = (x.length / sr).toFixed(1);
    if (referenceOnly) { console.log(`${name}: ${seconds} s audio, TS ${tsMs.toFixed(0)} ms`); continue; }
    const input = join(dir, `${name}.f32`), output = join(dir, `${name}.out.f32`);
    await writeFile(input, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
    const run = spawnSync(executable, [input, String(sr), output], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${name}: Swift failed ${run.stderr}`);
    const bytes = await readFile(output);
    const actual = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const errors = compare(name, spectral, actual);
    console.log(`${name}: ${seconds} s audio, TS ${tsMs.toFixed(0)} ms, Swift ${Number(run.stdout.trim()).toFixed(0)} ms; max error ${errors}`);
  }
  if (!referenceOnly) console.log(`PASS: Swift spectral stage agrees with TS within rel ${REL} + ${ABS}·peak (rmsDb ${DB} dB) on ${cases.length} tracks`);
} finally {
  // Only this process's mkdtemp directory is removed.
  await rm(dir, { recursive: true, force: true });
}
