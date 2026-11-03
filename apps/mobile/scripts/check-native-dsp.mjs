import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mora-dsp-'));
const referenceOnly = process.argv.includes('--reference-only');
function command(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${cmd} failed`);
}
function validate(cases) {
  assert.equal(cases.length, 8);
  for (const c of cases) {
    assert.ok(c.pcm.every(Number.isFinite), `${c.kind}: nonfinite PCM`);
    assert.ok(c.pcm.some(x => Math.abs(x) > .01), `${c.kind}: silent output`);
    assert.ok(c.pcm.every(x => Math.abs(x) <= 1), `${c.kind}: clipping`);
    assert.equal(c.events.filter(e => e.type === 'underrun' || e.type === 'fallback').length, 0);
    if (c.kind === 'effects' || c.kind === 'tape') {
      assert.deepEqual(c.events.filter(e => ['transitionStart', 'swap', 'transitionEnd'].includes(e.type)).map(e => e.type),
        ['transitionStart', 'swap', 'transitionEnd']);
      assert.equal(c.phases.at(-1).main, 1);
    } else if (c.kind === 'transition') {
      assert.deepEqual(c.events.filter(e => ['transitionStart', 'swap', 'transitionEnd'].includes(e.type)).map(e => e.type),
        ['transitionStart', 'swap', 'transitionEnd']);
      assert.equal(c.phases.at(-1).main, 1);
      if (c.events.some(e => e.type === 'tick')) assert.ok(c.events.some(e => e.type === 'tick' && e.decks[1].ratio > 1.005), 'WSOLA stretch not exercised');
    } else {
      assert.equal(c.phases.find(p => p.name === 'paused').paused, true);
      assert.equal(c.phases.find(p => p.name === 'resumed').paused, false);
      if (c.events.some(e => e.type === 'tick')) {
        const seek = c.events.find(e => e.type === 'tick' && e.paused && Math.abs(e.decks[0].position - 1.25 * c.sr) < 1);
        assert.ok(seek, 'paused seek did not apply');
      }
      assert.ok(c.pcm.slice(-2048).every(x => x === 0), 'stop did not settle to silence');
    }
  }
}
function compare(expected, actual, path = 'result') {
  assert.equal(typeof actual, typeof expected, `${path}: type`);
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual), `${path}: nonfinite`);
    assert.ok(Math.abs(expected - actual) <= 2e-5, `${path}: ${actual} != ${expected}`);
  } else if (expected !== null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${path}: keys`);
    for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}
try {
  const bundle = join(dir, 'mixer.js');
  await build({ entryPoints: [resolve(root, 'apps/mobile/test/native-dsp/fixture.ts')], outfile: bundle,
    bundle: true, platform: 'neutral', format: 'iife', globalName: 'MoraDspCheck', target: 'es2022' });
  const source = await readFile(bundle, 'utf8');
  // JSON roundtrip also rejects accidental reliance on cross-realm object identity.
  const reference = JSON.parse(runInNewContext(`${source}\nJSON.stringify(MoraDspCheck.run())`, {}, { timeout: 120000 }));
  validate(reference);
  // A broken renderer/comparator must not pass simply because both produce JSON.
  assert.throws(() => compare([.25], [.251]));
  console.log(`Node reference passed: ${reference.reduce((n, c) => n + c.pcm.length, 0)} stereo samples, 8 fixtures`);
  // The Swift mixer has no telemetry ticks or PCM requests: compare the audible events only.
  const audible = cases => cases.map(c => ({ ...c, events: c.events.filter(e => !['tick', 'need', 'audioHealth'].includes(e.type)).map(e => e.type) }));
  if (!referenceOnly) {
    assert.equal(process.platform, 'darwin', 'Native parity needs macOS; --reference-only does not test the Swift port');
    const executable = join(dir, 'native-dsp-check'), output = join(dir, 'native.json');
    command('swiftc', ['-O', resolve(root, 'apps/mobile/ios/App/App/NativeDSPRenderer.swift'), resolve(root, 'apps/mobile/test/native-dsp/main.swift'), '-o', executable]);
    command(executable, [output]);
    const actual = JSON.parse(await readFile(output, 'utf8'));
    validate(actual.map(c => ({ ...c, events: c.events.map(type => ({ type })) })));
    compare(audible(reference), actual);
    console.log('PASS: every PCM sample, phase and audible event of the Swift mixer agrees with Node within absolute 2e-5');
  }
} finally {
  // Only this process's mkdtemp directory is removed.
  await rm(dir, { recursive: true, force: true });
}
