import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { DEFAULT_AUTOMIX_SETTINGS as S } from '../packages/core/src/types.ts';
const root = process.cwd(), out = path.join(root, 'data-bench-results/rust-unlocked');
fs.mkdirSync(out, { recursive: true });
const harness = path.join(root, 'tools/.cache/rust-unlocked-check');
fs.mkdirSync(path.join(harness, 'src'), { recursive: true });
fs.writeFileSync(path.join(harness, 'Cargo.toml'), `[package]
name = "rust-unlocked-check"
version = "0.1.0"
edition = "2024"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order", "float_roundtrip"] }
[profile.release]
lto = "thin"
codegen-units = 1
`);
fs.writeFileSync(path.join(harness, 'src/main.rs'), `#[path="../../../../packages/audio-rust/src/plan/mod.rs"] mod plan;
#[path="../../../../packages/audio-rust/src/js_json.rs"] mod js_json;
fn main(){let args:Vec<_>=std::env::args().collect();let v:serde_json::Value=serde_json::from_reader(std::io::BufReader::new(std::fs::File::open(&args[1]).unwrap())).unwrap();let ctx=plan::context::Ctx{a:&v["from"],b:&v["to"],s:&v["settings"],requested_at:v["position"].as_f64(),vocal_repair:None,fixed:None,region_a:None,region_b:None};let a=&v["from"]["analysis"];let b=&v["to"]["analysis"];let key=&v["key"];let reason=v["reason"].as_str();let p=match v["branch"].as_str().unwrap(){"human"=>serde_json::to_value(plan::human::automatic_scenarios(&v["base"],a,b,&v["settings"])).unwrap(),"crossfade"=>plan::unlocked::plan_crossfade(&ctx,a,b,key,reason),"minimal"=>plan::unlocked::plan_minimal(&ctx,a,b,key,reason),"phrase_cut"=>plan::unlocked::plan_phrase_cut(&ctx,a,b,key,reason).unwrap_or(serde_json::Value::Null),"intro_drop"=>plan::unlocked::plan_intro_drop(&ctx,a,b,key,reason).unwrap_or(serde_json::Value::Null),"instrumental_bridge"=>plan::unlocked::plan_instrumental_bridge(&ctx,a,b,key,reason).unwrap_or(serde_json::Value::Null),"echo"=>plan::unlocked::plan_echo_out(&v["base"],a,b,&v["settings"],v["stretch"].as_f64().unwrap()).unwrap_or(serde_json::Value::Null),_=>plan::unlocked::plan_unlocked(&ctx,a,b,key,reason)};serde_json::to_writer(std::fs::File::create(&args[2]).unwrap(),&p).unwrap();}
`);
const cargo = process.env.CARGO ?? path.join(process.env.USERPROFILE ?? '', '.cargo/bin/cargo.exe');
const built = spawnSync(cargo, ['build', '--release', '--manifest-path', path.join(harness, 'Cargo.toml')], { env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'tools/.cache/rust-unlocked-target'), RUSTFLAGS: '-C linker=rust-lld -C link-self-contained=yes -A dead_code -A unused_imports' }, encoding: 'utf8', windowsHide: true });
assert.equal(built.status, 0, built.stderr);
const planner = path.join(root, 'packages/core/src/plan/planner.ts');
const extra = `export function probe(v){const ctx={a:v.from,b:v.to,s:v.settings,gainA:normalizationGain(v.from.analysis,v.settings.loudnessTarget),gainB:normalizationGain(v.to.analysis,v.settings.loudnessTarget),requestedAt:v.position};if(v.branch==="base")return {...basePlan(ctx,"echo_out"),keyInfo:v.key,...(v.reason===undefined?{}:{fallbackReason:v.reason})};const fn={crossfade:planCrossfade,minimal:planMinimal,phrase_cut:planPhraseCut,intro_drop:planIntroDrop,instrumental_bridge:planInstrumentalBridge,unlocked:planUnlocked}[v.branch];return v.branch==='human'?humanTransitionScenarios(v.base,v.from.analysis,v.to.analysis,v.settings).filter(x=>!x.auditionOnly).map(x=>[x.name,x.plan]):v.branch==='echo'?planEchoOut(v.base,v.from.analysis,v.to.analysis,v.settings,v.stretch):fn(ctx,v.from.analysis,v.to.analysis,v.key,v.reason);}`;
await build({ stdin: { contents: fs.readFileSync(planner, 'utf8') + extra, resolveDir: path.dirname(planner), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(out, 'oracle.mjs') });
const fixture = path.join(root, 'packages/core/test/transition-techniques.test.ts');
await build({ stdin: { contents: fs.readFileSync(fixture, 'utf8').split('describe(\'measured transition techniques\'')[0].replace("import { describe, expect, it } from 'vitest';", '') + 'export {song,bridgePair};', resolveDir: path.dirname(fixture), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(out, 'fixtures.mjs') });
const { probe } = await import(pathToFileURL(path.join(out, 'oracle.mjs')).href);
const { song, bridgePair } = await import(pathToFileURL(path.join(out, 'fixtures.mjs')).href);
const cases: any[] = [];
const add = (name: string, branch: string, from: any, to: any, settings: any = {}, key: any = {}, extra: any = {}) => cases.push({ name, branch, from, to, settings: { ...S, ...settings }, key: { compatibility: .8, ...key }, ...extra });
for (const style of ['tight', 'smooth', 'normal'])
    for (const eqHandoff of [true, false]) {
        add(`crossfade-${style}-${eqHandoff}`, 'crossfade', song('a', 118, { voice: false }), song('b', 156, { voice: false }), { style, eqHandoff });
    }
for (const style of ['tight', 'smooth', 'normal']) {
    const a = song('a', 118, { voice: false }), b = song('b', 156, { intro: 8, voice: false });
    for (let i = 160 * 20; i < 180 * 20; i++)
        a.analysis.curves.rmsDb[i] = -16 - (i / 20 - 160) * 1.6;
    add(`natural-fade-${style}`, 'crossfade', a, b, { style }, { compatibility: .1 });
}
for (const position of [undefined, 120]) {
    for (const branch of ['unlocked', 'phrase_cut', 'intro_drop', 'instrumental_bridge', 'minimal']) {
        add(`${branch}-${position}`, branch, song('a', 118, { voice: false }), song('b', 156, { voice: false }), {}, {}, { position, reason: 'test reason' });
    }
}
const { a, b } = bridgePair();
add('bridge', 'instrumental_bridge', a, b);
const hole = structuredClone(b);
hole.analysis.curves.rmsDb.fill(-32, 4 * 20, 7 * 20);
add('bridge-hole', 'instrumental_bridge', a, hole, { entryMode: 'preserve' });
add('bridge-disabled-stems', 'instrumental_bridge', a, b, { stemMixing: false });
for (const sungIntro of [true, false]) {
    const a = song('a', 118), b = song('b', 156);
    const drop = b.analysis.beat.downbeats.find((t: number) => t > 12);
    b.analysis.curves.lowDb = b.analysis.curves.lowDb.map((v: number, i: number) => i / 20 < drop ? v - 25 : v);
    b.analysis.curves.rmsDb = b.analysis.curves.rmsDb.map((v: number, i: number) => i / 20 < drop ? v - 4 : v);
    if (!sungIntro)
        b.analysis.vocalActivity.values = b.analysis.vocalActivity.values.map((v: number, i: number) => i / 10 < drop + 1 ? .03 : v);
    b.analysis.sectionBoundaries = [drop];
    add(`intro-${sungIntro}`, 'intro_drop', a, b);
}
const echoFixture = path.join(root, 'packages/core/test/unlocked.test.ts');
await build({ stdin: { contents: fs.readFileSync(echoFixture, 'utf8').split('const lane =')[0].replace("import { describe, expect, it } from 'vitest';", '') + 'export {track};', resolveDir: path.dirname(echoFixture), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(out, 'echo-fixtures.mjs') });
const { track } = await import(pathToFileURL(path.join(out, 'echo-fixtures.mjs')).href);
const ea = track('a', 152, { voice: [[20, 150]] }), eb = track('b', 100, { voice: [[8, 170]] });
add('echo-basic', 'echo', ea, eb, {}, {}, { stretch: 31.6 });
add('echo-none-voices', 'echo', track('a', 152, { voice: [] }), track('b', 100, { voice: [] }), {}, {}, { stretch: 31.6 });
add('echo-low-gap', 'echo', ea, eb, {}, {}, { stretch: 20 });
add('echo-preserve', 'echo', ea, eb, { entryMode: 'preserve' }, {}, { stretch: 31.6 });
add('echo-tail', 'echo', track('a', 89, { duration: 128, voice: [[20, 118]], rms: (t: number) => t >= 116 ? -24 : -9, low: (t: number) => t >= 116 ? -50 : -11 }), track('b', 130, { duration: 150, audibleStart: .3, voice: [[.3, 140]], rms: (t: number) => t < 7 ? -18 : -9, low: (t: number) => t < 7 ? -40 : -11 }), {}, {}, { stretch: 40 });
for (const c of cases.filter(c => c.branch === 'echo'))
    c.base = probe({ ...c, branch: 'base' });
for (const style of ['auto', 'smooth'])
    for (const alignment of [false, true])
        for (const shaky of [false, true]) {
            const a = song('a', 120, { voice: false }), b = song('b', 120, { voice: false });
            a.analysis.structure = { segments: [{ start: 0, end: 176, endClosure: .8 }] };
            if (shaky)
                a.analysis.beat.confidence = .5;
            const base = { ...probe({ from: a, to: b, settings: { ...S }, key: { compatibility: .8 }, branch: 'base' }), aExit: 164, confidence: .8, debug: { processingAllowed: true, discard: 'me' }, tempoA: [[0, 1]], loopA: { test: true } };
            if (alignment)
                base.beatAlign = { bpmA: 120, bpmB: 120, ratio: 1 };
            add(`human-${style}-${alignment}-${shaky}`, 'human', a, b, { style }, {}, { base });
            const af = structuredClone(a);
            for (let i = 176 * 20; i < 180 * 20; i++)
                af.analysis.curves.rmsDb[i] = -16 - (i / 20 - 176) * 6;
            add(`human-tail-${style}-${alignment}-${shaky}`, 'human', af, b, { style }, {}, { base });
        }
function compare(a: any, b: any, p = 'plan') { if (typeof b === 'number') {
    assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${p}: ${a} != ${b}`);
}
else if (b && typeof b === 'object') {
    assert.ok(a, `${p}: null`);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${p} keys`);
    for (const k of Object.keys(b))
        compare(a[k], b[k], p + '.' + k);
}
else
    assert.equal(a, b, p); }
for (const c of cases) {
    const clean = JSON.parse(JSON.stringify(c));
    const expected = JSON.parse(JSON.stringify(probe(clean)));
    fs.writeFileSync(path.join(out, c.name + '-input.json'), JSON.stringify(clean));
    fs.writeFileSync(path.join(out, c.name + '-ts.json'), JSON.stringify(expected));
    const p = spawnSync(path.join(root, 'tools/.cache/rust-unlocked-target/release/rust-unlocked-check.exe'), [path.join(out, c.name + '-input.json'), path.join(out, c.name + '-rust.json')], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const actual = JSON.parse(fs.readFileSync(path.join(out, c.name + '-rust.json'), 'utf8'));
    compare(actual, expected);
    console.log(c.name, 'OK', Array.isArray(expected) ? expected.map(x => x[0]).join(',') || 'none' : expected?.debug?.variant ?? expected?.method ?? 'null');
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ date: new Date().toISOString(), tolerance: 1e-9, cases: cases.map(c => c.name) }, null, 2));
