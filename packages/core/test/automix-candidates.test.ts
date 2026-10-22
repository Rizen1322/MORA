import { expect,it } from 'vitest';
import { firstVoice,preserveFirstWords,fallbackWithoutVocalStems,withVocalGap } from '../src/plan/first-words.ts';
import { planRequestedTransition,planSkip,planTransition } from '../src/plan/planner.ts';
import { integrateTempo,pointValue } from '../src/plan/timing.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { applyVocalHandoff,lyricTiming,splitsWord,VERIFIED_TIMING } from '../src/plan/vocals.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S,type PlannerTrack,type TrackAnalysis,type TransitionPlan } from '../src/types.ts';

function analysis(bpm=120,voice:(t:number)=>number=()=>.85,duration=40):TrackAnalysis {
  const rate=20,period=60/bpm,beats=Array.from({length:Math.ceil(duration/period)},(_,i)=>i*period).filter(t=>t<duration);
  const c=Array.from({length:duration*rate},()=>-18),downbeats=beats.filter((_,i)=>i%4===0);
  return {version:'p1',duration,audibleStart:0,audibleEnd:duration,bodyRmsDb:-18,
    loudness:{integratedLufs:-16,samplePeakDb:-5,truePeakDb:-4},
    beat:{bpm,period,confidence:.95,stable:true,jitterMs:2,beats,downbeats,downbeatConfidence:.9,downbeatPhase:0,alternatives:[]},
    rhythmStrength:.9,key:{tonic:-1,mode:'unknown',name:'unknown',camelot:'',confidence:0},
    phrases:downbeats.filter((_,i)=>i%4===0),phraseConfidence:.9,sectionBoundaries:[],intro:{start:0,end:0},outro:{start:36,end:40},
    curves:{rate,rmsDb:c,lowDb:c.map(x=>x-3),midDb:c.map(x=>x-6),highDb:c.map(x=>x-10),midDensity:c.map(()=>.2)},peaks:c.map(()=>.8),
    cues:{entry:[{time:0,score:.9,kind:'start',tags:[]}],exit:downbeats.filter(t=>t>20).map(time=>({time,score:.8,kind:'downbeat',tags:[]}))},
    features:{energy:.6,brightness:.5,rhythmStrength:.9,onsetRate:.4,bassWeight:.6,midDensity:.2,dynamics:.2,acousticness:.1},
    vocalActivity:{rate:100,values:Array.from({length:duration*100},(_,i)=>voice(i/100)),source:'demucs',model:'test'},warnings:[],elapsedMs:0};
}
function plan():TransitionPlan {
  return {id:'p1',version:'test',fromTrackId:'a',toTrackId:'b',method:'crossfade',confidence:.8,reasons:[],debug:{processingAllowed:true,stems:{vocalHandoff:4}},
    aExit:0,bEntry:0,duration:8,gap:0,swapAt:4,tempoB:[[0,1]],gainA:0,gainB:0,
    vocalA:[[0,1],[3.9,1],[4,0],[8,0]],vocalB:[[0,0],[4,0],[4.12,1],[8,1]],echo:{delay:.4,feedback:.5},
    automation:[{deck:'A',lane:'gain',points:[[0,1],[6,1],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[4,1],[8,1]]},
      {deck:'B',lane:'low',points:[[0,0],[4,0],[5,1],[8,1]]},{deck:'B',lane:'mid',points:[[0,.3],[4,.3],[6,1]]},
      {deck:'B',lane:'filter',points:[[0,-.5],[4,-.5],[5,0]]},{deck:'A',lane:'echo',points:[[0,0],[4,.7],[8,.7]]}]};
}
const track=(id:string,a:TrackAnalysis):PlannerTrack=>({id,duration:a.duration,mixingAllowed:true,analysis:a});
const at=(p:TransitionPlan,d:'A'|'B',l:'gain'|'low'|'mid'|'filter',t:number)=>pointValue(p.automation.find(x=>x.deck===d&&x.lane===l)?.points??[[0,l==='filter'?0:1]],t);

it.each([0,.06,.8,2])('preserves the first B attack at %f s, including rap/legato and a short pickup',attack=>{
  const p=plan(),q=preserveFirstWords(p,analysis(),analysis(120,t=>t<attack?.01:.85),S);
  expect(q.bEntry).toBe(p.bEntry);expect(q.tempoB).toEqual(p.tempoB);
  if(attack===0){expect(at(q,'B','gain',.012)).toBeLessThan(1);expect(at(q,'B','gain',.3)).toBe(1);}
  for(let t=Math.max(.012,attack);t<q.duration;t+=.017){
    expect(pointValue(q.vocalB??[[0,1]],t)).toBe(1);if(attack!==0||t>=.3)expect(at(q,'B','gain',t)).toBe(1);expect(at(q,'B','filter',t)).toBe(0);
  }
  expect(q.vocalA).toBeUndefined();expect(q.echo).toBeUndefined();
  expect(at(q,'A','gain',attack===0?.3:Math.max(.04,attack))).toBe(0);
});
it('keeps instrumental-intro plans and the bass handoff when the outgoing accompaniment is measured quiet',()=>{
  const p=plan(),A=analysis(120,()=>.01),B=analysis(120,t=>t<20?.01:.8);
  expect(preserveFirstWords(p,A,B,S)).toBe(p);
  B.vocalActivity!.values.fill(.85);const q=preserveFirstWords(p,A,B,S);
  expect(q.automation.find(l=>l.deck==='B'&&l.lane==='low')).toEqual(p.automation.find(l=>l.deck==='B'&&l.lane==='low'));
});
it('does not open B bass before the actual whole-deck A fade starts',()=>{
  const q=preserveFirstWords(plan(),analysis(),analysis(120,t=>t<2?.01:.85),S);
  expect(at(q,'A','gain',1)).toBe(1);expect(at(q,'B','gain',1)).toBeGreaterThan(0);
  expect(at(q,'B','low',1)).toBe(0);expect(at(q,'B','low',2)).toBe(1);
});
it('keeps the existing delayed gain floor when the first attack has several seconds of lead',()=>{
  const p={...plan(),automation:plan().automation.map(l=>l.deck==='B'&&l.lane==='gain'?{...l,points:[[0,0],[8,0]] as [number,number][]}:l)};
  const q=preserveFirstWords(p,analysis(),analysis(120,t=>t<6?.01:.85),S);
  expect((q.debug.firstWords as {attack:number}).attack).toBeCloseTo(6,1);
  expect(at(q,'B','gain',3)).toBe(0);expect(at(q,'B','gain',5.8)).toBeGreaterThan(.9);
});
it('keeps intentional EQ and later DJ phrasing when the incoming words are already open',()=>{
  const p={...plan(),vocalB:undefined,debug:{djFilterRelease:{arrival:6}},automation:plan().automation.map(l=>l.deck==='B'&&['gain','mid'].includes(l.lane)
    ?{...l,points:[[0,l.lane==='gain'?1:.7]] as [number,number][]}:l).filter(l=>!(l.deck==='B'&&l.lane==='filter'))};
  expect(preserveFirstWords(p,analysis(),analysis(),S)).toBe(p);
  const muted={...p,automation:[...p.automation.filter(l=>!(l.deck==='B'&&l.lane==='mid')),
    {deck:'B' as const,lane:'mid' as const,points:[[0,.08]] as [number,number][]},
    {deck:'B' as const,lane:'high' as const,points:[[0,.12]] as [number,number][]}]};
  const q=preserveFirstWords(muted,analysis(),analysis(),S);
  expect(at(q,'B','mid',.012)).toBe(1);expect(q.debug.firstWords).toBeDefined();
});
it('treats invalid/truncated measurements as unknown rather than an empty vocal window',()=>{
  const A=analysis(),B=analysis(),p=plan();
  expect(firstVoice(B,NaN,2)).toBeNull();expect(firstVoice(B,0,Infinity)).toBeNull();expect(firstVoice(B,0,41)).toBeNull();
  for(const bad of [{...B,vocalActivity:undefined},{...B,vocalActivity:{...B.vocalActivity!,values:[.01]}},
    {...B,vocalActivity:{...B.vocalActivity!,rate:NaN}},{...B,vocalActivity:{...B.vocalActivity!,values:B.vocalActivity!.values.map((v,i)=>i===1?NaN:v)}}])
    expect(preserveFirstWords(p,A,bad,S)).toBe(p);
  expect(preserveFirstWords(p,A,B,{...S,stemMixing:false})).toBe(p);
  expect(preserveFirstWords({...p,method:'gapless'},A,B,S).debug.firstWords).toBeUndefined();
});
it('maps a nonnative B attack to output time and keeps its recovery after the overlap',()=>{
  const p={...plan(),bEntry:2,tempoB:[[0,.94],[8,.98],[12,1]] as [number,number][]};
  const q=preserveFirstWords(p,analysis(),analysis(120,t=>t<4?.01:.85),S);
  const attack=(q.debug.firstWords as {attack:number}).attack;
  expect(p.bEntry+integrateTempo(q.tempoB,attack)).toBeCloseTo(4,3);expect(q.tempoB).toEqual(p.tempoB);
  expect(pointValue(q.vocalB??[[0,1]],attack)).toBe(1);
});
it.each([1.5,2])('finishes the entire outgoing fade in an earlier verified pause before B at %f s',attack=>{
  const A=analysis(120,t=>t<1.3||t>=1.55?.85:.01),B=analysis(120,t=>t<attack?.01:.85);
  const words:[[number,number],...[number,number][]]=[[0,1.3],...Array.from({length:15},(_,i)=>[1.55+i*2,3.3+i*2] as [number,number])];
  A.vocalActivity!.lyrics={version:'test',language:null,confidence:.95,words,lines:words,timing:VERIFIED_TIMING,voiced:words};
  const q=preserveFirstWords(plan(),A,B,S),end=(q.debug.stems as {vocalHandoff:number}).vocalHandoff;
  const gain=q.automation.find(l=>l.deck==='A'&&l.lane==='gain')!.points;
  const start=gain.find(([t,g],i)=>g===1&&gain[i+1]?.[1]<1)![0];
  expect(start).toBeGreaterThanOrEqual(1.3);expect(end).toBeLessThanOrEqual(1.55);expect(end).toBeLessThan(attack);
  expect(splitsWord(lyricTiming(A)!,start,end)).toBe(false);expect(at(q,'A','gain',end)).toBe(0);
  expect(pointValue(q.vocalB??[[0,1]],attack)).toBe(1);
});
it('never routes two present but incomplete vocal maps through the dual-vocal optimizer',()=>{
  const p={...plan(),vocalA:undefined,vocalB:undefined},A=analysis(),B=analysis();
  A.vocalActivity!.values=[.85];B.vocalActivity!.values=[.85];
  expect(applyVocalHandoff(p,A,B,S)).toBe(p);
  const q=applyVocalHandoff(plan(),A,B,S);
  expect(q.vocalA).toBeUndefined();expect(q.vocalB).toBeUndefined();expect(q.voiceEcho).toBeUndefined();
  const full=analysis(120,t=>t<2?.01:.85);
  const partial=applyVocalHandoff(p,A,full,S);
  expect((partial.debug.stems as {policy:string}).policy).toBe('one-sided-b-2');
});
it.each([32000,48000])('retains B PCM after the de-click and bounds the simultaneous peak at %i Hz',sr=>{
  const p=preserveFirstWords(plan(),analysis(),analysis(),S),n=sr*12;
  const av=Float32Array.from({length:n},(_,i)=>.27*Math.sin(2*Math.PI*660*i/sr)),bv=Float32Array.from(av,(_,i)=>.27*Math.sin(2*Math.PI*440*i/sr));
  const silence=new Float32Array(n),a={L:av,R:av,sampleRate:sr},b={L:bv,R:bv,sampleRate:sr};
  const q=renderTransitionOffline(a,b,p,0,1),reference=renderTransitionOffline({...a,L:silence,R:silence},b,{...p,automation:p.automation.filter(l=>l.deck==='B')},0,1);
  let error=0;for(let i=Math.round(sr*.35);i<sr;i++)error=Math.max(error,Math.abs(q.L[i]-reference.L[i]));
  expect(error).toBeLessThan(1e-6);expect(q.metrics.underruns).toBe(0);expect(q.metrics.peak).toBeLessThan(.9);
});
it('does not restore A when the consumer cannot load stems for a prepared quiet-voice plan',()=>{
  const p=preserveFirstWords(plan(),analysis(120,()=>.01),analysis(),S),q=fallbackWithoutVocalStems(p);
  expect(q.vocalA).toBeUndefined();expect(q.vocalB).toBeUndefined();expect(q.voiceEcho).toBeUndefined();
  expect(q.automation.some(l=>l.deck==='A'&&l.lane==='echo')).toBe(false);
  expect(at(q,'A','gain',.04)).toBeGreaterThan(0);expect(at(q,'A','gain',.3)).toBe(0);
  expect(at(q,'B','low',.04)).toBeLessThan(1);expect(at(q,'B','low',.3)).toBe(1);expect(q.bEntry).toBe(p.bEntry);
});
it('keeps the prepared instrumental groove under an immediate incoming voice instead of a 40 ms Next',()=>{
  const A=analysis(),B=analysis(),p=plan();A.vocalActivity!.accompanimentRmsDb=A.vocalActivity!.values.map(()=>-20);
  const q=preserveFirstWords(p,A,B,S);
  expect((q.debug.firstWords as {earlyStemHandoff:boolean}).earlyStemHandoff).toBe(true);
  expect(q.automation.find(l=>l.deck==='A'&&l.lane==='gain')).toEqual(p.automation.find(l=>l.deck==='A'&&l.lane==='gain'));
  expect(q.automation.find(l=>l.deck==='B'&&l.lane==='low')).toEqual(p.automation.find(l=>l.deck==='B'&&l.lane==='low'));
  // B's first words are at full level, but its accompaniment is not slammed to unity over A's groove.
  expect(pointValue(q.vocalA!,.04)).toBe(0);expect(at(q,'B','gain',.012)).toBeLessThan(1);
  expect(at(q,'B','gain',.3)*pointValue(q.vocalB!,.3)).toBeCloseTo(1,2);expect(at(q,'B','gain',.3)).toBeLessThan(.5);
  expect(at(q,'A','mid',.04)).toBeLessThanOrEqual(.35);expect(q.echo).toBeUndefined();
  const failed=fallbackWithoutVocalStems(q);
  expect(failed.vocalA).toBeUndefined();expect(at(failed,'A','gain',.3)).toBe(0);expect(at(failed,'B','low',.3)).toBe(1);
  expect(failed.vocalB).toBeUndefined();expect(at(failed,'B','gain',.3)).toBeCloseTo(1,2);
  for(const bed of [undefined,[-20],A.vocalActivity!.values.map(()=>-60),A.vocalActivity!.values.map(()=>NaN)]){
    const unknown={...A,vocalActivity:{...A.vocalActivity!,accompanimentRmsDb:bed}};
    expect(at(preserveFirstWords(p,unknown,B,S),'A','gain',.3)).toBe(0);
  }
});
it('moves a cue at the first word to a measured 1–4 bar instrumental lead-in',()=>{
  const A=analysis(),B=analysis(120,t=>t<12?.01:.85);
  B.cues.entry=[{time:12,score:.99,kind:'start',tags:['saved-cue']}];
  const p=planTransition(track('a',A),track('b',B),S);
  const first=firstVoice(B,B.audibleStart,B.audibleEnd);
  if(first===null)throw new Error('fixture vocal activity should be complete');
  expect(first).toBeCloseTo(12);
  expect(p.bEntry).toBeLessThan(first-1.9);
  expect(firstVoice(B,p.bEntry,first)).toBe(Infinity);
  expect(first-p.bEntry).toBeLessThanOrEqual(B.beat!.period*16+.1);
  expect(pointValue(p.automation.find(l=>l.deck==='B'&&l.lane==='gain')!.points,0)).toBe(0);
});
it('removes early outgoing vocal PCM while retaining the instrumental PCM',()=>{
  const sr=32000,n=sr*10,A=analysis();A.vocalActivity!.accompanimentRmsDb=A.vocalActivity!.values.map(()=>-20);
  const q=preserveFirstWords(plan(),A,analysis(),S),silence=new Float32Array(n);
  const voice=Float32Array.from({length:n},(_,i)=>.15*Math.sin(2*Math.PI*660*i/sr));
  const bed=Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*80*i/sr));
  const original=Float32Array.from(bed,(x,i)=>x+voice[i]);
  const b={L:silence,R:silence,sampleRate:sr,vocals:{L:silence,R:silence}};
  const rendered=renderTransitionOffline({L:original,R:original,sampleRate:sr,vocals:{L:voice,R:voice}},b,q,0,0);
  const reference=renderTransitionOffline({L:bed,R:bed,sampleRate:sr},b,{...q,vocalA:undefined},0,0);
  let error=0,power=0;for(let i=sr*.15;i<sr;i++){error=Math.max(error,Math.abs(rendered.L[i]-reference.L[i]));power+=rendered.L[i]**2;}
  expect(error).toBeLessThan(1e-6);expect(Math.sqrt(power/(sr*.85))).toBeGreaterThan(.02);expect(rendered.metrics.underruns).toBe(0);
});
it('keeps a completed utterance over a wide BPM gap, while retaining the phrase-cut alternative and B cue',()=>{
  const A=analysis(120,t=>t<35.8?.85:.01),B=analysis(160);A.phrases=[0,8,16,24,36];
  const a=track('a',A),b=track('b',B),p=planTransition(a,b,{...S,entryMode:'preserve'});
  const selection=p.debug.candidateSelection as {selected:string;candidates:unknown[];knownCoverage:boolean};
  expect(p.method).toBe('crossfade');expect(p.bEntry).toBe(0);
  expect(p.aExit+(p.debug.vocalGap as {end:number}).end).toBeCloseTo(35.8,3);
  expect(selection.selected).toBe('baseline');expect(selection.candidates.length).toBe(2);expect(selection.knownCoverage).toBe(true);
  expect(planTransition(a,b,{...S,entryMode:'preserve'})).toEqual(p);
});
it('does not select an automatic cut on continuous/unknown A or a rejected/local grid',()=>{
  for(const A of [analysis(120),{...analysis(120),vocalActivity:undefined},
    {...analysis(120,t=>t<35.8?.85:.01),structure:{gridCheck:{periodHint:{bpm:90}}}} as unknown as TrackAnalysis]){
    const p=planTransition(track('a',A),track('b',analysis(160)),{...S,entryMode:'preserve'});
    expect(p.method).not.toBe('phrase_cut');
  }
});
it('prefers a completed short utterance below the normal score margin only without extra conflicts',()=>{
  for(const cue of [152,154]){
    const A=analysis(120,t=>t>=cue-.2&&t<cue+.4?.85:.01,168),B=analysis(124,t=>t<.2?0:.85,168);
    A.vocalActivity!.vocalRmsDb=Array(16800).fill(-20);
    A.vocalActivity!.accompanimentRmsDb=Array(16800).fill(-18);
    const p=planTransition(track('a',A),track('b',B),S);
    const selection=p.debug.candidateSelection as {selected:string;margin:number;candidates:{cost:{total:number;cutA:boolean;lostB:number;voiceOverlap:number;holeDb:number}}[]};
    const [base,short]=selection.candidates.map(x=>x.cost);
    expect(base.total-short.total).toBeGreaterThan(0);
    expect(base.total-short.total).toBeLessThan(selection.margin);
    expect(short.lostB).toBeGreaterThanOrEqual(0);
    expect(short.lostB).toBeLessThanOrEqual(base.lostB);
    expect(short.voiceOverlap).toBeLessThanOrEqual(base.voiceOverlap);
    expect(short.holeDb).toBeLessThanOrEqual(base.holeDb);
    expect(selection.selected).toBe(cue===152?'short-phrase':'baseline');
    if(cue===152){expect(base.cutA).toBe(true);expect(short.cutA).toBe(false);expect(p.aExit).toBeGreaterThan(cue+.4);}
  }
});
it('leaves album continuity, disabled mixing and explicit manual transitions outside candidate selection',()=>{
  const a={...track('a',analysis()),album:'x',trackNo:1},b={...track('b',analysis(160)),album:'x',trackNo:2};
  expect(planTransition(a,b,S).method).toBe('gapless');
  for(const p of [planTransition(a,b,{...S,enabled:false}),planTransition({...a,mixingAllowed:false},b,S),
    planRequestedTransition(a,b,20,S),planSkip(a,b,20,S)])expect(p.debug.candidateSelection).toBeUndefined();
});
it('does not score an alternative outside its own measured range even when the baseline is covered',()=>{
  const A=analysis(120,t=>t<35.8?.85:.01),B=analysis(160);A.phrases=[36];A.vocalActivity!.values[3400]=NaN;
  for(const c of [A.curves.rmsDb,A.curves.lowDb,A.curves.midDb,A.curves.highDb])for(let i=38*A.curves.rate;i<c.length;i++)c[i]-=10;
  B.duration=B.audibleEnd=3;B.beat!.beats=B.beat!.beats.filter(t=>t<3);B.beat!.downbeats=B.beat!.downbeats.filter(t=>t<3);
  const p=planTransition(track('a',A),track('b',B),{...S,entryMode:'preserve'});
  const selection=p.debug.candidateSelection as {knownCoverage:boolean;selected:string;candidates:{name:string;cost:unknown}[]};
  expect(selection.knownCoverage).toBe(true);expect(selection.candidates[0].cost).not.toBeNull();
  expect(selection.candidates.find(c=>c.name==='phrase-cut')?.cost).toBeNull();expect(selection.selected).toBe('baseline');
});
it('keeps a measured local-grid plan inside its original source regions and avoids candidate re-search',()=>{
  const A=analysis(120),B=analysis(123,t=>t<12?.01:.8);
  for(const [an,start,end] of [[A,8,40],[B,0,20]] as const){
    an.beatRegions=[{...an.beat!,start,end,beats:an.beat!.beats.filter(t=>t>=start&&t<end),downbeats:an.beat!.downbeats.filter(t=>t>=start&&t<end)}];an.beat=null;
  }
  const p=planTransition(track('a',A),track('b',B),S),regions=p.beatAlign?.regions;
  expect(regions?.A).toBeDefined();expect(regions?.B).toBeDefined();expect(p.debug.candidateSelection).toBeUndefined();
  expect(p.aExit).toBeGreaterThanOrEqual(regions!.A!.start);expect(p.bEntry).toBeGreaterThanOrEqual(regions!.B!.start);
  expect(p.aExit+integrateTempo(p.tempoA,p.duration)).toBeLessThanOrEqual(regions!.A!.end+.001);
  expect(p.bEntry+integrateTempo(p.tempoB,p.duration)).toBeLessThanOrEqual(regions!.B!.end+.001);
});
it('keeps the long blend when B sings after 200 ms: only A\'s voice leaves, B\'s accompaniment keeps its planned rise',()=>{
  // Dislike 266: attack 0.39 s used to fade the whole A deck in 0.355 s of a 25.6 s beat blend.
  const A=analysis(),B=analysis(120,t=>t<.39?.01:.85),p=plan();A.vocalActivity!.accompanimentRmsDb=A.vocalActivity!.values.map(()=>-20);
  const q=preserveFirstWords(p,A,B,S),fw=q.debug.firstWords as {earlyStemHandoff:boolean;wholeDeckFade:boolean};
  expect(fw.earlyStemHandoff).toBe(true);expect(fw.wholeDeckFade).toBe(false);
  expect(q.automation.find(l=>l.deck==='A'&&l.lane==='gain')).toEqual(p.automation.find(l=>l.deck==='A'&&l.lane==='gain'));
  expect(pointValue(q.vocalA!,.4)).toBe(0);
  for(const t of [.4,1,2,3])expect(at(q,'B','gain',t)*pointValue(q.vocalB!,t)).toBeGreaterThan(.995);
  expect(at(q,'B','gain',1)).toBeLessThan(.6);expect(Math.max(...q.vocalB!.map(([,g])=>g))).toBeLessThanOrEqual(2.5);
});
it('renders a lifted voice mask as full voice over the deck\'s quieter accompaniment',()=>{
  const sr=32000,n=sr*4,silence=new Float32Array(n);
  const voice=Float32Array.from({length:n},(_,i)=>.1*Math.sin(2*Math.PI*660*i/sr)),bed=Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*80*i/sr));
  const original=Float32Array.from(bed,(x,i)=>x+voice[i]),a={L:silence,R:silence,sampleRate:sr,vocals:{L:silence,R:silence}};
  const base:TransitionPlan={...plan(),duration:3,swapAt:1.5,echo:undefined,vocalA:undefined,vocalB:[[0,2.5],[3,2.5]],
    automation:[{deck:'A',lane:'gain',points:[[0,0]]},{deck:'B',lane:'gain',points:[[0,.4],[3,.4]]}]};
  const lifted=renderTransitionOffline(a,{L:original,R:original,sampleRate:sr,vocals:{L:voice,R:voice}},base,0,0);
  const expected=renderTransitionOffline(a,{L:Float32Array.from(bed,(x,i)=>.4*x+voice[i]),R:Float32Array.from(bed,(x,i)=>.4*x+voice[i]),sampleRate:sr},
    {...base,vocalB:undefined,automation:[{deck:'A',lane:'gain',points:[[0,0]]},{deck:'B',lane:'gain',points:[[0,1]]}]},0,0);
  let error=0;for(let i=sr*.2;i<sr*2.5;i++)error=Math.max(error,Math.abs(lifted.L[i]-expected.L[i]));
  expect(error).toBeLessThan(1e-4);expect(lifted.metrics.underruns).toBe(0);
});
it('holds B at its cue for bDelay and then plays exactly the undelayed B on its own clock',()=>{
  const sr=32000,n=sr*6,silence=new Float32Array(n);
  const tone=Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*220*i/sr)*(1+.5*Math.sin(2*Math.PI*.7*i/sr)));
  const a={L:silence,R:silence,sampleRate:sr},b={L:tone,R:tone,sampleRate:sr};
  const base:TransitionPlan={...plan(),duration:2,swapAt:1,echo:undefined,vocalA:undefined,vocalB:undefined,
    automation:[{deck:'A',lane:'gain',points:[[0,0]]},{deck:'B',lane:'gain',points:[[0,0],[.5,1]]}]};
  const plain=renderTransitionOffline(a,b,base,0,1),held=renderTransitionOffline(a,b,{...base,bDelay:1,duration:3,swapAt:2},0,1);
  let early=0;for(let i=0;i<sr;i++)early=Math.max(early,Math.abs(held.L[i]));
  let error=0;for(let i=0;i<sr*2.5;i++)error=Math.max(error,Math.abs(held.L[i+sr]-plain.L[i]));
  expect(early).toBe(0);expect(error).toBeLessThan(1e-5);expect(held.metrics.underruns).toBe(0);
});
it.each(['mask','gain','eq'] as const)('finishes an audible utterance when the %s would cut it, then starts B',cause=>{
  const A=analysis(120,t=>t<23||t>=24?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p:TransitionPlan={...plan(),aExit:20,echo:undefined,vocalA:[[0,1],[6,1],[6.1,0],[8,0]],
    automation:[{deck:'A',lane:'gain',points:[[0,1],[6,1],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[.4,1],[8,1]]}]};
  if(cause==='mask')p.vocalA=[[0,1],[.3,1],[.35,0],[8,0]];
  if(cause==='gain')p.automation[0].points=[[0,1],[.3,1],[.35,0],[8,0]];
  if(cause==='eq')p.automation.push({deck:'A',lane:'mid',points:[[0,1],[.3,1],[.35,.2],[8,.2]]});
  const q=withVocalGap(p,A,B,S),g=q.debug.vocalGap as {end:number;off:number;bWord:number};
  expect(q.aExit).toBe(20);expect(g.end).toBeCloseTo(3,3);
  for(const t of [.4,1,2.99])expect(at(q,'A','gain',t)*at(q,'A','mid',t)*pointValue(q.vocalA!,t)).toBeCloseTo(1,3);
  expect(g.bWord).toBeGreaterThan(g.off);expect(pointValue(q.vocalA!,g.off)).toBe(0);
  expect(q.duration).toBeGreaterThan(q.bDelay!+4);
  const fallback=fallbackWithoutVocalStems(q);
  expect(at(fallback,'A','gain',2.99)).toBeCloseTo(1,3);
  expect(at(fallback,'A','gain',g.bWord)).toBe(0);
});
it('maps a phrase end through a non-unit A tempo ramp and keeps B on its own clock',()=>{
  const A=analysis(120,t=>t<23||t>=24?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p={...plan(),aExit:20,tempoA:[[0,.9],[5,1.1]] as [number,number][],vocalA:[[0,1],[.2,1],[.3,0],[8,0]] as [number,number][]};
  const q=withVocalGap(p,A,B,S),g=q.debug.vocalGap as {end:number};
  expect(q.aExit+integrateTempo(q.tempoA,g.end)).toBeCloseTo(23,3);
  expect(q.tempoA).toEqual(p.tempoA);expect(q.tempoB).toEqual(p.tempoB);
});
it('does not invent a quiet cut in continuous singing or repair an unmeasured/EOF tail',()=>{
  const p={...plan(),aExit:20,vocalA:[[0,1],[.2,1],[.3,0],[8,0]] as [number,number][]},B=analysis();
  const A=analysis();expect(withVocalGap(p,A,B,S)).toBe(p);
  const truncated=analysis(120,t=>t<23?.85:.01);truncated.vocalActivity!.values.length=2100;
  expect(withVocalGap(p,truncated,B,S)).toBe(p);
  const eof=analysis(120,t=>t<23?.85:.01);eof.audibleEnd=23;
  expect(withVocalGap(p,eof,B,S)).toBe(p);
});
it('renders the last sung second of A at full level even when its old deck gain ended early',()=>{
  const sr=32000,n=sr*16,silence=new Float32Array(n),voice=Float32Array.from({length:n},(_,i)=>i<3*sr?.1*Math.sin(2*Math.PI*660*i/sr):0);
  const A=analysis(120,t=>t<3?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p={...plan(),echo:undefined,vocalA:[[0,1],[6,1],[6.1,0],[8,0]] as [number,number][],
    automation:[{deck:'A' as const,lane:'gain' as const,points:[[0,1],[.3,1],[.35,0],[8,0]] as [number,number][]},{deck:'B' as const,lane:'gain' as const,points:[[0,0]] as [number,number][]}]};
  const q=withVocalGap(p,A,B,S),a={L:voice,R:voice,sampleRate:sr,vocals:{L:voice,R:voice}},b={L:silence,R:silence,sampleRate:sr,vocals:{L:silence,R:silence}};
  const old=renderTransitionOffline(a,b,p,0,0),fixed=renderTransitionOffline(a,b,q,0,0);
  const power=(x:Float32Array)=>x.subarray(sr*2,sr*2.9).reduce((s,v)=>s+v*v,0)/(sr*.9);
  expect(power(old.L)).toBeLessThan(1e-10);expect(power(fixed.L)).toBeGreaterThan(.004);
  expect(fixed.metrics.underruns).toBe(0);
});
it('protects a late handoff and keeps both bass curves on B clock after its delayed start',()=>{
  const A=analysis(120,t=>t<13||t>=14?.85:.01),B=analysis(120,t=>t<10?.01:.85);
  const p:TransitionPlan={...plan(),duration:20,swapAt:12,vocalA:[[0,1],[10,1],[10.1,0],[20,0]],
    automation:[{deck:'A',lane:'gain',points:[[0,1],[18,1],[20,0]]},{deck:'B',lane:'gain',points:[[0,0],[12,1],[20,1]]},
      {deck:'A',lane:'low',points:[[0,1],[11,1],[12,0]]},{deck:'B',lane:'low',points:[[0,0],[11,0],[12,1]]}]};
  const q=withVocalGap(p,A,B,S),g=q.debug.vocalGap as {end:number;off:number};
  expect(g.end).toBeCloseTo(13,3);expect(q.bDelay).toBeGreaterThan(3);
  for(const t of [0,3,10,11.5,12,15])expect(at(q,'A','low',t+q.bDelay!)+at(q,'B','low',t)).toBeCloseTo(1,3);
  expect(at(q,'A','gain',12.99)*pointValue(q.vocalA!,12.99)).toBeCloseTo(1,3);
  const failed=fallbackWithoutVocalStems(q);
  expect(at(failed,'A','gain',14)).toBe(0); // next A line must not return while B waits
});
it('rejects a delayed bass exchange beyond EOF and a significant locked tempo ramp',()=>{
  const A=analysis(120,t=>t<23||t>=24?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p:TransitionPlan={...plan(),aExit:20,vocalA:[[0,1],[.2,1],[.3,0],[8,0]]};
  const q={...p,method:'beatmatch_blend' as const,tempoA:[[0,.9],[5,1.1]] as [number,number][]};
  expect(withVocalGap(q,A,B,S)).toBe(q);
  const eof={...A,audibleEnd:25};expect(withVocalGap(p,eof,B,S)).toBe(p);
  const manual={...p,debug:{...p.debug,requested:true}};expect(withVocalGap(manual,A,B,S)).toBe(manual);
});
it('protects the whole-deck early fade even when preserveFirstWords removed vocalA',()=>{
  const A=analysis(120,t=>t<3||t>=4?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p=preserveFirstWords(plan(),A,B,S);expect(p.vocalA).toBeUndefined();
  const q=withVocalGap(p,A,B,S);expect(q.debug.vocalGap).toBeDefined();
  expect(at(q,'A','gain',2.99)).toBe(1);
});
it('retains the duration cap and never extends a separately planned instrumental bridge',()=>{
  const A=analysis(120,t=>t<3||t>=4?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  const p={...plan(),vocalA:[[0,1],[.2,1],[.3,0],[8,0]] as [number,number][]};
  expect(withVocalGap(p,A,B,{...S,maxBlendSeconds:8})).toBe(p);
  const bridge={...p,debug:{...p.debug,variant:'instrumental-bridge'}};
  expect(withVocalGap(bridge,A,B,S)).toBe(bridge);
});
it('does not repair at a false acoustic gap inside a verified word or an unknown future tail',()=>{
  const A=analysis(120,t=>t<3||t>=4?.85:.01),B=analysis(120,t=>t<.4?.01:.85);
  A.vocalActivity!.lyrics={version:'test',language:null,confidence:.95,timing:VERIFIED_TIMING,
    words:Array.from({length:10},(_,i)=>[i*4,i*4+3.8]),lines:[[0,39.8]],voiced:Array.from({length:10},(_,i)=>[i*4,i*4+3.8])};
  const p={...plan(),vocalA:[[0,1],[.2,1],[.3,0],[8,0]] as [number,number][]};
  expect(withVocalGap(p,A,B,S)).toBe(p);
  const late=analysis(120,t=>t<10?.85:.01);late.vocalActivity!.values[950]=NaN;
  expect(withVocalGap(p,late,B,S)).toBe(p);
});
