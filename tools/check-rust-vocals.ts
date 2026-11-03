import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MixerCore, type ArmedTransition } from '../packages/core/src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../packages/core/src/engine/chunks.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'data-bench-results/rust-vocals');
fs.mkdirSync(out,{recursive:true});
const exe=process.env.MORA_AUDIO_EXE || path.join(root,'packages/audio-rust/target/release/mora-audio.exe');
type Op=Record<string,any>;
const encode=(a:Float32Array)=>Buffer.from(a.buffer,a.byteOffset,a.byteLength).toString('base64');
const decode=(s:string)=>{const b=Buffer.from(s,'base64');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const kinds=['mask','lift','throw','clear','tempo','disable-before','disable-active','disable-b','force','force-no-stem','reset','reset-active','unready','late','seek','stop','reload','loop','playback'];
function fixture(sr:number,kind:string):Op[] {
  const ops:Op[]=[],late:Op[]=[];
  for(let deck=0;deck<2;deck++) {
    const total=sr*9;ops.push({cmd:'load',deck,token:`T${deck}`,totalFrames:total,gainDb:-3,cueFrame:0});
    for(let start=0;start<total;start+=CHUNK_FRAMES) {
      const n=Math.min(CHUNK_FRAMES,total-start),l=new Float32Array(n),r=new Float32Array(n),vl=new Float32Array(n),vr=new Float32Array(n);
      for(let i=0;i<n;i++) {
        const t=(start+i)/sr,voice=Math.sin(2*Math.PI*(deck?253:223)*t)*.21*(.75+.25*Math.sin(2*Math.PI*3*t));
        vl[i]=voice;vr[i]=voice*.9;
        const scale=t>=1&&t<3?1.2:.8;
        l[i]=voice*scale+.07*Math.sin(2*Math.PI*(deck?73:59)*t);r[i]=voice*.9*scale+.06*Math.sin(2*Math.PI*(deck?83:67)*t);
      }
      ops.push({cmd:'feed',deck,token:`T${deck}`,chunk:start/CHUNK_FRAMES,L:encode(l),R:encode(r)});
      const stem={cmd:'feedVocal',deck,token:`T${deck}`,chunk:start/CHUNK_FRAMES,L:encode(vl),R:encode(vr)};
      if((kind==='unready'||kind==='late')&&deck===1)late.push(stem);else ops.push(stem);
    }
  }
  ops.push({cmd:'start',deck:0,token:'T0',frame:0});
  const d=sr*2;
  const tr:ArmedTransition={planId:kind,method:kind,fromToken:'T0',toToken:'T1',triggerFrame:sr,entryFrame:sr,durationFrames:d,gapFrames:0,swapFrame:sr,tempoB:[[0,1]],
    vocalA:[[0,1],[Math.round(sr*.4),0],[d,0]],vocalB:[[0,0],[Math.round(sr*.5),0],[sr,1]],
    lanes:[{deck:'A',lane:0,points:[[0,1],[d,0]]},{deck:'B',lane:0,points:[[0,0],[d,1]]},{deck:'A',lane:4,points:[[0,.2],[d,.2]]}],echoDelayFrames:Math.round(sr*.25),echoFeedback:.4};
  if(kind==='lift')tr.vocalB=[[0,2],[sr,1],[d,1]];
  if(['throw','clear','force','force-no-stem','disable-active','seek','stop','reload'].includes(kind)) {
    tr.lanes.push({deck:'A',lane:5,points:[[0,.4],[Math.round(sr*.4),0]]});tr.voiceEchoDelayFrames=Math.round(sr*.25);tr.voiceEchoFeedback=.4;
  }
  if(kind==='clear')tr.voiceEchoClearFrame=Math.round(sr*.6);
  if(kind==='tempo'){tr.tempoA=[[0,1.04],[d,1]];tr.tempoB=[[0,.95],[d,1]];}
  if(kind==='loop')tr.loopA={start:sr,end:sr*2,until:sr*4,fade:Math.round(sr*.005)};
  ops.push({cmd:'arm',transition:tr});
  const render=(s:number)=>ops.push({cmd:'render',frames:Math.round(sr*s/128)*128});
  if(kind==='disable-before')ops.push({cmd:'disableVocals',deck:0,token:'T0'});
  if(kind==='reset') {render(.25);ops.push({cmd:'resetVocals',deck:1,token:'T1'});}
  if(kind==='unready') {render(.5);ops.push(...late);}
  if(kind==='late') {render(1.5);ops.push(...late);}
  if(['disable-active','disable-b','force','force-no-stem','reset-active','seek','stop','reload'].includes(kind)) {
    render(1.4);
    if(kind==='disable-active')ops.push({cmd:'disableVocals',deck:0,token:'T0'});
    if(kind==='disable-b')ops.push({cmd:'disableVocals',deck:1,token:'T1'});
    if(kind==='force'||kind==='force-no-stem') {
      if(kind==='force-no-stem')ops.push({cmd:'disableVocals',deck:0,token:'T0'});
      ops.push({cmd:'finish',fade:.4});
    }
    if(kind==='reset-active')ops.push({cmd:'resetVocals',deck:0,token:'T0'});
    if(kind==='seek')ops.push({cmd:'seek',token:'T0',frame:sr*4});
    if(kind==='stop')ops.push({cmd:'stop'});
    if(kind==='reload')ops.push({cmd:'load',deck:0,token:'reloaded',totalFrames:sr,gainDb:0,cueFrame:0});
  }
  if(kind==='playback')ops.push({cmd:'playback',settings:{speed:1.08,semitones:2}});
  render(5);ops.push({cmd:'stop'});render(.05);return ops;
}
function reference(ops:Op[],sr:number) {
  const events:any[]=[],core=new MixerCore(sr,e=>events.push(e)),buffers:Buffer[]=[];
  for(const o of ops) {
    if(o.cmd==='render') {for(let at=0;at<o.frames;at+=128){const n=Math.min(128,o.frames-at),l=new Float32Array(n),r=new Float32Array(n);core.process(l,r,n);const b=Buffer.alloc(n*8);for(let i=0;i<n;i++){b.writeFloatLE(l[i],i*8);b.writeFloatLE(r[i],i*8+4);}buffers.push(b);}}
    else if(o.cmd==='load')core.load(o.deck,o.token,o.totalFrames,o.gainDb,o.cueFrame);
    else if(o.cmd==='feed')core.feed(o.deck,o.token,o.chunk,decode(o.L),decode(o.R));
    else if(o.cmd==='feedVocal')core.feedVocal(o.deck,o.token,o.chunk,decode(o.L),decode(o.R));
    else if(o.cmd==='start')core.start(o.deck,o.token,o.frame);
    else if(o.cmd==='arm')core.arm(o.transition);
    else if(o.cmd==='disableVocals')core.disableVocals(o.deck,o.token);
    else if(o.cmd==='resetVocals')events.push({type:'vocalsReset',deck:o.deck,token:o.token,applied:core.resetVocals(o.deck,o.token)});
    else if(o.cmd==='finish')core.finishTransitionNow(o.fade);
    else if(o.cmd==='seek')core.seek(o.token,o.frame);
    else if(o.cmd==='stop')core.stopAll();
    else if(o.cmd==='playback')core.setPlayback(o.settings);
    else throw Error(o.cmd);
  }return {pcm:Buffer.concat(buffers),events};
}
function compare(a:any,e:any,at='event'):void {
  if(typeof e==='number'){assert.ok(Number.isFinite(a)&&Math.abs(a-e)<=2e-5,`${at}: ${a} != ${e}`);return;}
  if(e&&typeof e==='object'){assert.ok(a&&typeof a==='object',at);const keys=Object.keys(e).filter(k=>e[k]!==undefined);assert.deepEqual(Object.keys(a).sort(),keys.sort(),at);for(const k of keys)compare(a[k],e[k],`${at}.${k}`);}
  else assert.equal(a,e,at);
}
assert.throws(()=>compare(.1,0));
const results:any[]=[];
for(const sr of [44100,48000])for(const kind of kinds) {
  if(process.argv.some(a=>a.startsWith('--only='))&&!process.argv.find(a=>a.startsWith('--only='))!.slice(7).split(',').includes(kind))continue;
  const name=`${sr}-${kind}`,ops=fixture(sr,kind),input=path.join(out,`${name}.json`),pcm=path.join(out,`${name}.f32`),report=path.join(out,`${name}-rust.json`);
  fs.writeFileSync(input,JSON.stringify({sampleRate:sr,ops}));const ref=reference(ops,sr);
  const child=spawnSync(exe,['--offline',input,pcm,report],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  assert.equal(child.status,0,`${name}: ${child.error??child.stdout+child.stderr}`);
  const actual=fs.readFileSync(pcm),rust=JSON.parse(fs.readFileSync(report,'utf8'));assert.equal(actual.length,ref.pcm.length);
  let maxError=0,peak=0;for(let at=0;at<actual.length;at+=4){const a=actual.readFloatLE(at),e=ref.pcm.readFloatLE(at);if(!Number.isFinite(a)||Math.abs(a-e)>2e-5)assert.fail(`${name} sample ${at/4}: ${a} != ${e}, delta ${Math.abs(a-e)}`);maxError=Math.max(maxError,Math.abs(a-e));peak=Math.max(peak,Math.abs(a));}
  assert.ok(peak>.01&&peak<=1,`${name}: silence/clipping`);compare(rust.events.filter((e:any)=>e.type!=='need'),ref.events.filter(e=>e.type!=='need'));
  if(['mask','lift','throw','clear','tempo','loop','playback'].includes(kind))assert.ok(rust.events.some((e:any)=>e.type==='transitionEnd'));
  results.push({name,maxError,peak,events:rust.events.filter((e:any)=>!['need','tick'].includes(e.type))});console.log(`${name}: parity OK, max error ${maxError}`);
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({date:new Date().toISOString(),tolerance:2e-5,results},null,2));
