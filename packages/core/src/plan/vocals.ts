import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';
import { RangeMaximum } from './range-maximum.ts';

const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const rounded=(x:number)=>Math.round(x*1000)/1000;

export interface VocalPhrase { start: number; end: number; confidence: number }

/** Stable acoustic utterances. A consonant or a very short breath is not a
 * safe edit point: preserve it inside the phrase. Old caches get exactly the
 * same interpretation without rerunning source separation. */
export function vocalPhrases(analysis: TrackAnalysis): VocalPhrase[] {
  const v=analysis.vocalActivity;
  if(!v||!Number.isFinite(v.rate)||v.rate<=0)return [];
  if(v.phrases?.length&&v.phrases.every((p,i)=>Number.isFinite(p.start)&&Number.isFinite(p.end)
    &&Number.isFinite(p.confidence)&&p.start>=0&&p.end>p.start&&p.end<=analysis.duration+1/v.rate
    &&p.confidence>=0&&p.confidence<=1&&(!i||p.start>=v.phrases![i-1].end)))return v.phrases;
  const result:VocalPhrase[]=[];
  let start=-1,last=-1,sum=0,count=0;
  const finish=()=>{
    if(start>=0&&(last+1-start)/v.rate>=0.18)result.push({start:start/v.rate,end:(last+1)/v.rate,confidence:clamp(sum/Math.max(1,count))});
    start=last=-1;sum=count=0;
  };
  for(let i=0;i<v.values.length;i++){
    const x=Number.isFinite(v.values[i])?clamp(v.values[i]):0;
    if(start<0){if(x<0.52)continue;start=i;}
    if(x>=0.28){last=i;sum+=x;count++;}
    // Bridge up to 200 ms, matching the separator's measured-phrase pass.
    if((i-last)/v.rate>0.2+1e-9)finish();
  }
  finish();return result;
}

/** Recognised word/line timing. `words` and `lines` count and structure the
 * singing; `edit` holds the spans an edit must not touch. Whisper word edges on
 * singing are not edit-accurate (on the user library 77% of its 60-250 ms
 * "pauses" had no quiet 30 ms in the separated voice), so without a stem
 * measurement (`verified`) a pause also needs the measured phrases to agree. */
export interface LyricTiming { words: [number, number][]; lines: [number, number][]; edit: [number, number][]; verified: boolean }
export const VERIFIED_TIMING='stem-verified-1';
export function lyricTiming(analysis: TrackAnalysis): LyricTiming | null {
  const l=analysis.vocalActivity?.lyrics;
  if(!l||!Number.isFinite(l.confidence)||l.confidence<0.6||l.confidence>1||!Array.isArray(l.words)||l.words.length<10||!Array.isArray(l.lines))return null;
  const ok=(x:[number,number][])=>x.every((w,i)=>Array.isArray(w)&&Number.isFinite(w[0])&&Number.isFinite(w[1])
    &&w[0]>=0&&w[1]>w[0]&&w[1]<=analysis.duration+0.1&&(!i||w[0]>=x[i-1][1]));
  if(!ok(l.words)||!ok(l.lines))return null;
  if(l.timing===VERIFIED_TIMING&&Array.isArray(l.voiced)&&l.voiced.length&&ok(l.voiced))
    return {words:l.words,lines:l.lines,edit:l.voiced,verified:true};
  const words=trimToActivity(analysis,l.words);
  const measured=vocalPhrases(analysis).filter(p=>p.confidence>=0.35).map(p=>[p.start,p.end] as [number,number]);
  return {words,lines:l.lines,edit:mergeSpans([...words,...measured]),verified:false};
}
/** A Whisper "word" can span 27 s of a held line or of silence. Longer than 1 s,
 * it is limited to the measured activity inside it (100 ms frames, 50 ms reserve). */
function trimToActivity(analysis:TrackAnalysis,words:[number,number][]):[number,number][] {
  const v=analysis.vocalActivity!;
  if(!(v.rate>0))return words;
  return words.map(([a,b])=>{
    if(b-a<=1)return [a,b];
    let first=-1,last=-1;
    for(let i=Math.floor(a*v.rate);i<Math.min(v.values.length,Math.ceil(b*v.rate));i++)if(v.values[i]>=0.28){if(first<0)first=i;last=i;}
    if(first<0)return [a,b];
    const start=Math.max(a,first/v.rate-0.05),end=Math.min(b,(last+1)/v.rate+0.05);
    return end-start>=0.05?[start,end]:[a,b];
  });
}
function mergeSpans(spans:[number,number][]):[number,number][] {
  const out:[number,number][]=[];
  for(const [a,b] of [...spans].sort((x,y)=>x[0]-y[0])){
    const last=out.at(-1);
    if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);
  }
  return out;
}
/** True when [start, end] (track seconds) touches the inside of a sung word. */
export function splitsWord(t:LyricTiming,start:number,end:number):boolean {
  return t.words.some(([a,b])=>end>a+0.03&&start<b-0.03);
}
/** 1 inside the pause between two recognised lines (or after the last), else 0. */
export function betweenLines(t:LyricTiming,x:number):number {
  for(let i=0;i<t.lines.length;i++){
    const [, end]=t.lines[i],next=t.lines[i+1]?.[0]??Infinity;
    if(x>=end-0.02&&x<=next+0.02)return 1;
    if(x<end)return 0;
  }
  return 1;
}
/** Words whose middle falls in [start, end) of track time. */
export function wordsIn(t:LyricTiming,start:number,end:number):number {
  return t.words.filter(([a,b])=>(a+b)/2>=start&&(a+b)/2<end).length;
}

/** Confidence that an edit window is a genuine phrase gap, rather than the
 * low-energy consonant between two syllables. */
function phraseGap(phrases:VocalPhrase[],start:number,end:number):number {
  return phrases.some(p=>p.confidence>=0.35&&end>p.start&&start<p.end)?0:1;
}

/** A short tested edit window must not become a long fade across a word after
 * candidate selection. Fit the final fade inside a known breath when one is
 * available. Continuous singing retains the soft fallback; this is not word
 * recognition and cannot manufacture a pause. */
function fitFadeInBreath(
  at:number, duration:number, direction:'out'|'in', phrases:VocalPhrase[], lyrics:LyricTiming|null,
  cue:number, tempo:TransitionPlan['tempoA'], limit:number,
):number {
  const source=cue+integrateTempo(tempo,at);
  const spans=lyrics?.edit??phrases.filter(p=>p.confidence>=0.35).map(p=>[p.start,p.end] as [number,number]);
  if(spans.some(([start,end])=>source>start&&source<end))return duration;
  if(direction==='out'){
    const previous=spans.filter(([,end])=>end<=source).at(-1);
    if(!previous||previous[1]<cue)return duration;
    const boundary=outputTimeAt(tempo,previous[1]-cue,limit);
    const available=at-boundary-0.015;
    return available>=0.02?Math.min(duration,available):duration;
  }
  const next=spans.find(([start])=>start>=source);
  if(!next||next[0]>cue+integrateTempo(tempo,limit))return duration;
  const boundary=outputTimeAt(tempo,next[0]-cue,limit);
  const available=boundary-at-0.035;
  return available>=0.02?Math.min(duration,available):duration;
}

/** Extra edit points inside measured pauses. A 50 ms search grid can miss a
 * complete short word boundary, even with perfect timestamps. Keep the fade
 * and its attack/release reserve inside the pause, in output time. */
function breathCandidates(
  phrases:VocalPhrase[], lyrics:LyricTiming|null, cue:number, tempo:TransitionPlan['tempoA'],
  limit:number, direction:'out'|'in',
):number[] {
  const spans=lyrics?.edit??phrases.filter(p=>p.confidence>=0.35).map(p=>[p.start,p.end] as [number,number]);
  const sourceEnd=cue+integrateTempo(tempo,limit),result:number[]=[];
  for(let i=0;i<spans.length;i++){
    const start=Math.max(cue,i?spans[i-1][1]:cue),end=Math.min(sourceEnd,spans[i][0]);
    if(end<=start)continue;
    const from=outputTimeAt(tempo,start-cue,limit),to=outputTimeAt(tempo,end-cue,limit);
    const room=to-from-(direction==='out'?0.015:0.035)-0.005;
    if(room<0.02)continue;
    result.push(direction==='out'?from+0.015+Math.min(0.08,room):from+0.005);
  }
  return result;
}

export function vocalMean(analysis: TrackAnalysis, start: number, end: number): number {
  const v=analysis.vocalActivity;
  if(!v)return 0;
  const lo=Math.max(0,Math.floor(start*v.rate)),hi=Math.min(v.values.length,Math.ceil(end*v.rate));
  let sum=0;for(let i=lo;i<hi;i++)sum+=v.values[i];
  return hi>lo?sum/(hi-lo):0;
}

/** Fraction of measured stem power retained by a voice mask. This is not
 * inferred from presence: an a-cappella and a quiet voice over loud drums can
 * have the same activity but completely different accompaniment reserves. */
export function vocalPowerRetained(analysis:TrackAnalysis,start:number,end:number,gain:number):number {
  if(gain>=1)return 1;
  const v=analysis.vocalActivity,voice=v?.vocalRmsDb,band=v?.accompanimentRmsDb;
  if(!v||!voice?.length||!band?.length||!(v.rate>0))return 1;
  const lo=Math.max(0,Math.floor(start*v.rate)),hi=Math.min(voice.length,band.length,Math.ceil(end*v.rate));
  let vp=0,ip=0,n=0;
  for(let i=lo;i<hi;i++){
    if(!Number.isFinite(voice[i])||!Number.isFinite(band[i]))continue;
    vp+=10**(Math.max(-120,Math.min(12,voice[i]))/10);ip+=10**(Math.max(-120,Math.min(12,band[i]))/10);n++;
  }
  return n?clamp((ip+clamp(gain)**2*vp)/Math.max(1e-12,ip+vp)):1;
}

/** Phrase-like vocal attacks after a measured breath/gap. No lyric semantics. */
export function vocalStarts(analysis: TrackAnalysis, limit=75): number[] {
  const v=analysis.vocalActivity;
  if(!v)return [];
  const phrases=vocalPhrases(analysis);
  return phrases.filter((p,i)=>p.start<analysis.audibleStart+limit&&p.confidence>=0.5
    &&p.start-(phrases[i-1]?.end??0)>=0.7-1e-9).map(p=>p.start);
}

export function vocalEntryScore(A: TrackAnalysis,B: TrackAnalysis,aSwap:number,bSwap:number):number {
  if(!A.vocalActivity||!B.vocalActivity)return 0;
  const aGap=1-vocalMean(A,aSwap-0.25,aSwap+0.2);
  const before=vocalMean(B,bSwap-0.9,bSwap-0.1),after=vocalMean(B,bSwap+0.1,bSwap+0.9);
  const arrival=clamp((after-before+0.15)/0.65);
  return 0.45*aGap+0.55*arrival;
}

/** Independent vocal and rhythm handoffs. Subtraction happens before the
 * single stereo stretcher, keeping the residual and voice sample-aligned.
 *
 * One voice at a time: A's voice is always gone by swapAt and B's opens only
 * after it. Both moments are chosen together on measured vocal activity
 * (no lyric semantics): A should end in a breath or at a phrase end, B should
 * open at its own breath/phrase start, and as little audible singing of
 * either track as possible is masked. A's last sung word may be thrown into
 * a voice-only echo whose tail is below -40 dB before B's voice opens. */
/** Last output time a gain lane is still above -20 dB. */
function lastAudible(g:[number,number][],D:number):number{for(let t=D;t>0;t-=0.05)if(pointValue(g,t)>0.1)return t;return 0;}

/** Gains of A's mid (180-2500 Hz) and high bands once B's voice is open (about -9 and -6 dB). */
export const BLEED_MID=0.35,BLEED_HIGH=0.5;

/** A's mid/high lanes limited by a smooth ramp from 1 at `from` to the guard gains at `to`,
 * held to `D`; existing lower values (EQ handoffs) are kept. */
export function guardLanes(lanes:TransitionPlan['automation'],from:number,to:number,D:number,gains:{mid:number;high:number}):TransitionPlan['automation'] {
  const ramp=(t:number,g:number)=>t<=from?1:t>=to?g:1-(1-g)*(0.5-0.5*Math.cos(Math.PI*(t-from)/(to-from)));
  const out=lanes.filter(l=>!(l.deck==='A'&&(l.lane==='mid'||l.lane==='high')));
  for(const band of ['mid','high'] as const){
    const old=lanes.find(l=>l.deck==='A'&&l.lane===band)?.points??[[0,1]] as [number,number][];
    const knots=[...new Set([...old.map(([t])=>t).filter(t=>t<=D),...Array.from({length:9},(_,i)=>from+(to-from)*i/8),D])].filter(t=>t>=0).sort((x,y)=>x-y);
    out.push({deck:'A',lane:band,points:knots.map(t=>[rounded(t),rounded(Math.min(pointValue(old,t),ramp(t,gains[band])))] as [number,number])});
  }
  return out;
}

/** Partial preparation is useful, but an unknown voice must never be treated
 * as silence. No incoming voice mask is used in either partial mode. */
function partialVocalHandoff(p:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings):TransitionPlan {
  if(!['crossfade','beatmatch_blend'].includes(p.method)||p.voiceEcho||p.loopA)return p;
  const D=p.duration;
  const covered=(an:TrackAnalysis,from:number,to:number)=>{
    const v=an.vocalActivity;
    if(!v||!Number.isFinite(v.rate)||v.rate<=0||from<0||to<=from||to*v.rate>v.values.length)return false;
    for(let i=Math.floor(from*v.rate);i<Math.ceil(to*v.rate);i++)if(!Number.isFinite(v.values[i])||v.values[i]<0||v.values[i]>1)return false;
    return true;
  };
  if(A?.vocalActivity&&!B?.vocalActivity){
    const gB=p.automation.find(l=>l.deck==='B'&&l.lane==='gain')?.points??[[0,1]] as [number,number][];
    // B may sing immediately. A must be quiet before B reaches even -18 dB.
    let deadline=0;
    while(deadline<Math.min(1,D*.35)&&pointValue(gB,deadline)<.12)deadline+=.02;
    deadline=Math.max(0,deadline-.04);
    if(deadline<.1)return p;
    const src=(t:number)=>p.aExit+integrateTempo(p.tempoA,t),words=lyricTiming(A);
    if(!covered(A,src(0),src(deadline+.08)))return p;
    let end=-1;
    for(let t=.08;t<=deadline;t+=.02){
      if(vocalMean(A,src(t-.06),src(t+.08))>.12)continue;
      if(words?.edit.some(([a,b])=>src(t)>a&&src(t-.06)<b))continue;
      end=t;
    }
    if(end<0)return p;
    end=rounded(end);
    const from=rounded(Math.max(0,end-.06));
    const automation=s.eqHandoff?guardLanes(p.automation,from,end,D,{mid:BLEED_MID,high:BLEED_HIGH}):p.automation;
    return {...p,vocalA:[[0,1],[from,1],[end,0],[D,0]],vocalB:undefined,automation,
      reasons:[...p.reasons,'готов только текущий вокал: он уходит в измеренной паузе до заметного входа следующего трека; новый голос не заглушается'],
      debug:{...p.debug,stems:{policy:'one-sided-a-1',model:A.vocalActivity.model,source:'demucs',vocalHandoff:end,
        incomingUnknown:true,lostB:0,bleedGuard:s.eqHandoff?{from,to:end,mid:BLEED_MID,high:BLEED_HIGH}:null}}};
  }
  if(B?.vocalActivity&&!A?.vocalActivity){
    const src=(t:number)=>p.bEntry+integrateTempo(p.tempoB,t);
    if(!covered(B,src(0),src(D)))return p;
    const v=B.vocalActivity;
    let first=Infinity;
    // The first measured attack, not the later 180 ms phrase threshold.
    for(let i=Math.floor(p.bEntry*v.rate);i<Math.ceil(src(D)*v.rate);i++)if(v.values[i]>=.28){first=Math.max(p.bEntry,i/v.rate);break;}
    if(!Number.isFinite(first)||first<=p.bEntry)return p;
    const attack=outputTimeAt(p.tempoB,first-p.bEntry,D),end=rounded(attack-.15);
    if(end<.8||end>D*.85)return p;
    // Don't mistake a weak earlier sung line for an instrumental opening.
    if(vocalMean(B,p.bEntry,first)>.12)return p;
    // Use most of the measured lead: a 0.6 s whole-deck fade before B's words sounded like Next (dislike 231).
    const fade=Math.min(4,Math.max(.6,end*.8)),from=rounded(end-fade);
    const gain=p.automation.find(l=>l.deck==='A'&&l.lane==='gain')?.points??[[0,1]] as [number,number][];
    const knots=[...new Set([0,...gain.map(([t])=>t),...Array.from({length:13},(_,i)=>from+fade*i/12),end,D])].filter(t=>t>=0&&t<=D).sort((a,b)=>a-b);
    const envelope=(t:number)=>t<=from?1:t>=end?0:.5+.5*Math.cos(Math.PI*(t-from)/fade);
    // A leaves early: B's fader and EQ must finish here, not at the old long blend's end.
    const incoming=p.automation.map(l=>{
      if(l.deck!=='B'||!['gain','low','mid','high'].includes(l.lane))return l;
      const times=[...new Set([...l.points.map(([t])=>t),...knots])].sort((a,b)=>a-b);
      return {...l,points:times.map(t=>{
        const outgoing=envelope(t),floor=l.lane==='gain'?Math.sqrt(Math.max(0,1-outgoing*outgoing)):1-outgoing;
        return [rounded(t),rounded(Math.max(pointValue(l.points,t),floor))] as [number,number];
      })};
    });
    // The echo send is pre-fader; an unknown A voice cannot remain in its delay buffer.
    const automation=[...incoming.filter(l=>!(l.deck==='A'&&(l.lane==='gain'||l.lane==='echo'))),
      {deck:'A' as const,lane:'gain' as const,points:knots.map(t=>[rounded(t),rounded(Math.min(pointValue(gain,t),envelope(t)))] as [number,number])}];
    return {...p,automation,echo:automation.some(l=>l.lane==='echo')?p.echo:undefined,vocalA:undefined,vocalB:undefined,
      reasons:[...p.reasons,'готов только анализ нового голоса: текущий трек плавно уходит до его первого измеренного вступления; голос после выбранной точки входа не заглушается'],
      debug:{...p.debug,stems:{policy:'one-sided-b-2',model:v.model,source:'demucs',outgoingUnknown:true,
        vocalHandoff:end,bVoiceStart:rounded(attack),lostB:0,wholeDeckFade:{from,to:end}}}};
  }
  return p;
}

export function applyVocalHandoff(plan:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings):TransitionPlan {
  if(plan.debug.processingAllowed===false)return {...plan,vocalA:undefined,vocalB:undefined,voiceEcho:undefined,
    automation:plan.automation.filter(l=>l.lane!=='voiceEcho')};
  if(!s.enabled||s.stemMixing===false||plan.duration<0.7
    ||['skip_fade','gapless'].includes(plan.method))return plan;
  if(!A?.vocalActivity||!B?.vocalActivity)return partialVocalHandoff(plan,A,B,s);
  const covered=(an:TrackAnalysis,from:number,to:number)=>{
    const v=an.vocalActivity!;
    if(!Number.isFinite(v.rate)||v.rate<=0||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from
      ||Math.ceil((to-1e-8)*v.rate)>v.values.length)return false;
    for(let i=Math.floor(from*v.rate);i<Math.ceil((to-1e-8)*v.rate);i++)if(!Number.isFinite(v.values[i])||v.values[i]<0||v.values[i]>1)return false;
    return true;
  };
  const validA=covered(A,plan.aExit,Math.min(A.duration,plan.aExit+integrateTempo(plan.tempoA,plan.duration)));
  const validB=covered(B,plan.bEntry,plan.bEntry+integrateTempo(plan.tempoB,plan.duration));
  if(!validA||!validB){
    const clean=plan.vocalA||plan.vocalB||plan.voiceEcho||plan.automation.some(l=>l.lane==='voiceEcho')
      ?{...plan,vocalA:undefined,vocalB:undefined,voiceEcho:undefined,automation:plan.automation.filter(l=>l.lane!=='voiceEcho')}:plan;
    return partialVocalHandoff(clean,validA?A:{...A,vocalActivity:undefined},validB?B:{...B,vocalActivity:undefined},s);
  }
  const D=plan.duration,drop=plan.method==='drop_mix';
  const phrasesA=vocalPhrases(A),phrasesB=vocalPhrases(B),lyricsA=lyricTiming(A),lyricsB=lyricTiming(B);
  const region=plan.beatAlign?.regions?.A;
  const beat=region?.period??(plan.beatAlign?60/plan.beatAlign.bpmA:A.beat?.period)??0.5;
  const srcA=(t:number)=>plan.aExit+integrateTempo(plan.tempoA,t);
  const srcB=(t:number)=>plan.bEntry+integrateTempo(plan.tempoB,t);
  const gainOf=(deck:'A'|'B')=>plan.automation.find(l=>l.deck===deck&&l.lane==='gain')?.points??[[0,1]] as [number,number][];
  const gA=gainOf('A'),gB=gainOf('B');
  // The voice changes hands where B is audibly louder than A, not at the "now playing"
  // label: a crossfade over A's own decay put swapAt at 0.65 s and cut A's voice at once.
  const power=(an:TrackAnalysis,t:number)=>{const c=an.curves;let sum=0,n=0;
    for(let i=Math.max(0,Math.floor((t-0.75)*c.rate));i<Math.min(c.rmsDb.length,Math.ceil((t+0.75)*c.rate));i++){sum+=10**(c.rmsDb[i]/10);n++;}return n?sum/n:0;};
  let takeover=plan.swapAt;
  // only an early label is moved; otherwise the old voice still ends by swapAt
  if(!drop&&plan.swapAt<D*0.3)for(let t=0;t<D;t+=0.1){
    const a=pointValue(gA,t)**2*power(A,srcA(t))*10**(plan.gainA/10),b=pointValue(gB,t)**2*power(B,srcB(t))*10**(plan.gainB/10);
    if(b>=a){takeover=Math.max(plan.swapAt,t);break;}
  }
  const swap=Math.max(0.2,Math.min(D-0.35,takeover));
  // B's words carry the new song's meaning; A's line should end musically but may yield
  const STEP=0.05,SHORT=0.08,LOST=0.4,WORD_A=0.06,WORD_B=0.12,N=Math.ceil(D/STEP);
  // audible singing per grid step (activity above the stem's noise floor x deck gain), prefix sums in seconds
  const heard=(an:TrackAnalysis,src:(t:number)=>number,g:[number,number][])=>{
    const sum=[0];for(let i=0;i<N;i++){const t=i*STEP;sum.push(sum[i]+clamp((vocalMean(an,src(t),src(t+STEP))-0.15)/0.7)*pointValue(g,t)*STEP);}
    return (t:number)=>sum[Math.max(0,Math.min(N,Math.round(t/STEP)))];
  };
  const heardA=heard(A,srcA,gA),heardB=heard(B,srcB,gB);
  const window=Math.max(beat*8,1);
  // long blends may hand the voice over well before the swap when B already sings:
  // lost audible words of both tracks decide, not a fixed window
  // On a locked grid B's voice may ride over A's instrumental from early on (both grooves
  // agree), so B's words never wait for a fixed window; unlocked grooves keep the window.
  const locked=plan.method==='beatmatch_blend';
  const lo=drop?swap:locked?Math.min(swap,D*.1+SHORT):Math.max(Math.min(swap,D*.1+SHORT),Math.min(swap-beat*8,swap*.5));
  const fadeB=0.12;
  let best={score:-Infinity,aEnd:swap,aGap:0,bStart:swap,bGap:0};
  // Compute incoming candidates once, not once for every outgoing candidate.
  // A phrase can contain many low-energy consonants: only a genuine gap can
  // receive the fade-in, which must finish BEFORE the incoming attack.
  const incomingAt=(b:number)=>{
    const x=srcB(b);
    const testedFade=fitFadeInBreath(b,fadeB,'in',phrasesB,lyricsB,plan.bEntry,plan.tempoB,D);
    let bGap=(1-vocalMean(B,x-0.15,x+0.1))*phraseGap(phrasesB,srcB(b),srcB(b+testedFade+0.035));
    let arrival=clamp((vocalMean(B,x+0.1,x+0.9)-0.25)/0.4);
    let wordSafeBonus=0;
    // B's voice opens before the first word of a line, never on top of a word
    // Prefer a genuinely clear word boundary over the existing tolerant
    // fallback a few milliseconds earlier. Keep this bonus below the cost of
    // one lost word: waiting for another whole word is not an improvement.
    if(lyricsB){const open=srcB(b+testedFade),from=srcB(b);
      const chopped=lyricsB.words.some(([w0,w1])=>open>w0+0.08&&from<w1-0.05);
      // recognised words may only confirm a pause that the measurement does not contradict
      const clear=!lyricsB.edit.some(([w0,w1])=>open>w0+0.001&&from<w1-0.001);
      if(clear)wordSafeBonus=0.1;
      if(chopped)bGap=Math.min(bGap,0.3);
      else if(clear){const next=lyricsB.lines.find(([s0])=>s0>=open),lineStart=!!next&&next[0]-open<1&&!!betweenLines(lyricsB,from);
        bGap=Math.max(bGap,lineStart?1:0.75);arrival=Math.max(arrival*0.5,lineStart?1:0);}}
    // every recognised word of B already sung before its voice opens is lost to the listener
    const lostWords=lyricsB?wordsIn(lyricsB,srcB(0),srcB(b)):0;
    return {b,bGap,score:bGap+0.2*bGap*arrival+wordSafeBonus-LOST*heardB(b)-WORD_B*lostWords};
  };
  const incoming=[...new Set([...Array.from({length:N+1},(_,i)=>i*STEP),
    ...breathCandidates(phrasesB,lyricsB,plan.bEntry,plan.tempoB,D,'in')])].sort((a,b)=>a-b).map(incomingAt);
  // Inside [e,e+window] the gap reward is linear in b. An exact range
  // maximum replaces the quadratic scan without reducing candidate coverage.
  const maxima=drop?null:new RangeMaximum(incoming.map(c=>c.score+0.1*c.b/window));
  const outgoing=[...new Set([...Array.from({length:Math.max(0,Math.floor((swap-lo+1e-9)/STEP))+1},(_,i)=>swap-i*STEP),
    ...breathCandidates(phrasesA,lyricsA,plan.aExit,plan.tempoA,D,'out').filter(t=>t>=lo&&t<=swap)])].sort((a,b)=>b-a);
  for(const e of outgoing){
    const t=srcA(e);
    const testedFade=fitFadeInBreath(e,SHORT,'out',phrasesA,lyricsA,plan.aExit,plan.tempoA,D);
    let aGap=(1-vocalMean(A,t-SHORT-0.05,t+0.35))*phraseGap(phrasesA,srcA(Math.max(0,e-testedFade)),t);
    let phraseEnd=clamp((vocalMean(A,t-1.6,t-0.2)-0.25)/0.4);
    // Recognised words outrank the activity curve: a legato word boundary is a clean edit,
    // the pause after a sung line is the best exit, and a fade inside a word is never chosen.
    let split=false;
    if(lyricsA){const from=srcA(Math.max(0,e-testedFade));
      split=lyricsA.edit.some(([w0,w1])=>t>w0+0.001&&from<w1-0.001);const line=betweenLines(lyricsA,t);
      aGap=split?0:Math.max(aGap,line?1:0.75);phraseEnd=Math.max(phraseEnd*0.5,line);}
    // A's words still audible between e and the swap are lost
    // a chopped last word costs about one second of masked singing, not more: B's words count too
    const aScore=aGap+0.15*phraseEnd-LOST*(heardA(swap)-heardA(e))-(split?0.4:0)-(lyricsA?WORD_A*wordsIn(lyricsA,t,srcA(swap)):0);
    const hi=Math.min(D-fadeB,e+(drop?0:window));
    let first=0,last=incoming.length;
    while(first<last){const middle=(first+last)>>>1;if(incoming[middle].b<e-1e-9)first=middle+1;else last=middle;}
    let upper=first,right=incoming.length;
    while(upper<right){const middle=(upper+right)>>>1;if(incoming[middle].b<=hi+1e-9)upper=middle+1;else right=middle;}
    const index=maxima?.best(first,upper)??-1;
    if(drop||index>=0){
      const candidate=drop?incomingAt(e):incoming[index];
      const {b,bGap,score:bScore}=candidate;
      if(b>hi+1e-9)continue;
      // B's words already audible before its voice opens are lost too
      const score=aScore+bScore+0.1*clamp((b-e)/window);
      if(score>best.score)best={score,aEnd:e,aGap,bStart:b,bGap};
    }
  }
  const {aEnd,bStart}=best;
  const breath=best.aGap>=0.75,softB=best.bGap<0.75&&!drop;
  // no breath before the swap: a longer fade hides the cut, still finished by aEnd
  const fadeA=fitFadeInBreath(aEnd,breath||drop?Math.min(SHORT,aEnd):Math.min(0.45,Math.max(SHORT,aEnd*.5)),
    'out',phrasesA,lyricsA,plan.aExit,plan.tempoA,D);
  const appliedFadeB=fitFadeInBreath(bStart,softB?0.3:fadeB,'in',phrasesB,lyricsB,plan.bEntry,plan.tempoB,D);
  const bOpen=Math.min(D,bStart+appliedFadeB);
  // Fade windows clear of measured/verified singing. Both false = continuous singing on both
  // sides: the soft fallback, a candidate for moving the handoff elsewhere (planner re-search).
  const clearOf=(spans:[number,number][],from:number,to:number)=>!spans.some(([a,b])=>to>a+0.001&&from<b-0.001);
  const editA=lyricsA?.edit??phrasesA.filter(p=>p.confidence>=0.35).map(p=>[p.start,p.end] as [number,number]);
  const editB=lyricsB?.edit??phrasesB.filter(p=>p.confidence>=0.35).map(p=>[p.start,p.end] as [number,number]);
  const cleanA=clearOf(editA,srcA(Math.max(0,aEnd-fadeA)),srcA(aEnd)),cleanB=clearOf(editB,srcB(bStart),srcB(bOpen));
  const reasons=[...plan.reasons,'выделенные вокальные партии передаются отдельно от инструментала, без наложения основных голосов',
    breath?'голос текущего трека заканчивается в паузе до смены основы':'пауза в голосе не найдена: голос текущего трека плавно уводится к моменту смены',
    best.bGap>=0.75?'голос следующего трека открывается в начале своей фразы':'голос следующего трека мягко открывается сразу после текущего'];
  // vocal throw: echo of the last sung word, quiet (< -40 dB) before B's voice opens
  let voiceEcho:TransitionPlan['voiceEcho'];let throwLane:TransitionPlan['automation'][number]|undefined;
  let delay=beat/Math.max(0.5,pointValue(plan.tempoA??[],aEnd));
  while(delay<0.3)delay*=2;while(delay>0.8)delay/=2;
  let lastWord:number|null=null;
  for(let t=aEnd;t>=Math.max(STEP,aEnd-1.5);t-=STEP)if(vocalMean(A,srcA(t-STEP),srcA(t))>0.35){lastWord=t;break;}
  const repeatsBefore=Math.ceil((bStart-aEnd)/delay-1e-9);
  if(lastWord!==null&&!drop&&repeatsBefore>=2){
    const level=Math.max(0.2,0.55*pointValue(gA,lastWord));
    let feedback=Math.min(0.5,Math.pow(0.01/level,1/(repeatsBefore-1)));
    if(feedback<0.12)feedback=0;
    const from=Math.max(0.02,lastWord-Math.min(delay,0.5));
    voiceEcho={delay:rounded(delay),feedback:rounded(feedback)};
    throwLane={deck:'A',lane:'voiceEcho',points:[[0,0],[rounded(from),0],[rounded(from+0.04),rounded(level)],[rounded(aEnd),rounded(level)],[rounded(aEnd+0.03),0]]};
    reasons.push('последнее слово текущего голоса повторяется эхом и затихает до входа нового голоса');
  }
  // Bleed guard: the separated voice never contains all of A's singing (reverb, doubles,
  // backing vocals stay in the accompaniment). Re-separating rendered handoffs measured it at
  // -18..-58 dB under A's lead after B's voice opened, while the clean stem through the mask was
  // below -70 dB. Like a DJ cutting the outgoing mids, A's voice band (and part of its air) goes
  // down between A's voice leaving and B's opening, only when A would still sing and B sings.
  const aWouldSing=vocalMean(A,srcA(aEnd),srcA(D))>0.2,bSings=vocalMean(B,srcB(bStart),srcB(D))>0.2;
  let automation=[...plan.automation.filter(l=>l.lane!=='voiceEcho'),...(throwLane?[throwLane]:[])];
  let bleedGuard:{from:number;to:number;mid:number;high:number}|null=null;
  if(aWouldSing&&bSings&&!drop&&s.eqHandoff!==false){
    // Suppress the residual BEFORE B starts opening, including its first
    // consonant. Waiting until bOpen (or imposing a 250 ms minimum) left A's
    // backing/doubles exposed underneath the new singer on tight handoffs.
    const from=rounded(Math.max(0,aEnd-fadeA)),to=rounded(bStart);
    bleedGuard={from,to,mid:BLEED_MID,high:BLEED_HIGH};
    automation=guardLanes(automation,from,to,D,{mid:BLEED_MID,high:BLEED_HIGH});
    reasons.push('остаток старого голоса в аккомпанементе приглушается: вокальная полоса уходящего трека убирается к входу нового голоса');
  }
  return {...plan,
    vocalA:[[0,1],[rounded(Math.max(0,aEnd-fadeA)),1],[rounded(aEnd),0],[rounded(D),0]],
    vocalB:[[0,0],[rounded(bStart),0],[rounded(bOpen),1],[rounded(D),1]],
    automation,voiceEcho,
    reasons,
    debug:{...plan.debug,stems:{model:A.vocalActivity.model,source:'demucs',policy:'phrase-safe-v3',vocalHandoff:rounded(aEnd),bVoiceStart:rounded(bStart),
      aBreath:breath,bBreath:best.bGap>=0.75,lostA:rounded(heardA(swap)-heardA(aEnd)),lostB:rounded(heardB(bStart)),
      phrasesA:phrasesA.length,phrasesB:phrasesB.length,bleedGuard,fadeA:rounded(fadeA),fadeB:rounded(bOpen-bStart),cleanA,cleanB,
      ...(lyricsA||lyricsB?{lyrics:{a:!!lyricsA,b:!!lyricsB,verifiedA:!!lyricsA?.verified,verifiedB:!!lyricsB?.verified,
        // words a listener loses: A's still unsung words after its voice leaves (until A's gain is gone), B's words before it opens
        lostWordsA:lyricsA?wordsIn(lyricsA,srcA(aEnd),srcA(Math.min(D,lastAudible(gA,D)))):null,
        lostWordsB:lyricsB?wordsIn(lyricsB,srcB(0),srcB(bStart)):null}}:{}),
      voiceEcho:voiceEcho??null,entryScore:rounded(vocalEntryScore(A,B,srcA(aEnd),srcB(bStart)))}},
  };
}
