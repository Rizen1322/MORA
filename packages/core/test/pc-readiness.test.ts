import { describe, expect, it } from 'vitest';
import { withMasterTempo } from '../src/plan/master-tempo.ts';
import { applyVocalHandoff } from '../src/plan/vocals.ts';
import { integrateTempo, pointValue } from '../src/plan/timing.ts';
import { planTransition } from '../src/plan/planner.ts';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { MixerCore, type MixerEvent } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

function analysis(bpm: number, voice: (t: number) => number): TrackAnalysis {
  const duration=180, period=60/bpm, beats=Array.from({length:Math.ceil(duration/period)},(_,i)=>i*period).filter(t=>t<duration);
  const c=Array.from({length:duration*20},()=>-18),downbeats=beats.filter((_,i)=>i%4===0);
  return { version:'pc-fixture',duration,audibleStart:0,audibleEnd:duration,
    loudness:{integratedLufs:-16,samplePeakDb:-4,truePeakDb:-3},
    beat:{bpm,period,confidence:.95,stable:true,jitterMs:2,beats,downbeats,downbeatConfidence:.9,downbeatPhase:0,alternatives:[]},
    rhythmStrength:.9,key:{tonic:-1,mode:'unknown',name:'unknown',camelot:'',confidence:0},
    phrases:downbeats.filter((_,i)=>i%8===0),phraseConfidence:.8,sectionBoundaries:[],intro:{start:0,end:0},outro:{start:160,end:180},bodyRmsDb:-18,
    curves:{rate:20,rmsDb:c,lowDb:c.map(x=>x-3),midDb:c.map(x=>x-6),highDb:c.map(x=>x-10),midDensity:c.map(()=>.2)},peaks:c.map(()=>.8),
    cues:{entry:[{time:0,score:.9,kind:'start',tags:[]}],exit:downbeats.filter(t=>t>140).map(time=>({time,score:.8,kind:'downbeat',tags:[]}))},
    features:{energy:.6,brightness:.5,rhythmStrength:.9,onsetRate:.4,bassWeight:.6,midDensity:.2,dynamics:.2,acousticness:.1},
    vocalActivity:{rate:10,values:Array.from({length:duration*10},(_,i)=>voice(i/10)),source:'demucs',model:'fixture'},warnings:[],elapsedMs:0 };
}
function plan(ratio=120/123):TransitionPlan {
  return { id:'pc',version:'test',fromTrackId:'a',toTrackId:'b',method:'beatmatch_blend',confidence:.9,reasons:[],debug:{processingAllowed:true},
    aExit:100,bEntry:0,duration:8,gap:0,swapAt:4,tempoA:[[0,1],[8,1/ratio]],tempoB:[[0,ratio],[8,1]],gainA:0,gainB:0,
    beatAlign:{bpmA:120,bpmB:120/ratio,relation:1,ratio,stretchPercent:2.5,overlapBeats:16,phraseAligned:true,glide:true},
    automation:[{deck:'A',lane:'gain',points:[[0,1],[6,1],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[2,1],[8,1]]}] };
}

describe('vocal master tempo',()=>{
  it.each([120/123,123/120])('keeps source endpoints and both grids locked at ratio %f',ratio=>{
    const A=analysis(120,()=>.85),B=analysis(120/ratio,t=>t<12?.01:.8),original=plan(ratio);
    const p=withMasterTempo(original,A,B,S);
    expect(p.beatAlign?.masterDeck).toBe('A'); expect(p.tempoA).toBeUndefined();
    expect(p.duration).toBeCloseTo(integrateTempo(original.tempoA,original.duration),3);
    expect(integrateTempo(p.tempoB,p.duration)).toBeCloseTo(integrateTempo(original.tempoB,original.duration),3);
    expect(p.swapAt).toBeCloseTo(integrateTempo(original.tempoA,original.swapAt),3);
    for(let t=0;t<=p.duration;t+=.13)expect(pointValue(p.tempoB,t)/pointValue(p.tempoA??[[0,1]],t)).toBeCloseTo(ratio,6);
    expect(pointValue(p.tempoB,p.duration)).toBeCloseTo(ratio,6);
    expect(p.tempoB.at(-1)![0]).toBeGreaterThan(p.duration);
    expect(p.tempoB.at(-1)![1]).toBe(1);
    expect(original.tempoA).toBeDefined();
  });
  it('keeps the old strategy when the evidence or limits do not allow a master',()=>{
    const A=analysis(120,()=>.85),B=analysis(123,t=>t<12?.01:.8),p=plan();
    const cases: [TrackAnalysis,TrackAnalysis,typeof S,number|undefined][] = [
      [A,B,{...S,masterTempo:false},undefined], [A,B,S,100],
      [A,analysis(123,()=>.8),S,undefined], [analysis(120,()=>.01),B,S,undefined],
      [A,B,{...S,maxStretchPercent:1},undefined], [A,B,{...S,maxBlendSeconds:8},undefined],
      [{...A,beat:{...A.beat!,stable:false}},B,S,undefined],
      [A,{...B,vocalActivity:undefined},S,undefined],
      [A,{...B,vocalActivity:{...B.vocalActivity!,values:[.01]}},S,undefined],
    ];
    for(const [a,b,s,requested] of cases)expect(withMasterTempo(p,a,b,s,requested)).toBe(p);
    expect(withMasterTempo(plan(120/128),A,B,S).beatAlign?.masterDeck).toBeUndefined();
    const local={...p,beatAlign:{...p.beatAlign!,regions:{A:{start:90,end:120,period:.49,downbeat:90}}}};
    expect(withMasterTempo(local,A,B,S)).toBe(local);
  });
  it('is selected by the real planner, and completes recovery through the shared mixer',()=>{
    const A=analysis(120,()=>.85),B=analysis(123,t=>t<40?.01:.85);
    const p=planTransition({id:'a',duration:180,mixingAllowed:true,analysis:A},{id:'b',duration:180,mixingAllowed:true,analysis:B},S);
    expect(p.beatAlign?.masterDeck).toBe('A');
    const sr=8000,base=withMasterTempo(plan(),A,B,S),local={...base,aExit:1},events:MixerEvent[]=[];
    const m=new MixerCore(sr,e=>events.push(e)),audio=Float32Array.from({length:sr*30},(_,i)=>.15*Math.sin(i*.3));
    for(const [d,t] of [[0,'A'],[1,'B']] as const){m.load(d,t,audio.length,0);for(let c=0;c*CHUNK_FRAMES<audio.length;c++){const x=audio.slice(c*CHUNK_FRAMES,(c+1)*CHUNK_FRAMES);m.feed(d,t,c,x,x);}}
    m.start(0,'A',sr);m.arm(planToArmed(local,sr,'A','B'));
    const l=new Float32Array(128),r=l.slice(); let lastPosition=0;
    for(let i=0;i<Math.ceil((local.duration+6)*sr/128);i++){m.process(l,r,128);expect(l.every(Number.isFinite)).toBe(true);}
    const ticks=events.filter((e):e is Extract<MixerEvent,{type:'tick'}>=>e.type==='tick');
    expect(events.filter(e=>e.type==='transitionEnd')).toHaveLength(1); expect(events.filter(e=>e.type==='underrun')).toHaveLength(0);
    // Recovery survives transitionEnd; test its final source position against integration.
    const tick=ticks.at(-1)!; const b=tick.decks.find(d=>d.token==='B')!;
    lastPosition=integrateTempo(local.tempoB,tick.clock/sr);
    expect(b.position/sr).toBeCloseTo(lastPosition,1);
  });
});

describe('partial vocal preparation',()=>{
  it('uses an outgoing quiet breath while preserving every incoming sample',()=>{
    const A=analysis(120,()=>.01),B={...analysis(120,()=>.8),vocalActivity:undefined};
    const p={...plan(1),aExit:1,tempoA:undefined,tempoB:[[0,1]] as [number,number][]};
    const next=applyVocalHandoff(p,A,B,S);
    expect((next.debug.stems as {policy:string}).policy).toBe('one-sided-a-1');
    expect(next.vocalA?.at(-1)?.[1]).toBe(0);expect(next.vocalB).toBeUndefined();
    expect(next.bEntry).toBe(p.bEntry);expect(next.tempoB).toEqual(p.tempoB);
    const noBreath=applyVocalHandoff(p,analysis(120,()=>.85),B,S);expect(noBreath).toBe(p);
  });
  it('fades the whole unknown outgoing recording before a measured incoming attack, without a B mask',()=>{
    const A={...analysis(120,()=>.8),vocalActivity:undefined},B=analysis(120,t=>t<3?.01:.85);
    const p={...plan(1),aExit:1,tempoA:undefined,tempoB:[[0,1]] as [number,number][]};
    const next=applyVocalHandoff(p,A,B,S),st=next.debug.stems as {policy:string;bVoiceStart:number;vocalHandoff:number};
    expect(st.policy).toBe('one-sided-b-2');expect(st.vocalHandoff).toBeLessThan(st.bVoiceStart);
    expect(next.vocalB).toBeUndefined();expect(next.vocalA).toBeUndefined();
    expect(pointValue(next.automation.find(l=>l.deck==='A'&&l.lane==='gain')!.points,st.bVoiceStart)).toBe(0);
    const sr=8000,empty=new Float32Array(sr*18),voice=Float32Array.from(empty,(_,i)=>i>=sr*3?.12*Math.sin(i*.4):0);
    const reference={...p,automation:[{deck:'A' as const,lane:'gain' as const,points:[[0,0]] as [number,number][]},...p.automation.filter(l=>l.deck==='B')]};
    const a={L:empty,R:empty,sampleRate:sr},b={L:voice,R:voice,sampleRate:sr};
    const rendered=renderTransitionOffline(a,b,next,0,1),original=renderTransitionOffline(a,b,reference,0,1);
    expect(rendered.metrics.underruns).toBe(0);expect(rendered.L).toEqual(original.L);
  });
  it('falls back with singing from the start, missing coverage, disabled processing or missing both maps',()=>{
    const A={...analysis(120,()=>.8),vocalActivity:undefined},B=analysis(120,()=>.8),p=plan(1);
    expect(applyVocalHandoff(p,A,B,S)).toBe(p);
    expect(applyVocalHandoff(p,A,{...B,vocalActivity:{...B.vocalActivity!,values:[.01]}},S)).toBe(p);
    expect(applyVocalHandoff(p,A,{...B,vocalActivity:undefined},S)).toBe(p);
    expect(applyVocalHandoff(p,A,analysis(120,t=>t<3?.01:.8),{...S,stemMixing:false})).toBe(p);
  });
  it('completes the incoming fader and bass when the unknown outgoing deck leaves early',()=>{
    const A={...analysis(120,()=>.8),vocalActivity:undefined},B=analysis(120,t=>t<3?.01:.85);
    const p={...plan(1),tempoA:undefined,tempoB:[[0,1]] as [number,number][],automation:[
      {deck:'A' as const,lane:'gain' as const,points:[[0,1],[6,1],[8,0]] as [number,number][]},
      {deck:'B' as const,lane:'gain' as const,points:[[0,0],[8,1]] as [number,number][]},
      {deck:'B' as const,lane:'low' as const,points:[[0,0],[5,0],[6,1],[8,1]] as [number,number][]},
      {deck:'B' as const,lane:'mid' as const,points:[[0,.4],[5,.4],[8,1]] as [number,number][]},
      {deck:'B' as const,lane:'high' as const,points:[[0,.3],[5,.3],[8,1]] as [number,number][]},
    ]};
    const q=applyVocalHandoff(p,A,B,S),handoff=(q.debug.stems as {vocalHandoff:number}).vocalHandoff;
    const at=(name:'gain'|'low',t:number)=>pointValue(q.automation.find(l=>l.deck==='B'&&l.lane===name)!.points,t);
    expect(at('gain',handoff)).toBe(1);expect(at('low',handoff)).toBe(1);
    expect(at('gain',0)).toBe(0);expect(at('low',0)).toBe(0);
    for(let t=handoff;t<=q.duration;t+=.1){expect(at('gain',t)).toBe(1);expect(at('low',t)).toBe(1);}
    expect(q.bEntry).toBe(p.bEntry);expect(q.tempoB).toEqual(p.tempoB);expect(q.vocalB).toBeUndefined();
    for(const band of ['mid','high'] as const)expect(pointValue(q.automation.find(l=>l.deck==='B'&&l.lane===band)!.points,handoff)).toBe(1);
    const sr=8000,silence=new Float32Array(sr*18),bass=Float32Array.from(silence,(_,i)=>.12*Math.sin(2*Math.PI*80*i/sr));
    const a={L:silence,R:silence,sampleRate:sr},b={L:bass,R:bass,sampleRate:sr};
    const next=renderTransitionOffline(a,b,{...q,aExit:1},0,1),old=renderTransitionOffline(a,b,{...p,aExit:1},0,1);
    const rms=(x:Float32Array)=>Math.sqrt(x.slice(sr*3.5,sr*4.5).reduce((sum,v)=>sum+v*v,0)/sr);
    expect(rms(next.L)).toBeGreaterThan(rms(old.L)*2);
    expect(next.metrics.underruns).toBe(0);expect(next.metrics.peak).toBeLessThan(.2);
  });
  it('does not bring the unknown outgoing voice back through the pre-fader echo send',()=>{
    const A={...analysis(120,()=>.8),vocalActivity:undefined},B=analysis(120,t=>t<3?.01:.85);
    const p={...plan(1),aExit:1,tempoA:undefined,tempoB:[[0,1]] as [number,number][],echo:{delay:.4,feedback:.5},
      automation:[...plan(1).automation,{deck:'A' as const,lane:'echo' as const,points:[[0,0],[3,0],[3.1,.7],[8,.7]] as [number,number][]}]};
    const q=applyVocalHandoff(p,A,B,S);
    expect(q.automation.some(l=>l.deck==='A'&&l.lane==='echo')).toBe(false);expect(q.echo).toBeUndefined();
    const sr=8000,silence=new Float32Array(sr*18),voice=Float32Array.from(silence,(_,i)=>.15*Math.sin(2*Math.PI*660*i/sr));
    const a={L:voice,R:voice,sampleRate:sr},b={L:silence,R:silence,sampleRate:sr};
    const rendered=renderTransitionOffline(a,b,q,0,1);
    expect(rendered.metrics.underruns).toBe(0);
    expect(Math.max(...rendered.L.slice(sr*4,sr*5).map(Math.abs))).toBeLessThan(1e-7);
  });
});
