import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mora-native-mix-'));
const sr = 48000, count = sr * 6;
try {
  const sources = [0, 1, 2].map(deck => {
    const floats = new Float32Array(count * 2);
    let state = deck + 1;
    for (let i = 0; i < count; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      floats[i * 2] = Math.sin(i * (.03 - deck * .005)) * .2 + (state / 4294967296 - .5) * .01;
      floats[i * 2 + 1] = floats[i * 2] * .8;
    }
    return Buffer.from(floats.buffer);
  });
  await Promise.all(sources.map((bytes, i) => writeFile(join(dir, `${i}.f32le`), bytes)));
  const transition = { planId: 'native-files', method: 'beatmatch_blend', fromToken: 'A', toToken: 'B', triggerFrame: sr * 3,
    entryFrame: 0, durationFrames: sr * 2.5, gapFrames: 0, swapFrame: sr * 1.25, tempoB: [[0, 1.02], [sr * 2.5, 1]],
    lanes: [{ deck: 'A', lane: 0, points: [[0, 1], [sr * 2.5, 0]] }, { deck: 'B', lane: 0, points: [[0, 0], [sr * 2.5, 1]] }] };
  // A queue of three files with two DJ transitions; the page appends later tracks the same way.
  const config = { sampleRate: sr, position: .1, tracks: [0, 1, 2].map(i => ({ title: `fixture ${i}`, artist: '', totalFrames: count,
    gainDb: -1, file: i, ...(i ? { transition: { ...transition, planId: `native-files-${i}` } } : {}) })) };
  const configs = [config, { ...config, index: 1, position: 2.5 }, { ...config, playback: { speed: 1.1, semitones: 1 }, volume: .8 }];
  await writeFile(join(dir, 'configs.json'), JSON.stringify(configs));
  await build({ entryPoints: [resolve(root, 'apps/mobile/src/native-mixer.ts')], outfile: join(dir, 'mixer.js'),
    bundle: true, platform: 'neutral', format: 'iife', globalName: 'MoraNativeMixer', target: 'es2022' });
  const expected = [], pcm = [];
  for (const config of configs) {
    const context = { config, moraReadPcm: (deck, chunk) => sources[deck].subarray(chunk * 32768 * 8, (chunk + 1) * 32768 * 8).toString('base64') };
    runInNewContext(`${await readFile(join(dir, 'mixer.js'), 'utf8')}\nvar runtime = MoraNativeMixer.create(config);`, context);
    const blocks = [];
    for (let i = 0; i < 240; i++) {
      const b = runInNewContext('runtime.render()', context);
      pcm.push(...b.left, ...b.right);
      blocks.push({ frames: b.left.length, done: b.done, marks: b.marks, events: b.events.map(e => e.type) });
      if (b.done) break;
    }
    assert.equal(blocks.at(-1).done, true);
    expected.push({ blocks: JSON.parse(JSON.stringify(blocks)) });
  }
  assert.equal(expected[0].blocks.flatMap(b => b.events).filter(e => e === 'transitionEnd').length, 2);
  assert.deepEqual([...new Set(expected[0].blocks.flatMap(b => b.marks.map(m => m.index)))], [0, 1, 2]);
  assert.ok(!expected[0].blocks.flatMap(b => b.events).includes('fallback'), 'Native transition fell back');
  if (process.argv.includes('--reference-only')) { console.log('Native queue Node reference passed'); }
  else {
    assert.equal(process.platform, 'darwin', 'Requires macOS');
    for (const [command, args] of [
      ['swiftc', ['-O', resolve(root, 'apps/mobile/ios/App/App/NativeDSPRenderer.swift'), resolve(root, 'apps/mobile/test/native-mix/main.swift'), '-o', join(dir, 'check')]],
      [join(dir, 'check'), [dir]],
    ]) {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${command} failed`);
    }
    const actual = JSON.parse(await readFile(join(dir, 'actual.json'), 'utf8'));
    function compare(a, b) {
      if (typeof a === 'number') assert.ok(Number.isFinite(b) && Math.abs(a - b) <= 2e-5);
      else if (a && typeof a === 'object') {
        assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
        for (const key of Object.keys(a)) compare(a[key], b[key]);
      } else assert.equal(a, b);
    }
    compare(expected, actual);
    const bytes = await readFile(join(dir, 'actual.f32le'));
    assert.equal(bytes.length, pcm.length * 4);
    let max = 0;
    for (let i = 0; i < pcm.length; i++) {
      const sample = bytes.readFloatLE(i * 4);
      assert.ok(Number.isFinite(sample)); max = Math.max(max, Math.abs(sample - pcm[i]));
    }
    assert.ok(max <= 2e-5, `PCM differs by ${max}`);
    console.log(`PASS: native file reader, PCM copies and timeline parity, ${pcm.length} samples; max difference ${max}`);
  }
} finally {
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'mora-native-mix-')));
  await rm(dir, { recursive: true, force: true });
}
