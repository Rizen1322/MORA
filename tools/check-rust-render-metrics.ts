import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'data-bench-results/rust-render-metrics');
const harness = path.join(root, 'tools/.cache/rust-render-metrics-check');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(harness, 'src'), { recursive: true });
fs.writeFileSync(path.join(harness, 'Cargo.toml'), `[package]
name="rust-render-metrics-check"
version="0.1.0"
edition="2024"
[dependencies]
serde_json="1"
[profile.release]
lto="thin"
codegen-units=1
`);
fs.writeFileSync(path.join(harness, 'src/main.rs'), `mod wsola {pub fn round(x:f64)->f64{(x+0.5).floor()}}
#[path="../../../../packages/audio-rust/src/dsp.rs"] mod dsp;
#[path="../../../../packages/audio-rust/src/render_metrics.rs"] mod render_metrics;
fn main(){let args:Vec<_>=std::env::args().collect();let input:serde_json::Value=serde_json::from_reader(std::io::BufReader::new(std::fs::File::open(&args[1]).unwrap())).unwrap();let bytes=std::fs::read(&args[2]).unwrap();let(mut l,mut r)=(Vec::new(),Vec::new());for f in bytes.chunks_exact(8){l.push(f32::from_le_bytes(f[..4].try_into().unwrap()));r.push(f32::from_le_bytes(f[4..].try_into().unwrap()));}let value=render_metrics::metrics(&input["plan"],input["sampleRate"].as_u64().unwrap() as u32,&l,&r,input["transitionStartFrame"].as_i64().unwrap(),input["limiter"].as_f64().unwrap(),input["underruns"].as_u64().unwrap() as usize);serde_json::to_writer(std::fs::File::create(&args[3]).unwrap(),&value).unwrap();}
`);
const cargo = process.env.CARGO ?? path.join(process.env.USERPROFILE ?? '', '.cargo/bin/cargo.exe');
const compiled = spawnSync(cargo, ['build', '--release', '--manifest-path', path.join(harness, 'Cargo.toml')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'tools/.cache/rust-render-metrics-target'), RUSTFLAGS: '-C linker=rust-lld -C link-self-contained=yes -A dead_code' } });
assert.equal(compiled.status, 0, compiled.stderr);
const sourceFile = path.join(root, 'packages/core/src/engine/render-check.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const body = source.slice(source.indexOf('  const n = r.L.length'), source.indexOf('\r\n\r\ntype RatedPlan') >= 0 ? source.indexOf('\r\n\r\ntype RatedPlan') : source.indexOf('\n\ntype RatedPlan'));
const imports = `import {Biquad,BUTTERWORTH_Q,lowpass} from '../dsp/biquad.ts';import {kWeighting} from '../dsp/loudness.ts';const r2=(x:number)=>Math.round(x*100)/100; export function metrics(plan:any,sr:number,r:any){`;
await build({ stdin: { contents: imports + body, resolveDir: path.dirname(sourceFile), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(out, 'oracle.mjs') });
const { metrics } = await import(pathToFileURL(path.join(out, 'oracle.mjs')).href);
const report = [];
for (const sr of [44100, 48000, 96000])
    for (const kind of ['steady', 'side-bass', 'level-dip', 'level-bump', 'low-hole', 'flams', 'silence', 'limiter', 'underrun']) {
        const n = sr * 16, L = new Float32Array(n), R = new Float32Array(n);
        let state = 1;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            const noise = (state / 2 ** 32 * 2 - 1);
            const phase = t % .5;
            const flam = (t - .06) % .5;
            const kick = .4 * Math.exp(-phase * 65) * Math.sin(2 * Math.PI * 57 * t);
            const double = kind === 'flams' && t >= 6 && t < 10 ? .4 * Math.exp(-flam * 65) * Math.sin(2 * Math.PI * 57 * t) : 0;
            const low = .12 * Math.sin(2 * Math.PI * 65 * t) + kick + double;
            let x = .07 * Math.sin(2 * Math.PI * 550 * t) + .015 * noise + low;
            const transition = t >= 6 && t < 10;
            if (kind === 'flams')
                x = .01 * Math.sin(2 * Math.PI * 550 * t) + 1.5 * Math.exp(-phase * 180) * Math.sin(2 * Math.PI * 90 * phase)
                    + (transition ? 1.5 * Math.exp(-flam * 180) * Math.sin(2 * Math.PI * 90 * flam) : 0);
            if (kind === 'level-dip' && transition)
                x *= .07;
            if (kind === 'level-bump' && transition)
                x *= 3;
            if (kind === 'low-hole' && transition)
                x -= low;
            if (kind === 'silence')
                x = 0;
            L[i] = x;
            R[i] = kind === 'side-bass' ? -x : x * .93;
        }
        const input = { plan: { duration: 4, gap: 0 }, sampleRate: sr, transitionStartFrame: 6 * sr, limiter: kind === 'limiter' ? 4.321 : 0, underruns: kind === 'underrun' ? 2 : 0 };
        const bytes = Buffer.alloc(n * 8);
        for (let i = 0; i < n; i++) {
            bytes.writeFloatLE(L[i], i * 8);
            bytes.writeFloatLE(R[i], i * 8 + 4);
        }
        const name = `${sr}-${kind}`;
        const inputFile = path.join(out, name + '-input.json'), pcmFile = path.join(out, name + '.f32'), outputFile = path.join(out, name + '-rust.json');
        fs.writeFileSync(inputFile, JSON.stringify(input));
        fs.writeFileSync(pcmFile, bytes);
        const expected = metrics(input.plan, sr, { L, R, transitionStartFrame: input.transitionStartFrame, metrics: { maxLimiterReductionDb: input.limiter, underruns: input.underruns } });
        fs.writeFileSync(path.join(out, name + '-ts.json'), JSON.stringify(expected));
        const child = spawnSync(path.join(root, 'tools/.cache/rust-render-metrics-target/release/rust-render-metrics-check.exe'), [inputFile, pcmFile, outputFile], { encoding: 'utf8', windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        const actual = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)), name);
        if (kind === 'flams') assert.ok(actual.flams >= 4, 'fixture must exercise double attacks');
        if (kind === 'low-hole') assert.ok(actual.lowHoleSeconds > 1, 'fixture must exercise missing bass');
        if (kind === 'level-dip') assert.ok(actual.dipLU < -3, 'fixture must exercise a loudness dip');
        if (kind === 'level-bump') assert.ok(actual.bumpLU > 3, 'fixture must exercise a loudness bump');
        report.push({ name, metrics: actual });
        console.log(name, 'parity OK');
    }
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ date: new Date().toISOString(), exactRoundedMetrics: true, cases: report }, null, 2));
