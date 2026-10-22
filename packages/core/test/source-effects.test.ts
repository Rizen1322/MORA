import { expect,it } from 'vitest';
import { LoopPcmSource } from '../src/engine/loop.ts';
import { planToArmed,renderTransitionOffline } from '../src/engine/arm.ts';
import { planTransition,skipPlanFrom } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S,type TrackAnalysis,type TransitionPlan } from '../src/types.ts';
import { withVoiceAnswer } from '../src/plan/answer.ts';
import { withHarmonicHandoff } from '../src/plan/harmonic.ts';
import { pointValue } from '../src/plan/timing.ts';

function source(sr:number){
  const values=Float32Array.from({length:sr*12},(_,i)=>.2*Math.sin(2*Math.PI*100*i/sr));
  return {values,wrapped:new LoopPcmSource({totalFrames:values.length,read(start,len,L,R,offset){
    for(let i=0;i<len;i++)L[offset+i]=R[offset+i]=values[start+i]??0;return true;
  }},sr)};
}
function base():TransitionPlan {
  const t={id:'a',duration:20,analysis:null,mixingAllowed:true};
  return {...planTransition(t,{...t,id:'b'},S),method:'crossfade',aExit:2,bEntry:0,duration:8,swapAt:4,
    gainA:0,gainB:0,tempoB:[[0,1]],tempoA:undefined,debug:{processingAllowed:true},
    automation:[{deck:'A',lane:'gain',points:[[0,1],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[8,1]]},
      {deck:'A',lane:'mid',points:[[0,1],[8,1]]},{deck:'B',lane:'mid',points:[[0,1],[8,1]]}]};
}
function analysis(voiceAt:number):TrackAnalysis {
  return {duration:20,audibleStart:0,audibleEnd:20,key:{confidence:.9},beat:{period:.5},curves:{rate:10,
    rmsDb:Array(200).fill(-16),midDb:Array(200).fill(-20)},vocalActivity:{rate:10,values:Array.from({length:200},(_,i)=>i/10>=voiceAt?.8:0)}} as unknown as TrackAnalysis;
}
it('finite roll shortens at complete cycles and is independent of render block sizes at device rates',()=>{
  for(const sr of [32000,44100,48000,96000]){
    const {wrapped}=source(sr),start=sr*2,length=sr;
    expect(wrapped.setLoop({start,end:start+length,until:start+length*3,fade:Math.round(sr*.006),
      roll:[{at:start+length,length:length/2},{at:start+length*1.5,length:length/4}]})).toBe(true);
    const L=new Float32Array(sr*4),R=L.slice(),split=L.slice();
    wrapped.read(start,L.length,L,R,0);
    for(let i=0;i<split.length;i+=127)wrapped.read(start+i,Math.min(127,split.length-i),split,R,i);
    expect(split).toEqual(L);expect(L.subarray(sr*3).every(x=>x===0)).toBe(true);
    expect(wrapped.setLoop({start,end:start+length,until:start+length*3,fade:100,roll:[{at:start+length+.1,length:length/2}]})).toBe(false);
  }
});
it('tape stop resamples pitch and stops finitely without resuming voice or depending on block boundaries',()=>{
  for(const sr of [32000,44100,48000,96000]){
    const {wrapped,values}=source(sr),start=sr*2,end=start+sr;
    expect(wrapped.setTapeStop({start,end,fade:Math.round(sr*.025)})).toBe(true);
    const L=new Float32Array(sr+100),R=L.slice(),split=L.slice();wrapped.read(start,L.length,L,R,0);
    for(let i=0;i<split.length;i+=137)wrapped.read(start+i,Math.min(137,split.length-i),split,R,i);
    expect(split).toEqual(L);expect(L.subarray(sr).every(x=>x===0)).toBe(true);
    const u=Math.round(sr*.5),mapped=start+u-u*u/(2*sr),at=Math.floor(mapped),f=mapped-at;
    expect(L[u]).toBeCloseTo(values[at]*(1-f)+values[at+1]*f,6);
    wrapped.setLoop(null);wrapped.read(start,128,L,R,0);expect(L.subarray(0,128)).toEqual(values.subarray(start,start+128));
    expect(wrapped.setTapeStop({start,end:start+sr*2,fade:10})).toBe(false);
  }
});
it('renders tape through the existing mixer at speed/pitch settings and strips it on manual Next',()=>{
  const sr=8000,{values}=source(sr),p={...base(),tapeStopA:{start:3,end:3.75,crossfade:.025}};
  for(const playback of [{speed:1,semitones:0},{speed:1.2,semitones:0},{speed:1,semitones:3}]){
    const pcm={L:values,R:values,sampleRate:sr};
    const out=renderTransitionOffline(pcm,pcm,p,.5,.5,playback);
    expect(out.metrics.underruns).toBe(0);expect(out.L.every(Number.isFinite)).toBe(true);
    expect(out.events.filter(e=>e.type==='transitionEnd')).toHaveLength(1);
  }
  expect(skipPlanFrom(p,4).tapeStopA).toBeUndefined();
});
it('voice answer uses an acoustic deadline even with B mask already open; refuses unknown voice',()=>{
  const p={...base(),vocalA:[[0,1],[1,1],[2,0],[8,0]] as [number,number][],vocalB:[[0,1]] as [number,number][]};
  const A=analysis(0),B=analysis(6),out=withVoiceAnswer(p,A,B,S);
  expect(out.voiceEcho?.clearAt).toBeCloseTo(5.85);
  expect(planToArmed(out,48000,'a','b').voiceEchoClearFrame).toBe(280800);
  expect(out.bEntry).toBe(p.bEntry);expect(out.vocalB).toEqual(p.vocalB);
  expect(withVoiceAnswer(p,A,{...B,vocalActivity:undefined},S)).toBe(p);
  expect(withVoiceAnswer(p,A,B,S,1)).toBe(p);
});
it('harmonic relief preserves incoming lanes and limits added attenuation to one dB',()=>{
  const p={...base(),keyInfo:{a:'1A',b:'7B',compatibility:0,label:'clash'}},A=analysis(0),B=analysis(0);
  const out=withHarmonicHandoff(p,A,B,S),mid=out.automation.find(l=>l.deck==='A'&&l.lane==='mid')!;
  expect(out.debug.harmonicHandoff).toBeDefined();
  expect(pointValue(mid.points,4)).toBeGreaterThanOrEqual(10**(-1/20));
  expect(out.automation.filter(l=>l.deck==='B')).toEqual(p.automation.filter(l=>l.deck==='B'));
  expect(withHarmonicHandoff(p,{...A,key:{...A.key,confidence:.2}},B,S)).toBe(p);
});
it('renders an audible vocal answer that is silent before B first words with an already-open B mask',()=>{
  const sr=8000,{values}=source(sr),silence=new Float32Array(values.length);
  const p={...base(),vocalA:[[0,1],[1,1],[2,0],[8,0]] as [number,number][],vocalB:[[0,1]] as [number,number][]};
  const out=withVoiceAnswer(p,analysis(0),analysis(6),S);
  const a={L:values,R:values,sampleRate:sr,vocals:{L:values,R:values}};
  const b={L:silence,R:silence,sampleRate:sr,vocals:{L:silence,R:silence}};
  const wet=renderTransitionOffline(a,b,out,.5,.5),dry=renderTransitionOffline(a,b,p,.5,.5);
  let early=0,late=0;
  for(let i=Math.round(sr*3);i<Math.round(sr*4);i++)early=Math.max(early,Math.abs(wet.L[i]-dry.L[i]));
  for(let i=Math.round(sr*6.5);i<Math.round(sr*8.5);i++)late=Math.max(late,Math.abs(wet.L[i]-dry.L[i]));
  expect(early).toBeGreaterThan(.001);expect(late).toBeLessThan(.0001);
  expect(wet.metrics.underruns).toBe(0);
});
