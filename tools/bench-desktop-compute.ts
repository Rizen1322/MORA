import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULT_AUTOMIX_SETTINGS } from '../packages/core/src/index.ts';
import { rustComputeAsync, rustComputeOnceAsync, stopRustCompute } from '../apps/server/src/rust-core.ts';

process.env.AUTOMIX_RUST_CORE = path.resolve('packages/audio-rust/target/release/mora-audio.exe');
const input = { from: { id: 'bench-a', duration: 180, mixingAllowed: true, analysis: null },
  to: { id: 'bench-b', duration: 180, mixingAllowed: true, analysis: null }, settings: DEFAULT_AUTOMIX_SETTINGS };
try {
  const reference = await rustComputeOnceAsync('plan', input);
  await rustComputeAsync('plan', input);
  const measure = async (run: typeof rustComputeAsync) => {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(), result = await run('plan', input);
      times.push(performance.now() - start); assert.deepEqual(result, reference);
    }
    times.sort((a, b) => a - b);
    return { count: times.length, medianMs: times[15], p95Ms: times[28] };
  };
  const report = { date: new Date().toISOString(), fixture: '180-second tracks without analysis; plan IPC and process startup included',
    once: await measure(rustComputeOnceAsync), persistent: await measure(rustComputeAsync) };
  fs.mkdirSync('data-bench-results/desktop-0.3.25', { recursive: true });
  fs.writeFileSync('data-bench-results/desktop-0.3.25/compute.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { stopRustCompute(); }
