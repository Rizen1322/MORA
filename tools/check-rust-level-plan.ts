import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { withMasterTempo } from '../packages/core/src/plan/master-tempo.ts';
import { withMicroOnset } from '../packages/core/src/plan/micro-onset.ts';
import { withHarmonicHandoff } from '../packages/core/src/plan/harmonic.ts';
import { withTapeStop } from '../packages/core/src/plan/tape-stop.ts';
import { rhythmOverlap } from '../packages/core/src/plan/rhythm-overlap.ts';
import { ratingBias, ratingFeatures } from '../packages/core/src/plan/feedback.ts';
import { DEFAULT_AUTOMIX_SETTINGS } from '../packages/core/src/types.ts';
const root = process.cwd(), dir = path.join(root, 'tools/.cache/rust-level-check');
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
const source = (name: string) => JSON.stringify(path.join(root, 'packages/audio-rust/src', name).replaceAll('\\', '/'));
fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="rust-level-check"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nserde_json={version="1",features=["preserve_order","float_roundtrip"]}\n');
fs.writeFileSync(path.join(dir, 'src/main.rs'), `#[path=${source('js_json.rs')}] mod js_json;
#[path=${source('plan/mod.rs')}] mod plan;
fn main(){let v:serde_json::Value=serde_json::from_reader(std::io::stdin()).unwrap();let p=v["p"].clone();let a=&v["a"];let b=&v["b"];let s=&v["s"];let requested=v["requested"].as_f64();let out=match v["mode"].as_str().unwrap(){
"master"=>plan::tempo_decorators::master_tempo(p,a,b,s,requested),"micro"=>plan::tempo_decorators::micro_onset(p,a,b,s,requested),"harmonic"=>plan::tempo_decorators::harmonic_handoff(p,a,b,s,requested),"tape"=>plan::tempo_decorators::tape_stop(p,a,b,s,requested),
"hold"=>plan::level_decorators::hold_loudness(p,a,b),"bass"=>plan::level_decorators::bass_continuity(p,a,b),"phrase"=>plan::level_decorators::phrase_bass_swap(p,a,b),"rhythm"=>plan::rhythm_overlap::rhythm_overlap(&p,a,b),"feedback"=>plan::feedback::rating_bias(&v["stats"],&p,a,b),_=>panic!()};serde_json::to_writer(std::io::stdout(),&out).unwrap();}`);
const compiled=spawnSync(path.join(os.homedir(),'.cargo/bin/cargo.exe'),['build','--offline','--release','--manifest-path',path.join(dir,'Cargo.toml')],{encoding:'utf8',windowsHide:true,env:{...process.env,RUSTFLAGS:'-C linker=rust-lld -C link-self-contained=yes',CARGO_TARGET_DIR:path.join(root,'tools/.cache/rust-level-target')}});
assert.equal(compiled.status,0,compiled.stderr);
const planner=fs.readFileSync('packages/core/src/plan/planner.ts','utf8');
await build({stdin:{contents:planner+'\nexport {holdLoudness,bassContinuity,phraseBassSwap};',resolveDir:path.join(root,'packages/core/src/plan'),loader:'ts'},outfile:path.join(dir,'oracle.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const oracle=await import(pathToFileURL(path.join(dir,'oracle.mjs')).href);
const exe=path.join(root,'tools/.cache/rust-level-target/release/rust-level-check.exe');
const out='data-bench-results/rust-level-plan';fs.mkdirSync(out,{recursive:true});
const normalized=(v:any)=>JSON.parse(JSON.stringify(v));
function analysis(bpm=120){const duration=180,rate=10,period=60/bpm,beats=Array.from({length:Math.floor(duration/period)},(_,i)=>i*period);return {duration,audibleStart:0,audibleEnd:duration,bodyRmsDb:-16,beat:{stable:true,bpm,period,confidence:.95,jitterMs:2,downbeatConfidence:.9,beats,downbeats:beats.filter((_,i)=>i%4===0),accents:{kick:beats.map((_,i)=>i%4===0?1:.3),snare:beats.map((_,i)=>i%4===2?1:.1)},attacks:{version:'lf-attack-1',offsetsMs:beats.map(()=>0),strength:beats.map(()=>.9)}},key:{confidence:.9},phrases:beats.filter((_,i)=>i%16===0),phraseConfidence:.9,curves:{rate,rmsDb:Array(duration*rate).fill(-16),lowDb:Array(duration*rate).fill(-19),midDb:Array(duration*rate).fill(-22),highDb:Array(duration*rate).fill(-26),midDensity:Array(duration*rate).fill(.2)},vocalActivity:{rate,values:Array(duration*rate).fill(0),vocalRmsDb:Array(duration*rate).fill(-60),accompanimentRmsDb:Array(duration*rate).fill(-17)}};}
function plan(duration=16){const automation=[];for(const deck of ['A','B'])for(const lane of ['gain','low','mid','high'])automation.push({deck,lane,points:lane==='gain'?deck==='A'?[[0,1],[duration,0]]:[[0,0],[duration,1]]:lane==='low'?deck==='A'?[[0,1],[duration*.45,1],[duration*.55,0]]:[[0,0],[duration*.45,0],[duration*.55,1]]:[[0,1],[duration,1]]});return {id:'test',version:'test',fromTrackId:'a',toTrackId:'b',aExit:150,bEntry:0,duration,swapAt:duration/2,gap:0,gainA:0,gainB:0,method:'beatmatch_blend',tempoA:[[0,1.01],[duration,1]],tempoB:[[0,.99],[duration,1]],beatAlign:{stretchPercent:2},keyInfo:{compatibility:.1},automation,reasons:[],debug:{}};}
const funcs:any={master:withMasterTempo,micro:withMicroOnset,harmonic:withHarmonicHandoff,tape:withTapeStop,hold:oracle.holdLoudness,bass:oracle.bassContinuity,phrase:oracle.phraseBassSwap,rhythm:rhythmOverlap,feedback:ratingBias};
const reports:any[]=[];
function differences(a:any,b:any,where:string,rows:any[]){if(typeof b==='number'){if(typeof a!=='number'||!Number.isFinite(a)||Math.abs(a-b)>1e-8)rows.push({where,a,b});return;}if(!b||typeof b!=='object'){if(a!==b)rows.push({where,a,b});return;}if(!a||typeof a!=='object'){rows.push({where,a,b});return;}if(Object.keys(a).sort().join()!==Object.keys(b).sort().join())rows.push({where:where+'.keys',a:Object.keys(a),b:Object.keys(b)});for(const key of Object.keys(b))differences(a[key],b[key],where+'.'+key,rows);}
for(let i=0;i<36;i++){
 const a:any=analysis(),b:any=analysis(i%3===0?123:120),p:any=plan([6,10,16][i%3]),s:any={...DEFAULT_AUTOMIX_SETTINGS,maxBlendSeconds:60,stemMixing:true};
 if(i%6===0){a.vocalActivity.values.fill(.8);p.tempoA=[[0,1],[p.duration,1]];p.tempoB=[[0,120/123],[p.duration,120/123]];}
 if(i%6===1){p.method='crossfade';p.tempoA=undefined;p.tempoB=[[0,1]];b.beat.bpm=88;}
 if(i%6===2){delete a.vocalActivity;delete b.vocalActivity;p.tempoA=undefined;p.tempoB=[[0,1]];b.beat.attacks.offsetsMs.fill(8);}
 if(i%6===3){a.curves.lowDb.fill(-10);b.curves.lowDb.fill(-10);p.keyInfo.compatibility=.9;}
 if(i%6===4){b.curves.lowDb.fill(-50,0,70);p.swapAt=6;}
 if(i>=24){p.duration=6;p.aExit=174;p.method='crossfade';p.tempoA=undefined;p.tempoB=[[0,1]];b.beat.bpm=88;for(const l of p.automation)if(l.deck==='B')l.points=[[0,1],[6,1]];}
 if(i%12===11)p.debug.processingAllowed=false;
 const requested=i%12===10?20:undefined;
 const features=ratingFeatures(p,a,b),stats={version:'test',features:Object.fromEntries(features.map((f,j)=>[f,{good:j%5,bad:j%3}])),reasons:{'резко':Object.fromEntries(features.map(f=>[f,{good:0,bad:3}]))}};
 for(const [mode,fn] of Object.entries(funcs)){
  const expected=normalized(mode==='feedback'?(fn as any)(stats,p,a,b):(fn as any)(p,a,b,s,requested));const input=normalized({mode,p,a,b,s,requested,stats});const proc=spawnSync(exe,[],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});assert.equal(proc.status,0,proc.stderr);const actual=JSON.parse(proc.stdout);const rows:any[]=[];differences(actual,expected,`${i}-${mode}`,rows);reports.push({i,mode,differences:rows.length});if(rows.length){fs.writeFileSync(`${out}/${i}-${mode}.json`,JSON.stringify({input,actual,expected,rows},null,2));console.log(i,mode,JSON.stringify(rows.slice(0,4)));}
 }
}
fs.writeFileSync(`${out}/summary.json`,JSON.stringify(reports,null,2));assert(reports.every(r=>r.differences===0),'Level/decorator parity failed');console.log(`Level/decorator parity: ${reports.length} cases passed`);
