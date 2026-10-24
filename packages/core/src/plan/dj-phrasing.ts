import type { AutoMixSettings,TrackAnalysis,TransitionPlan,AutomationLane } from '../types.ts';
import { integrateTempo,outputTimeAt,pointValue } from './timing.ts';
import { vocalMean } from './vocals.ts';

const r=(x:number)=>Math.round(x*1000)/1000;
/** A real filter/echo handoff onto a measured incoming energy arrival.
 * Existing phrase-safe vocal envelopes remain untouched. A short software
 * automation plan uses the shared filter and echo, not pre-rendered audio. */
export function withDjPhrasing(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  if(!s.enabled||s.djPhrasing===false||!s.eqHandoff||s.stemMixing===false||s.style==='tight'||requestedAt!==undefined
    ||p.debug.processingAllowed===false||!A||!B||!['crossfade','beatmatch_blend'].includes(p.method)
    ||p.duration<6||p.duration>32||p.loopA||p.voiceEcho||p.beatAlign?.regions||!p.vocalA||!B.vocalActivity||!A.vocalActivity
    ||p.automation.some(l=>l.lane==='filter')||!B.beat?.stable||B.beat.confidence<.8||B.beat.downbeatConfidence<.7
    ||B.beat.jitterMs>12||B.structure?.gridCheck?.periodHint)return p;
  const D=p.duration,ba=B.beat;
  const value=(deck:'A'|'B',name:AutomationLane['lane'],t:number)=>pointValue(p.automation.find(l=>l.deck===deck&&l.lane===name)?.points??[[0,name==='echo'?0:1]],t);
  const mean=(an:TrackAnalysis,c:number[],from:number,to:number)=>{
    const rate=an.curves.rate,lo=Math.floor(from*rate),hi=Math.ceil(to*rate);
    if(!(rate>0)||lo<0||hi>c.length||hi<=lo)return NaN;
    let power=0;for(let i=lo;i<hi;i++){if(!Number.isFinite(c[i]))return NaN;power+=10**(c[i]/10);}return 10*Math.log10(Math.max(1e-12,power/(hi-lo)));
  };
  const candidates=[...new Set([...(B.sectionBoundaries??[]),...(p.entrySelection?.arrivalTime!==undefined?[p.entrySelection.arrivalTime]:[])])]
    .map(source=>({source,t:outputTimeAt(p.tempoB,source-p.bEntry,D)}))
    .filter(c=>c.source>p.bEntry&&c.t>=Math.max(3,D*.35)&&c.t<=D*.85
      &&ba.downbeats.some(t=>Math.abs(t-c.source)<.035)).slice(0,16);
  for(const {source,t:arrival} of candidates){
    const speed=pointValue(p.tempoB,arrival),beat=ba.period/speed,bar=beat*4,start=r(Math.max(0,arrival-bar));
    if(arrival-start<1.2||arrival-start>5||start<.5)continue;
    // A's planned sung line must already have ended before the build starts.
    if([start,arrival,...p.vocalA.map(([t])=>t).filter(t=>t>start&&t<arrival)].some(t=>pointValue(p.vocalA!,t)>.001))continue;
    // B opens fully before this release, and stays open. Never add a syllable mask.
    if(p.vocalB&&[arrival,D,...p.vocalB.map(([t])=>t).filter(t=>t>arrival)].some(t=>pointValue(p.vocalB!,t)<.999))continue;
    const bFrom=p.bEntry+integrateTempo(p.tempoB,start),bTo=p.bEntry+integrateTempo(p.tempoB,arrival-.04),v=B.vocalActivity;
    if(!(v.rate>0)||bFrom<0||bTo<=bFrom||Math.ceil(bTo*v.rate)>v.values.length)continue;
    const bins=v.values.slice(Math.floor(bFrom*v.rate),Math.ceil(bTo*v.rate));
    if(bins.some(x=>!Number.isFinite(x)||x<0||x>.28)||vocalMean(B,bFrom,bTo)>.12)continue;
    const beforeLow=mean(B,B.curves.lowDb,Math.max(B.audibleStart,source-ba.period*4),source-.08);
    const afterLow=mean(B,B.curves.lowDb,source,Math.min(B.audibleEnd,source+ba.period*4));
    const before=mean(B,B.curves.rmsDb,Math.max(B.audibleStart,source-ba.period*4),source-.08);
    const after=mean(B,B.curves.rmsDb,source,Math.min(B.audibleEnd,source+ba.period*4));
    const locked=!!p.beatAlign;
    if(![beforeLow,afterLow,before,after].every(Number.isFinite)||after-before<2||afterLow-beforeLow<(locked?3:9)||after<B.bodyRmsDb-5)continue;
    const end=r(arrival),cut=r(Math.max(start+.3,arrival-.12)),close=r(Math.min(start+.3,cut-.2));
    const lane=(deck:'A'|'B',name:AutomationLane['lane'],points:[number,number][]):AutomationLane=>({deck,lane:name,points});
    // Keep the lead-in exactly as planned, then use a musical one-bar build.
    const prefix=(deck:'A'|'B',name:AutomationLane['lane'])=>(p.automation.find(l=>l.deck===deck&&l.lane===name)?.points??[[0,value(deck,name,0)]] as [number,number][]).filter(([t])=>t<start);
    const automation=p.automation.filter(l=>!(l.lane==='echo'&&l.deck==='A')&&!(['gain','low'].includes(l.lane)));
    automation.push(
      lane('A','gain',[...prefix('A','gain'),[start,value('A','gain',start)],[cut,value('A','gain',cut)],[end,0],[D,0]]),
      lane('B','gain',[...prefix('B','gain'),[start,value('B','gain',start)],[end,1],[D,1]]),
      lane('A','low',[...prefix('A','low'),[start,value('A','low',start)],[r(end-beat*.5),0],[D,0]]),
      lane('B','low',[...prefix('B','low'),[start,value('B','low',start)],[close,0],[r(end-.06),0],[r(end+.04),1],[D,1]]),
      lane('A','filter',[[0,0],[start,0],[cut,.68],[D,.68]]),
      lane('B','filter',[[0,0],[start,0],[close,-.55],[r(end-.22),-.55],[r(end-.04),0],[D,0]]),
      lane('A','echo',[[0,0],[r(Math.max(start,end-beat)),0],[r(Math.max(start+.04,end-beat+.06)),.18],[cut,.18],[end,0],[D,0]])
    );
    let delay=beat;while(delay<.3)delay*=2;while(delay>.8)delay/=2;
    return {...p,automation,echo:{delay:r(delay),feedback:.22},
      reasons:[...p.reasons,'подводка к измеренному вступлению: фильтры создают напряжение, бас открывается на сильной доле, инструментал уходящего трека остаётся коротким эхом'],
      debug:{...p.debug,djFilterRelease:{policy:'filter-release-1',from:start,arrival:end,sourceB:source,bassRiseDb:r(afterLow-beforeLow),energyRiseDb:r(after-before),locked,echoDelay:r(delay)}}};
  }
  return p;
}
