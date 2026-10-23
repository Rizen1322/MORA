import { camelotCompatibility } from '../mir/key.ts';
import { closureAt } from '../mir/repetition.ts';
import { applyVocalHandoff, lyricTiming, vocalEntryScore, vocalMean, vocalPhrases, vocalPowerRetained, vocalStarts } from './vocals.ts';
import { drain, integrateTempo, linearPower, outputTimeAt, pointValue } from './timing.ts';
import { withInstrumentalLoop } from './loop.ts';
import { withMasterTempo } from './master-tempo.ts';
import { withDjPhrasing } from './dj-phrasing.ts';
import { firstVoice, outgoingPhraseCut, preserveFirstWords, withVocalGap } from './first-words.ts';
import { withMicroOnset } from './micro-onset.ts';
import { withVoiceAnswer } from './answer.ts';
import { withHarmonicHandoff } from './harmonic.ts';
import { withTapeStop } from './tape-stop.ts';
import { planEchoOut } from './unlocked.ts';
import { bodyDensity, fullMixCost, fullMixPair, localClashFraction, pickupLost, voiceUnknown, withBassShift, type FullMixCost } from './fullmix.ts';
import {
  PLANNER_VERSION,
  type AutoMixSettings,
  type BeatGrid,
  type BeatRegion,
  type AutomationLane,
  type CueCandidate,
  type PlannerTrack,
  type TrackAnalysis,
  type TransitionMethod,
  type TransitionPlan,
} from '../types.ts';

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Static loudness normalization gain (dB) for a track. */
export function normalizationGain(an: TrackAnalysis | null, target: number | null): number {
  if (!an || target === null) return 0;
  const l = an.loudness;
  if (!Number.isFinite(l.integratedLufs) || l.integratedLufs <= -69) return 0;
  let g = target - l.integratedLufs;
  // allow the master limiter to absorb at most ~3 dB of peaks
  g = Math.min(g, -1 - l.truePeakDb + 3);
  return r3(clamp(g, -18, 12));
}

export interface TempoRelation {
  /** B playback speed. */
  ratio: number;
  /** Output B beats per A beat factor: B period after stretch = A period * m. */
  m: number;
  stretchPercent: number;
}

/** Finds how B must be stretched to lock to A, considering half/double tempo. */
export function tempoRelation(bpmA: number, bpmB: number): TempoRelation {
  const stretch = (ratio: number) => Math.max(Math.abs(ratio - 1), Math.abs(1 / ratio - 1)) * 100;
  let best: TempoRelation = { ratio: bpmA / bpmB, m: 1, stretchPercent: stretch(bpmA / bpmB) };
  for (const m of [0.5, 1, 2]) {
    const ratio = bpmA / (bpmB * m);
    const sp = stretch(ratio);
    if (sp < best.stretchPercent - 1e-9) best = { ratio, m, stretchPercent: sp };
  }
  return best;
}

function curveMean(curve: number[], rate: number, a: number, b: number): number {
  const i0 = Math.min(curve.length, Math.max(0, Math.floor(a * rate)));
  const i1 = Math.min(curve.length, Math.max(i0 + 1, Math.ceil(b * rate)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += curve[i];
  return i1 > i0 ? s / (i1 - i0) : curve[curve.length - 1] ?? 0;
}

/** Samples f over [t0, t1] into points, mapping x in 0..1 to value. */
function shape(t0: number, t1: number, f: (x: number) => number, n = 8): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push([r3(t0 + (t1 - t0) * x), r3(f(x))]);
  }
  return pts;
}

const sinUp = (x: number) => Math.sin((x * Math.PI) / 2);
const cosDown = (x: number) => Math.cos((x * Math.PI) / 2);
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/** Concatenates point lists, dropping duplicates and enforcing increasing time. */
function lane(deck: 'A' | 'B', l: AutomationLane['lane'], ...parts: [number, number][][]): AutomationLane {
  const pts: [number, number][] = [];
  for (const p of parts) {
    for (const q of p) {
      const last = pts[pts.length - 1];
      if (last && q[0] < last[0]) continue;
      if (last && q[0] === last[0]) {
        last[1] = q[1];
        continue;
      }
      pts.push([q[0], q[1]]);
    }
  }
  return { deck, lane: l, points: pts };
}

function isConsecutiveAlbum(a: PlannerTrack, b: PlannerTrack): boolean {
  if (!a.album || !b.album || a.album !== b.album) return false;
  if ((a.albumArtist ?? '') !== (b.albumArtist ?? '')) return false;
  if (a.trackNo == null || b.trackNo == null) return false;
  const discA = a.discNo ?? 1;
  const discB = b.discNo ?? 1;
  if (discA === discB) return b.trackNo === a.trackNo + 1;
  return discB === discA + 1 && b.trackNo === 1;
}

interface Ctx {
  a: PlannerTrack;
  b: PlannerTrack;
  s: AutoMixSettings;
  gainA: number;
  gainB: number;
  /** User-requested handoff: choose cues around this source position. */
  requestedAt?: number;
  regionA?: BeatRegion;
  regionB?: BeatRegion;
  /** One bounded repair: preserve the selected B entry and A's heard phrase. */
  vocalRepair?: { entry: number; minHandoff: number };
  /** Full-mix alternative (P1): a locked blend restricted to one exit/entry/length. */
  fixed?: { exit: number; entry: number; bars: number };
}

function basePlan(ctx: Ctx, method: TransitionMethod): TransitionPlan {
  const featureKey=(an:TrackAnalysis|null)=>`${an?.version}|${an?.vocalActivity?.model??''}|${an?.vocalActivity?.version??''}|${an?.vocalActivity?.revision??''}`;
  const key = `${ctx.a.id}|${ctx.b.id}|${method}|${featureKey(ctx.a.analysis)}|${featureKey(ctx.b.analysis)}|${JSON.stringify(ctx.s)}`;
  return {
    id: `tp_${fnv1a(key)}_${fnv1a(PLANNER_VERSION + key)}`,
    version: PLANNER_VERSION,
    fromTrackId: ctx.a.id,
    toTrackId: ctx.b.id,
    method,
    confidence: 0,
    reasons: [],
    aExit: 0,
    bEntry: 0,
    duration: 0,
    gap: 0,
    swapAt: 0,
    tempoB: [[0, 1]],
    automation: [],
    gainA: ctx.a.mixingAllowed&&ctx.b.mixingAllowed?ctx.gainA:0,
    gainB: ctx.a.mixingAllowed&&ctx.b.mixingAllowed?ctx.gainB:0,
    debug: { processingAllowed: ctx.a.mixingAllowed && ctx.b.mixingAllowed },
  };
}

/** Plain sequential join: A plays to its very end, B starts at 0. */
function planSequential(ctx: Ctx, reason: string, method: TransitionMethod = 'gapless'): TransitionPlan {
  const p = basePlan(ctx, method);
  p.aExit = r3(ctx.a.duration);
  p.bEntry = 0;
  p.duration = 0;
  p.swapAt = 0;
  p.confidence = 1;
  p.reasons.push(reason);
  return p;
}

function planFallbackCrossfade(ctx: Ctx, reason: string): TransitionPlan {
  const p = basePlan(ctx, 'fallback_crossfade');
  const L = Math.min(ctx.s.fallbackSeconds, ctx.s.maxBlendSeconds, ctx.a.duration * 0.15, ctx.b.duration * 0.35);
  if (L < 0.03) return planSequential(ctx, reason);
  p.aExit = r3(Math.max(0, ctx.a.duration - L));
  p.bEntry = 0;
  p.duration = r3(L);
  p.swapAt = r3(L / 2);
  p.automation = [lane('A', 'gain', shape(0, L, cosDown)), lane('B', 'gain', shape(0, L, sinUp))];
  p.confidence = 0.3;
  p.fallbackReason = reason;
  p.reasons.push(reason, 'мягкий кроссфейд по длительности файла');
  return p;
}

function sanitizedSettings(settings: AutoMixSettings): AutoMixSettings {
  // Settings may come from persisted older clients. Keep all overlap limits real
  // even for short clips and avoid NaN automation from malformed numeric values.
  return {
    ...settings,
    maxStretchPercent: clamp(Number.isFinite(settings.maxStretchPercent) ? settings.maxStretchPercent : 12, 0, 30),
    maxBlendSeconds: clamp(Number.isFinite(settings.maxBlendSeconds) ? settings.maxBlendSeconds : 32, 0, 60),
    fallbackSeconds: clamp(Number.isFinite(settings.fallbackSeconds) ? settings.fallbackSeconds : 6, 0, 20),
    entryMode: settings.entryMode === 'preserve' ? 'preserve' as const : 'smart' as const,
    maxEntrySkipSeconds: clamp(Number.isFinite(settings.maxEntrySkipSeconds) ? settings.maxEntrySkipSeconds! : 45, 0, 75),
  };
}

function safePosition(position: number, duration: number): number {
  return clamp(Number.isFinite(position)?position:0,0,Math.max(0,duration-0.01));
}

/**
 * v2: lock rhythms only when each deck needs at most this much stretch. Listener
 * ratings were bad for nearly every tempo bridge (both decks 6-12 %, 1-4 bars, two
 * audible tempo ramps) and every drop between grooves; DJs rarely move a track more
 * than 5-10 %. Wider gaps get an unlocked blend instead.
 */
export const LOCK_MAX_PERCENT = 8;
const lockLimit = (s: AutoMixSettings) => Math.min(s.maxStretchPercent, LOCK_MAX_PERCENT);
/**
 * v2.5: up to 10 % per deck is still locked when the common tempo glides over at least
 * 8 bars and 12 s (under 0.9 % per second, a DJ's slow pitch ride). Ratings did not
 * blame stretch itself (good median 7.4 %, bad 0.5 %): the bad ones were 1-4 bar
 * bridges with two quick, audible tempo ramps.
 */
export const LOCK_LONG_PERCENT = 10;
const LONG_LOCK_MIN_SECONDS = 12;
/** v13 (P1): listener ratings: locks under ~10 s were heard as switches ("резко"). */
const MIN_LOCK_SECONDS = 10;

export function planTransition(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings, requestedAt?: number): TransitionPlan {
  return drain(rankPlans(a,b,settings,requestedAt))[0];
}

/** P10 finalists for a render check: the selected plan first, up to two ranked full-mix alternatives
 * and the selected plan's bass exchange one beat earlier/later (P6). One plan unless the pair is
 * planned as a full mix (a voice unknown). */
export function planFinalists(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings): TransitionPlan[] {
  return drain(planFinalistsSteps(a,b,settings));
}

/** planFinalists in steps (one per built plan), for an in-process server that must keep serving PCM. */
export function* planFinalistsSteps(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings): Generator<void, TransitionPlan[]> {
  const ranked=yield* rankPlans(a,b,settings),top=ranked[0];
  if(!top.debug.fullMix)return [top];
  const beat=(b.analysis?.beat?.period??0.5)/pointValue(top.tempoB,top.swapAt);
  const shifted=top.method==='beatmatch_blend'||top.method==='crossfade'
    ?[-1,1].map(k=>withBassShift(top,k*beat)).filter((q):q is TransitionPlan=>!!q):[];
  return [top,...ranked.slice(1,3),...shifted];
}

function* rankPlans(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings, requestedAt?: number): Generator<void, TransitionPlan[]> {
  const p=finishPlan(buildTransition(a,b,settings,requestedAt),a.analysis,b.analysis,settings,requestedAt);
  if(requestedAt===undefined&&settings.enabled&&fullMixPair(a.analysis,b.analysis,settings)){yield;return yield* chooseFullMixPlan(p,a,b,settings);}
  return [chooseMusicalPlan(p,a,b,settings,requestedAt)];
}

/** P1: a full mix (a voice unknown) chooses among the baseline and at most three alternatives that
 * reuse the existing techniques: a lock half as long, a neighbouring exit a phrase away, an unlocked blend (shaky pulse only),
 * B from its real start. The stemless cost (fullmix.ts) judges where A really leaves, B's pickup, the
 * one-second energy path, two bass lines, possible lead overlap and local key clashes. Unknown voices
 * never score as silence; the baseline wins unless an alternative is clearly (0.1) cheaper. */
function* chooseFullMixPlan(p:TransitionPlan,a:PlannerTrack,b:PlannerTrack,settings:AutoMixSettings):Generator<void,TransitionPlan[]> {
  const A=a.analysis,B=b.analysis,s=sanitizedSettings(settings);
  if(!A||!B||p.debug.processingAllowed===false||!['crossfade','beatmatch_blend'].includes(p.method)||p.loopA)return [p];
  const build=(alt:AutoMixSettings,fixed?:Ctx['fixed'])=>finishPlan(buildTransition(a,b,alt,undefined,undefined,fixed),A,B,alt);
  const entries:[string,TransitionPlan][]=[['baseline',p]];
  if(p.method==='beatmatch_blend'&&p.beatAlign&&!p.beatAlign.regions&&A.beat){
    const bars=p.beatAlign.overlapBeats/4,barA=A.beat.period*4;
    // half the shared section at most (16 -> 8 bars), and only to fix a measured fault of the long one:
    // its own search already traded A's skipped ending against length, and short blends were rated "резко"
    const baseCost=fullMixCost(p,A,B,s);
    const fault=!!baseCost&&(baseCost.unsupported>0||baseCost.holeDb>6||baseCost.jumpDb>2||baseCost.doubleBass/p.duration>0.2);
    if(bars>4&&(fault||(p.debug.fullMixRules as {looseGrid?:boolean}|undefined)?.looseGrid)){
      const half=Math.max(4,bars/2),q=build(s,{exit:p.aExit,entry:p.bEntry,bars:half});yield;
      if(q.method==='beatmatch_blend'&&q.beatAlign?.overlapBeats===half*4)entries.push(['shorter',q]);
    }
    const tried=(p.debug.candidates as {exit:number;entry:number;bars:number}[]|undefined)??[];
    const near=tried.find(c=>c.bars===bars&&Math.abs(c.exit-p.aExit)>=4*barA-0.05&&Math.abs(c.exit-p.aExit)<=8*barA+0.05);
    if(near){
      const q=build(s,{exit:near.exit,entry:near.entry,bars:near.bars});yield;
      if(q.method==='beatmatch_blend'&&Math.abs(q.aExit-near.exit)<0.01)entries.push(['neighbor-exit',q]);
    }
    // A working lock is kept (listener ratings): unlocking is an alternative only on a shaky pulse.
    if(p.debug.fullMixRules&&(p.debug.fullMixRules as {looseGrid?:boolean}).looseGrid){
      const q=build({...s,maxStretchPercent:0});yield;
      if(q.method!=='beatmatch_blend'&&['crossfade','beatmatch_blend'].includes(q.method))entries.push(['unlocked',q]);
    }
  }
  if(s.entryMode!=='preserve'&&s.maxEntrySkipSeconds!==0&&p.bEntry-B.audibleStart>=2){
    const q=build({...s,entryMode:'preserve'});yield;
    // keeping B's opening must not cost a working lock (Voyager -> Technologic lost its 16-bar glide)
    if(['crossfade','beatmatch_blend'].includes(q.method)&&q.bEntry<p.bEntry-1&&(p.method!=='beatmatch_blend'||q.method==='beatmatch_blend'))entries.push(['preserve-start',q]);
  }
  const rated=entries.slice(0,4).map(([name,plan])=>({name,plan,cost:fullMixCost(plan,A,B,s)}));
  const base=rated[0];
  const valid=rated.filter((c):c is typeof c&{cost:FullMixCost}=>!!c.cost).sort((x,y)=>x.cost.total-y.cost.total);
  const winner=base.cost&&valid[0]&&valid[0].name!=='baseline'&&valid[0].cost.total<base.cost.total-0.1?valid[0]:base;
  const reason=!base.cost?'полосы не измерены: исходный план':winner===base?'альтернативы полного микса не дали заметного улучшения':
    winner.name==='shorter'?'полный микс: короче общий участок, A уходит по окончании своего раздела'
    :winner.name==='neighbor-exit'?'полный микс: выход на соседней фразе, где текущий трек слышно заканчивает раздел'
    :winner.name==='unlocked'?'полный микс: без стыковки ритмов, ровнее путь громкости и баса'
    :'полный микс: следующий трек входит со своего начала, без срезанного затакта и вступления';
  const debug={policy:'full-mix-1',selected:winner.name,reason,margin:0.1,
    candidates:rated.map(c=>({name:c.name,method:c.plan.method,variant:c.plan.debug.variant,duration:c.plan.duration,bEntry:c.plan.bEntry,cost:c.cost}))};
  const label=(c:typeof rated[number])=>({...c.plan,id:c===base?c.plan.id:`${c.plan.id}_${c.name}`,
    reasons:c===winner&&c!==base?[...c.plan.reasons,reason]:c.plan.reasons,debug:{...c.plan.debug,fullMix:{...debug,selected:c===winner?winner.name:debug.selected,this:c.name}}});
  return [label(winner),...[...valid.map(c=>c as typeof rated[number]),...rated.filter(c=>!c.cost)].filter(c=>c!==winner).map(label)];
}

/** At most two additional metadata plans. Unknown measurements never earn a
 * zero conflict score; the prepared baseline remains immediately usable. */
function chooseMusicalPlan(p:TransitionPlan,a:PlannerTrack,b:PlannerTrack,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  const A=a.analysis,B=b.analysis;
  if(requestedAt!==undefined||!s.enabled||!A||!B||p.debug.processingAllowed===false||p.loopA||p.beatAlign?.regions
    ||!['crossfade','beatmatch_blend'].includes(p.method)||!gridTrust(A).trusted||!gridTrust(B).trusted)return p;
  const known=firstVoice(A,Math.max(A.audibleStart,p.aExit-2),A.audibleEnd)!==null
    &&firstVoice(B,p.bEntry,p.bEntry+integrateTempo(p.tempoB,p.duration-(p.bDelay??0)))!==null
    &&measuredCurves(A,Math.max(A.audibleStart,p.aExit-2),A.audibleEnd)
    &&measuredCurves(B,p.bEntry,Math.min(B.audibleEnd,p.bEntry+integrateTempo(p.tempoB,p.duration-(p.bDelay??0))+3));
  const entries:[string,TransitionPlan][]=[['baseline',p]];
  if(known){
    const protection=p.debug.firstWords as {wholeDeckFade?:boolean;earlyStemHandoff?:boolean;previousHandoff?:number}|undefined;
    const ctx:Ctx={a,b,s:sanitizedSettings(s),gainA:p.gainA,gainB:p.gainB,
      vocalRepair:{entry:p.bEntry,minHandoff:p.aExit+integrateTempo(p.tempoA,protection?.previousHandoff??p.swapAt)-.5}};
    if(p.method==='beatmatch_blend'&&p.duration>8&&(protection?.wholeDeckFade||protection?.earlyStemHandoff)){
      const shorter=finishPlan(buildTransition(a,b,s,undefined,ctx.vocalRepair),A,B,s);
      if(shorter.method==='beatmatch_blend'&&Math.abs(shorter.bEntry-p.bEntry)<.001&&shorter.duration<p.duration-.1
        &&!shorter.beatAlign?.regions)entries.push(['short-phrase',shorter]);
    }
    const ga=A.beat,gb=B.beat;
    if(ga&&gb&&ga.stable&&gb.stable&&ga.confidence>=.8&&gb.confidence>=.8&&ga.downbeatConfidence>=.7&&gb.downbeatConfidence>=.7
      &&ga.jitterMs<=12&&gb.jitterMs<=12&&A.phraseConfidence>=.6
      &&tempoRelation(ga.bpm,gb.bpm).stretchPercent>Math.max(LOCK_LONG_PERCENT,s.maxStretchPercent)){
      const cut=planPhraseCut(ctx,A,B,p.keyInfo!,p.fallbackReason);
      if(cut?.beatAlign?.phraseAligned&&Math.abs(cut.bEntry-p.bEntry)<.001)entries.push(['phrase-cut',finishPlan(cut,A,B,s)]);
    }
  }
  const cost=(q:TransitionPlan)=>{
    if(!known||firstVoice(A,Math.max(A.audibleStart,q.aExit-2),A.audibleEnd)===null
      ||firstVoice(B,q.bEntry,q.bEntry+integrateTempo(q.tempoB,q.duration-(q.bDelay??0)))===null
      ||!measuredCurves(A,Math.max(A.audibleStart,q.aExit-2),A.audibleEnd)
      ||!measuredCurves(B,q.bEntry,Math.min(B.audibleEnd,q.bEntry+integrateTempo(q.tempoB,q.duration-(q.bDelay??0))+3)))return null;
    const at=(deck:'A'|'B',name:AutomationLane['lane'],t:number)=>pointValue(q.automation.find(l=>l.deck===deck&&l.lane===name)?.points??[[0,1]],t);
    let lostA=0,lostB=0,voiceOverlap=0,drumOverlap=0,hole=0;
    // B runs on its own clock after bDelay (silent before)
    const delay=q.bDelay??0,endB=q.bEntry+integrateTempo(q.tempoB,q.duration-delay);
    const reference=Math.min(levelBefore(A,q.aExit)+q.gainA,powerLevel(B,endB,Math.min(B.audibleEnd,endB+3))+q.gainB);
    for(let i=0;i<32;i++){
      const t=q.duration*(i+.5)/32,dt=q.duration/32,tb=t-delay,sa=q.aExit+integrateTempo(q.tempoA,t),sb=q.bEntry+integrateTempo(q.tempoB,Math.max(0,tb));
      const va=vocalMean(A,sa,sa+.05),vb=tb<0?0:vocalMean(B,sb,sb+.05),ma=pointValue(q.vocalA??[[0,1]],t),mb=pointValue(q.vocalB??[[0,1]],tb);
      const ag=at('A','gain',t),bg=tb<0?0:at('B','gain',tb);
      lostA+=va*(1-Math.min(1,ag*ma))*dt;lostB+=vb*(1-Math.min(1,bg*mb))*dt;
      voiceOverlap+=Math.min(va*ag*ma,vb*bg*mb)*dt;
      if(q.method!=='beatmatch_blend')drumOverlap+=Math.min(ag*at('A','low',t),bg*at('B','low',tb))*dt*A.rhythmStrength*B.rhythmStrength;
      const power=ag*ag*filteredPower(A,sa,q.gainA,at('A','low',t),at('A','mid',t),at('A','high',t),ma)
        +bg*bg*filteredPower(B,sb,q.gainB,at('B','low',tb),at('B','mid',tb),at('B','high',tb),mb);
      hole=Math.max(hole,reference-10*Math.log10(Math.max(1e-12,power))-3);
    }
    const tail=q.aExit+integrateTempo(q.tempoA,q.duration);
    if(tail<A.audibleEnd)lostA+=vocalMean(A,tail,A.audibleEnd)*(A.audibleEnd-tail);
    const total=.16*lostA+.8*lostB+.5*voiceOverlap+.2*drumOverlap+.2*Math.max(0,hole)+(q.method==='phrase_cut'?.3:0);
    if(!Number.isFinite(total))return null;
    return {total:r3(total),cutA:!!outgoingPhraseCut(q,A),lostA:r3(lostA),lostB:r3(lostB),voiceOverlap:r3(voiceOverlap),drumOverlap:r3(drumOverlap),holeDb:r3(Math.max(0,hole))};
  };
  const rated=entries.map(([name,plan])=>({name,plan,cost:cost(plan)}));
  let winner=rated[0];
  // A completed utterance breaks a close tie only without extra incoming loss or overlap.
  for(const c of rated.slice(1))if(c.cost&&winner.cost
    &&(c.cost.total<winner.cost.total-.15||winner.cost.cutA&&!c.cost.cutA&&c.cost.total<=winner.cost.total
      &&c.cost.lostB<=winner.cost.lostB&&c.cost.voiceOverlap<=winner.cost.voiceOverlap)
    &&c.cost.holeDb<=Math.max(3,winner.cost.holeDb+.5))winner=c;
  const reason=!known?'измерения неполны: исходный план, неизвестный вокал не оценивался как тишина':winner.name==='baseline'?'альтернативы не дали подтверждённого улучшения с запасом':'меньше потерянных фраз и конфликтов без ухудшения расчётного провала мощности';
  return {...winner.plan,id:winner.name==='baseline'?p.id:`${winner.plan.id}_${winner.name}`,
    reasons:winner.name==='baseline'?p.reasons:[...winner.plan.reasons,reason],
    debug:{...winner.plan.debug,candidateSelection:{policy:'metadata-candidates-1',baseline:'baseline',selected:winner.name,reason,
      knownCoverage:known,margin:.15,candidates:rated.map(c=>({name:c.name,method:c.plan.method,duration:c.plan.duration,cost:c.cost}))}}};
}

function finishPlan(plan:TransitionPlan,A:TrackAnalysis|null,B:TrackAnalysis|null,s:AutoMixSettings,requestedAt?:number):TransitionPlan {
  const timed=withMasterTempo(plan,A,B,s,requestedAt);
  const p=applyVocalHandoff(holdLoudness(timed,A,B),A,B,s);
  // Existing caches keep their previous loudness behavior. Fresh measured
  // accompaniment curves reveal holes hidden by the full-mix RMS estimate.
  const held=(p.vocalA||p.vocalB)&&(A?.vocalActivity?.accompanimentRmsDb||B?.vocalActivity?.accompanimentRmsDb)?holdLoudness(p,A,B):p;
  const result = s.eqHandoff && requestedAt === undefined && held.method === 'beatmatch_blend' && A && B ? phraseBassSwap(held, A, B) : held;
  const bassed = s.eqHandoff && requestedAt === undefined && A && B ? bassContinuity(result, A, B) : result;
  const decorated=withDjPhrasing(withInstrumentalLoop(bassed, A, B, s, requestedAt), A, B, s, requestedAt);
  const protectedPlan=requestedAt===undefined?withVocalGap(preserveFirstWords(decorated,A,B,s),A,B,s):decorated;
  // Later passes time B from the overlap start; a delayed B start keeps the plan as protected.
  if(protectedPlan.bDelay||protectedPlan.debug.vocalGap)return protectedPlan;
  const onset=withMicroOnset(protectedPlan,A,B,s,requestedAt);
  return withTapeStop(withHarmonicHandoff(withVoiceAnswer(onset,A,B,s,requestedAt),A,B,s,requestedAt),A,B,s,requestedAt);
}

/**
 * Equal-power gains plus band handoffs (bass swap, tamed mids/highs) attenuate
 * both decks in the middle at once: the summed power used to sag 4-5 dB there.
 * Estimate the audible power along the plan from measured band levels and
 * raise both decks where it falls below the line from A's level before the
 * transition to B's level after it. Only raises (at most +3 dB) and never
 * above a deck's own level (gain 1), like a DJ pushing a fader back up; never
 * cuts: a quieter musical passage stays quieter, it is not hollowed out twice.
 */
function holdLoudness(p: TransitionPlan, A: TrackAnalysis | null, B: TrackAnalysis | null): TransitionPlan {
  if (!A || !B || p.duration < 1 || !['crossfade', 'beatmatch_blend'].includes(p.method)) return p;
  // faders first; if they are already up, open tamed mids/highs (never the bass swap)
  return raiseLanes(raiseLanes(p, A, B, ['gain']), A, B, ['mid', 'high']);
}

function raiseLanes(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, lanes: AutomationLane['lane'][]): TransitionPlan {
  const D = p.duration;
  const pts = (deck: 'A' | 'B', l: AutomationLane['lane']) => p.automation.find((x) => x.deck === deck && x.lane === l)?.points;
  const at = (points: [number, number][] | undefined, t: number) => (points ? pointValue(points, t) : 1);
  const before = levelBefore(A, p.aExit) + p.gainA;
  const bEnd = p.bEntry + integrateTempo(p.tempoB, D);
  const after = powerLevel(B, bEnd, Math.min(B.audibleEnd, bEnd + 6)) + p.gainB;
  const N = 16, maxBoost = Math.pow(10, 3 / 20);
  const boost: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = (D * i) / N;
    const ga = at(pts('A', 'gain'), t), gb = at(pts('B', 'gain'), t);
    const sum = ga * ga * filteredPower(A, p.aExit + integrateTempo(p.tempoA, t), p.gainA, at(pts('A', 'low'), t), at(pts('A', 'mid'), t), at(pts('A', 'high'), t),at(p.vocalA,t))
      + gb * gb * filteredPower(B, p.bEntry + integrateTempo(p.tempoB, t), p.gainB, at(pts('B', 'low'), t), at(pts('B', 'mid'), t), at(pts('B', 'high'), t),at(p.vocalB,t));
    const target = Math.pow(10, (before + (after - before) * (t / D)) / 10);
    const held = typeof p.debug.holdUntil === 'number' && t > p.debug.holdUntil;
    boost.push([r3(t), held ? 1 : Math.min(maxBoost, Math.max(1, Math.sqrt(target / Math.max(1e-12, sum))))]);
  }
  // the edges stay exact: the transition starts and ends at the tracks' own levels
  boost[0][1] = 1; boost[N][1] = 1;
  if (boost.every(([, k]) => k < 1.02)) return p;
  const guard = (p.debug.stems as { bleedGuard?: { from: number } | null } | undefined)?.bleedGuard;
  const automation = p.automation.map((l) => {
    if (!lanes.includes(l.lane)) return l;
    const knots = [...new Set([...l.points.map(([t]) => t), ...boost.map(([t]) => t)])].filter((t) => t <= D + 1e-9).sort((x, y) => x - y);
    const tail = l.points.filter(([t]) => t > D + 1e-9);
    // the bleed guard deliberately keeps A's voice band down: loudness comes from the rest
    const guarded = l.deck === 'A' && (l.lane === 'mid' || l.lane === 'high') && guard;
    const raised = (t: number) => { const g = pointValue(l.points, t); return guarded && t >= guard.from ? g : Math.max(0, g, Math.min(1, g * pointValue(boost, t))); };
    return { ...l, points: [...knots.map((t) => [t, r3(raised(t))] as [number, number]), ...tail] };
  });
  const peak = Math.max(...boost.map(([, k]) => k));
  const first = p.debug.loudnessHold === undefined;
  return { ...p, automation, reasons: first ? [...p.reasons, 'громкость в середине перехода выровнена по измеренным полосам: без ямы от одновременного спада обеих дек'] : p.reasons,
    debug: { ...p.debug, loudnessHold: [...((p.debug.loudnessHold as number[] | undefined) ?? []), r3(20 * Math.log10(peak))] } };
}

function buildTransition(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings, requestedAt?: number,vocalRepair?:Ctx['vocalRepair'],fixed?:Ctx['fixed']): TransitionPlan {
  const s = sanitizedSettings(settings);
  const ctx: Ctx = {
    a,
    b,
    s,
    gainA: normalizationGain(a.analysis, settings.loudnessTarget),
    gainB: normalizationGain(b.analysis, settings.loudnessTarget),
    requestedAt,
    vocalRepair,
    fixed,
  };
  if (s.maxBlendSeconds < 0.03) return planSequential(ctx, 'наложение выключено в настройках длительности');
  if (!settings.enabled) return planSequential(ctx, 'AutoMix выключен: треки играют подряд');
  if (!a.mixingAllowed || !b.mixingAllowed) {
    ctx.gainA=0;ctx.gainB=0;
    return planSequential(ctx, 'источник не разрешает обработку звука: без наложения');
  }
  if (settings.respectAlbums && isConsecutiveAlbum(a, b)) {
    return planSequential(ctx, 'треки одного альбома идут подряд: без паузы и без наложения');
  }
  const A = a.analysis;
  const B = b.analysis;
  if (!A || !B) return planFallbackCrossfade(ctx, !A && !B ? 'анализ обоих треков ещё не готов' : !A ? 'анализ текущего трека ещё не готов' : 'анализ следующего трека ещё не готов');
  if (A.warnings.includes('silent') || B.warnings.includes('silent')) {
    return planSequential(ctx, 'в треке нет звука: переход без наложения');
  }
  if (Math.min(A.audibleEnd - A.audibleStart, B.audibleEnd - B.audibleStart) < 0.06) {
    return planSequential(ctx, 'слишком короткий звуковой фрагмент для наложения');
  }

  const trustA = gridTrust(A), trustB = gridTrust(B);
  const rhythmA = !!A.beat && A.beat.confidence >= 0.45 && A.beat.stable && trustA.trusted;
  const rhythmB = !!B.beat && B.beat.confidence >= 0.45 && B.beat.stable && trustB.trusted;
  const key = camelotCompatibility(A.key.camelot, B.key.camelot);
  const keyKnown = A.key.confidence > 0.15 && B.key.confidence > 0.15 && !!A.key.camelot && !!B.key.camelot;
  const keyInfo = { a: A.key.camelot || '?', b: B.key.camelot || '?', compatibility: keyKnown ? key.score : 0.5, label: keyKnown ? key.label : 'тональность не определена уверенно' };

  let fallbackReason: string | undefined;
  if (rhythmA && rhythmB) {
    const rel = tempoRelation(A.beat!.bpm, B.beat!.bpm);
    if (rel.stretchPercent <= lockLimit(s) + 1e-6) {
      const p = planBeatmatch(ctx, A, B, rel, keyInfo);
      if (p) return p;
      fallbackReason = 'не нашлось общих фраз с достаточным запасом звука';
    } else if (rel.stretchPercent <= Math.min(s.maxStretchPercent, LOCK_LONG_PERCENT) + 1e-6 && s.style !== 'tight') {
      const p = planBeatmatch(ctx, A, B, rel, keyInfo, 8);
      if (p) return p;
      fallbackReason = `темп отличается на ${rel.stretchPercent.toFixed(1)} %: для такой разницы нужна долгая плавная стыковка, а места для неё нет — мягкий переход без стыковки ритмов`;
    } else {
      fallbackReason = `темп отличается слишком сильно для сведения по битам: ${A.beat!.bpm.toFixed(1)} и ${B.beat!.bpm.toFixed(1)} BPM (нужно ${rel.stretchPercent.toFixed(1)} %, без слышимого растяжения до ${lockLimit(s)} %): мягкий переход без стыковки ритмов`;
    }
  } else {
    fallbackReason = !A.beat || !B.beat ? 'у одного из треков нет устойчивого ритма'
      : !trustA.trusted || !trustB.trusted ? 'повторы музыки не ложатся на такты найденной сетки битов: такты не совпадут, сведение по этой сетке не используется'
      : 'сетка битов неустойчива или уверенность низкая';
  }

  // A song may change tempo, yet have a perfectly steady intro or ending.
  // Never extend a local grid beyond its independently validated region.
  // A stable whole-song estimate can still hide a different intro/outro tempo.
  // Try measured windows after any failed global lock, not only an unstable grid.
  const local=planLocalRhythm(ctx,A,B,keyInfo);
  if(local)return withGridTrust(local,trustA,trustB);
  // Downbeat-dependent techniques below must not use a grid that the repetition check rejects.
  const gridA=trustA.trusted?A:{...A,beat:null},gridB=trustB.trusted?B:{...B,beat:null};
  return withGridTrust(planUnlocked(ctx,gridA,gridB,keyInfo,fallbackReason),trustA,trustB);
}

function withGridTrust(p:TransitionPlan,a:GridTrust,b:GridTrust):TransitionPlan{
  if(a.trusted&&b.trusted)return p;
  return {...p,debug:{...p.debug,gridTrust:{A:a,B:b}}};
}

interface GridTrust { trusted: boolean; reason?: 'period-hint'; hintBpm?: number }
/** v7: repetition lags (analyzer-10 `structure.gridCheck`) test the global grid without onsets.
 * When they are whole beats of a 2:3/3:4-related tempo instead (`periodHint`), the grid's beats
 * and bars are not the music's: Beat This! agreed with the hint on 4/4 checked tracks and all
 * four rated transitions with such grids were rated bad. Fractional lags alone are not used:
 * Beat This! confirmed our tempo on such a track. Older analyses keep their behaviour. */
export function gridTrust(an: TrackAnalysis): GridTrust {
  const g = an.structure?.gridCheck;
  if (!g?.periodHint || !an.beat) return { trusted: true };
  return { trusted: false, reason: 'period-hint', hintBpm: g.periodHint.bpm };
}

/** A region that measured the same tempo family as a rejected global grid shares its error. */
function regionTrusted(an: TrackAnalysis, region: BeatRegion, trust: GridTrust): boolean {
  if (trust.trusted || !an.beat) return true;
  const family = (x: number, y: number) => [0.5, 1, 2].some(m => Math.abs(x / (y * m) - 1) < 0.03);
  if (trust.hintBpm && family(region.bpm, trust.hintBpm)) return true;
  return !family(region.bpm, an.beat.bpm);
}

function planUnlocked(ctx: Ctx, A: TrackAnalysis, B: TrackAnalysis,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>, fallbackReason?: string): TransitionPlan {
  const settings = ctx.s;
  const fadeA = naturalFade(A);
  const hardEnd = fadeA.length < 2.5 && levelMean(A, A.audibleEnd - 1.5, A.audibleEnd - 0.2) > A.bodyRmsDb - 6;
  const hardStart = levelMean(B, B.audibleStart, B.audibleStart + 0.6) > B.bodyRmsDb - 6;

  // a quick cut at a phrase is only used when the listener asked for short transitions
  const strongBeats =
    !!A.beat && !!B.beat && A.beat.stable && A.beat.confidence >= 0.5 && B.beat.confidence >= 0.45 && A.beat.downbeatConfidence >= 0.3 && A.beat.downbeats.length > 8 && B.beat.downbeats.length > 2;
  if (settings.style === 'tight' && strongBeats && fadeA.length < 6) {
    const p = planPhraseCut(ctx, A, B, keyInfo, fallbackReason);
    if (p) return p;
  }
  // interludes and stings that end and start abruptly are joined without overlap
  const shortTrack = A.audibleEnd - A.audibleStart < 30 || B.audibleEnd - B.audibleStart < 30;
  if (shortTrack && hardEnd && hardStart && !fadeA.length) return planMinimal(ctx, A, B, keyInfo, fallbackReason);
  if (A.rhythmStrength > 0.45 && B.rhythmStrength > 0.45) {
    const p = planIntroDrop(ctx, A, B, keyInfo, fallbackReason);
    if (p) return p;
  }
  const bridge = planInstrumentalBridge(ctx, A, B, keyInfo, fallbackReason);
  if (bridge) return bridge;
  if (ctx.requestedAt === undefined && A.beat && B.beat) {
    const echo = planEchoOut({ ...basePlan(ctx, 'echo_out'), keyInfo, fallbackReason }, A, B, settings, tempoRelation(A.beat.bpm, B.beat.bpm).stretchPercent);
    if (echo) return echo;
  }
  return planCrossfade(ctx, A, B, keyInfo, fallbackReason);
}

/**
 * Change tempo underneath a measured, drum-light instrumental ending. This is
 * the existing recording, never a generated/looped bridge. Require measurements
 * throughout the tail rather than calling a low average an instrumental break.
 */
function planInstrumentalBridge(ctx: Ctx, A: TrackAnalysis, B: TrackAnalysis,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>, fallbackReason?: string): TransitionPlan | null {
  if (ctx.requestedAt !== undefined || !A.vocalActivity || !ctx.s.eqHandoff
    || keyInfo.compatibility < 0.5 || !B.beat?.stable || B.beat.confidence < 0.6
    || B.beat.downbeatConfidence < 0.5) return null;
  const voice = A.vocalActivity;
  if (!(voice.rate > 0) || voice.values.length / voice.rate < A.audibleEnd - 0.1
    || !voice.values.slice(Math.floor(Math.max(0, A.audibleEnd - 8) * voice.rate)).every(Number.isFinite)) return null;
  const bodyLow = powerLevel(A, A.audibleStart, A.audibleEnd, A.curves.lowDb);
  const bodyHigh = powerLevel(A, A.audibleStart, A.audibleEnd, A.curves.highDb);
  const deClick = Math.min(0.75, B.beat.period);
  const limit = Math.min(16, ctx.s.maxBlendSeconds - deClick, (A.audibleEnd - A.audibleStart) * 0.15);
  if (!measuredCurves(A, Math.max(A.audibleStart, A.audibleEnd - limit - 8), A.audibleEnd)) return null;
  let start = A.audibleEnd;
  for (let t = A.audibleEnd - 0.25; t >= A.audibleEnd - limit; t -= 0.25) {
    if (vocalMean(A, t, t + 0.25) > 0.18
      || powerLevel(A, t, t + 0.25, A.curves.lowDb) > bodyLow - 9
      || powerLevel(A, t, t + 0.25, A.curves.highDb) > bodyHigh - 5) break;
    start = t;
  }
  const tail = A.audibleEnd - start;
  // Reject truncated scans whose true boundary is unknown. A spectral tail
  // boundary can already be 10 dB into a fade: one beat of preparation left
  // a large hole before the new deck was heard in real-library renders.
  if (tail < 2.5 || tail >= limit - 0.25
    || powerLevel(A, start - 1, start) < A.bodyRmsDb - 7) return null;
  const quietStart = start;
  // Prepare B with bass/hats held back while A still carries the mix. Hand
  // its bass over after a whole B bar, when A's measured drums have left.
  // This keeps native tempos and aligns the actual bass arrival to B's grid.
  const barB = B.beat.period * 4;
  const preparations = [1, 2, 3].map(bars => bars * barB)
    .filter(rise => rise <= 8 && tail + rise <= ctx.s.maxBlendSeconds
      && quietStart - rise >= A.audibleStart
      && powerLevel(A, quietStart - rise, quietStart - rise + 0.75) >= A.bodyRmsDb - 3.5);
  const rise = preparations[0];
  if (rise === undefined) return null;
  start -= rise;
  const D = A.audibleEnd - start;
  const outgoingVoice = vocalMean(A, start, quietStart) > 0.18;
  const candidates = entryCandidates(B, ctx.s, 0, 0, ctx.requestedAt === undefined, !A.vocalActivity && !!B.vocalActivity);
  if (ctx.s.entryMode !== 'preserve' && ctx.s.maxEntrySkipSeconds !== 0) {
    const skip = Math.min(ctx.s.maxEntrySkipSeconds ?? 45, (B.audibleEnd - B.audibleStart) * 0.45);
    for (const time of B.beat.downbeats) if (time >= B.audibleStart && time <= B.audibleStart + skip)
      candidates.push({ time, score: 0.68, kind: 'downbeat', tags: ['bridge-arrival'] });
  }
  const entries = candidates.filter(c =>
    B.beat!.downbeats.some(t => Math.abs(t - c.time) < 0.025)
    && c.time + D + 1 <= B.audibleEnd
    && measuredCurves(B, c.time, c.time + D + 1)
    // The preparation precedes the instrumental tail. If A still sings,
    // require an available vocal handoff or measured silence in B; disabling
    // stems must not turn this extension into two simultaneous singers.
    && (!outgoingVoice || !!B.vocalActivity && (ctx.s.stemMixing !== false
      || vocalMean(B, c.time, c.time + rise) <= 0.18))
    && powerLevel(B, c.time, c.time + 1) >= B.bodyRmsDb - 4
    // Don't spend a whole verse to manufacture a spectacular entry.
    && (c.time - B.audibleStart < 1 || !!B.vocalActivity && vocalMean(B, B.audibleStart, c.time) * (c.time - B.audibleStart) < 1));
  entries.sort((a, b) => entrySkipCost(B, a.time) - entrySkipCost(B, b.time) || a.time - b.time);
  const entry = entries[0];
  if (!entry) return null;
  const p = basePlan(ctx, 'crossfade');
  p.aExit = r3(start); p.bEntry = r3(entry.time); p.duration = r3(D);
  p.swapAt = r3(rise);
  p.automation = [
    lane('B', 'gain', shape(0, Math.min(3, rise), sinUp, 8)),
    lane('A', 'gain', [[0, 1]], shape(rise, D, cosDown, 10)),
    lane('A', 'low', [[0, 1]], shape(rise - deClick, rise, x => 1 - smoothstep(x), 6)),
    lane('B', 'low', [[0, 0]], shape(rise - deClick, rise, smoothstep, 6)),
    lane('B', 'high', shape(0, rise, x => 0.25 + 0.75 * smoothstep(x), 8)),
  ];
  p.confidence = r3(Math.min(0.8, B.beat.confidence));
  p.keyInfo = keyInfo; p.fallbackReason = fallbackReason;
  p.debug = { variant: 'instrumental-bridge', holdUntil: rise, measuredTail: r3(tail), preparation: r3(rise) };
  p.reasons = ['смена темпа через измеренный инструментальный хвост: следующий трек подготовлен заранее, бас входит на сильную долю после ухода старых барабанов, окончание звучит до конца'];
  describeEntry(p, B, entry);
  // The first beat alone is insufficient: a bright transient may precede a
  // quiet intro. Do not replace the established fallback with a bridge whose
  // measured one-second power sags after A has already given up its bass.
  const reference = Math.min(A.bodyRmsDb + ctx.gainA, B.bodyRmsDb + ctx.gainB);
  const value = (deck: 'A' | 'B', name: AutomationLane['lane'], t: number) => {
    const points = p.automation.find(l => l.deck === deck && l.lane === name)?.points;
    return points ? pointValue(points, t) : 1;
  };
  let hole = 0;
  for (let t = rise; t <= D + 0.001; t += 0.25) {
    const power = value('A', 'gain', t) ** 2 * filteredPower(A, start + t, ctx.gainA,
      value('A', 'low', t), 1, 1)
      + Math.pow(10, (powerLevel(B, entry.time + t - 0.25, entry.time + t + 0.5) + ctx.gainB) / 10);
    hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, power)));
  }
  if (hole > 3) return null;
  p.debug.levelHole = r3(hole);
  return p;
}

function planLocalRhythm(ctx:Ctx,A:TrackAnalysis,B:TrackAnalysis,keyInfo:NonNullable<TransitionPlan['keyInfo']>):TransitionPlan|null{
  const views=(analysis:TrackAnalysis,role:'A'|'B')=>{
    const list:{analysis:TrackAnalysis;region?:BeatRegion}[]=[];
    const trust=gridTrust(analysis);
    if(analysis.beat?.stable&&analysis.beat.confidence>=0.45&&trust.trusted)list.push({analysis});
    const limit=analysis.audibleStart+Math.min(ctx.s.maxEntrySkipSeconds??45,(analysis.audibleEnd-analysis.audibleStart)*0.45);
    for(const region of analysis.beatRegions??[]){
      if(region.confidence<0.55||region.end-region.start<12||!regionTrusted(analysis,region,trust))continue;
      if(role==='A'&&(ctx.requestedAt===undefined?region.end<analysis.audibleEnd-24:region.end<ctx.requestedAt+2||region.start>ctx.requestedAt+3))continue;
      if(role==='B'&&(region.start>limit||ctx.s.entryMode==='preserve'&&region.start>analysis.audibleStart+0.1))continue;
      const entry=region.downbeats.find(t=>t>=region.start&&t<=limit);
      list.push({region,analysis:{...analysis,beat:{...region,stable:true,alternatives:[]},
        // Global cue points can all miss the independently fitted local phase.
        // Offer its first measured bar; entryCandidates still enforces preserve
        // mode and the listener's skip limit.
        cues:role==='B'&&entry!==undefined?{...analysis.cues,entry:[...analysis.cues.entry,
          {time:entry,score:0.68,kind:'downbeat',tags:['measured-local-entry']}]}:analysis.cues,
        phrases:analysis.phrases.filter(t=>t>=region.start&&t<=region.end),
        phraseConfidence:Math.min(analysis.phraseConfidence,region.downbeatConfidence)}});
    }
    return list.slice(0,9);
  };
  let best:TransitionPlan|null=null,bestScore=-Infinity;
  for(const av of views(A,'A'))for(const bv of views(B,'B')){
    if(!av.region&&!bv.region)continue;
    const context={...ctx,regionA:av.region,regionB:bv.region};
    const rel=tempoRelation(av.analysis.beat!.bpm,bv.analysis.beat!.bpm);
    const plan=rel.stretchPercent<=lockLimit(ctx.s)+1e-6
      ?planBeatmatch(context,av.analysis,bv.analysis,rel,keyInfo)
      :rel.stretchPercent<=Math.min(ctx.s.maxStretchPercent,LOCK_LONG_PERCENT)+1e-6&&ctx.s.style!=='tight'
        ?planBeatmatch(context,av.analysis,bv.analysis,rel,keyInfo,8):null;
    if(!plan)continue;
    const cut=A.audibleEnd-plan.aExit-integrateTempo(plan.tempoA,plan.duration);
    if(ctx.requestedAt===undefined&&cut>20&&vocalMean(A,plan.aExit+integrateTempo(plan.tempoA,plan.duration),A.audibleEnd)>0.2)continue;
    const score=Number(plan.debug.score??0)+0.1*plan.confidence-0.08*Math.max(0,cut)/24;
    if(score>bestScore){
      if(plan.beatAlign){
        const summary=(r:BeatRegion)=>({start:r.start,end:r.end,period:r.period,downbeat:r.downbeats[0]});
        plan.beatAlign.regions={...(av.region?{A:summary(av.region)}:{}),...(bv.region?{B:summary(bv.region)}:{})};
      }
      best=plan;bestScore=score;
    }
  }
  if(best){best.reasons.push('сведение по проверенной локальной сетке: общий BPM всей песни не используется');
    best.debug={...best.debug,localRhythm:true};}
  return best;
}

/** Mean level (dB) of the analysis RMS curve over [a, b]. */
function levelMean(an: TrackAnalysis, a: number, b: number): number {
  return curveMean(an.curves.rmsDb, an.curves.rate, a, b);
}

/** A's level just before an exit, never below its body level - 2 dB: when the
 * exit already sits inside a quiet outro, a local reference hid the drop that
 * the listener hears relative to the song itself. */
function levelBefore(A: TrackAnalysis, exit: number): number {
  return Math.max(powerLevel(A, Math.max(A.audibleStart, exit - 6), Math.max(A.audibleStart + 0.1, exit - 1)), A.bodyRmsDb - 2);
}

/** Mean linear power; averaging dB undervalues sparse percussion and long rests. */
function powerLevel(an: TrackAnalysis, a: number, b: number, curve = an.curves.rmsDb): number {
  const lo = Math.max(0, Math.floor(a * an.curves.rate));
  const hi = Math.min(curve.length, Math.ceil(b * an.curves.rate));
  const lin = linearPower(curve);
  let power = 0;
  for (let i = lo; i < hi; i++) power += lin[i];
  return hi > lo ? 10 * Math.log10(Math.max(1e-12, power / (hi - lo))) : -90;
}

function measuredCurves(an: TrackAnalysis, from: number, to: number): boolean {
  if (!Number.isFinite(an.curves.rate) || an.curves.rate <= 0) return false;
  const lo = Math.max(0, Math.floor(from * an.curves.rate)), hi = Math.ceil(to * an.curves.rate);
  for (const c of [an.curves.rmsDb, an.curves.lowDb, an.curves.midDb, an.curves.highDb]) {
    if (c.length < hi) return false;
    for (let i = lo; i < hi; i++) if (!Number.isFinite(c[i])) return false;
  }
  return true;
}

/** Estimate the audible power after the planned three-band handoff. Using
 * local RMS and spectral proportions prevents a quiet outro + quiet intro
 * from winning merely because their levels happen to match each other. */
function filteredPower(an: TrackAnalysis, time: number, gain: number, low: number, mid: number, high: number,voiceGain=1): number {
  const t0 = Math.max(an.audibleStart, time - 0.6);
  const t1 = Math.min(an.audibleEnd, time + 0.9);
  const bands = [an.curves.lowDb, an.curves.midDb, an.curves.highDb].map((c) => Math.pow(10, curveMean(c, an.curves.rate, t0, t1) / 10));
  const total = bands[0] + bands[1] + bands[2];
  const filtered = (bands[0]*low*low + bands[1]*mid*mid + bands[2]*high*high) / Math.max(1e-12,total);
  return Math.pow(10, (powerLevel(an,t0,t1)+gain)/10) * filtered * vocalPowerRetained(an,t0,t1,voiceGain);
}

/** v11-dj-7: on bass-led (808) songs the low band carries most of the level, so the low
 * lanes, not the faders, decide when the music changes. Renders of dislikes 259/266: A's
 * bass left while B had none yet (a -10 dB hole for 4 s), and a one-beat swap moved A by
 * -25 dB and B by +12 dB within a second. A keeps its bass until B's measured bass is
 * there; between two bass-led locked songs the exchange is an equal-power bar. */
function bassContinuity(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis): TransitionPlan {
  if (p.loopA || p.debug.variant === 'intro-drop' || !['beatmatch_blend', 'crossfade'].includes(p.method)
    || (p.debug.stems as { wholeDeckFade?: unknown } | undefined)?.wholeDeckFade) return p;
  const la = p.automation.find(l => l.deck === 'A' && l.lane === 'low')?.points, lb = p.automation.find(l => l.deck === 'B' && l.lane === 'low')?.points;
  if (!la || !lb) return p;
  const D = p.duration, srcA = (t: number) => p.aExit + integrateTempo(p.tempoA, t), srcB = (t: number) => p.bEntry + integrateTempo(p.tempoB, t);
  if (!measuredCurves(A, p.aExit, srcA(D)) || !measuredCurves(B, p.bEntry, Math.min(B.audibleEnd, srcB(D) + 1))) return p;
  let from = -1, to = -1;
  for (let t = 0; t <= D; t += 0.02) { const v = pointValue(la, t); if (from < 0 && v < 0.98) from = t; if (v <= 0.02) { to = t; break; } }
  if (from < 0 || to < 0) return p;
  const cut = (from + to) / 2, low = B.curves.lowDb, bodyB = powerLevel(B, B.audibleStart, B.audibleEnd, low);
  const bassAt = (t: number) => powerLevel(B, srcB(t), srcB(t) + 1, low) >= bodyB - 8;
  let at: number | null = cut;
  if (!bassAt(cut)) {
    at = null;
    for (let t = cut; t <= D - 1; t += 0.05) if (bassAt(t) && bassAt(t + 0.5)) { at = t; break; }
    // B's own bass arrival is on its bar line: snap to the nearest B downbeat in output time
    const bars = B.beat?.downbeats ?? [];
    if (at !== null && bars.length) {
      const near = bars.map(d => outputTimeAt(p.tempoB, d - p.bEntry, D)).filter(t => t > cut && t < D - 0.5)
        .reduce<number | null>((best, t) => best === null || Math.abs(t - at!) < Math.abs(best - at!) ? t : best, null);
      if (near !== null && Math.abs(near - at) < 0.6) at = near;
    }
  }
  const led = (an: TrackAnalysis, x: number) => powerLevel(an, x, x + 2, an.curves.lowDb) >= powerLevel(an, x, x + 2) - 3;
  const beat = (B.beat?.period ?? 0.5) / pointValue(p.tempoB, at ?? cut);
  // A bass-led B is nearly silent without its low band: it grows in at -9 dB under A's bass, on a lock with a compatible key only.
  const wide = p.method === 'beatmatch_blend' && at !== null && led(B, srcB(at)) && (p.keyInfo?.compatibility ?? 0) >= 0.5;
  const pre = wide ? 0.35 : 0;
  // Unlocked bass-led songs (dislikes 256/259 after v2): a 1.2 s bass swap under A's full fader moved
  // the whole song at once. The faders now carry the exchange over 3-5 s around the swap.
  // Two unlocked grooves never share the bass: the low swap keeps its width, only the faders widen.
  const fader = p.method === 'crossfade' && !p.debug.washout && at !== null && (led(A, srcA(at)) || led(B, srcB(at)));
  const width = wide ? 4 * beat : to - from, fadeWidth = clamp(D * 0.25, 3, 5);
  if (at !== null && Math.abs(at - cut) < 0.05 && !wide && !fader) return p;
  const b0 = Math.max(pointValue(lb, 0), 0);
  const start = at === null ? D : Math.max(0, Math.min(D - width, at - width / 2)), end = Math.min(D, start + width);
  const knots = [0, ...(pre ? Array.from({ length: 8 }, (_, i) => start * (i + 1) / 9) : []), ...Array.from({ length: 13 }, (_, i) => start + (end - start) * i / 12), D]
    .filter((t, i, a) => t <= D && (!i || t > a[i - 1]));
  const x = (t: number) => end > start ? clamp((t - start) / (end - start)) : t >= end ? 1 : 0;
  const bLow = (t: number) => t < start ? Math.max(b0, pre * Math.sin(t / start * Math.PI / 2)) : Math.max(b0, pre) + (1 - Math.max(b0, pre)) * Math.sin(x(t) * Math.PI / 2);
  let automation = p.automation.map(l => l.lane !== 'low' || l.deck === 'B' && at === null ? l : lane(l.deck, 'low',
    knots.map(t => [r3(t), r3(l.deck === 'A' ? (at === null ? 1 : Math.cos(x(t) * Math.PI / 2)) : bLow(t))] as [number, number])));
  if (fader) {
    // A's fader: full until B is (nearly) up and a few seconds before the swap, then gone a few seconds after it
    const gb = p.automation.find(l => l.deck === 'B' && l.lane === 'gain')?.points ?? [[0, 1]];
    let bUp = 0;
    while (bUp < D && pointValue(gb, bUp) < 0.85) bUp += 0.05;
    const f0 = Math.min(at!, Math.max(0, at! - fadeWidth, bUp)), f1 = Math.min(D, at! + fadeWidth), y = (t: number) => clamp((t - f0) / Math.max(1e-3, f1 - f0));
    automation = automation.map(l => l.deck !== 'A' || l.lane !== 'gain' ? l : { ...l, points: [...new Set([...l.points.map(([t]) => t),
      ...Array.from({ length: 13 }, (_, i) => f0 + (f1 - f0) * i / 12)])].sort((a, b) => a - b)
      .map(t => [r3(t), r3(Math.min(pointValue(l.points, t), Math.cos(y(t) * Math.PI / 2)))] as [number, number]) });
  }
  return { ...p, automation,
    reasons: [...p.reasons, at === null ? 'бас текущего трека уходит вместе с ним: у следующего в переходе нет своего баса'
      : fader ? 'басовые треки меняются фейдерами за несколько секунд вокруг смены баса: без переключения'
      : wide ? 'бас следующего трека входит тихо заранее и забирает низ за такт: смена бита не звучит как переключение' : 'бас передаётся, когда у следующего трека появляется свой бас: без провала'],
    debug: { ...p.debug, bassContinuity: { previousAt: r3(cut), at: at === null ? null : r3(at), width: r3(fader ? fadeWidth : width), wide, fader } } };
}

/** Keep the chosen overlap and vocal timing, but exchange bass at B's measured
 * phrase arrival when the default midpoint misses it. No new audio primitive.
 * Structural confidence and a power comparison are required; otherwise the
 * existing downbeat swap is retained byte-for-byte. */
function phraseBassSwap(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis): TransitionPlan {
  if ((p.debug.stems as {wholeDeckFade?:unknown}|undefined)?.wholeDeckFade) return p;
  if (!B.beat || !A.beat || !gridTrust(A).trusted || !gridTrust(B).trusted || B.phraseConfidence < 0.6 || B.beat.downbeatConfidence < 0.5
    || A.beat.downbeatConfidence < 0.5 || p.duration < 8 || Number((p.debug.drumPattern as { k?: number } | undefined)?.k ?? 0)) return p;
  const D = p.duration, original = p.swapAt;
  const value = (deck: 'A' | 'B', name: AutomationLane['lane'], t: number) => {
    const points = p.automation.find(l => l.deck === deck && l.lane === name)?.points;
    return points ? pointValue(points, t) : 1;
  };
  const candidates = B.phrases.map(source => ({ source, time: outputTimeAt(p.tempoB, source - p.bEntry, D) }))
    .filter(c => c.time >= D * 0.25 && c.time <= D * 0.75
      && Math.abs(c.time - original) <= Math.min(5, D * 0.25)
      && Math.abs(c.time - original) > B.beat!.period * 0.5
      && B.beat!.downbeats.some(t => Math.abs(t - c.source) < 0.035)
      && A.beat!.downbeats.some(t => Math.abs(t - p.aExit - integrateTempo(p.tempoA, c.time)) < 0.035))
    .sort((a, b) => Math.abs(a.time - original) - Math.abs(b.time - original));
  for (const c of candidates) {
    if (!measuredCurves(A, p.aExit, p.aExit + integrateTempo(p.tempoA, D))
      || !measuredCurves(B, p.bEntry, p.bEntry + integrateTempo(p.tempoB, D))) continue;
    const speedB = pointValue(p.tempoB, c.time), beat = B.beat.period / speedB;
    const lowB = powerLevel(B, c.source, c.source + B.beat.period * 4, B.curves.lowDb);
    const bodyLowB = powerLevel(B, B.audibleStart, B.audibleEnd, B.curves.lowDb);
    if (lowB < bodyLowB - 5) continue;
    const newLow = (deck: 'A' | 'B', t: number) => {
      const x = clamp((t - c.time + beat / 2) / beat);
      return deck === 'A' ? 1 - x : x;
    };
    let regression = 0, oldPeak = 0, newPeak = 0;
    const begin = Math.max(0, Math.min(c.time, original) - beat), end = Math.min(D, Math.max(c.time, original) + beat);
    for (let t = begin; t <= end; t += 0.2) {
      const estimate = (replacement: boolean) => (['A', 'B'] as const).reduce((sum, deck) => {
        const an = deck === 'A' ? A : B, position = (deck === 'A' ? p.aExit : p.bEntry) + integrateTempo(deck === 'A' ? p.tempoA : p.tempoB, t);
        return sum + value(deck, 'gain', t) ** 2 * filteredPower(an, position, deck === 'A' ? p.gainA : p.gainB,
          replacement ? newLow(deck, t) : value(deck, 'low', t), value(deck, 'mid', t), value(deck, 'high', t),
          pointValue((deck === 'A' ? p.vocalA : p.vocalB) ?? [[0, 1]], t));
      }, 0);
      const before = estimate(false), after = estimate(true);
      regression = Math.max(regression, 10 * Math.log10(Math.max(1e-12, before) / Math.max(1e-12, after)));
      oldPeak = Math.max(oldPeak, before); newPeak = Math.max(newPeak, after);
    }
    // v7: nor a louder peak than the default swap anywhere in the window: one moved swap
    // measured +0.44 LU above both songs in a render (its own ramp dip does not count)
    const bump = 10 * Math.log10(Math.max(1e-12, newPeak) / Math.max(1e-12, oldPeak));
    if (regression > 0.5 || bump > 0.5) continue;
    return { ...p, automation: p.automation.map(l => l.lane !== 'low' ? l : lane(l.deck, 'low', [[0, l.deck === 'A' ? 1 : 0]],
      [[r3(c.time - beat / 2), l.deck === 'A' ? 1 : 0], [r3(c.time + beat / 2), l.deck === 'A' ? 0 : 1]])),
      reasons: [...p.reasons, 'бас передаётся на измеренной границе фразы следующего трека: сохранены точки входа, выхода и передача голоса'],
      debug: { ...p.debug, bassSwap: { technique: 'phrase-bass-swap', at: r3(c.time), sourceB: r3(c.source), previousAt: original, maxPredictedLossDb: r3(regression), maxPredictedRiseDb: r3(bump) } } };
  }
  return p;
}

function beatContinuityCost(ctx: Ctx, A: TrackAnalysis, B: TrackAnalysis, exit: number, entry: number,
  nativeA: number, nativeB: number, bars: number, midDuck: boolean): number {
  const reference = Math.min(levelBefore(A, exit)+ctx.gainA,
    powerLevel(B,entry+nativeB,Math.min(B.audibleEnd,entry+nativeB+6))+ctx.gainB);
  let hole=0;
  for(let i=1;i<=12;i++){
    const x=i/12;
    let ag=cosDown(x),bg=sinUp(x),al=1,bl=1,am=1,bm=1,ah=1,bh=1;
    if(ctx.s.eqHandoff){
      const fadeStart=Math.max(0.5,(bars-2)/bars);
      ag=x<=fadeStart?1:cosDown((x-fadeStart)/(1-fadeStart));
      bg=sinUp(clamp(x/0.5));
      const bass=smoothstep(clamp((x-0.5)*bars*4+0.5));al=1-bass;bl=bass;
      bh=0.25+0.75*smoothstep(clamp(x*2));ah=1-0.75*smoothstep(clamp((x-0.5)*2));
      const b0=midDuck?0.18:0.4;bm=b0+(1-b0)*smoothstep(clamp(x*2));
      am=1-(midDuck?0.8:0.55)*smoothstep(clamp((x-0.5)/Math.min(0.5,2/bars)));
    }
    const stems=ctx.s.stemMixing!==false&&A.vocalActivity&&B.vocalActivity;
    const sum=ag*ag*filteredPower(A,exit+x*nativeA,ctx.gainA,al,am,ah,stems&&x>=0.5?0:1)
      +bg*bg*filteredPower(B,entry+x*nativeB,ctx.gainB,bl,bm,bh,stems&&x<0.5?0:1);
    hole=Math.max(hole,reference-10*Math.log10(Math.max(1e-12,sum))-2.5);
    // A ends/decays while it still carries the mix and B's bass is not in yet
    if(ag>=0.5&&bl<0.5){const aPos=exit+x*nativeA;hole=Math.max(hole,levelBefore(A,exit)-powerLevel(A,aPos-0.75,aPos+0.75)-6);}
  }
  return clamp(hole/10);
}

/** First sustained acoustic decay relative to the music immediately before A's exit. */
function decayHandoff(A: TrackAnalysis, exit: number, duration: number): number {
  const reference = powerLevel(A, Math.max(A.audibleStart, exit - 6), Math.max(A.audibleStart + 0.1, exit - 2));
  for (let t = 0; t < duration * 0.75; t += 0.25) {
    if (powerLevel(A, exit + t, Math.min(A.audibleEnd, exit + t + 1.5)) < reference - 2.5) return clamp(t, Math.min(0.65, duration * 0.2), duration * 0.75);
  }
  return duration / 2;
}

/** Last moment the 2 s smoothed level is still near the body level. */
function loudUntil(an: TrackAnalysis): number {
  const rate = an.curves.rate;
  const rms = an.curves.rmsDb;
  const end = Math.min(rms.length - 1, Math.floor(an.audibleEnd * rate));
  const w = rate * 2;
  for (let i = end; i > w; i--) {
    let s = 0;
    for (let k = i - w; k < i; k++) s += rms[k];
    if (s / w >= an.bodyRmsDb - 3) return i / rate;
  }
  return an.audibleEnd;
}

/**
 * Detects a natural fade-out at the end of a track: the last moment the
 * (2 s smoothed) level is still near the body level, and how long the decay lasts.
 */
export function naturalFade(an: TrackAnalysis): { start: number; length: number } {
  const start = loudUntil(an);
  const length = Math.max(0, an.audibleEnd - start);
  // only a real decay counts (level clearly lower towards the end)
  const tail = levelMean(an, an.audibleEnd - Math.min(2, length / 2), an.audibleEnd);
  // A hard stop followed by a quiet tail is not a fade (256: -16 dB within a second); B must not wait for it
  const stop = levelMean(an, start + 0.5, start + 1.5) < levelMean(an, start - 1.5, start) - 12;
  return tail < an.bodyRmsDb - 8 && length >= 3 && !stop ? { start, length } : { start: an.audibleEnd, length: 0 };
}

/**
 * How acceptable it is to skip music of A after the transition ends.
 * Long DJ outros (steady, sparse in the vocal band) may be skipped; the end of
 * a song with melody or vocals should not be.
 */
function cutScore(A: TrackAnalysis, endOfBlend: number): number {
  const cut = A.audibleEnd - endOfBlend;
  if (cut <= 2) return 1;
  const dens = curveMean(A.curves.midDensity, A.curves.rate, endOfBlend, A.audibleEnd);
  return dens < 0.18 ? clamp(1 - cut / 45) : clamp(1 - cut / 14);
}

/** Skipping quiet/sparse lead-in is cheaper than dropping an already full song. */
function entrySkipCost(B: TrackAnalysis, time: number, sung = false, unknownVoice = false): number {
  const skipped = time - B.audibleStart;
  if (skipped < 1) return 0;
  const level = levelMean(B, B.audibleStart, time);
  const density = curveMean(B.curves.midDensity, B.curves.rate, B.audibleStart, time);
  const fullness = clamp((level - B.bodyRmsDb + 12) / 12);
  const spectral = clamp(skipped / 60) * (0.08 + 0.2 * fullness + 0.12 * clamp(density / 0.4));
  // v7: entering 20-30 s into B skipped a median 19.5 s of B's measured singing in the
  // 552-pair matrix. Skipped words are lost for good (a mask at least overlaps them), so
  // each sung second costs more than a masked one. The first 5 s are free: trimming an
  // ad-lib, pickup or short hook to reach a fuller entry is not a lost verse; charging
  // 4.8 s of such a hook (or the repetition-structure skipCost) moved entries into quieter
  // openings with -1.5..-2.3 LU deeper dips in real renders. Instrumental intros stay cheap.
  // Only a locked blend prices it (its continuity check measures the whole overlap); the
  // unlocked fade/washout entry search judges the level at the handoff only, and there an
  // earlier entry measured -3.3..-4.5 LU dips: it keeps its v6 cost.
  // P3: without a voice map a skipped opening as dense as the song's body may hold words; sparse intros stay cheap
  return spectral + (sung ? 0.03 * Math.max(0, sungSeconds(B, B.audibleStart, time) - 5) : 0)
    + (unknownVoice ? 0.005 * Math.max(0, skipped - 5) * clamp((density / bodyDensity(B) - 0.7) / 0.3) : 0);
}

/** Seconds of measured singing (separated-voice activity above its 0.15 floor) in [from, to]. 0 without stems. */
export function sungSeconds(an: TrackAnalysis, from: number, to: number): number {
  const v = an.vocalActivity;
  if (!v || !(v.rate > 0)) return 0;
  const lo = Math.max(0, Math.floor(from * v.rate)), hi = Math.min(v.values.length, Math.ceil(to * v.rate));
  let sum = 0;
  for (let i = lo; i < hi; i++) if (Number.isFinite(v.values[i])) sum += clamp((v.values[i] - 0.15) / 0.7);
  return sum / v.rate;
}

/** A cue past B's opening whose measured voice starts within about a bar: the first
 * words would have to open at once (0.3.10 dislikes 266/269). Unknown maps never reject. */
function voiceTooSoon(B: TrackAnalysis, time: number, outgoingUnknown = false): boolean {
  // B's opening bar (downbeat a little after audibleStart) is its first words, not a skipped-into phrase.
  if (time < B.audibleStart + 1) return false;
  // An unmeasured A voice leaves as a whole deck before B's words: that fade needs two bars (dislike 231).
  const bar = (B.beat?.period ?? 0) * 4, lead = (outgoingUnknown ? clamp(bar * 2, 4, 6) : clamp(bar, 1.5, 3)) - 0.1;
  const first = firstVoice(B, time, Math.min(B.duration, time + lead));
  return first !== null && Number.isFinite(first);
}

function entryCandidates(B: TrackAnalysis, s: AutoMixSettings, nativeBeforeSwap = 0, nativeTotal = 0, allowMeasuredVocalLead = true, outgoingUnknown = false): CueCandidate[] {
  const len = B.audibleEnd - B.audibleStart;
  if (s.entryMode === 'preserve' || s.maxEntrySkipSeconds === 0) return [{ time: B.audibleStart, score: 0.76, kind: 'start', tags: ['preserve-opening'] }];
  const limit = B.audibleStart + Math.min(s.maxEntrySkipSeconds ?? 45, len * 0.45);
  let candidates = B.cues.entry.filter((c) => c.time >= B.audibleStart - 0.05 && c.time <= limit).map((c) => ({ ...c }));
  const bars = B.beat?.downbeats ?? [];
  const snap = (time: number) => bars.length ? bars.reduce((a, b) => Math.abs(b - time) < Math.abs(a - time) ? b : a) : time;
  // Put a measured energy/texture change at the handoff or the end of the
  // overlap. Entering before a section often works better than entering on it.
  const targets = [...B.sectionBoundaries, B.intro.end,...(s.stemMixing!==false?vocalStarts(B):[])].filter((t) => t > B.audibleStart + 4 && t <= limit + nativeTotal);
  for (const target of targets) for (const lead of [0, nativeBeforeSwap, nativeTotal]) {
    const time = snap(target - lead);
    if (time < B.audibleStart - 0.03 || time > limit || candidates.some((c) => Math.abs(c.time - time) < 0.03)) continue;
    candidates.push({ time: r3(time), score: 0.68, kind: 'section', tags: ['structural-arrival', `arrival:${r3(target)}`] });
  }
  // If the first measured vocal starts after a real instrumental lead-in,
  // offer a bar-aligned entry 1, 2, or 4 bars before it. Require a complete,
  // valid voice map and verify the whole lead-in is quiet; incomplete stems
  // must not justify skipping into the song on a guessed vocal boundary.
  const first = firstVoice(B, B.audibleStart, B.audibleEnd);
  const grid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 && B.beat.period > 0 ? B.beat : null;
  const phrases = allowMeasuredVocalLead && grid && first !== null && Number.isFinite(first) ? vocalStarts(B) : [];
  if (grid && phrases.length) {
    const bar = grid.period * 4;
    for (const target of phrases) for (const count of [1, 2, 4]) {
      const time = r3(snap(target - count * bar)), lead = target - time;
      if (time < B.audibleStart - 0.03 || time > limit || lead < bar - 0.1 || lead > bar * 4 + 0.1
        || firstVoice(B, time, target) !== Infinity || candidates.some(c => Math.abs(c.time - time) < 0.03)) continue;
      candidates.push({ time, score: 1, kind: 'section', tags: ['measured-vocal-lead', `lead-target:${r3(target)}`, `lead-bars:${count}`] });
    }
    // If an entry candidate lands on a later measured vocal phrase, either
    // enter during its own verified instrumental lead-in or start from B's
    // opening. The ordinary energy score alone can otherwise jump directly
    // to that phrase and open it in the first milliseconds of the blend.
    const localPhrases = vocalPhrases(B).filter(p => p.confidence >= 0.5
      && candidates.some(c => c.time >= p.start - 0.2 && c.time <= p.end + 0.2));
    if (localPhrases.length) {
      // Keep clean opening/intro cues. Only remove a cue that actually starts
      // inside one of the local phrases it could select; a chorus later in the
      // song must not globally force every entry through that chorus's lead-in.
      const safe = candidates.filter(c => !localPhrases.some(p => c.time >= p.start - 0.2 && c.time <= p.end + 0.2))
        .map(c => localPhrases.some(p => {
          const lead = p.start - c.time;
          return lead >= bar - 0.1 && lead <= bar * 4 + 0.1 && firstVoice(B, c.time, p.start) === Infinity;
        }) ? { ...c, score: Math.max(c.score, 1), tags: [...c.tags, 'measured-vocal-lead'] } : c);
      candidates = safe.length ? safe : [{ time: B.audibleStart, score: 0.76, kind: 'start', tags: ['measured-vocal-lead-unavailable'] }];
    }
  }
  if (allowMeasuredVocalLead && s.stemMixing !== false) candidates = candidates.filter((c) => !voiceTooSoon(B, c.time, outgoingUnknown));
  if (!candidates.length) candidates.push({ time: B.audibleStart, score: 0.6, kind: 'start', tags: [] });
  // P3: the real audible start stays a candidate when B's voice is unknown
  else if (voiceUnknown(B, s) && !candidates.some(c => Math.abs(c.time - B.audibleStart) < 0.05))
    candidates.push({ time: B.audibleStart, score: 0.6, kind: 'start', tags: ['full-mix-start'] });
  return candidates;
}

function arrivalFit(B: TrackAnalysis, entry: number, nativeBeforeSwap: number, nativeTotal: number): { score: number; time?: number } {
  let best: { score: number; time?: number } = { score: 0 };
  const targets = [...B.sectionBoundaries, B.intro.end];
  for (const time of targets) {
    if (time < B.audibleStart + 3 || time < entry - 0.1) continue;
    const before = levelMean(B, Math.max(B.audibleStart, time - 6), time);
    const after = levelMean(B, time, Math.min(B.audibleEnd, time + 6));
    if (after < B.bodyRmsDb - 6 || after < before - 2) continue;
    const distance = Math.min(Math.abs(entry + nativeBeforeSwap - time), Math.abs(entry + nativeTotal - time));
    const score = (0.5 + 0.5 * clamp((after - before) / 8)) * (1 - clamp(distance / Math.max(3, nativeTotal * 0.35)));
    if (score > best.score) best = { score, time };
  }
  return best;
}

function describeEntry(p: TransitionPlan, B: TrackAnalysis, cue: CueCandidate, arrivalTime?: number): void {
  const skippedSeconds = r3(Math.max(0, p.bEntry - B.audibleStart));
  p.entrySelection = {
    kind: skippedSeconds < 1 ? 'start' : cue.kind === 'section' || arrivalTime !== undefined && [...B.sectionBoundaries,B.intro.end].some(t=>Math.abs(t-arrivalTime)<0.05) ? 'section' : 'intro-trim',
    skippedSeconds,
    ...(arrivalTime === undefined ? {} : { arrivalTime: r3(arrivalTime) }),
    confidence: r3(clamp(cue.score)),
  };
  if (skippedSeconds >= 2) p.reasons.push(`вход в следующий трек с ${p.bEntry.toFixed(1)} с: выбрана подходящая граница по энергии и структуре`);
}

/** Seconds of audible singing that a one-voice-at-a-time handoff must mask when
 * both tracks sing during the overlap (equal-power gains, measured activity
 * only, no lyric semantics). 0 without separated vocals. */
function voiceClash(A: TrackAnalysis, B: TrackAnalysis, aStart: number, nativeA: number, bStart: number, nativeB: number, duration: number,
  gains: (x: number) => [number, number] = (x) => [cosDown(x), sinUp(x)]): number {
  if (!A.vocalActivity || !B.vocalActivity) return 0;
  let lost = 0;
  for (let i = 0; i < 12; i++) {
    const x = (i + 0.5) / 12;
    const [ga, gb] = gains(x);
    const a = clamp((vocalMean(A, aStart + x * nativeA - 0.4, aStart + x * nativeA + 0.4) - 0.15) / 0.7) * ga;
    const b = clamp((vocalMean(B, bStart + x * nativeB - 0.4, bStart + x * nativeB + 0.4) - 0.15) / 0.7) * gb;
    lost += Math.min(a, b) * duration / 12;
  }
  return lost;
}

/** Native-tempo handoffs can still land a measured B downbeat on A's exit. */
function pickHandoffEntry(ctx: Ctx, A: TrackAnalysis, B: TrackAnalysis, aStart: number, swap: number, duration: number, align = false) {
  const preserving = ctx.s.entryMode === 'preserve' || ctx.s.maxEntrySkipSeconds === 0;
  const unknownA = !A.vocalActivity && !!B.vocalActivity;
  let candidates = entryCandidates(B, ctx.s, swap, duration, ctx.requestedAt === undefined, unknownA);
  const bGrid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 ? B.beat : null;
  if (align && bGrid && !preserving) {
    const limit = B.audibleStart + Math.min(ctx.s.maxEntrySkipSeconds ?? 45, (B.audibleEnd - B.audibleStart) * 0.45);
    const base = candidates;
    const aligned = bGrid.downbeats.filter((t) => t - swap >= B.audibleStart - 0.01 && t - swap <= limit).map((t) => ({
      time: r3(Math.max(B.audibleStart, t - swap)), score: 0.68, kind: 'downbeat' as const, tags: ['handoff-downbeat'],
    }));
    // Handoff alignment must not restore a deep cue that the measured vocal
    // lead-in rule just rejected. Keep only aligned points outside the active
    // phrase, or inside a verified one-to-four-bar lead before that phrase.
    const first = firstVoice(B, B.audibleStart, B.audibleEnd);
    const grid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 && B.beat.period > 0 ? B.beat : null;
    const phrases = ctx.requestedAt === undefined && ctx.s.stemMixing !== false && grid && first !== null && Number.isFinite(first)
      ? vocalPhrases(B).filter(p => p.confidence >= 0.5 && base.some(c => c.time >= p.start - 0.2 && c.time <= p.end + 0.2)) : [];
    const safeAligned = phrases.length && grid ? aligned.filter(c => phrases.every(p => {
      if (c.time < p.start - 0.2 || c.time > p.end + 0.2) return true;
      const lead = p.start - c.time, bar = grid.period * 4;
      return lead >= bar - 0.1 && lead <= bar * 4 + 0.1 && firstVoice(B, c.time, p.start) === Infinity;
    })) : aligned;
    // A phrase cut is only valid on the aligned downbeat candidates. Keeping
    // the unaligned base cues here can make a good tempo-reset cut look invalid
    // after selection, then fall through to a crossfade.
    candidates = ctx.requestedAt === undefined && ctx.s.stemMixing !== false ? safeAligned.filter((c) => !voiceTooSoon(B, c.time, unknownA)) : safeAligned;
  }
  if (!candidates.length) candidates = [{ time: B.audibleStart, score: 0.6, kind: 'start', tags: [] }];
  const densA = curveMean(A.curves.midDensity, A.curves.rate, aStart, aStart + Math.max(1, swap));
  let best: { cue: CueCandidate; score: number; arrival?: number; aligned: boolean } | undefined;
  for (const cue of candidates) {
    if (cue.time + duration > B.audibleEnd - Math.min(3, (B.audibleEnd - B.audibleStart) * 0.15)) continue;
    const handoffLevel = powerLevel(B, cue.time + Math.max(0, swap - 0.5), cue.time + swap + 2);
    const bodyLevel = powerLevel(B, Math.max(B.audibleStart, B.intro.end), Math.min(B.audibleEnd, Math.max(B.intro.end + 8, B.audibleStart + 16)));
    const energyFit = 1 - clamp(Math.abs(handoffLevel - bodyLevel) / 15);
    const outgoing = levelBefore(A, aStart) + ctx.gainA;
    // Once A has decayed, B must carry the mix. A later measured entrance is
    // preferable to starting two quiet passages together.
    const needed = Math.min(outgoing, bodyLevel+ctx.gainB);
    const holeCost = clamp((needed-handoffLevel-ctx.gainB-2.5)/12);
    const densB = curveMean(B.curves.midDensity, B.curves.rate, cue.time, cue.time + Math.max(1, swap));
    const conflict = clamp(densA * densB * 6);
    const arrival = arrivalFit(B, cue.time, swap, duration);
    const voiceScore=ctx.s.stemMixing!==false?vocalEntryScore(A,B,aStart+swap,cue.time+swap):0;
    const clash=ctx.s.stemMixing!==false?voiceClash(A,B,aStart,duration,cue.time,duration,duration):0;
    const unknownB = voiceUnknown(B, ctx.s);
    const score = 0.18 * cue.score + 0.35 * energyFit + 0.23 * (1 - conflict) + 0.24 * arrival.score - entrySkipCost(B, cue.time, false, unknownB) - 0.45*holeCost +0.18*voiceScore
      - (unknownB ? 0.12 * pickupLost(B, cue.time) : 0)
      + (cue.tags.includes('measured-vocal-lead') ? 0.18 : 0)
      - Math.min(0.2, 0.02*clash);
    const aligned = !!bGrid?.downbeats.some((t) => Math.abs(t - cue.time - swap) < 0.004);
    if (!best || score > best.score) best = { cue, score, arrival: arrival.time, aligned };
  }
  return best ?? { cue: { time: B.audibleStart, score: 0.6, kind: 'start' as const, tags: [] }, score: 0, aligned: false };
}

/** Mean kick/snare accent at bar positions 0..3 (counted from the grid's downbeats) over
 * beats in [from, to). Null without accents or with fewer than 3 beats per position. */
export function barPattern(g: Pick<BeatGrid, 'beats' | 'downbeats' | 'accents'>, from: number, to: number): number[][] | null {
  const acc = g.accents;
  if (!acc || acc.kick.length !== g.beats.length) return null;
  const down = new Set(g.downbeats.map((t) => Math.round(t * 1000)));
  const sum = [[0, 0, 0, 0], [0, 0, 0, 0]], n = [0, 0, 0, 0];
  let pos = -1;
  g.beats.forEach((t, i) => {
    if (down.has(Math.round(t * 1000))) pos = 0; else if (pos >= 0) pos = (pos + 1) % 4;
    if (pos < 0 || t < from || t >= to) return;
    sum[0][pos] += acc.kick[i]; sum[1][pos] += acc.snare[i]; n[pos]++;
  });
  return Math.min(...n) < 3 ? null : sum.map((f) => f.map((v, i) => v / n[i]));
}

/** Kick on kick, snare on snare: Pearson match of A's bar pattern with B's pattern rotated by k
 * beats (A position i against B position i+k), k = 0..3, averaged over bands that show a bar
 * pattern on both decks. Null when neither band does (no drums, steady kick, flat hats). */
export function drumAlignment(a: number[][], b: number[][]): number[] | null {
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
  // a steady four-on-the-floor kick or flat hats (contrast ~0.1-0.15) carries no bar position
  const bands = [0, 1].filter((f) => sd(a[f]) >= 0.3 * mean(a[f]) && sd(b[f]) >= 0.3 * mean(b[f]));
  if (!bands.length) return null;
  return [0, 1, 2, 3].map((k) => mean(bands.map((f) => {
    const ma = mean(a[f]), mb = mean(b[f]);
    let c = 0;
    for (let i = 0; i < 4; i++) c += (a[f][i] - ma) * (b[f][(i + k) % 4] - mb);
    return c / (4 * sd(a[f]) * sd(b[f]));
  })));
}
/** A rotation must beat the analysed bar phase by this much (and match on its own) to move B. */
const DRUM_SHIFT_MARGIN = 0.5, DRUM_SHIFT_MIN = 0.3;

function planBeatmatch(
  ctx: Ctx,
  A: TrackAnalysis,
  B: TrackAnalysis,
  rel: TempoRelation,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>,
  minBars = 1,
): TransitionPlan | null {
  const s = ctx.s;
  const pA = A.beat!.period;
  const barA = pA * 4;
  const r = rel.ratio;
  // 1-2 bar locks sounded like cuts ("резко"): only for "tight", a musical Next, or when
  // the listener's overlap cap leaves no room for 4 bars
  const short = ctx.requestedAt !== undefined || barA * 4 > s.maxBlendSeconds;
  // average A speed over a glide: output seconds of a lock = bars * barA / avgA
  const avgA = Math.abs(r - 1) > 0.00001 ? (1 + 1 / r) / 2 : 1;
  // v13 (P1): the first-words repair keeps a blend of at least 10 s ("резко" below 8 s: 1 good of 15 rated)
  const repairBars = [4, 8, 16].find(b => b * barA / avgA >= MIN_LOCK_SECONDS - 0.01 && b * barA / avgA <= s.maxBlendSeconds + 0.0001) ?? 4;
  const barOptions = ctx.fixed ? [ctx.fixed.bars] : ctx.vocalRepair ? [repairBars] : s.style === 'tight' ? [4, 2, 1, 8] : short ? [16, 8, 4, 2, 1] : [16, 8, 4];
  // Full mix (P5): an uncertain or live grid gets a shorter shared drum section, and a half/double
  // relation needs its drum accents (not just the period) to line up before a long sync.
  const unknownA = voiceUnknown(A, s), unknownB = voiceUnknown(B, s), fullMix = unknownA || unknownB;
  // many songs have weak downbeats and still lock well (listener: beatmatching sounded good); only a
  // clearly shaky pulse shortens the shared drums
  const looseGrid = fullMix && [A.beat!, B.beat!].some(g => g.confidence < 0.55 || g.jitterMs > 20);
  let barCap = looseGrid ? 8 : Infinity;
  if (fullMix && rel.m !== 1) {
    const pa = barPattern(A.beat!, A.audibleEnd - 40, A.audibleEnd), pb = barPattern(B.beat!, B.audibleStart, B.audibleStart + 40);
    const accents = pa && pb ? drumAlignment(pa, pb) : null;
    barCap = Math.min(barCap, accents === null ? 8 : accents[0] < 0.2 ? 4 : Infinity);
  }
  const keyClash = keyInfo.compatibility < 0.5;
  const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1000)));
  const cueScore = new Map(A.cues.exit.map((c) => [Math.round(c.time * 1000), c.score]));
  const len = A.audibleEnd - A.audibleStart;
  // every 4th downbeat (and every phrase start) in the second half of A is a possible exit
  const exits: CueCandidate[] = A.beat!.downbeats
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (ctx.requestedAt===undefined?t > Math.max(A.audibleStart + len * 0.5, A.audibleEnd - 96)
      :t>=ctx.requestedAt+0.15&&t<=ctx.requestedAt+0.15+Math.min(3,barA+0.02)) && t < A.audibleEnd - Math.min(barA, s.maxBlendSeconds))
    .map(({ t }) => ({
      time: t,
      score: cueScore.get(Math.round(t * 1000)) ?? 0.4,
      kind: phraseSet.has(Math.round(t * 1000)) ? ('phrase' as const) : ('downbeat' as const),
      tags: [],
    }));
  // A preserved repair entry may already sit off B's analysed downbeat (drum-pattern shift).
  const bDown = ctx.vocalRepair || ctx.fixed ? B.beat!.beats : B.beat!.downbeats;
  const pB = B.beat!.period;
  const voices = s.stemMixing !== false && !!A.vocalActivity && !!B.vocalActivity;
  let best: { score: number; e: CueCandidate; n: CueCandidate; bars: number; conflict: number; cut: number; arrival?: number; localClash: number; drum?: Record<string, unknown> } | null = null;
  const tried: unknown[] = [];
  const glide = Math.abs(r - 1) > 0.00001;
  const target = 1 / r;
  for (const bars of barOptions) {
    const nativeA = bars * barA;
    const nativeB = nativeA * r;
    const D = nativeA / avgA;
    if (D > s.maxBlendSeconds + 0.0001) continue;
    if (bars < minBars || minBars > 1 && D < LONG_LOCK_MIN_SECONDS) continue;
    if (bars > barCap && !ctx.fixed) continue;
    if (keyClash && bars > 8) continue;
    const entries: CueCandidate[] = ctx.fixed
      ? [{time:ctx.fixed.entry,score:0.76,kind:'start',tags:['full-mix-alternative']}]
      : ctx.vocalRepair
      ? [{time:ctx.vocalRepair.entry,score:0.76,kind:'start',tags:['preserved-vocal-repair-entry']}]
      : entryCandidates(B, s, nativeB / 2, nativeB, ctx.requestedAt === undefined, !A.vocalActivity && !!B.vocalActivity);
    for (const e of exits) {
      // The voice can leave near 10 % of a locked blend. Keep even that early
      // handoff close to the original phrase, rather than sacrificing A to
      // make the incoming-loss number look better.
      if(ctx.vocalRepair&&e.time+nativeA*0.1<ctx.vocalRepair.minHandoff)continue;
      if (e.time + nativeA > A.audibleEnd + 0.03) continue;
      if (ctx.fixed && Math.abs(e.time - ctx.fixed.exit) > 0.01) continue;
      if(ctx.regionA&&(e.time<ctx.regionA.start-0.001||e.time+nativeA>ctx.regionA.end+0.001))continue;
      for (const n of entries) {
        // entry must sit on one of B's downbeats so bars line up
        if (!bDown.some((t) => Math.abs(t - n.time) < 0.03)) continue;
        if (n.time + nativeB > B.audibleEnd - Math.min(12, (B.audibleEnd - B.audibleStart) * 0.2)) continue;
        if(ctx.regionB&&(n.time<ctx.regionB.start-0.001||n.time+nativeB>ctx.regionB.end+0.001))continue;
        const densA = curveMean(A.curves.midDensity, A.curves.rate, e.time, e.time + nativeA);
        const densB = curveMean(B.curves.midDensity, B.curves.rate, n.time, n.time + nativeB);
        const conflict = clamp(densA * densB * 6);
        // v13 (P2): a key clash no longer shortens the lock, its mids take turns instead (lanes below)
        const dense = conflict > 0.6;
        // v13 (P1): length is judged in seconds, not bars: 4 bars are 6.4 s at 150 BPM but 10.7 s at 90.
        // With separated voices only one voice sings at a time, so dense mids keep the normal length.
        const lockTarget = dense && !voices ? 8 : s.style === 'smooth' ? 20 : 14;
        const lenPref = s.style === 'tight' ? 1 - clamp(Math.abs(Math.log2(bars / 4)) / 4)
          // shorter than the target costs twice as fast as longer (long blends were rated best)
          : 1 - clamp(Math.max(Math.log2(lockTarget / D) / 2, Math.log2(D / lockTarget) / 4))
            - (short ? 0 : 0.2 * clamp((MIN_LOCK_SECONDS - D) / MIN_LOCK_SECONDS));
        // P2: with an unknown voice judge where A is really gone (its fader and EQ), not the deck's formal end
        const heardEnd = unknownA ? e.time + nativeA - (s.eqHandoff && bars >= 4 ? 0.4 * barA : 0.2 * nativeA) : e.time + nativeA;
        const cs = ctx.requestedAt===undefined?cutScore(A, heardEnd):1;
        // A leaves at the end of a structural unit (repetition structure), not inside one
        const closure = ctx.requestedAt===undefined&&A.structure?closureAt(A.structure, heardEnd):0;
        const localClash = fullMix ? localClashFraction(A, e.time, nativeA, B, n.time, nativeB) : 0;
        const arrival = arrivalFit(B, n.time, nativeB / 2, nativeB);
        const phraseBonus = (e.kind === 'phrase' ? 0.5 : 0) + (B.phraseConfidence >= 0.2 && (n.kind === 'phrase' || n.kind === 'start') ? 0.5 : 0);
        const aLevel = levelMean(A, e.time, e.time + nativeA) + ctx.gainA;
        const bLevel = levelMean(B, n.time, n.time + nativeB) + ctx.gainB;
        const energyFit = 1 - clamp(Math.abs(aLevel - bLevel) / 14);
        const continuityCost=beatContinuityCost(ctx,A,B,e.time,n.time,nativeA,nativeB,bars,conflict>0.35||keyClash);
        const voiceScore=s.stemMixing!==false?vocalEntryScore(A,B,e.time+nativeA/2,n.time+nativeB/2):0;
        // words of one singer are masked while both sing: prefer overlaps where at most one voice is busy
        const fadeStart=Math.max(0.5,(bars-2)/bars);
        const clash=s.stemMixing!==false?voiceClash(A,B,e.time,nativeA,n.time,nativeB,D,s.eqHandoff
          ?(x)=>[x<=fadeStart?1:cosDown((x-fadeStart)/(1-fadeStart)),sinUp(clamp(x/0.5))]:undefined):0;
        const score = 0.1 * closure + 0.1 * e.score + 0.1 * n.score + 0.28 * cs + 0.12 * lenPref + 0.12 * (1 - conflict) + 0.11 * arrival.score + 0.08 * energyFit + 0.09 * phraseBonus - entrySkipCost(B, n.time, true, unknownB) - 0.45*continuityCost+0.2*voiceScore
          + (n.tags.includes('measured-vocal-lead') ? 0.18 : 0)
          - Math.min(0.4, 0.02*clash)
          - (unknownB ? 0.12 * pickupLost(B, n.time) : 0) - 0.1 * localClash;
        tried.push({ exit: e.time, entry: n.time, bars, cut: r3(A.audibleEnd - e.time - nativeA), score: r3(score), continuityCost:r3(continuityCost) });
        if (!best || score > best.score) best = { score, e, n, bars, conflict, cut: A.audibleEnd - e.time - nativeA, arrival: arrival.time, localClash };
      }
    }
  }
  if (!best) return null;
  // Analysed downbeats can be a beat off (low confidence, half-time feel). When the drum
  // patterns of the chosen overlap clash at the analysed phase but clearly agree k beats
  // later, B enters on that beat: kick meets kick, snare meets snare. Only the bar phase of
  // the selected candidate moves; its exit, length and entry region stay (relation 1 only).
  if (!ctx.vocalRepair && !ctx.fixed && rel.m === 1) {
    const nativeA = best.bars * barA, nativeB = nativeA * r;
    // only what actually sounds together: a verse groove after the overlap does not clash with A
    const pa = barPattern(A.beat!, best.e.time, best.e.time + nativeA), pb = barPattern(B.beat!, best.n.time, best.n.time + nativeB);
    const match = pa && pb ? drumAlignment(pa, pb) : null;
    if (match) {
      const k = match.indexOf(Math.max(...match)), drum: Record<string, unknown> = { match: match.map(r3), k: 0 };
      if (k && match[k] - match[0] >= DRUM_SHIFT_MARGIN && match[k] >= DRUM_SHIFT_MIN) {
        const preserve = s.entryMode === 'preserve' || s.maxEntrySkipSeconds === 0;
        // A phase correction is still an entry edit: it must respect exactly
        // the same trimmed opening and skip budget as the candidate search.
        const entryLimit = B.audibleStart + (preserve ? 0 : Math.min(s.maxEntrySkipSeconds ?? 45,
          (B.audibleEnd - B.audibleStart) * 0.45));
        // Both directions give the same bar alignment. Prefer the one with less of B's measured
        // singing inside the overlap (later voice, A's phrase can finish), then the smaller move.
        const time = [{ t: best.n.time + k * pB, move: k }, { t: best.n.time - (4 - k) * pB, move: 4 - k }]
          .filter(({ t }) => t >= B.audibleStart && t <= entryLimit && !(ctx.requestedAt === undefined && s.stemMixing !== false && voiceTooSoon(B, t, !A.vocalActivity))
            && t + nativeB <= B.audibleEnd && (!ctx.regionB || t >= ctx.regionB.start - 0.001 && t + nativeB <= ctx.regionB.end + 0.001))
          .map((o) => ({ ...o, cost: (voices ? vocalMean(B, o.t, o.t + nativeB) : 0) + 0.01 * o.move }))
          .sort((x, y) => x.cost - y.cost)[0]?.t;
        if (time === undefined) drum.blocked = preserve ? 'preserve-opening' : 'no-room';
        else { best.n = { ...best.n, time: r3(time), tags: [...best.n.tags, `drum-shift:${k}`] }; drum.k = k; }
      }
      best.drum = drum;
    }
  }

  const p = basePlan(ctx, 'beatmatch_blend');
  const bars = best.bars;
  const halfBars = bars / 2;
  // Tempo glide: the common tempo moves from A's BPM to B's BPM across the
  // overlap. A speeds towards B's tempo, B starts matched to A and ends at its
  // native speed, so beats stay locked and each track is stretched most while
  // it is the quieter one.
  const D = (bars * barA) / avgA;
  const rA = (t: number) => (glide ? 1 + (target - 1) * smoothstep(clamp(t / D)) : 1);
  /** Output time at which A has played `x` seconds of its own content. */
  const tOfA = (x: number) => {
    let acc = 0;
    const dt = D / 400;
    for (let t = 0; t < D; t += dt) {
      const v = rA(t + dt / 2) * dt;
      if (acc + v >= x) return t + ((x - acc) / v) * dt;
      acc += v;
    }
    return D;
  };
  const swap = tOfA(halfBars * barA);
  const beat = pA / rA(swap);
  p.aExit = r3(best.e.time);
  p.bEntry = r3(best.n.time);
  p.duration = r3(D);
  p.swapAt = r3(swap);
  if (glide) {
    const pts = Array.from({ length: 13 }, (_, i) => (D * i) / 12);
    p.tempoA = pts.map((t) => [r3(t), Math.round(rA(t) * 1e6) / 1e6]);
    p.tempoB = pts.map((t, i) => [r3(t), i === 12 ? 1 : Math.round(rA(t) * r * 1e6) / 1e6]);
  } else {
    p.tempoB = [[0, 1]];
  }
  const barOut = (k: number) => tOfA(k * barA);

  const lanes: AutomationLane[] = [];
  const reasons: string[] = [];
  let echoSafe = true;
  if (ctx.s.eqHandoff) {
    // EQ blend: B's fader rises through the first half (thin: no bass, soft mids/highs),
    // basses swap on the downbeat in the middle, then A thins out and leaves. A one-bar
    // rise put B at -6 dB within ~1 s of a 16-25 s blend: heard as switching B on.
    const fadeStart = Math.max(swap, barOut(bars - 2));
    lanes.push(lane('B', 'gain', shape(0, swap, sinUp, 8)));
    lanes.push(lane('A', 'gain', [[0, 1]], shape(fadeStart, D, cosDown, 8)));
    lanes.push(lane('A', 'low', [[0, 1]], [[r3(swap - beat / 2), 1], [r3(swap + beat / 2), 0]]));
    lanes.push(lane('B', 'low', [[0, 0]], [[r3(swap - beat / 2), 0], [r3(swap + beat / 2), 1]]));
    lanes.push(lane('B', 'high', shape(0, swap, (x) => 0.25 + 0.75 * smoothstep(x))));
    lanes.push(lane('A', 'high', [[0, 1]], shape(swap, D, (x) => 1 - 0.75 * smoothstep(x))));
    const midDuck = best.conflict > 0.35 || keyInfo.compatibility < 0.5 || best.localClash >= 0.5;
    const bMid0 = s.stemMixing!==false&&A.vocalActivity&&B.vocalActivity ? (keyClash?0.4:0.7) : midDuck ? 0.18 : 0.4;
    // v13 (P2): clashing keys take turns in the mids around the bass swap (B's mids stay back until
    // it, then take over while A's leave) instead of a shorter lock. With separated voices B's
    // mids keep 0.4 before the swap: its first words are not EQ'd away.
    const turns = keyClash || best.localClash >= 0.5;
    if (turns) {
      // B's mids wait for the swap, A's leave from there as gently as before: A dropping its mids
      // within a beat made it vanish halfway through the blend (a -9 LU render dip)
      const t0 = Math.max(0, swap - beat);
      lanes.push(lane('B', 'mid', [[0, bMid0]], shape(t0, Math.min(D, swap + beat), (x) => bMid0 + (1 - bMid0) * sinUp(x))));
      lanes.push(lane('A', 'mid', [[0, 1]], shape(t0, Math.max(t0 + beat, Math.min(D, barOut(halfBars + 2))), (x) => 0.2 + 0.8 * cosDown(x))));
    } else {
      lanes.push(lane('B', 'mid', shape(0, swap, (x) => bMid0 + (1 - bMid0) * smoothstep(x))));
      lanes.push(lane('A', 'mid', [[0, 1]], shape(swap, Math.min(D, barOut(halfBars + 2)), (x) => 1 - (midDuck ? 0.8 : 0.55) * smoothstep(x))));
    }
    reasons.push('бас плавно передаётся на сильной доле в середине перехода, чтобы уменьшить конфликт басовых линий');
    if (turns) reasons.push('тональности конфликтуют: середина треков меняется по очереди на смене баса, длина сведения не сокращается');
    else if (midDuck) reasons.push('средние частоты обоих треков плотные: середина следующего трека входит приглушённой');
    // A leaves before its own ending: its last bar goes into an echo on the shared grid
    // (B's beat at its native tempo), so A does not just fade under B. Only on a lock:
    // the old unlocked echo repeated A's groove against B's ("сбился ритм").
    // P7: with A's voice unknown the pre-fader echo may repeat a syllable: only a sparse last bar that
    // closes a section or phrase, and a tail that is gone (-40 dB) within 1.5 s instead of 3 s
    const exitA = best.e.time + bars * barA;
    echoSafe = !unknownA || (best.e.kind === 'phrase' || !!A.structure && closureAt(A.structure, exitA) >= 0.5)
      && curveMean(A.curves.midDensity, A.curves.rate, exitA - barA, exitA) < 0.2;
    if (best.cut > 4 && echoSafe) {
      let delay = B.beat!.period;
      while (delay < 0.3) delay *= 2;
      while (delay > 0.8) delay /= 2;
      const send = 0.5;
      // the tail is 40 dB under the send level about 3 s after A has gone
      p.echo = { delay: r3(delay), feedback: r3(Math.min(0.45, Math.pow(0.01 / send, delay / (unknownA ? 1.5 : 3)))) };
      lanes.push(lane('A', 'echo', [[0, 0]], [[r3(barOut(bars - 1)), 0], [r3(D), send]]));
      reasons.push('текущий трек уходит в эхо по сетке битов: повторы ложатся на доли следующего трека');
    }
  } else {
    lanes.push(lane('A', 'gain', shape(0, D, cosDown, 12)));
    lanes.push(lane('B', 'gain', shape(0, D, sinUp, 12)));
  }
  p.automation = lanes;
  const aConf = A.beat!.confidence;
  const bConf = B.beat!.confidence;
  const drumShift = Number(best.drum?.k ?? 0);
  const phraseAligned = !drumShift && A.phraseConfidence >= 0.2 && B.phraseConfidence >= 0.2 && best.e.kind === 'phrase' && (best.n.kind === 'phrase' || best.n.kind === 'start');
  const phraseConf = (A.phraseConfidence + B.phraseConfidence) / 2;
  p.confidence = r3(Math.sqrt(aConf * bConf) * (0.75 + 0.25 * phraseConf) * (0.75 + 0.25 * keyInfo.compatibility) * (1 - 0.3 * best.conflict));
  p.beatAlign = {
    bpmA: A.beat!.bpm,
    bpmB: B.beat!.bpm,
    relation: rel.m,
    ratio: Math.round(r * 1e5) / 1e5,
    stretchPercent: Math.round(rel.stretchPercent * 100) / 100,
    overlapBeats: bars * 4,
    phraseAligned,
    glide,
  };
  p.keyInfo = keyInfo;
  const tempoText =
    rel.m === 1
      ? `${A.beat!.bpm.toFixed(1)} → ${B.beat!.bpm.toFixed(1)} BPM`
      : `${A.beat!.bpm.toFixed(1)} ↔ ${B.beat!.bpm.toFixed(1)} BPM (${rel.m === 2 ? 'половинный' : 'двойной'} темп)`;
  p.reasons = [
    `сведение по битам на ${bars} тактов, ${tempoText}`,
    glide ? `общий темп плавно переходит с ${A.beat!.bpm.toFixed(1)} на ${(B.beat!.bpm * rel.m).toFixed(1)} BPM за ${D.toFixed(0)} с; сетки битов синхронизированы, высота тона сохраняется` : 'темп совпадает',
    phraseAligned ? 'вход и выход на границах фраз' : 'выход на сильной доле',
    best.cut > 2 ? `пропускается ${Math.round(best.cut)} с финала` : 'текущий трек звучит до конца',
    keyInfo.label,
    ...(drumShift ? [`рисунок ударных выровнен: такт следующего трека сдвинут на ${drumShift} ${drumShift === 1 ? 'долю' : 'доли'} относительно найденной сильной доли, бочка совпадает с бочкой, малый с малым`] : []),
    ...reasons,
  ];
  describeEntry(p, B, best.n, best.arrival);
  p.debug = {
    candidates: (tried as { score: number }[]).sort((a, b) => b.score - a.score).slice(0, 40),
    candidateCount: tried.length,
    conflict: r3(best.conflict), score: r3(best.score), cut: r3(best.cut),
    ...(best.drum ? { drumPattern: best.drum } : {}),
    ...(fullMix ? { fullMixRules: { looseGrid, barCap: Number.isFinite(barCap) ? barCap : null, localClash: r3(best.localClash), echoSafe } } : {}),
    ...(p.echo ? { variant: 'echo-tail' } : {}),
    consumedA: r3(bars * barA), consumedB: r3(bars * barA * r),
    analysisLimits: ['mid-density-is-not-vocal-detection', '4/4-meter-assumed'],
  };
  return p;
}

function planPhraseCut(
  ctx: Ctx,
  A: TrackAnalysis,
  B: TrackAnalysis,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>,
  fallbackReason?: string,
): TransitionPlan | null {
  const pA = A.beat!.period;
  // A cut is a tempo reset, not a four-second overlap of unlocked drums.
  // A short de-click ramp retains B's attack while clearing A before its next beat.
  const D = Math.min(0.12, pA / 4, B.beat!.period / 4, ctx.s.maxBlendSeconds);
  if (D < 0.03) return null;
  // the last phrase (or 4-bar) boundary that still leaves room for the filter-out
  const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1000)));
  const downs = A.beat!.downbeats;
  // A quiet consonant can look like silence in the activity average while it
  // still belongs to a sung word. Test the complete de-click window against
  // measured phrases (or validated lyric edit spans), not just frame energy.
  const editSpans = lyricTiming(A)?.edit ?? vocalPhrases(A)
    .filter(p => p.confidence >= 0.35).map(p => [p.start, p.end]);
  const clearVoice = (t: number) => !editSpans.some(([start, end]) =>
    t + D + 0.015 > start && t - 0.015 < end);
  const minT = A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5;
  const latest = (pred: (t: number, i: number) => boolean): number | null => {
    // A remains audible throughout the de-click fade. A grid tolerance must
    // not move that fade past the last available source samples.
    for (let i = downs.length - 1; i >= 0; i--) if (pred(downs[i], i) && downs[i] + D <= A.audibleEnd
      && (ctx.requestedAt===undefined?downs[i]>minT&&A.audibleEnd-downs[i]<=8:downs[i]>=ctx.requestedAt+0.15&&downs[i]<=ctx.requestedAt+3)
      && (!A.vocalActivity || vocalMean(A, downs[i]-0.2, downs[i]+0.25)<0.2 && clearVoice(downs[i]))) return downs[i];
    return null;
  };
  const phraseExit = latest((t) => phraseSet.has(Math.round(t * 1000)));
  const barExit = latest((_t, i) => i % 4 === 0) ?? latest(() => true);
  // a phrase boundary is preferred unless it throws away clearly more of the ending
  const cutOf = (t: number | null) => (t === null ? Infinity : A.audibleEnd - t - D);
  const exit = phraseExit !== null && cutOf(phraseExit) <= cutOf(barExit) + 4 ? phraseExit : barExit;
  if (exit === null) return null;
  const isPhrase = phraseSet.has(Math.round(exit * 1000));
  const selected = ctx.vocalRepair
    ? {cue:{time:ctx.vocalRepair.entry,score:.76,kind:'downbeat' as const,tags:['preserved-cut-entry']},
      aligned:B.beat!.downbeats.some(t=>Math.abs(t-ctx.vocalRepair!.entry)<.025)}
    : pickHandoffEntry(ctx, A, B, exit, 0, D, true);
  const entry = selected.cue;
  const incomingSpans=lyricTiming(B)?.edit??vocalPhrases(B).filter(p=>p.confidence>=.35).map(p=>[p.start,p.end]);
  if (!selected.aligned || B.beat!.downbeatConfidence < 0.5
    || incomingSpans.some(([a,b])=>entry.time>a+.025&&entry.time<b-.025)
    || powerLevel(B, entry.time, entry.time + 0.6) < B.bodyRmsDb - 6) return null;
  const rel = tempoRelation(A.beat!.bpm, B.beat!.bpm);
  const p = basePlan(ctx, 'phrase_cut');
  const beat = pA;
  p.aExit = r3(exit);
  p.bEntry = r3(entry.time);
  p.duration = r3(D);
  p.swapAt = r3(D / 2);
  // filter-out: A loses its bass at once and fades under B, B enters full on its downbeat
  p.automation = [
    lane('B', 'gain', shape(0, Math.min(0.012, D / 4), sinUp, 4)),
    lane('A', 'gain', shape(0, D, (x) => Math.pow(cosDown(x), 1.4), 10)),
    // basses swap right on B's first downbeat: B's kick lands with full weight
    lane('A', 'low', shape(0, Math.min(beat / 4, D), (x) => 1 - smoothstep(x), 4)),
    lane('A', 'mid', [[0, 1]], shape(Math.min(beat, D / 2), D, (x) => 1 - 0.5 * smoothstep(x), 4)),
  ];
  p.confidence = r3(0.45 * Math.sqrt(A.beat!.confidence * B.beat!.confidence) + 0.25);
  p.keyInfo = keyInfo;
  p.fallbackReason = fallbackReason;
  p.beatAlign = {
    bpmA: A.beat!.bpm,
    bpmB: B.beat!.bpm,
    relation: rel.m,
    ratio: 1,
    stretchPercent: 0,
    overlapBeats: Math.round(D / pA),
    phraseAligned: isPhrase,
  };
  const cut = Math.max(0, A.audibleEnd - exit - D);
  p.reasons = [
    `смена темпа на сильной доле у границы ${isPhrase ? 'фразы' : 'такта'}: короткий срез с защитой от щелчка`,
    ...(fallbackReason ? [fallbackReason] : []),
    cut > 2 ? `пропускается ${Math.round(cut)} с финала` : 'текущий трек звучит почти до конца',
  ];
  p.debug = { cut: r3(cut), variant: 'downbeat-cut' };
  describeEntry(p, B, entry);
  return p;
}

function planCrossfade(
  ctx: Ctx,
  A: TrackAnalysis,
  B: TrackAnalysis,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>,
  fallbackReason?: string,
): TransitionPlan {
  const fade = naturalFade(A);
  const rhythmic = A.rhythmStrength > 0.45 && B.rhythmStrength > 0.45;
  const styleK = ctx.s.style === 'tight' ? 0.55 : ctx.s.style === 'smooth' ? 1.3 : 1;
  const p = basePlan(ctx, 'crossfade');
  const lenCap = Math.min(ctx.s.maxBlendSeconds, (A.audibleEnd - A.audibleStart) * 0.3, (B.audibleEnd - B.audibleStart) * 0.35);
  let L: number;
  let aGain: [number, number][];
  let bGain: [number, number][];
  let handoff: number;
  const reasons: string[] = [];
  if (fade.length >= 3) {
    // A fades out by itself: B rises inside that decay instead of fading twice
    // start B well before the decay ends: at least ~8 s of overlap
    const startIn = Math.min(Math.max(A.audibleStart, fade.start - 1), A.outro.start);
    L = Math.min(Math.max(8 * styleK, A.audibleEnd - startIn), 14 * styleK, lenCap);
    p.aExit = r3(Math.max(A.audibleStart, A.audibleEnd - L));
    handoff = decayHandoff(A, p.aExit, L);
    // v2.5: when A starts decaying right away, B came up and took the bass within ~2 s
    // ("резко"): start earlier so B rises for ~4 s under A's still-loud part
    const extra = Math.min(3.5 - handoff, Math.min(16 * styleK, lenCap) - L, p.aExit - A.audibleStart);
    if (extra > 0.25) {
      L += extra;
      p.aExit = r3(p.aExit - extra);
      handoff = decayHandoff(A, p.aExit, L);
    }
    // a long gentle decay already loses 2.5 dB in its first seconds: B's bass still waits ~3.5 s
    handoff = Math.max(handoff, Math.min(3.5, L * 0.35));
    // A has already lost level acoustically. Do not apply a second full-length
    // fade; bring B to its body near the measured decay, then remove A's tail.
    // B rises over at least ~4 s: a sub-second rise over A's decay was rated "резко";
    // A stays until B is (nearly) up, otherwise both sag together
    // v11-dj-7: B rose to full in ~3 s of a 16 s fade, still heard as switching B on; half the blend now
    const bRise = Math.min(L, Math.max(0.3, handoff * 1.15, L * 0.5));
    const aRelease = Math.min(Math.max(handoff + 1, bRise * 0.85), L * 0.7);
    aGain = [[0, 1], [r3(aRelease), 1], ...shape(aRelease, L, cosDown, 10).slice(1)];
    bGain = shape(0, bRise, sinUp, 10);
    reasons.push('текущий трек затихает сам: следующий нарастает внутри его затухания');
  } else {
    L = Math.min((rhythmic ? 9 : 11) * styleK, lenCap);
    // overlap the last seconds of A so the ending is heard; a quiet outro (not a
    // fade) longer than 4 s would leave the first half of the blend hollow, so
    // A's last loud bars carry it instead
    const loud = loudUntil(A);
    const late = A.audibleEnd - L;
    p.aExit = r3(Math.max(A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5, A.audibleEnd - loud >= 4 ? Math.min(late, loud - L * 0.5) : late));
    aGain = shape(0, L, cosDown, 14);
    bGain = shape(0, L, sinUp, 14);
    handoff = L / 2;
    reasons.push('тишина в начале и в конце обрезана, переход в самом конце трека');
  }
  const selectedEntry = pickHandoffEntry(ctx, A, B, p.aExit, handoff, L);
  // v11-dj-7: B's measured body must arrive while A still plays. Dislikes 259/256: A ended 3 s
  // in and B's quiet opening carried 4-8 s alone, 8-10 dB down, then the beat hit. Start
  // earlier so A's music runs under that opening until B's own body arrives.
  const cueB = selectedEntry.cue.time;
  let arrivalB: number | undefined;
  if (powerLevel(B, cueB, cueB + 2) < B.bodyRmsDb - 6)
    for (let t = cueB + 0.5; t <= Math.min(B.audibleEnd - 3, cueB + L + 8); t += 0.25)
      if (powerLevel(B, t, t + 1.5) >= B.bodyRmsDb - 4 && powerLevel(B, t, t + 3) >= B.bodyRmsDb - 5) { arrivalB = t; break; }
  // B's body comes in 4 s before A's loud part ends, not on it: A ending on a stop exactly where
  // B's beat arrives was still heard as a track switch (256/259 after v3).
  const early = arrivalB === undefined ? 0 : arrivalB - cueB - (loudUntil(A) - p.aExit) + 4;
  if (early > 0.5 && early <= 14 && L + early <= ctx.s.maxBlendSeconds && p.aExit - early >= A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5) {
    p.aExit = r3(p.aExit - early);
    L += early;
    handoff += early;
    aGain = aGain.map(([t, v], i) => (i ? [r3(t + early), v] : [t, v]) as [number, number]);
    // A's fader leaves before A's own ending (often a hard stop), under B's arrived body
    const stop = Math.min(L, loudUntil(A) - p.aExit), r0 = Math.max(0, stop - 4);
    const ramp = (t: number) => t <= r0 ? 1 : t >= stop ? 0.15 : 1 - 0.85 * smoothstep((t - r0) / (stop - r0));
    aGain = [...new Set([...aGain.map(([t]) => t), ...Array.from({ length: 9 }, (_, i) => r0 + (stop - r0) * i / 8)])].sort((a, b) => a - b)
      .map((t) => [r3(t), r3(Math.min(pointValue(aGain, t), ramp(t)))] as [number, number]);
    reasons.push('переход начинается раньше: музыка текущего трека держит тихое начало следующего до прихода его основной части');
  }
  p.bEntry = r3(cueB);
  p.duration = r3(L);
  p.swapAt = r3(handoff);
  p.automation = [lane('A', 'gain', aGain), lane('B', 'gain', bGain)];
  // Two unlocked grooves: A's drums (bass, hats) wash out through the filter before B's
  // rhythm comes in, so two kicks never run together ("сбился ритм"); melody/voice linger
  const washout = ctx.s.eqHandoff && rhythmic && fade.length < 3;
  if (washout) {
    p.automation.push(lane('A', 'filter', [[0, 0]], shape(L * .3, L * .85, x => .7 * smoothstep(x), 12)));
    p.automation.push(lane('A', 'low', [[0, 1]], shape(L * 0.25, L * 0.5, (x) => 1 - smoothstep(x), 6)));
    p.automation.push(lane('B', 'low', [[0, 0]], shape(L * 0.4, L * 0.58, smoothstep, 6)));
    p.automation.push(lane('A', 'high', [[0, 1]], shape(L * 0.1, L * 0.45, (x) => 1 - 0.6 * smoothstep(x), 6)));
    p.automation.push(lane('B', 'high', [[0, 0.3]], shape(L * 0.35, L * 0.65, (x) => 0.3 + 0.7 * smoothstep(x), 6)));
    reasons.push('уход через фильтр: бас и верха текущего трека растворяются до того, как входит ритм следующего');
  } else if (ctx.s.eqHandoff) {
    // bass hands over in the middle; with two different grooves the tops
    // (hats, cymbals) are exchanged one after the other instead of on top of each other
    const handoffFrom = Math.max(0, handoff - Math.min(0.75, L * 0.08));
    const handoffTo = Math.min(L, handoff + Math.min(0.75, L * 0.08));
    p.automation.push(lane('A', 'low', [[0, 1]], shape(handoffFrom, handoffTo, (x) => 1 - smoothstep(x), 4)));
    p.automation.push(lane('B', 'low', [[0, 0.15]], shape(handoffFrom, handoffTo, (x) => 0.15 + 0.85 * smoothstep(x), 4)));
    // two vocals/melodies at once: B's middle stays back until A's has gone
    const densA = curveMean(A.curves.midDensity, A.curves.rate, p.aExit, p.aExit + L);
    const densB = curveMean(B.curves.midDensity, B.curves.rate, p.bEntry, p.bEntry + L);
    // v7: two reliably detected, clashing keys are not layered at full mids either (harmonic mixing)
    const keyClash = keyInfo.compatibility < 0.3 && A.key.confidence >= 0.4 && B.key.confidence >= 0.4;
    if (densA * densB * 6 > 0.35 || keyClash) {
      p.automation.push(lane('B', 'mid', [[0, 0.4]], shape(Math.max(0, handoff - L * 0.15), Math.min(L, handoff + L * 0.25), (x) => 0.4 + 0.6 * smoothstep(x), 6)));
      p.automation.push(lane('A', 'mid', [[0, 1]], shape(Math.max(0, handoff - L * 0.2), Math.min(L, handoff + L * 0.2), (x) => 1 - 0.6 * smoothstep(x), 6)));
      reasons.push(keyClash && densA * densB * 6 <= 0.35 ? 'тональности конфликтуют: середина треков меняется по очереди, а не звучит одновременно' : 'плотные средние частоты меняются по очереди, чтобы уменьшить конфликт мелодий');
    }
    if (rhythmic) {
      p.automation.push(lane('A', 'high', shape(0, Math.min(L, handoff + L * 0.1), (x) => 1 - 0.55 * smoothstep(x), 6)));
      p.automation.push(lane('B', 'high', [[0, 0.45]], shape(Math.max(0, handoff - L * 0.1), Math.min(L, handoff + L * 0.5), (x) => 0.45 + 0.55 * smoothstep(x), 6)));
      reasons.push('верха и бас меняются по очереди, чтобы уменьшить конфликт разных ритмов');
    }
  }
  p.confidence = 0.6;
  p.keyInfo = keyInfo;
  p.fallbackReason = fallbackReason;
  p.reasons = [fade.length >= 3 ? `передача по измеренному затуханию, ${L.toFixed(0)} с` : `плавный переход с постоянной мощностью, ${L.toFixed(0)} с`, ...(fallbackReason ? [fallbackReason] : []), ...reasons];
  describeEntry(p, B, selectedEntry.cue, selectedEntry.arrival);
  p.debug = { naturalFade: fade.length >= 3, washout, acousticHandoff: r3(handoff), entryScore: r3(selectedEntry.score) };
  return p;
}

/**
 * Bass-free stretches at the start of B (pads, vocals, filtered intro) that end in a
 * measured bass/kick arrival: the low band stays >= 10 dB under B's body for at least
 * 6 s, then rises to its body level and stays there. Band levels only, no semantics.
 */
export function bassArrivals(B: TrackAnalysis, until: number): { start: number; arrival: number }[] {
  const c = B.curves, low = c.lowDb;
  const sorted = low.slice(Math.floor(B.audibleStart * c.rate), Math.ceil(B.audibleEnd * c.rate)).sort((x, y) => x - y);
  if (!sorted.length) return [];
  const body = sorted[sorted.length >> 1];
  const level = (a: number, b: number) => powerLevel(B, a, b, low);
  const grid = B.beat && B.beat.confidence >= 0.45 ? B.beat.downbeats : [];
  const out: { start: number; arrival: number }[] = [];
  let runStart: number | null = null;
  for (let t = B.audibleStart; t <= Math.min(until, B.audibleEnd - 6); t += 0.25) {
    if (level(t - 0.5, t + 0.5) < body - 10) { runStart ??= t; continue; }
    if (runStart !== null && t - runStart >= 6 && level(t, t + 4) >= body - 4) {
      // first 0.25 s where the bass is back, on B's bar line when one is that close
      let at = t - 1;
      while (at < t + 1.5 && level(at, at + 0.25) < body - 6) at += 0.05;
      const bar = grid.find((d) => Math.abs(d - at) < 0.3);
      out.push({ start: runStart, arrival: r3(bar ?? at) });
    }
    runStart = null;
  }
  return out;
}

/**
 * Intro over groove (v2.5): B enters with its bass-free intro over A's full groove,
 * A's kick and bass wash out well before B's own beat arrives, and B's beat drops when
 * A is nearly gone. The tempi stay native, yet no two kicks ever run together: the
 * DJ move for tracks whose tempi cannot be locked, aligned to B's measured arrival
 * instead of fixed percentages of the overlap.
 */
function planIntroDrop(ctx: Ctx, A: TrackAnalysis, B: TrackAnalysis, keyInfo: NonNullable<TransitionPlan['keyInfo']>, fallbackReason?: string): TransitionPlan | null {
  const s = ctx.s;
  if (!s.eqHandoff || s.style === 'tight' || ctx.requestedAt !== undefined) return null;
  const lenB = B.audibleEnd - B.audibleStart, lenA = A.audibleEnd - A.audibleStart;
  const preserving = s.entryMode === 'preserve' || s.maxEntrySkipSeconds === 0;
  const limit = B.audibleStart + (preserving ? 0.5 : Math.min(s.maxEntrySkipSeconds ?? 45, lenB * 0.45));
  const tail = 2;
  const maxT = Math.min(16, s.maxBlendSeconds - tail, lenA * 0.3, lenB * 0.35);
  if (maxT < 6) return null;
  const bDowns = B.beat && B.beat.confidence >= 0.45 ? B.beat.downbeats : [];
  const aGrid = A.beat && A.beat.stable && A.beat.confidence >= 0.45 ? A.beat.downbeats : null;
  const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1000)));
  const keyClash = keyInfo.compatibility < 0.5;
  // A's groove (and its bass, most of the power) stays until 0.65 T; its bass is gone 0.8 s
  // before B's beat, A is mostly gone at T
  const lanesAt = (T: number, duckMid = keyClash) => {
    const L = T + tail;
    return [
      lane('B', 'gain', shape(0, Math.min(4, T * 0.4), sinUp, 8)),
      lane('B', 'low', [[0, 0]], shape(T - 0.4, T - 0.05, smoothstep, 4)),
      lane('B', 'high', [[0, 0.5]], shape(T * 0.5, T, (x) => 0.5 + 0.5 * smoothstep(x), 6)),
      lane('A', 'gain', [[0, 1]], shape(T * 0.7, T + tail * 0.4, cosDown, 10), [[r3(L), 0]]),
      lane('A', 'low', [[0, 1]], shape(T * 0.65, T - 0.8, (x) => 1 - smoothstep(x), 6)),
      lane('A', 'high', [[0, 1]], shape(T * 0.4, T * 0.85, (x) => 1 - 0.5 * smoothstep(x), 6)),
      ...(duckMid ? [lane('A', 'mid', [[0, 1]], shape(T * 0.3, T * 0.7, (x) => 1 - 0.5 * smoothstep(x), 6))] : []),
    ];
  };
  // P7: a bass-free intro can carry a voice. With B's voice unknown a dense intro is not laid
  // under A's full mids: A's middle steps back, and two dense unknown parts are not overlapped at all.
  const unknownA = voiceUnknown(A, s), unknownB = voiceUnknown(B, s);
  let best: { score: number; exit: number; entry: number; T: number; cut: number; hole: number; duck: boolean } | null = null;
  for (const run of bassArrivals(B, limit + maxT)) {
    const entries = [run.arrival - maxT, run.arrival - 12, run.arrival - 8].map((e) => Math.max(e, run.start, B.audibleStart))
      .map((e) => bDowns.find((d) => d >= e - 0.01 && d < e + 1) ?? e);
    for (const entry of new Set(entries.map(r3))) {
      const T = run.arrival - entry;
      if (T < 6 || T > maxT + 0.01 || entry > limit) continue;
      const L = T + tail;
      let lanes = lanesAt(T);
      const at = (deck: 'A' | 'B', l: AutomationLane['lane'], t: number) => { const x = lanes.find((q) => q.deck === deck && q.lane === l); return x ? pointValue(x.points, t) : 1; };
      const densB = unknownB ? curveMean(B.curves.midDensity, B.curves.rate, entry, entry + T) / bodyDensity(B) : 0;
      // B's words before about T/2 stay masked while A's voice still owns the blend (vocal handoff)
      let bMuted = 0;
      if (s.stemMixing !== false && B.vocalActivity) for (let t = 0; t < T / 2; t += 0.25) bMuted += clamp((vocalMean(B, entry + t, entry + t + 0.25) - 0.15) / 0.7) * at('B', 'gain', t) * 0.25;
      if (bMuted > 1.5) continue;
      const drops = aGrid ? aGrid.filter((t) => t > A.audibleEnd - 60 && t <= A.audibleEnd - tail) : Array.from({ length: 120 }, (_, i) => A.audibleEnd - tail - i * 0.5);
      for (const drop of drops) {
        const exit = drop - T;
        if (exit < A.audibleStart + lenA * 0.5) continue;
        // densities relative to each song's own body (most songs sit near 0.24 overall)
        const densA = densB >= 0.9 ? curveMean(A.curves.midDensity, A.curves.rate, exit, exit + T * 0.7) / bodyDensity(A) : 0;
        if (unknownA && densA >= 1.1 && densB >= 1.1) continue;
        const duck = keyClash || densB >= 0.9 && densA >= 0.9;
        lanes = lanesAt(T, duck);
        // audible power along the blend against the louder of the two songs' own levels
        const reference = Math.min(levelBefore(A, exit) + ctx.gainA, powerLevel(B, run.arrival, Math.min(B.audibleEnd, run.arrival + 6)) + ctx.gainB);
        let hole = 0;
        for (let i = 1; i <= 16; i++) {
          const t = (L * i) / 16;
          const stems=s.stemMixing!==false&&A.vocalActivity&&B.vocalActivity;
          const sum = at('A', 'gain', t) ** 2 * filteredPower(A, exit + t, ctx.gainA, at('A', 'low', t), at('A', 'mid', t), at('A', 'high', t),stems&&t>=T/2?0:1)
            + at('B', 'gain', t) ** 2 * filteredPower(B, entry + t, ctx.gainB, at('B', 'low', t), at('B', 'mid', t), at('B', 'high', t),stems&&t<T/2?0:1);
          // a short breath before B's beat drops is part of the move: 3 dB are tolerated
          hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, sum)) - 3);
          // A must not run into its own quiet outro while it still carries the mix
          if (at('A', 'gain', t) >= 0.5) hole = Math.max(hole, levelBefore(A, exit) - powerLevel(A, exit + t - 0.75, exit + t + 0.75) - 6);
        }
        if (hole > 3) continue;
        const cut = A.audibleEnd - drop - tail;
        const clash = s.stemMixing !== false ? voiceClash(A, B, exit, L, entry, L, L, (x) => [at('A', 'gain', x * L), at('B', 'gain', x * L)]) : 0;
        const score = 0.45 * cutScore(A, drop + tail) - 0.5 * clamp(hole / 10) + (phraseSet.has(Math.round(drop * 1000)) ? 0.08 : 0)
          + 0.12 * (1 - clamp(Math.abs(T - 12) / 8)) - entrySkipCost(B, entry, false, unknownB) - Math.min(0.4, 0.08 * clash) - 0.1 * bMuted
          - 0.1 * vocalMean(A, drop - 0.3, drop + 0.2);
        if (!best || score > best.score) best = { score, exit, entry, T, cut, hole, duck };
      }
    }
  }
  if (!best || best.score < 0.2) return null;
  const { exit, entry, T } = best, L = T + tail;
  const p = basePlan(ctx, 'crossfade');
  p.aExit = r3(exit);
  p.bEntry = r3(entry);
  p.duration = r3(L);
  p.swapAt = r3(T);
  p.automation = lanesAt(T, best.duck);
  p.confidence = 0.65;
  p.keyInfo = keyInfo;
  p.fallbackReason = fallbackReason;
  p.reasons = [
    `вступление следующего трека поверх ритма текущего, ${T.toFixed(0)} с; бит следующего входит, когда ритм текущего уже ушёл`,
    ...(fallbackReason ? [fallbackReason] : []),
    'бас и верха текущего трека растворяются до того, как вступает бит следующего: две бочки не звучат вместе',
    ...(best.duck && !keyClash ? ['вступление следующего плотное, голос в нём не измерен: середина текущего трека отступает, две ведущие партии не звучат в полную силу'] : []),
    best.cut > 2 ? `пропускается ${Math.round(best.cut)} с финала` : 'текущий трек звучит почти до конца',
  ];
  describeEntry(p, B, { time: entry, score: 0.7, kind: 'section', tags: ['bass-arrival'] }, entry + T);
  // the fader push of holdLoudness must not bring A's groove back at B's drop
  p.debug = { washout: true, variant: 'intro-drop', bassArrival: r3(entry + T), holdUntil: r3(T * 0.85), levelHole: r3(best.hole), cut: r3(best.cut), entryScore: r3(best.score) };
  return p;
}

function planMinimal(
  ctx: Ctx,
  A: TrackAnalysis,
  B: TrackAnalysis,
  keyInfo: NonNullable<TransitionPlan['keyInfo']>,
  fallbackReason?: string,
): TransitionPlan {
  const p = basePlan(ctx, 'gapless');
  const D = 0.03;
  p.aExit = r3(Math.min(A.duration - D, A.audibleEnd));
  p.bEntry = r3(Math.max(0, B.audibleStart - 0.02));
  p.duration = D;
  p.gap = 0.12;
  p.swapAt = D;
  p.automation = [lane('A', 'gain', [[0, 1], [D, 0]])];
  p.confidence = 0.7;
  p.keyInfo = keyInfo;
  p.fallbackReason = fallbackReason;
  p.reasons = [
    'резкий финал и резкое начало: наложение испортило бы оба трека',
    'стык без наложения с короткой паузой',
    ...(fallbackReason ? [fallbackReason] : []),
  ];
  return p;
}

/** An explicit Next request uses the same DSP strategies near the current
 * position, rather than throwing the prepared mix away for a 400 ms skip. */
export function planRequestedTransition(a: PlannerTrack, b: PlannerTrack, position: number, settings: AutoMixSettings): TransitionPlan {
  settings=sanitizedSettings(settings);
  const now = safePosition(position,a.duration);
  if (!settings.enabled || settings.mixOnNext === false || !a.mixingAllowed || !b.mixingAllowed) return planSkip(a,b,now,settings);
  const A=a.analysis, B=b.analysis;
  const model=planTransition(a,b,{...settings,maxBlendSeconds:Math.min(8,settings.maxBlendSeconds)},now);
  if (model.method==='gapless') return planSkip(a,b,now,settings);
  // The requested-position search already chose this boundary with B's cue.
  // Moving it to a different bar would discard that local energy comparison.
  const exit=model.aExit;
  const points=model.tempoA??[[0,1]] as [number,number][];
  const knots=[0,...points.map(([t])=>t).filter(t=>t>0&&t<model.duration),model.duration];
  const value=(t:number)=>{for(let i=1;i<points.length;i++)if(t<=points[i][0])return points[i-1][1]+(points[i][1]-points[i-1][1])*(t-points[i-1][0])/(points[i][0]-points[i-1][0]);return points[points.length-1][1]};
  let consumed=0;for(let i=1;i<knots.length;i++)consumed+=(knots[i]-knots[i-1])*(value(knots[i])+value(knots[i-1]))/2;
  if(Number.isFinite(exit)&&exit+consumed<=Math.min(a.duration,A?.audibleEnd??a.duration)&&model.method!=='crossfade'&&model.method!=='fallback_crossfade'){
    return {...model,id:`${model.id}_request_${Math.round(now*1000)}`,aExit:r3(exit),
      reasons:['переход по кнопке «Следующий»: начинается у ближайшей музыкальной доли',...model.reasons.filter(r=>!r.includes('финала')&&!r.includes('до конца'))],
      debug:{...model.debug,requested:true,requestedAt:now}};
  }
  const ctx:Ctx={a,b,s:settings,gainA:normalizationGain(A,settings.loudnessTarget),gainB:normalizationGain(B,settings.loudnessTarget)};
  const p=basePlan(ctx,A&&B?'crossfade':'fallback_crossfade');
  const D=Math.min(6,settings.maxBlendSeconds,(A?.audibleEnd??a.duration)-now-0.08,(B?.audibleEnd??b.duration)-(B?.audibleStart??0));
  if(D<0.2)return planSkip(a,b,now,settings);
  p.id+=`_request_${Math.round(now*1000)}`;p.aExit=r3(now+0.08);p.duration=r3(D);p.swapAt=r3(D/2);
  const selected=A&&B?pickHandoffEntry(ctx,A,B,p.aExit,D/2,D):null;
  p.bEntry=r3(selected?.cue.time??B?.audibleStart??0);
  p.automation=[lane('A','gain',shape(0,D,cosDown,16)),lane('B','gain',shape(0,D,sinUp,16))];
  if(settings.eqHandoff){
    p.automation.push(lane('A','low',[[0,1]],shape(D*.35,D*.65,x=>1-smoothstep(x),8)));
    p.automation.push(lane('B','low',[[0,0]],shape(D*.35,D*.65,smoothstep,8)));
  }
  p.confidence=A&&B?0.65:0.3;p.reasons=['переход по кнопке «Следующий»: плавная передача из текущего места',`наложение ${D.toFixed(1)} с с выравниванием громкости`];
  if(B&&selected)describeEntry(p,B,selected.cue,selected.arrival);
  p.debug={requested:true,requestedAt:now};return finishPlan(p,A,B,settings,now);
}

/** Fast explicit skip (dislike, repeated Next, or AutoMix disabled). */
export function planSkip(a: PlannerTrack, b: PlannerTrack, aPosition: number, settings: AutoMixSettings): TransitionPlan {
  aPosition=safePosition(aPosition,a.duration);
  const ctx: Ctx = {
    a,
    b,
    s: settings,
    gainA: normalizationGain(a.analysis, settings.loudnessTarget),
    gainB: normalizationGain(b.analysis, settings.loudnessTarget),
  };
  if (!a.mixingAllowed || !b.mixingAllowed) {
    const join=planSequential(ctx,'источник не разрешает обработку звука: переключение без наложения');
    join.aExit=r3(Math.max(0,Math.min(a.duration,aPosition)));
    join.gainA=0;join.gainB=0;
    return join;
  }
  const p = basePlan(ctx, 'skip_fade');
  p.id = `${p.id}_skip_${Math.round(aPosition * 10)}`;
  const B = b.analysis;
  const entry = B ? settings.entryMode === 'preserve' ? B.audibleStart : (B.cues.entry.find((c) => c.kind === 'start')?.time ?? B.audibleStart) : 0;
  const D = 0.4;
  p.aExit = r3(aPosition);
  p.bEntry = r3(Math.max(0, settings.enabled ? entry : 0));
  p.duration = D;
  p.swapAt = 0;
  p.automation = [lane('A', 'gain', shape(0, D, cosDown, 6)), lane('B', 'gain', shape(0, 0.12, sinUp, 4))];
  p.confidence = 1;
  p.reasons = ['переключение вручную: быстрое затухание'];
  return p;
}

/**
 * Manual "next" while a transition to B is already prepared: reuse B's entry
 * point and gains from the prepared plan, fade A out quickly from `aPosition`.
 */
export function skipPlanFrom(prepared: TransitionPlan, aPosition: number): TransitionPlan {
  if(prepared.debug.processingAllowed===false){
    return {...prepared,id:`${prepared.id}_skip_${Math.round(aPosition*10)}`,method:'gapless',aExit:r3(aPosition),bEntry:0,duration:0,gap:0,swapAt:0,
      gainA:0,gainB:0,tempoA:undefined,tempoB:[[0,1]],echo:undefined,voiceEcho:undefined,automation:[],beatAlign:undefined,
      vocalA:undefined,vocalB:undefined,loopA:undefined,tapeStopA:undefined,bDelay:undefined,
      reasons:['источник не разрешает обработку звука: переключение без наложения'],debug:{processingAllowed:false,skippedFrom:prepared.id}};
  }
  const D = 0.4;
  return {
    ...prepared,
    id: `${prepared.id}_skip_${Math.round(aPosition * 10)}`,
    method: 'skip_fade',
    confidence: 1,
    reasons: ['переключение вручную: быстрое затухание'],
    fallbackReason: undefined,
    aExit: r3(aPosition),
    duration: D,
    gap: 0,
    swapAt: 0,
    tempoB: [[0, 1]],
    tempoA: undefined,
    loopA: undefined,
    tapeStopA:undefined,
    bDelay: undefined,
    vocalA: undefined,
    vocalB: undefined,
    echo: undefined,
    voiceEcho: undefined,
    automation: [lane('A', 'gain', shape(0, D, cosDown, 6)), lane('B', 'gain', shape(0, 0.12, sinUp, 4))],
    beatAlign: undefined,
    debug: { skippedFrom: prepared.id },
  };
}
