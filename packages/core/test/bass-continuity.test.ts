import {expect,it} from 'vitest';
import {naturalFade,planTransition} from '../src/plan/planner.ts';
import {DEFAULT_AUTOMIX_SETTINGS as S} from '../src/types.ts';
import {pointValue} from '../src/plan/timing.ts';
/** Steady 120 s song; `lowGap` is the low band relative to full RMS (-2: 808-led, -12: light bass). */
function analysis(bpm=120,duration=120,lowGap=-2){const rate=20,period=60/bpm,beats=Array.from({length:Math.ceil(duration/period)},(_,i)=>i*period).filter(t=>t<duration);
 const c=Array.from({length:duration*rate},()=>-18),downbeats=beats.filter((_,i)=>i%4===0);
 return {version:'p1',duration,audibleStart:0,audibleEnd:duration,bodyRmsDb:-18,loudness:{integratedLufs:-16,samplePeakDb:-5,truePeakDb:-4},
  beat:{bpm,period,confidence:.95,stable:true,jitterMs:2,beats,downbeats,downbeatConfidence:.9,downbeatPhase:0,alternatives:[]},
  rhythmStrength:.9,key:{tonic:0,mode:'major',name:'C',camelot:'8B',confidence:.9},phrases:downbeats.filter((_,i)=>i%4===0),phraseConfidence:.9,sectionBoundaries:[],intro:{start:0,end:0},outro:{start:duration-4,end:duration},
  curves:{rate,rmsDb:c,lowDb:c.map(x=>x+lowGap),midDb:c.map(x=>x-8),highDb:c.map(x=>x-12),midDensity:c.map(()=>.2)},peaks:c.map(()=>.8),
  cues:{entry:[{time:0,score:.9,kind:'start',tags:[]}],exit:downbeats.filter(t=>t>60).map(time=>({time,score:.8,kind:'downbeat',tags:[]}))},
  features:{energy:.6,brightness:.5,rhythmStrength:.9,onsetRate:.4,bassWeight:.6,midDensity:.2,dynamics:.2,acousticness:.1},warnings:[],elapsedMs:0} as any;}
const plan=(lowGap:number)=>{
  const p=planTransition({id:'a',duration:120,mixingAllowed:true,analysis:analysis(120,120,lowGap)},{id:'b',duration:120,mixingAllowed:true,analysis:analysis(120,120,lowGap)},S);
  return {p,v:(d:'A'|'B',l:string,t:number)=>pointValue(p.automation.find(x=>x.deck===d&&x.lane===l)?.points??[[0,1]],t)};
};
it("raises B's fader through the first half of a locked blend instead of one bar",()=>{
  const {p,v}=plan(-2);
  expect(p.method).toBe('beatmatch_blend');
  expect(v('B','gain',p.duration*.1)).toBeLessThan(.5);
  expect(v('B','gain',p.swapAt)).toBeGreaterThan(.99);
});
it('lets a bass-led B grow in quietly and exchanges the bass over an equal-power bar',()=>{
  const {p,v}=plan(-2),bc=p.debug.bassContinuity as {at:number;width:number;wide:boolean};
  expect(bc.wide).toBe(true);
  const from=bc.at-bc.width/2,to=bc.at+bc.width/2;
  expect(bc.width).toBeCloseTo(4*60/120,2);
  for(let t=0;t<from;t+=.1){expect(v('A','low',t)).toBe(1);expect(v('B','low',t)).toBeLessThanOrEqual(.35+1e-9);}
  expect(v('B','low',from*.8)).toBeGreaterThan(.2);
  for(let t=from;t<=to;t+=.05)expect(v('A','low',t)**2+v('B','low',t)**2).toBeGreaterThan(.95);
  for(let t=to;t<=p.duration;t+=.1){expect(v('A','low',t)).toBeLessThan(.01);expect(v('B','low',t)).toBeGreaterThan(.99);}
});
it("keeps the one-beat bass swap when B's level is not carried by its bass",()=>{
  const {p,v}=plan(-12);
  expect((p.debug.bassContinuity as {wide?:boolean}|undefined)?.wide??false).toBe(false);
  expect(v('B','low',p.swapAt-1)).toBe(0);
});

it('does not mistake a hard stop with a quiet tail for a natural fade (dislike 256)',()=>{
  const stop=analysis(),fade=analysis(),r=stop.curves.rate;
  stop.curves.rmsDb=stop.curves.rmsDb.map((v:number,i:number)=>i/r<110?v:v-22);
  fade.curves.rmsDb=fade.curves.rmsDb.map((v:number,i:number)=>i/r<110?v:v-(i/r-110)*2.2);
  expect(naturalFade(stop).length).toBe(0);
  expect(naturalFade(fade).length).toBeGreaterThan(3);
});
it('lets the faders carry an unlocked bass-led exchange instead of a one-second bass cut (256/259)',()=>{
  const A=analysis(120,120,-2),B=analysis(160,120,-2),r=A.curves.rate;
  for(const k of ['rmsDb','lowDb','midDb','highDb'])A.curves[k]=A.curves[k].map((v:number,i:number)=>i/r<108?v:v-(i/r-108)*2.5);
  A.outro={start:108,end:120};
  const p=planTransition({id:'a',duration:120,mixingAllowed:true,analysis:A},{id:'b',duration:120,mixingAllowed:true,analysis:B},S);
  const bc=p.debug.bassContinuity as {fader?:boolean;at:number;width:number}|undefined;
  expect(p.method).toBe('crossfade');expect(bc?.fader).toBe(true);
  const g=(t:number)=>pointValue(p.automation.find(x=>x.deck==='A'&&x.lane==='gain')!.points,t);
  expect(g(bc!.at+bc!.width/2)).toBeLessThan(.8);expect(g(bc!.at+bc!.width/2)).toBeGreaterThan(.2);
  expect(g(Math.min(p.duration,bc!.at+bc!.width))).toBeLessThan(.05);
});
