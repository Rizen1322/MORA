import { VOICE_LIFT_MAX, type AutoMixSettings, type TrackAnalysis, type TransitionPlan } from '../types.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';
import { BLEED_HIGH, BLEED_MID, guardLanes, lyricTiming, vocalMean, vocalPhrases } from './vocals.ts';

const r=(x:number)=>Math.round(x*1000)/1000;

/** A failed stem read must not restore A's old singer under protected B words. */
export function fallbackWithoutVocalStems(p:TransitionPlan):TransitionPlan {
  const protection=p.debug.firstWords as {attack?:number}|undefined;
  let automation=p.automation.filter(l=>l.lane!=='voiceEcho');
  // A lifted B voice (mask > 1) was full while B's accompaniment rose: without stems the whole deck carries it.
  const lifted=p.vocalB?.some(([,g])=>g>1)?p.vocalB:undefined;
  if(lifted)automation=automation.map(l=>l.deck!=='B'||l.lane!=='gain'?l:{...l,points:[...new Set([...l.points.map(([t])=>t),...lifted.map(([t])=>t)])]
    .sort((x,y)=>x-y).map(t=>{const old=pointValue(l.points,t);return [r(t),r(Math.max(old,Math.min(1,old*pointValue(lifted,t))))];}) as [number,number][]});
  // A delayed B (vocal gap): A's next line fades out over the instrumental gap instead; B's lanes are on its own clock.
  const gap=p.debug.vocalGap as {end:number;off?:number;bWord:number}|undefined;
  if(gap||protection&&Number.isFinite(protection.attack)){
    const end=gap?r(gap.off??Math.max(gap.end+.1,gap.bWord-.035)):r(Math.min(p.duration,Math.max(protection!.attack!<=.012?.3:.04,protection!.attack!-.035)));
    const from=gap?r(gap.end):r(Math.max(0,end-Math.min(.45,end)));
    automation=automation.filter(l=>!(l.deck==='A'&&l.lane==='echo')).map(l=>{
      if(!(l.deck==='A'&&l.lane==='gain')&&!(!gap&&l.deck==='B'&&l.lane==='low'))return l;
      const times=[...new Set([...l.points.map(([t])=>t),0,p.duration,...Array.from({length:13},(_,i)=>from+(end-from)*i/12)])].sort((a,b)=>a-b);
      return {...l,points:times.map(t=>{
        const x=t<=from?0:t>=end?1:(t-from)/(end-from),old=pointValue(l.points,t);
        return [r(t),r(l.deck==='A'?Math.min(old,Math.cos(x*Math.PI/2)):Math.max(old,Math.sin(x*Math.PI/2)))];
      }) as [number,number][]};
    });
  }
  return {...p,vocalA:undefined,vocalB:undefined,voiceEcho:undefined,automation,
    echo:automation.some(l=>l.lane==='echo')?p.echo:undefined,
    debug:{...p.debug,voiceAnswer:undefined,...(p.debug.stems?{stems:{...(p.debug.stems as object),voiceEcho:null}}:{}),
      ...(protection?{firstWords:{...protection,stemFallback:true}}:{})}};
}
/** null means unknown, Infinity means measured but no detected attack. */
export function firstVoice(an:TrackAnalysis,from:number,to:number):number|null {
  const v=an.vocalActivity;
  if(!v||!(v.rate>0)||!Number.isFinite(v.rate)||!Number.isFinite(from)||!Number.isFinite(to)
    ||from<0||to<=from||to>an.duration+1e-6||Math.ceil((to-1e-8)*v.rate)>v.values.length)return null;
  let first=Infinity;
  for(let i=Math.floor(from*v.rate);i<Math.min(v.values.length,Math.ceil((to-1e-8)*v.rate));i++){
    const x=v.values[i];if(!Number.isFinite(x)||x<0||x>1)return null;
    if(x>=.28&&!Number.isFinite(first))first=Math.max(from,i/v.rate);
  }
  // A verified word boundary can precede the separator's coarse attack bin.
  const words=lyricTiming(an);
  if(words?.verified)for(const [a,b] of words.edit)if(b>from&&a<to){first=Math.min(first,Math.max(from,a));break;}
  return first;
}

/** Preserve the first measured incoming utterance, rather than waiting for A's
 * vocal handoff. An unavoidable cut yields the whole A deck, including bleed. */
export function preserveFirstWords(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings):TransitionPlan {
  if(!s.enabled||s.stemMixing===false||!B||p.debug.processingAllowed===false||p.debug.requested===true||p.duration<.7
    ||!['crossfade','beatmatch_blend'].includes(p.method)||p.loopA)return p;
  const D=p.duration,sourceEnd=p.bEntry+integrateTempo(p.tempoB,D),first=firstVoice(B,p.bEntry,sourceEnd);
  if(first===null||!Number.isFinite(first))return p;
  const attack=r(first<=p.bEntry?0:outputTimeAt(p.tempoB,first-p.bEntry,D));
  const at=(deck:'A'|'B',name:TransitionPlan['automation'][number]['lane'],t:number)=>
    pointValue(p.automation.find(l=>l.deck===deck&&l.lane===name)?.points??[[0,name==='filter'?0:1]],t);
  const mask=pointValue(p.vocalB??[[0,1]],attack);
  if(mask>=.999&&at('B','gain',attack)>=.999&&at('B','mid',attack)>=.5&&at('B','high',attack)>=.5
    &&Math.abs(at('B','filter',attack))<.001)return p;
  const deadline=r(Math.max(0,attack-.035));
  const srcA=(t:number)=>p.aExit+integrateTempo(p.tempoA,t);
  const spans=A?(lyricTiming(A)?.edit??vocalPhrases(A).filter(x=>x.confidence>=.35).map(x=>[x.start,x.end])):[];
  let quiet=-1;
  if(A&&deadline>=.1&&firstVoice(A,srcA(0),srcA(Math.min(D,deadline+.08)))!==null){
    for(let t=deadline;t>=Math.max(.1,deadline-2);t-=.02){
      const lo=srcA(Math.max(0,t-.08)),hi=srcA(t+.035);
      if(vocalMean(A,lo,hi)<=.12&&!spans.some(([a,b])=>hi>a&&lo<b)){quiet=r(t);break;}
    }
  }
  const oldEnd=Number((p.debug.stems as {vocalHandoff?:number}|undefined)?.vocalHandoff??D);
  const laterVoice=A?firstVoice(A,srcA(Math.min(deadline,D-.001)),srcA(D)):null;
  const alreadyQuiet=!!p.vocalA&&oldEnd<=deadline||A&&firstVoice(A,srcA(0),srcA(D))===Infinity;
  // An immediate incoming word must not turn a prepared beat blend into a 40 ms Next.
  // Keep the measured accompaniment; if its PCM fails, the controller uses the whole-deck fallback.
  const activity=A?.vocalActivity,bed=activity?.accompanimentRmsDb;
  const bedFrom=activity?Math.floor(srcA(0)*activity.rate):0,bedTo=activity?Math.ceil(srcA(Math.min(D,4))*activity.rate):0;
  // Any early attack, not only <=200 ms: otherwise a later A word turned a 25 s blend into a 0.35 s whole-deck Next.
  const earlyStem=s.eqHandoff&&!!p.vocalA&&activity?.source==='demucs'&&!!A&&firstVoice(A,srcA(0),srcA(D))!==null
    &&!!bed&&bedTo>bedFrom&&bedTo<=bed.length&&bed.slice(bedFrom,bedTo).every(x=>Number.isFinite(x)&&x>=-42&&x<=60);
  // The controller can lose a stem after planning; only a whole-deck fade
  // guarantees that A's later singing cannot return through its residual.
  const wholeDeck=!earlyStem&&(laterVoice!==Infinity||!alreadyQuiet&&quiet<0);
  const immediate=attack<=.012;
  const end=r(earlyStem?(quiet>=0?quiet:Math.max(.04,deadline)):wholeDeck?Math.max(immediate?.3:.04,quiet>=0?quiet:deadline):alreadyQuiet?Math.min(oldEnd,deadline):quiet);
  const fade=wholeDeck&&quiet<0?Math.min(.45,end):.06,from=r(Math.max(0,end-fade));
  const outgoing=(t:number)=>t<=from?1:t>=end?0:Math.cos((t-from)/(end-from)*Math.PI/2);
  const open=r(Math.max(.012,deadline)),gainOpen=r(immediate?.3:open),rise=r(Math.max(0,open-Math.min(1.2,open)));
  // While A's accompaniment stays, only B's voice must be at full level for its first words:
  // B's accompaniment keeps the planned rise (floored at -8 dB) and the voice mask lifts above 1.
  const lift=!wholeDeck,floorB=1/VOICE_LIFT_MAX;
  let automation=p.automation.filter(l=>!(l.deck==='A'&&(l.lane==='voiceEcho'||(wholeDeck||earlyStem)&&l.lane==='echo')));
  automation=automation.map(l=>{
    const incoming=l.deck==='B'&&(['gain','mid','high','filter'].includes(l.lane)||wholeDeck&&l.lane==='low');
    if(!incoming&&!(wholeDeck&&l.deck==='A'&&l.lane==='gain'))return l;
    const knots=[...new Set([...l.points.map(([t])=>t),0,D,...Array.from({length:13},(_,i)=>
      incoming&&l.lane==='gain'&&immediate?gainOpen*i/12:incoming?rise+(open-rise)*i/12:from+(end-from)*i/12)])].sort((a,b)=>a-b);
    return {...l,points:knots.map(t=>{
      const old=pointValue(l.points,t);
      if(!incoming)return [r(t),r(Math.min(old,outgoing(t)))];
      const laneOpen=l.lane==='gain'&&immediate?gainOpen:open,laneRise=l.lane==='gain'&&immediate?0:rise;
      const x=t<=laneRise?0:t>=laneOpen?1:(t-laneRise)/(laneOpen-laneRise),floor=l.lane==='low'
        ?Math.sqrt(Math.max(0,1-outgoing(t)**2)):Math.sin(x*Math.PI/2)*(lift&&l.lane==='gain'?floorB:1);
      return [r(t),r(l.lane==='filter'?old*(1-x):Math.max(old,floor))];
    }) as [number,number][]};
  });
  if(!wholeDeck&&(earlyStem||!alreadyQuiet)&&s.eqHandoff)automation=guardLanes(automation,from,Math.max(end,deadline),D,{mid:BLEED_MID,high:BLEED_HIGH});
  const vocalA=wholeDeck?undefined:alreadyQuiet&&!earlyStem?p.vocalA:[[0,1],[from,1],[end,0],[D,0]] as [number,number][];
  const voiceRise=immediate?0:rise,voiceOpen=immediate?gainOpen:open;
  const voice=(t:number)=>t<=voiceRise?0:t>=voiceOpen?1:Math.sin((t-voiceRise)/(voiceOpen-voiceRise)*Math.PI/2);
  let vocalB:[number,number][]|undefined=deadline<=.012?undefined:[[0,0],[rise,0],[open,1],[D,1]];
  if(lift){
    const gainB=automation.find(l=>l.deck==='B'&&l.lane==='gain')?.points??[[0,1]];
    const knots=[...new Set([0,D,...gainB.map(([t])=>t),...Array.from({length:13},(_,i)=>voiceRise+(voiceOpen-voiceRise)*i/12),
      ...Array.from({length:Math.ceil(D/.25)},(_,i)=>i*.25)])].filter(t=>t>=0&&t<=D).sort((a,b)=>a-b);
    vocalB=knots.map(t=>[r(t),r(Math.min(VOICE_LIFT_MAX,voice(t)/Math.max(1e-3,pointValue(gainB,t))))]);
    while(vocalB.length>2&&Math.abs(vocalB[vocalB.length-2][1]-1)<1e-3&&vocalB[vocalB.length-1][1]===1)vocalB.pop();
  }
  return {...p,automation,vocalA,vocalB,voiceEcho:undefined,
    echo:automation.some(l=>l.lane==='echo')?p.echo:undefined,
    reasons:[...p.reasons.filter(x=>! /^(голос следующего трека|последнее слово текущего голоса|текущий трек уходит в эхо|подводка к измеренному вступлению:)/.test(x)),
      earlyStem?'новый голос начинается сразу: предыдущий голос убран отдельно, измеренная инструментальная партия сохраняет ритм сведения':wholeDeck?'первые слова нового трека не ждут вокальной маски: текущая запись целиком плавно уступает им место':'новый голос открыт до первой измеренной атаки; текущий заканчивается в доступной измеренной паузе'],
    debug:{...p.debug,djFilterRelease:undefined,firstWords:{policy:'first-words-1',attack,source:first,previousHandoff:oldEnd,wholeDeckFade:wholeDeck,
      outgoingTailMeasuredQuiet:laterVoice===Infinity,earlyStemHandoff:earlyStem,unavoidableOverlapSeconds:r(Math.max(0,end-attack)),
      declickSeconds:attack<.012?.012:0,gainRiseSeconds:r(immediate?.3:Math.min(1.2,open)),voiceLift:lift},
      stems:{...(p.debug.stems as object|undefined),policy:'first-words-1',vocalHandoff:end,bVoiceStart:deadline,
        lostB:0,voiceEcho:null,...(wholeDeck?{wholeDeckFade:{from,to:end}}:{})}}};
}

/** First measured utterance attenuated while it is still sounding; callers validate coverage. */
export function outgoingPhraseCut(p:TransitionPlan,A:TrackAnalysis):{cut:number;endSource:number}|null {
  const D=p.duration,srcA=(t:number)=>p.aExit+integrateTempo(p.tempoA,t);
  const lane=(name:TransitionPlan['automation'][number]['lane'],t:number)=>pointValue(p.automation.find(l=>l.deck==='A'&&l.lane===name)?.points??[[0,name==='filter'?0:1]],t);
  const effective=(t:number)=>pointValue(p.vocalA??[[0,1]],t)*lane('gain',t)*Math.min(lane('mid',t),lane('high',t));
  // Acoustic utterances bridge short breaths; individual ASR word ends are not phrase ends.
  const phrases=vocalPhrases(A).filter(x=>x.confidence>=.35);
  let cut=-1,endSource=-1;
  for(let t=0;t<D;t+=.02){
    if(effective(t)>=.5)continue;
    const phrase=phrases.find(x=>x.start<srcA(t)&&x.end>srcA(t)+.03);
    if(!phrase)continue;
    const start=phrase.start<=p.aExit?0:outputTimeAt(p.tempoA,phrase.start-p.aExit,D);
    if(effective(start)<.5)continue; // Do not restore a later line that was intentionally muted.
    cut=t;endSource=phrase.end;break;
  }
  return cut<0?null:{cut,endSource};
}

/** Finish an already audible acoustic utterance before yielding to B. The deck fader
 * and EQ are part of the voice envelope; a smooth stem mask alone cannot protect it. */
export function withVocalGap(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings):TransitionPlan {
  if(!s.enabled||s.stemMixing===false||!A?.vocalActivity||!B?.vocalActivity||p.bDelay||p.loopA||p.tapeStopA
    ||p.debug.processingAllowed===false||p.debug.requested===true||p.debug.variant==='instrumental-bridge'
    ||!['crossfade','beatmatch_blend'].includes(p.method))return p;
  const D=p.duration,srcA=(t:number)=>p.aExit+integrateTempo(p.tempoA,t);
  const available=Math.min(A.duration,A.audibleEnd);
  if(firstVoice(A,p.aExit,Math.min(available,srcA(D)))===null)return p;
  const attackSource=firstVoice(B,p.bEntry,Math.min(B.duration,p.bEntry+integrateTempo(p.tempoB,D)));
  if(attackSource===null||!Number.isFinite(attackSource))return p;
  const bWord=outputTimeAt(p.tempoB,attackSource-p.bEntry,D);
  const clipped=outgoingPhraseCut(p,A);if(!clipped)return p;
  const {cut,endSource}=clipped,phrases=vocalPhrases(A).filter(x=>x.confidence>=.35);
  // shortcut: finish at most 16 s of an utterance; longer continuous vocals need another cue/pair.
  if(cut<0||endSource>available-.08||endSource>srcA(cut+16))return p;
  const end=outputTimeAt(p.tempoA,endSource-p.aExit,D+16),off=end+.12;
  if(firstVoice(A,p.aExit,Math.min(available,srcA(off)+.02))===null)return p;
  // A coarse activity dip must not override a stem-verified sung word.
  if(lyricTiming(A)?.edit.some(([a,b])=>srcA(off)+.02>a&&endSource<b))return p;
  // A real pause must fit the release, including the next utterance's consonant.
  if(phrases.some(x=>x.start< srcA(off)+.02&&x.end>endSource+.001&&x.start>=endSource))return p;
  let delay=Math.max(0,off+.08-bWord);
  if(delay>0&&p.method==='beatmatch_blend'){
    const bar=(p.beatAlign?.regions?.A?.period??A.beat?.period??.5)*4;
    delay=outputTimeAt(p.tempoA,Math.ceil(integrateTempo(p.tempoA,delay)/bar-1e-6)*bar,D+16);
    // Delaying B's original tempo ramp would break the lock; only negligible (<20 ms) drift is safe.
    const rates=(p.tempoA??[[0,1]]).map(([,v])=>v);
    if((Math.max(...rates)-Math.min(...rates))*(D+delay)>.02)return p;
  }
  if(delay>16.01)return p;
  const N=r(Math.max(D+delay,off+.4)),release=Math.min(off+.4,outputTimeAt(p.tempoA,available-p.aExit,N));
  const cap=Number.isFinite(s.maxBlendSeconds)?Math.max(0,Math.min(60,s.maxBlendSeconds)):32;
  if(release<=off||N>cap+.001||p.bEntry+integrateTempo(p.tempoB,N-delay)>B.audibleEnd+.001)return p;
  // Keep the bass exchange on the same clock as B. If A cannot carry that exchange,
  // retain the original plan rather than create a hole beyond its real EOF.
  const shifted=p.automation.map(l=>l.deck==='A'&&delay?{...l,points:[[0,l.points[0]?.[1]??1] as [number,number],...l.points.map(([t,v])=>[r(t+delay),v] as [number,number])]}:l);
  const tail=outputTimeAt(p.tempoA,available-p.aExit,N),bassB=p.automation.find(l=>l.deck==='B'&&l.lane==='low')?.points??[[0,1]];
  const gainB=p.automation.find(l=>l.deck==='B'&&l.lane==='gain')?.points??[[0,1]];
  if(delay&&tail<N-.02&&(tail<=delay||pointValue(bassB,tail-delay)*pointValue(gainB,tail-delay)<.7))return p;
  // Hold the singer's real signal, then rejoin the original bed automation after the phrase.
  const automation=shifted.filter(l=>l.lane!=='voiceEcho'&&!(l.deck==='A'&&l.lane==='echo')).map(l=>{
    if(l.deck!=='A'||!['gain','mid','high','filter'].includes(l.lane))return l;
    const times=[...new Set([0,end,off,release,N,...l.points.map(([t])=>t)])].sort((a,b)=>a-b);
    return {...l,points:times.map(t=>{
      const old=pointValue(l.points,t),keep=t<=end?1:t>=release?0:Math.cos((t-end)/(release-end)*Math.PI/2);
      return [r(t),r(l.lane==='filter'?old*(1-keep):Math.max(old,keep))] as [number,number];
    })};
  });
  const guarded=s.eqHandoff?guardLanes(automation,r(end),r(off),N,{mid:BLEED_MID,high:BLEED_HIGH}):automation;
  return {...p,duration:N,swapAt:r(p.swapAt+delay),...(delay?{bDelay:r(delay)}:{}),automation:guarded,
    vocalA:[[0,1],[r(end),1],[r(off),0],[N,0]],voiceEcho:undefined,echo:undefined,
    reasons:[...p.reasons,'звучащая фраза текущего голоса заканчивается до передачи: громкость деки сохраняет её окончание'],
    debug:{...p.debug,...(p.debug.firstWords?{firstWords:{...(p.debug.firstWords as object),wholeDeckFade:false,earlyStemHandoff:true,deferredBy:r(delay)}}:{}),
      vocalGap:{policy:'finish-utterance-1',cut:r(cut),end:r(end),off:r(off),bWord:r(bWord+delay),gap:r(bWord+delay-off),bDelay:r(delay)},
      stems:{...(p.debug.stems as object|undefined),policy:'finish-utterance-1',vocalHandoff:r(off),bVoiceStart:r(bWord+delay),voiceEcho:null,wholeDeckFade:undefined,cleanA:true,fadeA:.12}}};
}
