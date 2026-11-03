import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyVocalHandoff} from '../packages/core/src/plan/vocals.ts';
import {preserveFirstWords,withVocalGap,outgoingPhraseCut} from '../packages/core/src/plan/first-words.ts';
import {withDjPhrasing} from '../packages/core/src/plan/dj-phrasing.ts';
import {withInstrumentalLoop} from '../packages/core/src/plan/loop.ts';
import {withVoiceAnswer} from '../packages/core/src/plan/answer.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.env.MORA_VOCAL_PLAN_EXE){
 const dir=path.join(root,'tools/.cache/rust-vocal-plan-check');fs.mkdirSync(path.join(dir,'src/plan'),{recursive:true});
 fs.writeFileSync(path.join(dir,'Cargo.toml'),'[package]\nname="rust-vocal-plan-check"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nserde_json={version="1",features=["preserve_order","float_roundtrip"]}\n');
 const source=(name:string)=>JSON.stringify(path.join(root,'packages/audio-rust/src',name).replaceAll('\\','/'));
 fs.writeFileSync(path.join(dir,'src/main.rs'),`#[path=${source('js_json.rs')}] mod js_json;
mod plan {
 #[path=${source('plan/common.rs')}] pub mod common;
 #[path=${source('plan/voice_measure.rs')}] pub mod voice_measure;
 #[path=${source('plan/vocal_handoff.rs')}] pub mod vocal_handoff;
 #[path=${source('plan/first_words.rs')}] pub mod first_words;
 #[path=${source('plan/musical_decorators.rs')}] pub mod musical_decorators;
}
fn main(){let input:serde_json::Value=serde_json::from_reader(std::io::stdin()).unwrap();let p=input["p"].clone();let a=&input["a"];let b=&input["b"];let s=&input["s"];let requested=input["requested"].as_f64();let result=match input["mode"].as_str().unwrap(){"dj"=>plan::musical_decorators::dj_phrasing(p,a,b,s,requested),"loop"=>plan::musical_decorators::instrumental_loop(p,a,b,s,requested),"answer"=>plan::musical_decorators::voice_answer(p,a,b,s,requested),"handoff"=>plan::vocal_handoff::apply_vocal_handoff(p,a,b,s),"first"=>plan::first_words::preserve_first_words(p,a,b,s),"gap"=>plan::first_words::with_vocal_gap(p,a,b,s),"cut"=>plan::first_words::outgoing_phrase_cut(&p,a).unwrap_or(serde_json::Value::Null),_=>panic!()};serde_json::to_writer(std::io::stdout(),&result).unwrap();}`);
 const cargo=process.env.CARGO??path.join(os.homedir(),'.cargo/bin/cargo.exe');
 const build=spawnSync(cargo,['build','--offline','--release','--manifest-path',path.join(dir,'Cargo.toml')],{encoding:'utf8',windowsHide:true,env:{...process.env,RUSTFLAGS:process.env.RUSTFLAGS??'-C linker=rust-lld -C link-self-contained=yes',CARGO_TARGET_DIR:path.join(root,'tools/.cache/rust-vocal-plan-target')}});
 assert.equal(build.status,0,build.error?.message??build.stderr);
}
const exe=process.env.MORA_VOCAL_PLAN_EXE??path.join(root,'tools/.cache/rust-vocal-plan-target/release/rust-vocal-plan-check.exe');
const out=path.join(root,'data-bench-results/rust-vocal-plan');fs.mkdirSync(out,{recursive:true});
const normalized=(v:any)=>JSON.parse(JSON.stringify(v));
function differences(a:any,b:any,p:string,out:any[]){if(typeof b==='number'){if(typeof a!=='number'||Math.abs(a-b)>1e-8)out.push({p,a,b});return;}if(!b||typeof b!=='object'){if(a!==b)out.push({p,a,b});return;}if(!a||typeof a!=='object'){out.push({p,a,b});return;}if(Object.keys(a).sort().join(',')!==Object.keys(b).sort().join(','))out.push({p:p+'.keys',a:Object.keys(a),b:Object.keys(b)});for(const k of Object.keys(b))differences(a[k],b[k],p+'.'+k,out);}
function analysis(seed:number){const rate=10,duration=70;const values=Array.from({length:rate*duration},(_,i)=>{const t=i/rate;return seed===0?0:seed===1?.8:seed===2?(t>6&&t<60?.85:0):((t+seed*.37)%6>1.5&&(t+seed*.37)%6<4.2?.8:.02)});const spans:number[][]=[];for(let i=0;i<25;i++)spans.push([i*2.3+.1,i*2.3+1.3]);return {duration,audibleStart:0,audibleEnd:duration,beat:{period:.5},curves:{rate:2,rmsDb:Array(140).fill(-15)},vocalActivity:{model:'test',version:'1',source:'demucs',rate,values,accompanimentRmsDb:Array(700).fill(-20),...(seed>=5?{lyrics:{confidence:.9,words:spans,lines:spans.filter((_,i)=>i%3===0),...(seed%2?{timing:'stem-verified-1',voiced:spans}:{})}}:{})}};}
function plan(i:number){const duration=[2,6,12,24][i%4];const method=['crossfade','beatmatch_blend','drop_mix'][i%3];const automation=[];for(const deck of ['A','B'])for(const lane of ['gain','low','mid','high','filter'])automation.push({deck,lane,points:lane==='filter'?[[0,0],[duration,0]]:lane==='gain'?deck==='A'?[[0,1],[duration,0]]:[[0,0],[duration,1]]:[[0,1],[duration,1]]});return {duration,aExit:10,bEntry:0,swapAt:duration*.5,gainA:-2,gainB:-1,method,reasons:[],debug:{},tempoB:[[0,1]],...(i%5===0?{tempoA:[[0,1.02],[duration,1]],tempoB:[[0,.98],[duration,1]]}:{}),automation,...(method==='beatmatch_blend'?{beatAlign:{bpmA:120,regions:{A:{period:.5}}}}:{})};}
const rows:any[]=[];
for(let i=0;i<56;i++){
 let a:any=analysis(i%8),b:any=analysis((i*3+2)%8),p:any=plan(i);const s:any={enabled:true,stemMixing:true,eqHandoff:i%3!==0,maxBlendSeconds:60};
 if(i%7===1)delete a.vocalActivity;if(i%7===2)delete b.vocalActivity;if(i%7===3)a.vocalActivity.values.length=115;if(i%7===4)b.vocalActivity.values.length=20;
 if(i>=48){p.debug={processingAllowed:i%2===0,requested:i%3===0};if(i%4===0)p.loopA={start:2,end:4,until:10};}
 for(const mode of ['handoff','first','gap','cut']){
  if(mode!=='handoff'){p=applyVocalHandoff(p,a,b,s);if(mode==='gap'||mode==='cut')p=preserveFirstWords(p,a,b,s);}
  const expected=normalized(mode==='handoff'?applyVocalHandoff(p,a,b,s):mode==='first'?preserveFirstWords(p,a,b,s):mode==='gap'?withVocalGap(p,a,b,s):outgoingPhraseCut(p,a));
  const input=normalized({mode,p,a,b,s});const result=spawnSync(exe,[],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr+result.stdout);const actual=JSON.parse(result.stdout);const diffs:any[]=[];differences(actual,expected,`${i}-${mode}`,diffs);rows.push({i,mode,differences:diffs.length});if(diffs.length){fs.writeFileSync(path.join(out,`${i}-${mode}.json`),JSON.stringify({input,actual,expected,diffs},null,2));console.log(i,mode,JSON.stringify(diffs.slice(0,4)));}
 }
}
{
 const a:any=analysis(0),b:any=analysis(0),p:any=plan(1),s:any={enabled:true,stemMixing:true,eqHandoff:true,maxBlendSeconds:60};
 p.method='crossfade';p.duration=8;p.aExit=10;p.bEntry=0;p.tempoB=[[0,1]];delete p.tempoA;
 a.vocalActivity.values=Array.from({length:700},(_,i)=>i>=100&&i<140?.8:0);
 b.vocalActivity.values=Array.from({length:700},(_,i)=>i>=50?.8:0);
 p.automation=[{deck:'A',lane:'gain',points:[[0,1],[4,0],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[8,1]]}];
 const expected=normalized(withVocalGap(p,a,b,s));assert(expected.debug.vocalGap,'fixture must exercise finishing an audible phrase');
 const input={mode:'gap',p,a,b,s},r=spawnSync(exe,[],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const actual=JSON.parse(r.stdout),diffs:any[]=[];differences(actual,expected,'active-gap',diffs);rows.push({i:'active',mode:'gap',differences:diffs.length});assert.deepEqual(diffs,[]);
}
for(const mode of ['dj','loop','answer'])for(let variant=0;variant<14;variant++){
 const a:any=analysis(1),b:any=analysis(0),p:any=plan(2),s:any={enabled:true,stemMixing:true,eqHandoff:true,style:'auto',maxBlendSeconds:60};
 p.id='musical';p.method='crossfade';p.duration=12;p.aExit=10;p.bEntry=0;delete p.beatAlign;delete p.tempoA;p.tempoB=[[0,1]];
 p.vocalA=[[0,1],[1,0],[12,0]];p.vocalB=[[0,1],[12,1]];p.automation=p.automation.filter((l:any)=>l.lane!=='filter');
 a.beat=b.beat={period:.5,stable:true,confidence:.95,downbeatConfidence:.9,jitterMs:2,downbeats:Array.from({length:35},(_,i)=>i*2)};
 if(mode==='dj'){b.sectionBoundaries=[8];b.bodyRmsDb=-15;b.curves.lowDb=Array.from({length:140},(_,i)=>i<16?-30:-15);b.curves.rmsDb=Array.from({length:140},(_,i)=>i<16?-22:-15);}
 if(mode==='loop'){p.duration=6;p.entrySelection={arrivalTime:4};a.bodyRmsDb=-15;a.vocalActivity.vocalRmsDb=Array(700).fill(-80);a.curves.rmsDb=Array.from({length:140},(_,i)=>i>=28?-25:-15);}
 if(mode==='answer'){p.vocalA=[[0,1],[2,0],[12,0]];b.vocalActivity.values=Array.from({length:700},(_,i)=>i>=50?.8:0);}
 let requested:number|undefined;
 if(variant===1)requested=0;if(variant===2)s.eqHandoff=false;if(variant===3)s.stemMixing=false;if(variant===4)s.djPhrasing=false;if(variant===5)s.style='tight';
 if(variant===6)p.debug.processingAllowed=false;if(variant===7)p.loopA={start:0,end:1,until:2};if(variant===8)p.voiceEcho={delay:.5,feedback:.3};
 if(variant===9)b.vocalActivity.values.fill(.5);if(variant===10)a.beat.jitterMs=20;if(variant===11)p.tempoA=[[0,1.2]];
 if(variant===12)a.vocalActivity.vocalRmsDb=Array(700).fill(-20);if(variant===13)b.vocalActivity.values.length=10;
 const expected=normalized(mode==='dj'?withDjPhrasing(p,a,b,s,requested):mode==='loop'?withInstrumentalLoop(p,a,b,s,requested):withVoiceAnswer(p,a,b,s,requested));
 if(variant===0)assert(expected.debug[mode==='dj'?'djFilterRelease':mode==='loop'?'loopBridge':'voiceAnswer'],`fixture must exercise active ${mode}`);
 const input=normalized({mode,p,a,b,s,requested}),result=spawnSync(exe,[],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout),diffs:any[]=[];differences(actual,expected,`${variant}-${mode}`,diffs);rows.push({i:variant,mode,differences:diffs.length});if(diffs.length){fs.writeFileSync(path.join(out,`${variant}-${mode}.json`),JSON.stringify({input,actual,expected,diffs},null,2));console.log(variant,mode,JSON.stringify(diffs.slice(0,4)));}
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(rows,null,2));console.log(`${rows.filter(x=>!x.differences).length}/${rows.length} decorator cases match`);assert(rows.every(x=>!x.differences),'vocal plan parity failed');
