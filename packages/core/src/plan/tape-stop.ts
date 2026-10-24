import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { pointValue } from './timing.ts';

/** Rare intentional pitch fall on a measured instrumental tail, at native tempo. */
export function withTapeStop(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  if(!s.enabled||!s.eqHandoff||s.loopBridges===false||s.djPhrasing===false||s.style!=='auto'||requestedAt!==undefined||!A||!B
    ||p.debug.processingAllowed===false||p.debug.firstWords||p.method!=='crossfade'||p.duration<4||p.duration>10||p.loopA||p.echo||p.voiceEcho
    ||p.tempoA?.some(([,v])=>Math.abs(v-1)>.00001)||p.tempoB.some(([,v])=>Math.abs(v-1)>.00001)
    ||!A.beat?.stable||!B.beat?.stable||A.beat.confidence<.85||B.beat.confidence<.85
    ||A.beat.jitterMs>8||B.beat.jitterMs>8||Math.abs(A.beat.bpm/B.beat.bpm-1)<.15)return p;
  const start=A.beat.downbeats.find(t=>t>=p.aExit+.5&&t<=p.aExit+Math.min(2,p.duration*.4));
  if(start===undefined)return p;
  const v=A.vocalActivity,end=start+Math.max(.3,Math.min(.9,A.beat.period*1.5));
  if(!v?.vocalRmsDb||!v.accompanimentRmsDb||!(v.rate>0)||end>A.audibleEnd-.01||end>p.aExit+p.duration)return p;
  const lo=Math.floor((start-.05)*v.rate),hi=Math.ceil(A.audibleEnd*v.rate);
  if(lo<0||hi>v.vocalRmsDb.length||hi>v.accompanimentRmsDb.length)return p;
  for(let i=lo;i<hi;i++)if(!Number.isFinite(v.vocalRmsDb[i])||!Number.isFinite(v.accompanimentRmsDb[i])
    ||v.vocalRmsDb[i]+p.gainA> -42||v.vocalRmsDb[i]>v.accompanimentRmsDb[i]-25)return p;
  const from=start-p.aExit,until=end-p.aExit,D=p.duration;
  // Stopping A early must not expose a still-muted B bass or a long, quiet fade.
  for(const name of ['gain','low','mid','high','filter'] as const){
    const points=p.automation.find(l=>l.deck==='B'&&l.lane===name)?.points??[[0,name==='filter'?0:1]];
    for(const t of [until,D,...points.filter(([t])=>t>until&&t<D).map(([t])=>t)]){
      const value=pointValue(points,t);
      if(!Number.isFinite(value)||(name==='filter'?Math.abs(value)>.001:value<(name==='gain'?.95:.9)))return p;
    }
  }
  const automation=p.automation.map(l=>{
    if(l.deck!=='A'||l.lane!=='gain')return l;
    return {...l,points:[...l.points.filter(([t])=>t<from),[from,pointValue(l.points,from)],[until,0],[D,0]] as [number,number][]};
  });
  return {...p,tapeStopA:{start,end,crossfade:.025},automation,
    reasons:[...p.reasons,'короткая остановка инструментального финала с понижением тона перед сменой темпа'],
    debug:{...p.debug,tapeStop:{policy:'quiet-tail-1',start,end}}};
}
