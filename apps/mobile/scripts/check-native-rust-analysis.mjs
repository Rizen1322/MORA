// Compares the compiled iOS analyzer (Rust through NativeRustAnalysis.swift) with the bundled
// JavaScriptCore analyzer on a full-length recording, and prints both timings.
// macOS: links the Swift wrapper against the Rust static library. Elsewhere: the Rust analyzer binary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build as bundle } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'mora-rust-mir-'));
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')} failed`);
};
try {
  await bundle({ entryPoints: [resolve(root, 'apps/mobile/src/native-preparation-core.ts')], outfile: join(folder, 'preparation.js'),
    bundle: true, format: 'iife', platform: 'neutral', globalName: 'MoraPreparation', target: 'es2022' });
  // 4 minutes: a groove with chord changes, a break and a quiet outro exercise tempo, key, structure and loudness.
  const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.slice(10) ?? 240);
  const frames = 44100 * seconds, input = new Float32Array(frames * 2);
  const chords = [261.63, 220, 174.61, 196];
  for (let i = 0; i < frames; i++) {
    const t = i / 44100, bar = Math.floor(t / 2), inBreak = t > seconds * 0.45 && t < seconds * 0.55;
    const kick = inBreak ? 0 : Math.exp(-(i % 22050) / 600) * Math.sin(i * 2 * Math.PI * 60 / 44100) * .3;
    const hat = (i % 11025) < 300 ? Math.sin(i * 1.7) * .03 : 0;
    const pad = Math.sin(i * 2 * Math.PI * chords[bar % 4] / 44100) * .08 * (t > seconds - 20 ? (seconds - t) / 20 : 1);
    input[i * 2] = kick + hat + pad;
    input[i * 2 + 1] = kick + pad * .8 - hat;
  }
  const bytes = Buffer.from(input.buffer), pcm = join(folder, 'input.f32le');
  await writeFile(pcm, bytes);
  const source = await readFile(join(folder, 'preparation.js'), 'utf8');
  const context = {
    moraPreparationRead: (offset, count) => bytes.subarray(offset * 8, (offset + count) * 8).toString('base64'),
    moraPreparationCancelled: () => false, moraPreparationProgress: () => {},
  };
  let start = performance.now();
  const expected = JSON.parse(runInNewContext(`${source}\nMoraPreparation.analyzeJSON(JSON.stringify({ frames: ${frames} }))`, context, { timeout: 600000 }));
  const scriptMs = performance.now() - start;
  const version = runInNewContext(`${source}\nMoraPreparation.analyzerVersion`, context);
  const output = join(folder, 'actual.json');
  start = performance.now();
  if (process.platform === 'darwin') {
    run('sh', [resolve(root, 'apps/mobile/scripts/build-rust-ios.sh'), 'macosx']);
    const binary = join(folder, 'check');
    run('xcrun', ['swiftc', '-O', resolve(root, 'apps/mobile/ios/App/App/NativeRustAnalysis.swift'),
      resolve(root, 'apps/mobile/test/native-rust-analysis/main.swift'),
      resolve(root, 'packages/audio-rust/target/ios/macosx/libmora_audio.a'), '-o', binary]);
    start = performance.now();
    run(binary, [pcm, output, String(frames), version]);
  } else {
    const cargo = process.platform === 'win32' ? join(process.env.USERPROFILE ?? '', '.cargo/bin/cargo.exe') : 'cargo';
    const env = { ...process.env, ...(process.platform === 'win32' && !process.env.RUSTFLAGS ? { RUSTFLAGS: '-C linker=rust-lld -C link-self-contained=yes' } : {}) };
    run(cargo, ['build', '--release', '--locked', '--manifest-path', resolve(root, 'packages/audio-rust/Cargo.toml')], env);
    start = performance.now();
    run(resolve(root, 'packages/audio-rust/target/release', process.platform === 'win32' ? 'mora-audio.exe' : 'mora-audio'), ['--analyze', pcm, output, String(seconds + 5)]);
  }
  const compiledMs = performance.now() - start;
  const actual = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(actual.version, version, 'The compiled analyzer must carry the bundled analyzer version');
  const rows = [];
  (function compare(a, b, path) {
    if (path.endsWith('.elapsedMs')) return;
    if (typeof b === 'number') { if (!(typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= 2e-5 * Math.max(1, Math.abs(b)))) rows.push({ path, actual: a, expected: b }); }
    else if (b && typeof b === 'object') {
      const keys = Object.keys(b).filter(k => b[k] !== undefined);
      if (!a || typeof a !== 'object' || Object.keys(a).length !== keys.length) rows.push({ path: `${path}.keys`, actual: a && Object.keys(a), expected: keys });
      else for (const key of keys) compare(a[key], b[key], `${path}.${key}`);
    } else if (a !== b) rows.push({ path, actual: a, expected: b });
  })(actual, expected, 'analysis');
  assert.equal(rows.length, 0, JSON.stringify(rows.slice(0, 8)));
  console.log(`Compiled MIR agrees with the bundled analyzer: ${seconds} s audio, script ${Math.round(scriptMs)} ms (Node JIT), compiled ${Math.round(compiledMs)} ms`);
} finally {
  await rm(folder, { recursive: true, force: true });
}
