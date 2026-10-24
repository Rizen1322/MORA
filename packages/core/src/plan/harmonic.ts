import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { integrateTempo, pointValue } from './timing.ts';

/** Relieve a confident tonal clash without sacrificing the bass or incoming words. */
export function withHarmonicHandoff(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  if(!s.enabled||!s.eqHandoff||s.djPhrasing===false||requestedAt!==undefined||!A||!B||p.loopA
    ||p.debug.processingAllowed===false||p.duration<3||!['crossfade','beatmatch_blend'].includes(p.method)
    ||!(A.key?.confidence>=.75)||!(B.key?.confidence>=.75)||!p.keyInfo||p.keyInfo.compatibility>=.3)return p;
  const at=(deck:'A'|'B',lane:'gain'|'mid',t:number)=>pointValue(p.automation.find(l=>l.deck===deck&&l.lane===lane)?.points??[[0,1]],t);
  const mid=p.automation.find(l=>l.deck==='A'&&l.lane==='mid');
  if(!mid)return p;
  const points:[number,number][]=[];
  for(const t of [...new Set([...mid.points.map(([t])=>t),...Array.from({length:17},(_,i)=>p.duration*i/16)])].sort((a,b)=>a-b)){
    const sourceA=p.aExit+integrateTempo(p.tempoA,t),sourceB=p.bEntry+integrateTempo(p.tempoB,t);
    const read=(an:TrackAnalysis,c:number[],time:number)=>c[Math.floor(time*an.curves.rate)];
    const a=read(A,A.curves.rmsDb,sourceA),b=read(B,B.curves.rmsDb,sourceB),m=read(A,A.curves.midDb,sourceA);
    if(![a,b,m].every(Number.isFinite))return p;
    const gA=at('A','gain',t),gB=at('B','gain',t),old=at('A','mid',t);
    const total=10**((a+p.gainA)/10)*gA*gA+10**((b+p.gainB)/10)*gB*gB;
    const midPower=10**((m+p.gainA)/10)*gA*gA;
    const budget=total*(1-10**(-1/10));
    const floor=midPower>0?Math.sqrt(Math.max(0,old*old-budget/midPower)):old;
    const depth=Math.sin(Math.PI*t/p.duration)**2;
    points.push([t,Math.min(old,Math.max(floor,old*10**(-1/20),old*(1-.35*depth)))]);
  }
  return {...p,automation:p.automation.map(l=>l===mid?{...l,points}:l),
    reasons:[...p.reasons,'конфликтующие тональные середины расходятся мягче; бас и новый голос сохраняются'],
    debug:{...p.debug,harmonicHandoff:{policy:'measured-mid-1',maxAdditionalMidAttenuationDb:1}}};
}
