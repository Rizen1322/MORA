import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTransitionOffline } from '../packages/core/src/engine/arm.ts';
import { renderRust, measureRust } from '../apps/server/src/rust-render.ts';
import { renderMetrics } from '../packages/core/src/engine/render-check.ts';
import type { TransitionPlan } from '../packages/core/src/types.ts';
process.env.AUTOMIX_RUST_CORE = path.resolve(process.env.MORA_AUDIO_EXE ?? 'packages/audio-rust/target/release/mora-audio.exe');
const rows:any[]=[];
for(const sr of [44100,48000]) {
 const length=sr*12,L=Float32Array.from({length},(_,i)=>.15*Math.sin(2*Math.PI*220*i/sr)+.06*Math.sin(2*Math.PI*57*i/sr)),R=Float32Array.from(L,x=>x*.9);
 const a={L,R,sampleRate:sr},b={L:R,R:L,sampleRate:sr};
 const base:TransitionPlan={id:'test',version:'test',fromTrackId:'a',toTrackId:'b',method:'crossfade',confidence:1,reasons:[],debug:{},aExit:6,bEntry:1,duration:4,gap:0,swapAt:2,tempoB:[[0,1]],gainA:0,gainB:0,automation:[{deck:'A',lane:'gain',points:[[0,1],[4,0]]},{deck:'B',lane:'gain',points:[[0,0],[4,1]]}]};
 const cases=[{name:'crossfade',plan:base},{name:'delay',plan:{...base,bDelay:1}},{name:'tempo',plan:{...base,tempoA:[[0,1.02],[4,1]],tempoB:[[0,.98],[4,1]]}},{name:'gap',plan:{...base,method:'gapless',duration:0,gap:.2,swapAt:0,automation:[]}},{name:'loop',plan:{...base,loopA:{start:4,end:5,until:3,crossfade:.02}}},{name:'vocal',plan:{...base,vocalA:[[0,1],[4,0]],vocalB:[[0,0],[4,1]]}},{name:'speed-pitch',plan:base,playback:{speed:1.2,semitones:2}}];
 for(const c of cases) {
  const plan=c.plan as TransitionPlan, playback=c.playback;
  const av=c.name==='vocal'?{...a,vocals:{L:Float32Array.from(L,x=>x*.2),R:Float32Array.from(R,x=>x*.2)}}:a;
  const bv=c.name==='vocal'?{...b,vocals:{L:Float32Array.from(R,x=>x*.2),R:Float32Array.from(L,x=>x*.2)}}:b;
  const before=performance.now(),expected=renderTransitionOffline(av,bv,plan,1,1,playback),tsMs=performance.now()-before;
  const start=performance.now(),actual=await renderRust(av,bv,plan,1,1,playback),rustMs=performance.now()-start;
  assert.equal(Buffer.compare(Buffer.from(actual.L.buffer),Buffer.from(expected.L.buffer)),0,`${sr}-${c.name} L`);
  assert.equal(Buffer.compare(Buffer.from(actual.R.buffer),Buffer.from(expected.R.buffer)),0,`${sr}-${c.name} R`);
  assert.equal(actual.transitionStartFrame,expected.transitionStartFrame,`${c.name} start`);
  assert.deepEqual(actual.metrics,expected.metrics,`${c.name} metrics`);
  assert.deepEqual(actual.events,expected.events,`${c.name} events`);
  assert.deepEqual(await measureRust(plan,{pcm:av,start:0},{pcm:bv,start:0}),renderMetrics(plan,{pcm:av,start:0},{pcm:bv,start:0}),`${c.name} technical metrics`);
  rows.push({suite:'render',sampleRate:sr,kind:c.name,frames:actual.L.length,typescriptMs:tsMs,rustWithIpcMs:rustMs,bitExact:true});
 }
 for(const kind of ['crossfade','tempo','side','early','gap','limiter']) {
  const n=sr*25;
  const L=Float32Array.from({length:n},(_,i)=>(kind==='limiter'?1:.2)*Math.sin(i/sr*Math.PI*2*55)+.08*Math.sin(i/sr*Math.PI*2*440));
  const R=Float32Array.from(L,x=>kind==='side'?-x:x*.9);
  const a={pcm:{L,R,sampleRate:sr},start:4},b={pcm:{L:R,R:L,sampleRate:sr},start:3};
  const plan:TransitionPlan={...base,aExit:kind==='early'?6:10,bEntry:5,gap:kind==='gap'?.2:0,
   tempoB:kind==='tempo'?[[0,.95],[4,1]]:[[0,1]],...(kind==='tempo'?{tempoA:[[0,1.02],[4,1]] as [number,number][]}:{})};
  const before=performance.now(),expected=renderMetrics(plan,a,b),tsMs=performance.now()-before;
  const start=performance.now(),actual=await measureRust(plan,a,b),rustMs=performance.now()-start;
  assert.deepEqual(actual,expected,`${sr}-${kind} technical metrics with source offsets`);
  if(kind==='early')assert.equal(actual,null,'insufficient source coverage must skip measurement');
  if(kind==='side')assert.ok(actual!.lowHoleSeconds>1,'fixture must exercise missing stereo bass');
  if(kind==='gap')assert.ok(actual!.flams>4,'fixture must exercise double attacks');
  if(kind==='limiter')assert.ok(actual!.limiterDb>1,'fixture must exercise limiter reduction');
  rows.push({suite:'metrics',sampleRate:sr,kind,typescriptMs:tsMs,rustWithIpcMs:rustMs,exactMetrics:true,metrics:actual});
 }
}
if(process.argv.includes('--long')) {
 const sr=96000,length=sr*76,L=new Float32Array(length),R=new Float32Array(length),pcm={L,R,sampleRate:sr};
 const plan:TransitionPlan={id:'long-96k',version:'test',fromTrackId:'a',toTrackId:'b',method:'crossfade',confidence:1,reasons:[],debug:{},aExit:6,bEntry:0,duration:64,gap:0,swapAt:32,tempoB:[[0,1]],gainA:0,gainB:0,automation:[{deck:'A',lane:'gain',points:[[0,1],[64,0]]},{deck:'B',lane:'gain',points:[[0,0],[64,1]]}]};
 const inputBase64Bytes=4*Math.ceil(length*4/3)*4;
 assert.ok(inputBase64Bytes>128*1024*1024,'fixture must exceed the old native request limit');
 const before=performance.now(),expected=renderMetrics(plan,{pcm,start:0},{pcm,start:0}),tsMs=performance.now()-before;
 const start=performance.now(),actual=await measureRust(plan,{pcm,start:0},{pcm,start:0}),rustMs=performance.now()-start;
 assert.notEqual(actual,null,'valid long 96kHz blend must be measured');
 assert.deepEqual(actual,expected,'long 96kHz technical metrics');
 rows.push({suite:'metrics',sampleRate:sr,kind:'long-64s',inputBase64Bytes,typescriptMs:tsMs,rustWithIpcMs:rustMs,exactMetrics:true,metrics:actual});
}
fs.mkdirSync('data-bench-results/rust-render',{recursive:true});fs.writeFileSync('data-bench-results/rust-render/summary.json',JSON.stringify(rows,null,2));
console.log(`Native offline render: ${rows.filter(r=>r.suite==='render').length} bit-exact renders and ${rows.filter(r=>r.suite==='metrics').length} adversarial metric cases passed`);
