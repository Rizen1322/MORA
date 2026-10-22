import { expect,it } from 'vitest';
import { withDjPhrasing } from '../src/plan/dj-phrasing.ts';
import { pointValue } from '../src/plan/timing.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S,type TrackAnalysis,type TransitionPlan } from '../src/types.ts';

function scene(){
  const rate=20,duration=30,c=Array.from({length:rate*duration},(_,i)=>i/rate<6?-28:-16);
  const an={duration,audibleStart:0,audibleEnd:duration,bodyRmsDb:-16,sectionBoundaries:[6],
    beat:{stable:true,period:.5,bpm:120,confidence:.95,downbeatConfidence:.9,jitterMs:2,downbeats:Array.from({length:15},(_,i)=>i*2)},
    curves:{rate,rmsDb:c,lowDb:c.map(x=>x-3)},vocalActivity:{rate:10,values:Array.from({length:duration*10},(_,i)=>i<60?.01:.85),model:'test',source:'demucs'}} as TrackAnalysis;
  const p:TransitionPlan={id:'dj',version:'test',method:'beatmatch_blend',fromTrackId:'a',toTrackId:'b',confidence:.9,reasons:[],debug:{processingAllowed:true},
    aExit:0,bEntry:0,duration:10,gap:0,swapAt:4,gainA:0,gainB:0,tempoB:[[0,1]],
    vocalA:[[0,1],[.9,1],[1,0],[10,0]],vocalB:[[0,0],[4,0],[4.2,1],[10,1]],
    beatAlign:{bpmA:120,bpmB:120,ratio:1,relation:1,overlapBeats:20,stretchPercent:0,phraseAligned:true},
    automation:[{deck:'A',lane:'gain',points:[[0,1],[8,1],[10,0]]},{deck:'B',lane:'gain',points:[[0,0],[2,1],[10,1]]}]};
  return {A:an,B:structuredClone(an),p};
}
it('builds a real filter and short echo around an energy arrival while preserving both vocal maps',()=>{
  const {A,B,p}=scene(),q=withDjPhrasing(p,A,B,S);
  expect(q.debug.djFilterRelease).toBeDefined();expect(q.vocalA).toEqual(p.vocalA);expect(q.vocalB).toEqual(p.vocalB);
  expect(q.automation.filter(l=>l.lane==='filter')).toHaveLength(2);expect(q.echo?.feedback).toBe(.22);
  const gain=q.automation.find(l=>l.deck==='A'&&l.lane==='gain')!;
  expect(pointValue(gain.points,6)).toBe(0);expect(pointValue(q.automation.find(l=>l.deck==='B'&&l.lane==='low')!.points,6.04)).toBe(1);
  for(const l of q.automation)for(let i=0;i<l.points.length;i++){const [t,g]=l.points[i];expect(t).toBeGreaterThanOrEqual(i?l.points[i-1][0]:0);expect(t).toBeLessThanOrEqual(q.duration);expect(Number.isFinite(g)).toBe(true);}
});
it('rejects ordinary flat-energy blends, sung filter windows, an unfinished A phrase and disabled creative effects',()=>{
  const {A,B,p}=scene();
  expect(withDjPhrasing(p,A,B,{...S,djPhrasing:false})).toBe(p);
  expect(withDjPhrasing(p,A,B,S,1)).toBe(p);
  expect(withDjPhrasing(p,A,B,{...S,eqHandoff:false})).toBe(p);
  const local={...p,beatAlign:{...p.beatAlign!,regions:{B:{start:0,end:20,period:.49,downbeat:0}}}};
  expect(withDjPhrasing(local,A,B,S)).toBe(local);
  expect(withDjPhrasing({...p,vocalA:[[0,1],[10,0]]},A,B,S).debug.djFilterRelease).toBeUndefined();
  B.vocalActivity!.values.fill(.8);expect(withDjPhrasing(p,A,B,S)).toBe(p);
  B.vocalActivity!.values.fill(.01);B.curves.lowDb.fill(-20);B.curves.rmsDb.fill(-16);expect(withDjPhrasing(p,A,B,S)).toBe(p);
});
it.each([32000,48000])('renders the filter-release through the shared stem-aware engine at %i Hz',sr=>{
  const {A,B,p}=scene(),q=withDjPhrasing(p,A,B,S);
  const voice=Float32Array.from({length:sr*16},(_,i)=>.1*Math.sin(2*Math.PI*660*i/sr));
  const a=Float32Array.from(voice,(v,i)=>v+.12*Math.sin(2*Math.PI*110*i/sr));
  const b=Float32Array.from(voice,(_,i)=>(i/sr<6?.025:.2)*Math.sin(2*Math.PI*220*i/sr));
  const silent=new Float32Array(voice.length);
  const rendered=renderTransitionOffline({L:a,R:a,sampleRate:sr,vocals:{L:voice,R:voice}},{L:b,R:b,sampleRate:sr,vocals:{L:silent,R:silent}},q,0,4);
  expect(rendered.metrics.underruns).toBe(0);expect(rendered.L.every(Number.isFinite)).toBe(true);expect(rendered.metrics.peak).toBeLessThan(.9);
  expect(rendered.events.filter(e=>e.type==='transitionEnd')).toHaveLength(1);
});
it('keeps an incoming pickup audible during the last 100 ms before the arrival',()=>{
  const {A,B,p}=scene();
  B.vocalActivity={...B.vocalActivity!,rate:100,values:Array.from({length:3000},(_,i)=>i<591?.01:.85)};
  expect(withDjPhrasing(p,A,B,S)).toBe(p);
});
