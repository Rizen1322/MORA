import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { firstVoice } from './first-words.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';

/** A measured phrase gap, not a delayed incoming syllable, makes room for the throw. */
export function withVoiceAnswer(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  if(!s.enabled||s.djPhrasing===false||s.stemMixing===false||!s.eqHandoff||requestedAt!==undefined||!A||!B
    ||p.debug.processingAllowed===false||p.loopA||p.tapeStopA||p.echo||!p.vocalA||!p.vocalB||p.duration<4
    ||!['crossfade','beatmatch_blend'].includes(p.method))return p;
  const end=p.vocalA.find(([t,g])=>t>0&&g<=.001)?.[0];
  const first=firstVoice(B,p.bEntry,p.bEntry+integrateTempo(p.tempoB,p.duration));
  if(end===undefined||end<.5||first===null||!Number.isFinite(first))return p;
  const attack=outputTimeAt(p.tempoB,first-p.bEntry,p.duration),clear=attack-.15;
  let delay=(A.beat?.period??.5)/pointValue(p.tempoA??[[0,1]],end);
  if(!Number.isFinite(delay)||delay<=0)return p;
  while(delay<.3)delay*=2;while(delay>.8)delay/=2;
  if(clear-end<delay*2||pointValue(p.vocalB,attack)<.999)return p;
  const last=firstVoice(A,p.aExit+integrateTempo(p.tempoA,Math.max(0,end-.5)),p.aExit+integrateTempo(p.tempoA,end));
  if(last===null||!Number.isFinite(last))return p;
  const from=Math.max(0,end-Math.min(delay,.5)),level=.2;
  return {...p,voiceEcho:{delay,feedback:.22,clearAt:clear},automation:[...p.automation.filter(l=>l.lane!=='voiceEcho'),
    {deck:'A',lane:'voiceEcho',points:[[0,0],[from,0],[Math.min(end,from+.04),level],[end,level],[end+.03,0],[p.duration,0]]}],
    reasons:[...p.reasons,'вокальное эхо отвечает в измеренной паузе и полностью закрывается перед новой фразой'],
    debug:{...p.debug,voiceAnswer:{policy:'measured-gap-1',from,end,clearAt:clear,attack,delay}}};
}
