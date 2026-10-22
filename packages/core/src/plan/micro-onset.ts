import type { AutoMixSettings,BeatGrid,TrackAnalysis,TransitionPlan } from '../types.ts';
import { firstVoice } from './first-words.ts';
import { integrateTempo,outputTimeAt,pointValue } from './timing.ts';

const median=(xs:number[])=>{const a=[...xs].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
const trusted=(b:BeatGrid|null|undefined)=>!!b&&b.stable&&b.confidence>=.85&&b.jitterMs<=8&&b.downbeatConfidence>=.7
  &&b.attacks?.version==='lf-attack-1'&&b.attacks.offsetsMs.length===b.beats.length&&b.attacks.strength.length===b.beats.length;

/** Align measured kick attacks, never waveform phase or an already playing deck. */
export function withMicroOnset(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  if(!s.enabled||requestedAt!==undefined||p.debug.requested===true||p.debug.processingAllowed===false||p.debug.microOnset||p.debug.firstWords
    ||p.method!=='beatmatch_blend'||!p.beatAlign||p.beatAlign.regions||p.loopA||p.tapeStopA||p.voiceEcho||p.duration<3
    ||!A||!B||!trusted(A.beat)||!trusted(B.beat)||A.structure?.gridCheck?.periodHint||B.structure?.gridCheck?.periodHint)return p;
  const ga=A.beat!,gb=B.beat!;
  for(const [an,cue] of [[A,p.aExit],[B,p.bEntry]] as const){
    if(cue<an.audibleStart+.025||firstVoice(an,cue-.025,cue+.18)!==Infinity)return p;
  }
  const shifts:number[]=[],until=Math.min(p.duration,6);
  let previous=-1;
  for(let i=0;i<ga.beats.length&&shifts.length<8;i++){
    const ta=ga.beats[i];if(ta<p.aExit-.001)continue;
    if(ta>p.aExit+integrateTempo(p.tempoA,until))break;
    const t=outputTimeAt(p.tempoA,ta-p.aExit,until),predicted=p.bEntry+integrateTempo(p.tempoB,t);
    let j=-1,distance=.018;
    for(let k=Math.max(0,previous+1);k<gb.beats.length;k++){
      const d=Math.abs(gb.beats[k]-predicted);if(d<distance){distance=d;j=k;}
      if(gb.beats[k]>predicted+.018)break;
    }
    if(j<0)continue;
    const oa=ga.attacks!.offsetsMs[i],ob=gb.attacks!.offsetsMs[j],sa=ga.attacks!.strength[i],sb=gb.attacks!.strength[j];
    if(oa===null||ob===null||!Number.isFinite(oa)||!Number.isFinite(ob)||Math.abs(oa)>25||Math.abs(ob)>25
      ||!Number.isFinite(sa)||!Number.isFinite(sb)||sa<.7||sb<.7||sa>1||sb>1)continue;
    previous=j;
    const ra=pointValue(p.tempoA??[[0,1]],t),rb=pointValue(p.tempoB,t);
    if(!Number.isFinite(ra)||!Number.isFinite(rb)||ra<.8||ra>1.2||rb<.8||rb>1.2)return p;
    shifts.push((gb.beats[j]-predicted)+ob/1000-oa/1000*rb/ra);
  }
  if(shifts.length<4)return p;
  const shift=median(shifts),residual=Math.max(...shifts.map(x=>Math.abs(x-shift)));
  if(Math.abs(shift)<.002||Math.abs(shift)>.015||residual>.003)return p;
  const entry=Math.round((p.bEntry+shift)*1e6)/1e6;
  if(entry<B.audibleStart||entry+integrateTempo(p.tempoB,p.duration)>B.audibleEnd)return p;
  return {...p,id:`${p.id}_onset_${Math.round(shift*1e6)}`,bEntry:entry,
    entrySelection:p.entrySelection?{...p.entrySelection,skippedSeconds:Math.max(0,p.entrySelection.skippedSeconds+shift)}:undefined,
    reasons:[...p.reasons,`атаки бочки уточнены по ${shifts.length} измеренным долям: ${Math.round(shift*1000)} мс`],
    debug:{...p.debug,microOnset:{policy:'lf-attack-1',shiftMs:Math.round(shift*1e6)/1000,pairs:shifts.length,residualMs:Math.round(residual*1e6)/1000}}};
}
