import { describe, expect, it } from 'vitest';
import { planRequestedTransition, planSkip, planTransition, skipPlanFrom } from '../src/plan/planner.ts';
import { applyVocalHandoff, BLEED_MID, BLEED_HIGH, lyricTiming, vocalPhrases, vocalPowerRetained } from '../src/plan/vocals.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { integrateTempo, outputTimeAt, pointValue } from '../src/plan/timing.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type BeatGrid, type BeatRegion, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

const S = DEFAULT_AUTOMIX_SETTINGS;

describe('phrase-safe vocal policy v3',()=>{
  it('clears outgoing vocal bleed before the first incoming consonant on a tight handoff',()=>{
    const A=song('bleed-a',120).analysis!,B=song('bleed-b',120).analysis!;
    const base:TransitionPlan={id:'tight-bleed',version:'test',fromTrackId:'a',toTrackId:'b',method:'beatmatch_blend',
      confidence:1,reasons:[],debug:{},aExit:0,bEntry:0,duration:2,gap:0,swapAt:1,tempoB:[[0,1]],gainA:0,gainB:0,
      automation:[{deck:'A',lane:'gain',points:[[0,1],[2,0]]},{deck:'B',lane:'gain',points:[[0,0],[2,1]]}]};
    const p=applyVocalHandoff(base,A,B,S);
    const st=p.debug.stems as {bVoiceStart:number;bleedGuard:{from:number;to:number}|null};
    expect(st.bleedGuard).not.toBeNull();
    expect(st.bleedGuard!.to).toBeLessThanOrEqual(st.bVoiceStart);
    for(const [band,ceiling] of [['mid',BLEED_MID],['high',BLEED_HIGH]] as const){
      const lane=p.automation.find(l=>l.deck==='A'&&l.lane===band)!;
      expect(pointValue(lane.points,st.bVoiceStart)).toBeLessThanOrEqual(ceiling+1e-6);
      expect(lane.points.every(([t,g])=>t>=0&&t<=p.duration&&Number.isFinite(g))).toBe(true);
    }
    checkSeparatedVoices(p);
  });

  it('rejects out-of-track and overlapping word timestamps before they influence an edit',()=>{
    const a=song('lyrics-validation',120).analysis!;
    const words=Array.from({length:10},(_,i)=>[i,i+0.4] as [number,number]);
    const valid={version:'test',language:null,confidence:0.8,words,lines:[[0,9.4]] as [number,number][]};
    a.vocalActivity!.lyrics=valid;
    expect(lyricTiming(a)).not.toBeNull();
    for(const invalid of [
      {...valid,confidence:Infinity},
      {...valid,words:[[-1,0.4] as [number,number],...words.slice(1)]},
      {...valid,words:[...words.slice(0,9),[9,181] as [number,number]]},
      {...valid,words:[[0,1.2] as [number,number],...words.slice(1)]},
    ]){
      a.vocalActivity!.lyrics=invalid;
      expect(lyricTiming(a)).toBeNull();
    }
  });
  it.each([44100,48000])('keeps applied fades inside short breaths and preserves incoming PCM at %i Hz',(sr)=>{
    const A=song('short-breath-a',120).analysis!,B=song('short-breath-b',120).analysis!;
    A.vocalActivity!.values.fill(0.4);B.vocalActivity!.values.fill(0.4);
    A.vocalActivity!.phrases=[{start:0,end:0.9,confidence:0.9},{start:1.2,end:2,confidence:0.9}];
    B.vocalActivity!.phrases=[{start:0,end:0.9,confidence:0.9},{start:1.15,end:2,confidence:0.9}];
    const base:TransitionPlan={id:'short-breath',version:'test',fromTrackId:'a',toTrackId:'b',method:'crossfade',
      confidence:1,reasons:[],debug:{},aExit:0,bEntry:0,duration:2,gap:0,swapAt:1,tempoB:[[0,1]],gainA:0,gainB:0,
      automation:[{deck:'A',lane:'gain',points:[[0,1],[2,1]]},{deck:'B',lane:'gain',points:[[0,0],[2,0]]}]};
    const p=applyVocalHandoff(base,A,B,S);
    expect(p.vocalA![2][0]).toBe(0.95);
    expect(p.vocalA![1][0]).toBeGreaterThanOrEqual(0.9);
    expect(p.vocalB![1][0]).toBeLessThan(1.15);
    expect(p.vocalB![2][0]).toBeLessThanOrEqual(1.15);
    checkSeparatedVoices(p);
    const voice=Float32Array.from({length:sr*4},(_,i)=>i>=Math.round(1.15*sr)&&i<Math.round(1.4*sr)?0.15*Math.sin(2*Math.PI*660*i/sr):0);
    const silence=new Float32Array(voice.length);
    const a={L:silence,R:silence,sampleRate:sr,vocals:{L:silence,R:silence}};
    const b={L:voice,R:voice,sampleRate:sr,vocals:{L:voice,R:voice}};
    // Isolate B's first syllable: equal deck gains and no EQ hide no difference.
    const isolated={...p,voiceEcho:undefined,automation:[
      {deck:'A' as const,lane:'gain' as const,points:[[0,0]] as [number,number][]},
      {deck:'B' as const,lane:'gain' as const,points:[[0,1]] as [number,number][]},
    ]};
    const fixed=renderTransitionOffline(a,b,isolated,0,0.2);
    const reference=renderTransitionOffline(a,b,{...isolated,vocalB:undefined},0,0.2);
    const old=renderTransitionOffline(a,b,{...isolated,vocalB:[[0,0],[0.95,0],[1.25,1],[2,1]]},0,0.2);
    let error=0,oldError=0;
    for(let i=Math.round(1.15*sr);i<Math.round(1.3*sr);i++){
      error=Math.max(error,Math.abs(fixed.L[i]-reference.L[i]));
      oldError=Math.max(oldError,Math.abs(old.L[i]-reference.L[i]));
    }
    expect(error).toBeLessThan(1e-6);
    expect(oldError).toBeGreaterThan(0.02);
    expect(fixed.metrics.underruns).toBe(0);
  });

  it('fits breaths in source time during tempo glides and offset entries',()=>{
    const A=song('glide-breath-a',120).analysis!,B=song('glide-breath-b',120).analysis!;
    A.vocalActivity!.values.fill(0.4);B.vocalActivity!.values.fill(0.4);
    const tempoA:[number,number][]=[[0,1.08],[2,1]],tempoB:[number,number][]=[[0,0.94],[2,1]];
    const a=(t:number)=>2+integrateTempo(tempoA,t),b=(t:number)=>3+integrateTempo(tempoB,t);
    A.vocalActivity!.phrases=[{start:a(0),end:a(0.9),confidence:0.9},{start:a(1.2),end:a(2),confidence:0.9}];
    B.vocalActivity!.phrases=[{start:b(0),end:b(0.9),confidence:0.9},{start:b(1.15),end:b(2),confidence:0.9}];
    const base:TransitionPlan={id:'glide-breath',version:'test',fromTrackId:'a',toTrackId:'b',method:'crossfade',
      confidence:1,reasons:[],debug:{},aExit:2,bEntry:3,duration:2,gap:0,swapAt:1,tempoA,tempoB,gainA:0,gainB:0,
      automation:[{deck:'A',lane:'gain',points:[[0,1],[2,1]]},{deck:'B',lane:'gain',points:[[0,0],[2,0]]}]};
    const p=applyVocalHandoff(base,A,B,S);
    expect(a(p.vocalA![1][0])).toBeGreaterThanOrEqual(a(0.9));
    expect(b(p.vocalB![2][0])).toBeLessThanOrEqual(b(1.15));
    checkSeparatedVoices(p);
  });

  it('bridges consonants, rejects isolated leakage, and keeps a genuine breath',()=>{
    const a=song('phrases',120).analysis!;
    a.vocalActivity!.values=Array.from({length:1800},(_,i)=>{
      const t=i/10;
      return t>=1&&t<4&&!(t>=2&&t<2.2)||t>=4.6&&t<6||t===8?0.9:0.03;
    });
    const phrases=vocalPhrases(a);
    expect(phrases.map(p=>[p.start,p.end])).toEqual([[1,4],[4.6,6]]);
    expect(phrases.every(p=>p.confidence>0.8)).toBe(true);
  });

  it('uses validated measured phrases and safely derives them for malformed old caches',()=>{
    const a=song('phrases',120).analysis!;
    const measured=[{start:1,end:2,confidence:0.95}];
    a.vocalActivity!.phrases=measured;
    expect(vocalPhrases(a)).toBe(measured);
    a.vocalActivity!.phrases=[{start:2,end:1,confidence:NaN}];
    expect(vocalPhrases(a)).toEqual([{start:0,end:180,confidence:expect.any(Number)}]);
  });

  it('edits A in a sustained breath and completes B’s fade before its first consonant',()=>{
    const A=song('a-phrases',120).analysis!,B=song('b-phrases',120).analysis!;
    A.vocalActivity!.values=Array.from({length:1800},(_,i)=>{
      const t=i/10;return (t>=2.3&&t<3.2)||(t>=3.7&&t<3.9)?0.03:0.9;
    });
    B.vocalActivity!.values=Array.from({length:1800},(_,i)=>i<43?0.03:0.9);
    const base:TransitionPlan={id:'phrase-safe',version:'test',fromTrackId:'a',toTrackId:'b',method:'beatmatch_blend',
      confidence:1,reasons:[],debug:{},aExit:0,bEntry:0,duration:8,gap:0,swapAt:4,tempoB:[[0,1]],gainA:0,gainB:0,
      automation:[{deck:'A',lane:'gain',points:[[0,1],[8,0]]},{deck:'B',lane:'gain',points:[[0,0],[2,1],[8,1]]}]};
    const p=applyVocalHandoff(base,A,B,S),d=p.debug.stems as {vocalHandoff:number;aBreath:boolean;bBreath:boolean};
    expect(d.aBreath).toBe(true);
    expect(d.bBreath).toBe(true);
    expect(d.vocalHandoff).toBeGreaterThanOrEqual(2.3);
    expect(d.vocalHandoff).toBeLessThan(3.2);
    expect(pointValue(p.vocalB!,4.3)).toBe(1);
    checkSeparatedVoices(p);
    // Re-decorating an already prepared plan never leaves an old throw behind.
    const noThrow=applyVocalHandoff({...p,voiceEcho:{delay:0.5,feedback:0.7},automation:[...p.automation,{deck:'A',lane:'voiceEcho',points:[[0,1]]}]},
      {...A,vocalActivity:{...A.vocalActivity!,values:Array(1800).fill(0)}},B,S);
    expect(noThrow.voiceEcho).toBeUndefined();
    expect(noThrow.automation.some(l=>l.lane==='voiceEcho')).toBe(false);
  });

  it('measures accompaniment reserves rather than equating presence with vocal power',()=>{
    const a=song('power',120).analysis!,v=a.vocalActivity!;
    v.vocalRmsDb=Array(1800).fill(-6);v.accompanimentRmsDb=Array(1800).fill(-40);
    expect(vocalPowerRetained(a,0,2,0)).toBeLessThan(0.001);
    [v.vocalRmsDb,v.accompanimentRmsDb]=[v.accompanimentRmsDb,v.vocalRmsDb];
    expect(vocalPowerRetained(a,0,2,0)).toBeGreaterThan(0.99);
    expect(vocalPowerRetained(a,0,2,1)).toBe(1);
    v.vocalRmsDb=[NaN];v.accompanimentRmsDb=[NaN];
    expect(vocalPowerRetained(a,0,2,0)).toBe(1);
  });

  it('invalidates plan identity when measured feature policy changes and drops inherited voice echoes on skip',()=>{
    const a=song('a-id',118),b=song('b-id',121);
    const legacy=planTransition(a,b,S);
    a.analysis!.vocalActivity!.version='vocal-activity-2';
    const current=planTransition(a,b,S);
    expect(current.id).not.toBe(legacy.id);
    a.analysis!.vocalActivity!.revision='21ad334a0218fdeb24385d62';
    expect(planTransition(a,b,S).id).not.toBe(current.id);
    expect(skipPlanFrom({...current,voiceEcho:{delay:0.5,feedback:0.5}},45).voiceEcho).toBeUndefined();
  });

  it('keeps B’s opening instead of suppressing its entire first phrase in a long locked blend',()=>{
    const a=song('vocal-budget-a',130),b=song('vocal-budget-b',127);
    for(const t of [a,b])t.analysis!.curves.midDensity.fill(0.1);
    a.analysis!.audibleEnd=175.5;
    a.analysis!.cues.exit=a.analysis!.beat!.downbeats.filter(t=>t>140).map(time=>({time,score:Math.abs(time-144)<0.03?1:0.1,kind:'downbeat',tags:[]}));
    // A has no usable breath; B sings its first 14.5 s continuously. A
    // 16-bar blend must not make that complete opening disappear.
    a.analysis!.vocalActivity!.values.fill(0.9);
    b.analysis!.vocalActivity!.values=b.analysis!.vocalActivity!.values.map((_,i)=>i<145||i>=250?0.9:0.03);
    const p=planTransition(a,b,{...S,style:'smooth',entryMode:'preserve'});
    const policy=p.debug.vocalBudget as {applied:boolean;previousLostB:number;previousDuration:number}|undefined;
    // v7 planner: the selection itself prices long masked overlaps (cap 0.4), so the
    // four-bar move may be chosen directly; the bounded repair must then not be needed.
    if(policy){expect(policy.applied).toBe(true);expect(policy.previousLostB).toBeGreaterThan(3.5);expect(p.duration).toBeLessThan(policy.previousDuration);}
    expect(p.bEntry).toBe(0); // no disguised skip of the opening words
    expect(p.duration).toBeLessThan(20);
    expect(p.beatAlign!.overlapBeats).toBe(16); // still a complete four-bar DJ move
    expect((p.debug.stems as {lostB:number}).lostB).toBeLessThanOrEqual(3.5);
    checkSeparatedVoices(p);
    b.analysis!.vocalActivity!.values=b.analysis!.vocalActivity!.values.map((_,i)=>i<400?0.03:0.9);
    const instrumental=planTransition(a,b,{...S,style:'smooth',entryMode:'preserve'});
    expect(instrumental.duration).toBeGreaterThan(p.duration);
    expect(instrumental.debug.vocalBudget).toBeUndefined();
  });

  it('retains more audible power after a vocal handoff using measured accompaniment, without a gain overshoot',()=>{
    const a=song('power-a',118,{global:false}),b=song('power-b',121,{global:false});
    const settings={...S,eqHandoff:false,loudnessTarget:null,entryMode:'preserve' as const};
    const legacy=planRequestedTransition(a,b,2,settings);
    for(const track of [a,b]){
      track.analysis!.vocalActivity!.vocalRmsDb=Array(1800).fill(-18.93);
      track.analysis!.vocalActivity!.accompanimentRmsDb=Array(1800).fill(-35.05);
    }
    const measured=planRequestedTransition(a,b,2,settings);
    expect(measured.aExit).toBe(legacy.aExit);
    expect(measured.bEntry).toBe(legacy.bEntry);
    const sr=22050;
    const pcm=(hz:number,bandHz:number)=>{
      const voice=Float32Array.from({length:sr*14},(_,i)=>0.16*Math.sin(2*Math.PI*hz*i/sr));
      const L=Float32Array.from(voice,(v,i)=>v+0.025*Math.sin(2*Math.PI*bandHz*i/sr));
      return {L,R:L,sampleRate:sr,vocals:{L:voice,R:voice}};
    };
    const A=pcm(880,110),B=pcm(660,165);
    const old=renderTransitionOffline(A,B,legacy,1,1),fresh=renderTransitionOffline(A,B,measured,1,1);
    const level=(render:typeof fresh,plan:TransitionPlan)=>{
      const start=render.transitionStartFrame+Math.round((plan.swapAt+0.55)*sr),end=start+Math.round(0.7*sr);
      let p=0;for(let i=start;i<end;i++)p+=render.L[i]**2;
      return 10*Math.log10(p/(end-start));
    };
    expect(level(fresh,measured)-level(old,legacy)).toBeGreaterThan(0.5);
    expect(fresh.metrics.underruns).toBe(0);
    expect(Math.max(...measured.automation.filter(l=>l.lane==='gain').flatMap(l=>l.points.map(([,g])=>g)))).toBeLessThanOrEqual(1);
  });
});

function rhythm(bpm: number, start: number, end: number, phase = start): BeatRegion {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil((end - phase) / period) }, (_, i) => phase + i * period).filter((t) => t >= start && t < end);
  return { start, end, bpm, period, confidence: 0.93, jitterMs: 2, beats, downbeats: beats.filter((_, i) => i % 4 === 0), downbeatConfidence: 0.85, downbeatPhase: 0 };
}

function song(id: string, bpm: number, { intro = 0, voice = true, phase = 0, global = true, regions = [] as BeatRegion[] } = {}): PlannerTrack {
  const duration = 180, rate = 20;
  const rmsDb = Array.from({ length: duration * rate }, (_, i) => i / rate < intro ? -34 : -16);
  const pulse = rhythm(bpm, 0, duration, phase);
  const beat: BeatGrid = { ...pulse, stable: global, alternatives: [] };
  const analysis: TrackAnalysis = {
    version: 'dj-policy-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: global ? beat : null, beatRegions: regions, rhythmStrength: 0.93,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: pulse.downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: intro ? [intro] : [], intro: { start: 0, end: intro }, outro: { start: 164, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10), midDensity: rmsDb.map(() => 0.3) },
    peaks: rmsDb.map(() => 0.8),
    cues: {
      entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }, ...(intro ? [{ time: intro, score: 0.85, kind: 'section' as const, tags: ['energy-arrival'] }] : [])],
      exit: pulse.downbeats.filter((t) => t > 140).map((time) => ({ time, score: 0.8, kind: 'downbeat' as const, tags: ['outro'] })),
    },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.93, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.3, dynamics: 0.2, acousticness: 0.1 },
    ...(voice ? { vocalActivity: { rate: 10, values: Array.from({ length: duration * 10 }, (_, i) => i / 10 < intro ? 0.03 : 0.85), source: 'demucs' as const, model: 'measured-test' } } : {}),
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

function checkSeparatedVoices(p: TransitionPlan) {
  const first=p.debug.firstWords as {attack:number;wholeDeckFade:boolean;outgoingTailMeasuredQuiet:boolean;earlyStemHandoff?:boolean;gainRiseSeconds:number}|undefined;
  if(first){
    const a=p.automation.find(l=>l.deck==='A'&&l.lane==='gain')!.points,gb=p.automation.find(l=>l.deck==='B'&&l.lane==='gain')?.points??[[0,1]];
    // B's voice is heard at full level from its attack: deck gain times a (possibly lifted) voice mask.
    for(let t=Math.max(.012,first.attack)+(first.attack<=.012?first.gainRiseSeconds:0);t<=p.duration-(p.bDelay??0);t+=.025)
      expect(Math.min(1,pointValue(gb,t)*pointValue(p.vocalB??[[0,1]],t))).toBeGreaterThan(.995);
    if(first.wholeDeckFade){
      expect(p.vocalA).toBeUndefined();
      for(let t=Math.max(first.attack<=.012?.3:.04,first.attack);t<=p.duration;t+=.025)expect(pointValue(a,t)).toBe(0);
      expect(p.automation.some(l=>l.deck==='A'&&['echo','voiceEcho'].includes(l.lane))).toBe(false);
    }else if(first.earlyStemHandoff){
      const gap=p.debug.vocalGap as {off:number;bWord:number}|undefined;
      if(gap)expect(gap.off).toBeLessThan(gap.bWord);
      for(let t=gap?.off??Math.max(.04,first.attack);t<=p.duration;t+=.025)expect(pointValue(p.vocalA!,t)).toBe(0);
    }else expect(first.outgoingTailMeasuredQuiet).toBe(true);
    return;
  }
  expect(p.vocalA?.length).toBeGreaterThan(1);
  expect(p.vocalB?.length).toBeGreaterThan(1);
  for (const points of [p.vocalA!, p.vocalB!]) for (let i = 0; i < points.length; i++) {
    expect(points[i][0]).toBeGreaterThanOrEqual(0);
    expect(points[i][0]).toBeLessThanOrEqual(p.duration + 0.001);
    expect(points[i][1]).toBeGreaterThanOrEqual(0);
    expect(points[i][1]).toBeLessThanOrEqual(1);
    if (i) expect(points[i][0]).toBeGreaterThanOrEqual(points[i - 1][0]);
  }
  expect(pointValue(p.vocalA!, 0)).toBe(1);
  expect(pointValue(p.vocalB!, 0)).toBe(0);
  for (let i = 0; i <= 1000; i++) {
    const time = p.duration * i / 1000;
    expect(pointValue(p.vocalA!, time) > 0.25 && pointValue(p.vocalB!, time) > 0.25).toBe(false);
  }
  const bOpen = p.vocalB!.findIndex(([, gain]) => gain === 1);
  for (let i = bOpen; i < p.vocalB!.length; i++) expect(p.vocalB![i][1]).toBe(1);
  expect(pointValue(p.vocalA!, p.duration + 2)).toBe(0);
  expect(pointValue(p.vocalB!, p.duration + 2)).toBe(1);
}

function checkBounds(p: TransitionPlan, a: PlannerTrack, b: PlannerTrack, cap = S.maxBlendSeconds) {
  expect(p.duration).toBeGreaterThan(0);
  expect(p.duration).toBeLessThanOrEqual(cap + 0.001);
  expect(p.aExit).toBeGreaterThanOrEqual(0);
  expect(p.bEntry).toBeGreaterThanOrEqual(0);
  // The outgoing deck may already be silent while its delayed echo finishes.
  // Only the dry signal and the final echo-send samples require source audio.
  const silenceFrom = (lane: 'gain' | 'echo') => {
    const points = p.automation.find((l) => l.deck === 'A' && l.lane === lane)?.points;
    if (!points) return lane === 'echo' ? 0 : p.duration;
    return points.find(([time, value], i) => value <= 1e-6 && points.slice(i).every(([, v]) => v <= 1e-6))?.[0] ?? p.duration;
  };
  const neededA = Math.max(silenceFrom('gain'), silenceFrom('echo'));
  expect(p.aExit + integrateTempo(p.tempoA, neededA)).toBeLessThanOrEqual(a.analysis!.audibleEnd + 0.005);
  expect(p.bEntry + integrateTempo(p.tempoB, p.duration-(p.bDelay??0))).toBeLessThanOrEqual(b.analysis!.audibleEnd + 0.005);
}

describe('DJ policy: independent vocal and instrumental handoffs', () => {
  it.each([[118, 121], [118, 140], [118, 156]])('keeps %i → %i vocal parties separate throughout the planned blend', (bpmA, bpmB) => {
    const a = song('a', bpmA), b = song('b', bpmB, { intro: 24 });
    const p = planTransition(a, b, S);
    checkSeparatedVoices(p);
    checkBounds(p, a, b);
  });

  it('v2: blends 118 → 156 BPM with prepared vocals at native tempi instead of cutting between grooves', () => {
    const a = song('a', 118);
    const b = song('b', 156, { intro: 24, phase: 24 % (240 / 156) });
    const p = planTransition(a, b, S);
    // every rated drop between grooves was "резко" / "сбился ритм"
    expect(p.method).toBe('crossfade');
    expect(p.tempoA).toBeUndefined();
    expect(p.tempoB).toEqual([[0, 1]]);
    expect(p.duration).toBeGreaterThanOrEqual(6);
    checkSeparatedVoices(p);
    checkBounds(p, a, b);
  });

  it('preserves the complete opening when requested even with a later vocal arrival', () => {
    const a = song('a', 118), b = song('b', 156, { intro: 24 });
    const p = planTransition(a, b, { ...S, entryMode: 'preserve' });
    expect(p.bEntry).toBe(0);
    checkSeparatedVoices(p);
    checkBounds(p, a, b);
  });

  it('honors a smaller skip budget and duration cap', () => {
    const a = song('a', 118), b = song('b', 156, { intro: 24 });
    const p = planTransition(a, b, { ...S, maxEntrySkipSeconds: 8, maxBlendSeconds: 4 });
    expect(p.bEntry).toBeLessThanOrEqual(8.001);
    checkBounds(p, a, b, 4);
  });

  it('does not apply EQ when the bass/EQ setting is disabled', () => {
    const p = planTransition(song('a', 118), song('b', 156, { intro: 24 }), { ...S, eqHandoff: false });
    expect(p.method).toBe('crossfade');
    expect(p.automation.every((l) => l.lane === 'gain' || l.lane === 'echo' || l.lane === 'voiceEcho')).toBe(true);
    checkSeparatedVoices(p);
  });

  it('lets A’s loud part carry the blend instead of its quiet instrumental outro', () => {
    // "baby my type" → "КАРТА В БЛОКЕ": A ends with a quiet instrumental outro and the old
    // drop plan dipped by −9.3 LU.
    const a = song('a', 118), b = song('b', 156, { intro: 24, phase: 24 % (240 / 156) });
    const A = a.analysis!, rate = A.curves.rate;
    for (const curve of [A.curves.rmsDb, A.curves.lowDb, A.curves.midDb, A.curves.highDb])
      for (let i = 171 * rate; i < curve.length; i++) curve[i] -= 13;
    A.vocalActivity!.values.fill(0, 171 * 10);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('crossfade');
    // B already carries the mix when A drops into its quiet outro at 171 s
    expect(p.aExit).toBeLessThan(171);
    expect(pointValue(p.automation.find((l) => l.deck === 'B' && l.lane === 'gain')!.points, 171 - p.aExit)).toBeGreaterThan(0.95);
    checkSeparatedVoices(p);
    checkBounds(p, a, b);
  });

  it('omits vocal masks when disabled or when either separated party is missing', () => {
    for (const [voiceA, voiceB, enabled] of [[true, true, false], [false, true, true], [true, false, true]]) {
      const a = song('a', 118, { voice: voiceA }), b = song('b', 156, { voice: voiceB, intro: 24 });
      const p = planTransition(a, b, { ...S, stemMixing: enabled });
      expect(p.vocalA).toBeUndefined();
      expect(p.vocalB).toBeUndefined();
      expect(p.method).not.toBe('drop_mix');
    }
  });

  it('clears masks for both fast skip paths and retains them for the first musical Next', () => {
    const a = song('a', 118), b = song('b', 156, { intro: 24 });
    const requested = planRequestedTransition(a, b, 55.1, S);
    checkSeparatedVoices(requested);
    expect(requested.aExit).toBeGreaterThan(55.1);
    expect(requested.aExit).toBeLessThan(58.3);
    for (const fast of [planSkip(a, b, 55.1, S), skipPlanFrom(requested, 55.2)]) {
      expect(fast.method).toBe('skip_fade');
      expect(fast.vocalA).toBeUndefined();
      expect(fast.vocalB).toBeUndefined();
      expect(fast.echo).toBeUndefined();
    }
  });

  it('does not process a restricted source, including when constructing a repeated skip', () => {
    for (const side of ['A', 'B']) {
      const a = song('a', 118), b = song('b', 156, { intro: 24 });
      (side === 'A' ? a : b).mixingAllowed = false;
      for (const p of [planTransition(a, b, S), planRequestedTransition(a, b, 55.1, S), skipPlanFrom(planTransition(a, b, S), 55.1)]) {
        expect(p.duration).toBe(0);
        expect(p.automation).toEqual([]);
        expect(p.vocalA).toBeUndefined();
        expect(p.vocalB).toBeUndefined();
        expect(p.gainA).toBe(0);
        expect(p.gainB).toBe(0);
      }
    }
  });

  it('keeps the processingAllowed=false invariant inside the vocal decorator itself', () => {
    const a = song('a', 118), b = song('b', 121);
    const base = planTransition(a, b, { ...S, stemMixing: false });
    for (const prepared of [base, planTransition(a, b, S)]) {
      const p = applyVocalHandoff({ ...prepared, debug: { ...prepared.debug, processingAllowed: false } }, a.analysis, b.analysis, S);
      expect(p.vocalA).toBeUndefined();
      expect(p.vocalB).toBeUndefined();
    }
  });
});

describe('DJ policy: measured local rhythms', () => {
  it('v2: a normal beatmatch locks at least 4 bars; 1-2 bar locks only for a musical Next', () => {
    const p = planTransition(song('a', 118, { voice: false }), song('b', 121, { voice: false }), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.beatAlign!.overlapBeats).toBeGreaterThanOrEqual(16);
  });

  it('mixes within reliable entry/outro regions when no global grid exists', () => {
    const ar = rhythm(118, 142, 176), br = rhythm(121, 0, 40);
    const a = song('a', 118, { global: false, voice: false, regions: [ar] });
    const b = song('b', 121, { global: false, voice: false, regions: [br] });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.localRhythm).toBe(true);
    expect(p.aExit).toBeGreaterThanOrEqual(ar.start - 0.001);
    expect(p.aExit + integrateTempo(p.tempoA, p.duration)).toBeLessThanOrEqual(ar.end + 0.005);
    expect(p.bEntry).toBeGreaterThanOrEqual(br.start - 0.001);
    expect(p.bEntry + integrateTempo(p.tempoB, p.duration)).toBeLessThanOrEqual(br.end + 0.005);
    checkBounds(p, a, b);
  });

  it('does not extend an outro grid through an unmeasured gap', () => {
    const regions = [rhythm(118, 130, 146), rhythm(118, 160, 180)];
    const a = song('a', 118, { global: false, voice: false, regions });
    const b = song('b', 121, { global: false, voice: false, regions: [rhythm(121, 0, 40)] });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    const end = p.aExit + integrateTempo(p.tempoA, p.duration);
    expect(regions.some((r) => p.aExit >= r.start - 0.001 && end <= r.end + 0.005)).toBe(true);
  });

  it('supports a locally stable passage in the middle for musical Next', () => {
    const ar = rhythm(118, 44, 68), br = rhythm(121, 0, 40);
    const a = song('a', 118, { global: false, voice: false, regions: [ar] });
    const b = song('b', 121, { global: false, voice: false, regions: [br] });
    const p = planRequestedTransition(a, b, 52.37, S);
    expect(p.debug.localRhythm).toBe(true);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.aExit).toBeGreaterThan(52.37);
    expect(p.aExit).toBeLessThan(55.57);
    expect(p.aExit + integrateTempo(p.tempoA, p.duration)).toBeLessThanOrEqual(ar.end + 0.005);
  });

  it('falls back when no measured region covers the current handoff', () => {
    const a = song('a', 118, { global: false, voice: false, regions: [rhythm(118, 140, 176)] });
    const b = song('b', 121, { global: false, voice: false, regions: [rhythm(121, 0, 40)] });
    const p = planRequestedTransition(a, b, 92.37, S);
    expect(p.method).toBe('crossfade');
    expect(p.beatAlign).toBeUndefined();
    expect(p.debug.localRhythm).not.toBe(true);
  });

  it('uses the measured local tempo instead of an unstable global hypothesis', () => {
    const ar = rhythm(118, 142, 176);
    const a = song('a', 90, { voice: false, regions: [ar] });
    a.analysis!.beat!.stable = false;
    a.analysis!.beat!.confidence = 0.6;
    const b = song('b', 121, { voice: false });
    const p = planTransition(a, b, S);
    expect(p.debug.localRhythm).toBe(true);
    expect(p.beatAlign!.bpmA).toBe(118);
    expect(p.beatAlign!.bpmB).toBe(121);
    expect(p.aExit + integrateTempo(p.tempoA, p.duration)).toBeLessThanOrEqual(ar.end + 0.005);
  });

  it('ends the outgoing voice in a measured breath before the swap, then opens the incoming one', () => {
    const ar = rhythm(118, 142, 176);
    const a = song('a', 90, { regions: [ar] });
    a.analysis!.beat!.stable = false;
    const b = song('b', 121);
    const base = planTransition(a, b, { ...S, stemMixing: false });
    expect(base.beatAlign!.regions!.A).toEqual({ start: ar.start, end: ar.end, period: ar.period, downbeat: ar.downbeats[0] });
    // a breath on the local bar grid, well before the swap (the old planner moved the handoff after it)
    const candidate = ar.downbeats.map((source) => ({ source, time: outputTimeAt(base.tempoA, source - base.aExit, base.duration) }))
      .filter(({ time }) => time < base.swapAt - 0.8 && time >= base.duration * 0.1 + 0.5 && base.swapAt - time <= ar.period * 7)
      .at(-1);
    expect(candidate).toBeDefined();
    a.analysis!.vocalActivity!.values = a.analysis!.vocalActivity!.values.map((_, i) => Math.abs(i / 10 - candidate!.source) <= 0.4 ? 0.03 : 0.85);
    const sourceB = base.bEntry + integrateTempo(base.tempoB, base.swapAt);
    b.analysis!.vocalActivity!.values = b.analysis!.vocalActivity!.values.map((_, i) => i / 10 < sourceB ? 0.03 : 0.85);
    const p = applyVocalHandoff(base, a.analysis, b.analysis, S);
    const stems = p.debug.stems as { vocalHandoff: number; bVoiceStart: number; aBreath: boolean };
    expect(stems.aBreath).toBe(true);
    // the voice fade ends inside the measured breath, not at the swap
    const endSource = base.aExit + integrateTempo(base.tempoA, stems.vocalHandoff);
    expect(Math.abs(endSource - candidate!.source)).toBeLessThanOrEqual(0.4);
    expect(pointValue(p.vocalA!, base.swapAt)).toBe(0);
    expect(stems.bVoiceStart).toBeGreaterThanOrEqual(stems.vocalHandoff);
    checkSeparatedVoices(p);
  });

  it('prefers an overlap that masks less audible singing when both tracks sing', () => {
    const a = song('a', 118), b = song('b', 121);
    // B sings from its start, but has an instrumental passage at 24-48 s
    b.analysis!.vocalActivity!.values = b.analysis!.vocalActivity!.values.map((_, i) => i / 10 >= 24 && i / 10 < 48 ? 0.03 : 0.85);
    b.analysis!.sectionBoundaries = [24];
    const lost = (p: TransitionPlan) => { const st = p.debug.stems as { lostA: number; lostB: number }; return st.lostA + st.lostB; };
    const plain = applyVocalHandoff(planTransition(a, b, { ...S, stemMixing: false }), a.analysis, b.analysis, S);
    const aware = planTransition(a, b, S);
    expect(lost(aware)).toBeLessThan(lost(plain));
    expect(aware.duration).toBeGreaterThanOrEqual(4); // not collapsed into a cut
    checkSeparatedVoices(aware);
  });

  it('v2: a short natural fade still gets a full blend, and A stays up while B rises', () => {
    const a = song('a', 118, { global: false, voice: false }), b = song('b', 121, { global: false, voice: false });
    const c = a.analysis!.curves;
    c.rmsDb = c.rmsDb.map((v, i) => { const t = i / c.rate; return t < 174 ? v : v - (t - 174) * 5; });
    a.analysis!.outro = { start: 174, end: 180 };
    c.lowDb = c.rmsDb.map((v) => v - 3); c.midDb = c.rmsDb.map((v) => v - 6); c.highDb = c.rmsDb.map((v) => v - 10);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('crossfade');
    expect(p.debug.naturalFade).toBe(true);
    // the decay lasts ~6 s; the old plan used it as the whole overlap (5 s joins)
    expect(p.duration).toBeGreaterThanOrEqual(8);
    const gain = (deck: 'A' | 'B', t: number) => pointValue(p.automation.find((l) => l.deck === deck && l.lane === 'gain')!.points, t);
    const bUp = p.automation.find((l) => l.deck === 'B' && l.lane === 'gain')!.points.find(([, g]) => g >= 0.85)![0];
    expect(gain('A', bUp)).toBeGreaterThan(0.9);
  });

  it('v2.5: over A’s own fade B rises before its bass takes over, and an early label does not cut the voice', () => {
    const a = song('a', 118, { global: false }), b = song('b', 121, { global: false });
    // This checks an instrumental opening; immediate B words have priority over A's long decay.
    b.analysis!.vocalActivity!.values=b.analysis!.vocalActivity!.values.map((v,i)=>i<200?.03:v);
    // A fades by itself over its last 14 s: the crossfade puts swapAt near the start of that decay
    const c = a.analysis!.curves;
    c.rmsDb = c.rmsDb.map((v, i) => { const t = i / c.rate; return t < 166 ? v : v - (t - 166) * 2.2; });
    c.lowDb = c.rmsDb.map((v) => v - 3); c.midDb = c.rmsDb.map((v) => v - 6); c.highDb = c.rmsDb.map((v) => v - 10);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('crossfade');
    // v2.5: B's bass no longer takes over 0.65 s into A's decay ("резко"); B rises for ~3.5 s first
    expect(p.swapAt).toBeGreaterThanOrEqual(3);
    const bLow = p.automation.find((l) => l.deck === 'B' && l.lane === 'low')!.points;
    expect(pointValue(bLow, 2.5)).toBeLessThan(0.5);
    const stems = p.debug.stems as { vocalHandoff: number; bVoiceStart: number };
    expect(stems.vocalHandoff).toBeGreaterThan(2.5);
    expect(stems.bVoiceStart).toBeGreaterThanOrEqual(stems.vocalHandoff);
    // an early "now playing" label alone still does not cut the voice: it stays until B is the louder deck
    const early = applyVocalHandoff({ ...p, swapAt: 0.65, vocalA: undefined, vocalB: undefined }, a.analysis, b.analysis, S);
    const earlyStems = early.debug.stems as { vocalHandoff: number; bVoiceStart: number };
    expect(earlyStems.vocalHandoff).toBeGreaterThan(0.65 + 0.5);
    expect(earlyStems.bVoiceStart).toBeGreaterThanOrEqual(earlyStems.vocalHandoff);
    checkSeparatedVoices(early);
    checkSeparatedVoices(p);
  });

  it('never leaves the outgoing voice after the swap, even without a breath', () => {
    for (const [bpmA, bpmB] of [[118, 121], [118, 140], [118, 156]]) {
      const p = planTransition(song('a', bpmA), song('b', bpmB), S);
      if(p.debug.firstWords){checkSeparatedVoices(p);expect(pointValue(p.automation.find(l=>l.deck==='A'&&l.lane==='gain')!.points,p.swapAt)).toBe(0);continue;}
      expect(p.vocalA).toBeDefined();
      const stems = p.debug.stems as { vocalHandoff: number; bVoiceStart: number; aBreath: boolean };
      expect(stems.aBreath).toBe(false);
      expect(stems.vocalHandoff).toBeLessThanOrEqual(p.swapAt + 1e-3);
      expect(pointValue(p.vocalA!, p.swapAt)).toBe(0);
      // without a breath the fade is soft (not a 60 ms cut)
      const fadeStart = p.vocalA!.find(([, g], i) => g === 1 && p.vocalA![i + 1]?.[1] === 0)![0];
      // drop_mix keeps its cut exactly on the drop beat
      if (p.method !== 'drop_mix') expect(stems.vocalHandoff - fadeStart).toBeGreaterThan(0.2);
      expect(stems.bVoiceStart).toBeGreaterThanOrEqual(stems.vocalHandoff);
      checkSeparatedVoices(p);
    }
  });

  it('does not jump beyond the permitted entry search to reach a rhythmic region', () => {
    const a = song('a', 118, { global: false, voice: false, regions: [rhythm(118, 142, 176)] });
    const b = song('b', 121, { global: false, voice: false, regions: [rhythm(121, 60, 100)] });
    const p = planTransition(a, b, { ...S, maxEntrySkipSeconds: 30 });
    expect(p.method).toBe('crossfade');
    expect(p.bEntry).toBeLessThanOrEqual(30.001);
    expect(p.beatAlign).toBeUndefined();
  });

  it('does not lock local regions whose tempi are too far apart (118 vs 140)', () => {
    const ar = rhythm(118, 142, 176), br = rhythm(140, 20, 50);
    const a = song('a', 118, { global: false, voice: false, regions: [ar] });
    const b = song('b', 140, { global: false, voice: false, regions: [br] });
    const p = planTransition(a, b, S);
    expect(p.method).not.toBe('tempo_bridge');
    for (const [, rate] of [...(p.tempoA ?? [[0, 1]]), ...p.tempoB]) expect(rate).toBe(1);
    checkBounds(p, a, b);
  });
});

describe('DJ policy v2.5: more DJ moves without breaking the rhythm', () => {
  /** B opens with a bass-free intro (pads/melody, no kick) until `drop`, then its beat arrives. */
  function introSong(id: string, bpm: number, drop: number, sungIntro = false): PlannerTrack {
    const t = song(id, bpm), an = t.analysis!, c = an.curves;
    c.lowDb = c.lowDb.map((v, i) => (i / c.rate < drop ? v - 25 : v));
    c.rmsDb = c.rmsDb.map((v, i) => (i / c.rate < drop ? v - 4 : v));
    if (!sungIntro) an.vocalActivity!.values = an.vocalActivity!.values.map((v, i) => (i / an.vocalActivity!.rate < drop + 1 ? 0.03 : v));
    an.sectionBoundaries = [drop];
    return t;
  }
  const lanePoint = (p: TransitionPlan, deck: 'A' | 'B', l: string, t: number) => {
    const x = p.automation.find((q) => q.deck === deck && q.lane === l);
    return x ? pointValue(x.points, t) : 1;
  };

  it('lays B’s bass-free intro over A’s groove and drops B’s beat when A’s kick has gone (118 → 156)', () => {
    const drop = rhythm(156, 0, 40).downbeats.find((t) => t > 12)!;
    const a = song('a', 118), b = introSong('b', 156, drop);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('crossfade');
    expect(p.debug.variant).toBe('intro-drop');
    // B's own beat arrival is the swap: no fixed-percentage bass entry
    expect(p.bEntry + p.swapAt).toBeCloseTo(drop, 1);
    expect(p.duration).toBeGreaterThanOrEqual(8);
    expect(p.duration).toBeLessThanOrEqual(S.maxBlendSeconds + 0.001);
    for (let t = 0; t <= p.duration; t += 0.05) {
      // A's bass is gone well before B's beat (0.8 s); never both basses together
      if (t >= p.swapAt - 0.8) expect(lanePoint(p, 'A', 'low', t)).toBeLessThan(0.05);
      if (t < p.swapAt - 0.4) expect(lanePoint(p, 'B', 'low', t)).toBeLessThan(0.05);
      expect(Math.min(lanePoint(p, 'A', 'low', t) * lanePoint(p, 'A', 'gain', t), lanePoint(p, 'B', 'low', t) * lanePoint(p, 'B', 'gain', t))).toBeLessThan(0.1);
    }
    // A's groove stays whole while B's intro comes up, and is mostly gone at the drop
    expect(lanePoint(p, 'A', 'gain', p.swapAt * 0.4)).toBeGreaterThan(0.95);
    expect(lanePoint(p, 'A', 'gain', p.swapAt)).toBeLessThan(0.35);
    for (const [, r] of p.tempoB) expect(r).toBe(1);
    expect(p.tempoA).toBeUndefined();
    checkSeparatedVoices(p);
    checkBounds(p, a, b);
  });

  it('does not lay a sung intro under A’s voice: B’s words would be masked (keeps an ordinary blend)', () => {
    const drop = rhythm(156, 0, 40).downbeats.find((t) => t > 12)!;
    const p = planTransition(song('a', 118), introSong('b', 156, drop, true), S);
    expect(p.debug.variant).not.toBe('intro-drop');
  });

  it('a locked blend that leaves A before its ending sends A’s last bar into an echo on B’s grid', () => {
    const a = song('a', 124), b = song('b', 124);
    // a musical Next in the middle of A: A leaves long before its ending
    const p = planRequestedTransition(a, b, 100, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(Number(p.debug.cut)).toBeGreaterThan(4);
    expect(p.debug.variant).toBe('echo-tail');
    const beat = 60 / 124;
    const k = p.echo!.delay / beat;
    expect(Math.abs(Math.log2(k) - Math.round(Math.log2(k)))).toBeLessThan(0.01);
    const send = p.automation.find((l) => l.deck === 'A' && l.lane === 'echo')!.points;
    const bar = (4 * beat) / pointValue(p.tempoA ?? [[0, 1]], p.duration);
    // only the last bar feeds the echo, the tail is 40 dB down about 3 s after A has gone
    expect(pointValue(send, p.duration - bar - 0.05)).toBe(0);
    expect(p.echo!.feedback).toBeLessThanOrEqual(0.45);
    expect(0.5 * Math.pow(p.echo!.feedback, 3 / p.echo!.delay)).toBeLessThanOrEqual(0.0101);
    checkSeparatedVoices(p);
    checkBounds(p, a, b, 8);
    // A played out to its ending needs no echo
    const full = planTransition(a, b, S);
    if (Number(full.debug.cut) <= 4) expect(full.echo).toBeUndefined();
  });

  it('the echo tail is rendered on the grid and dies away; unlocked plans never echo A’s groove', () => {
    const SR = 22050, a = song('a', 124, { voice: false }), b = song('b', 124, { voice: false });
    const base = planTransition(a, b, S);
    const beat = 60 / 124, delay = 2 * beat;
    const p: TransitionPlan = { ...base, tempoA: undefined, tempoB: [[0, 1]], echo: { delay, feedback: 0.4 },
      automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [3.5, 1], [4, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0]] },
        { deck: 'A', lane: 'echo', points: [[0, 0], [2, 0], [4, 0.5], [4.02, 0]] }], duration: 8, swapAt: 4 };
    // A = clicks on every beat, B silent: what is heard after 4 s is the echo alone
    const n = Math.round(a.duration * SR), clicks = new Float32Array(n);
    for (let t = 0; t < a.duration; t += beat) for (let i = 0; i < 64; i++) clicks[Math.round(t * SR) + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / SR);
    const r = renderTransitionOffline({ L: clicks, R: clicks, sampleRate: SR }, { L: new Float32Array(n), R: new Float32Array(n), sampleRate: SR }, p, 2, 6);
    const start = r.transitionStartFrame, rms = (from: number, to: number) => { let e = 0; for (let i = from; i < to; i++) e += r.L[i] * r.L[i]; return Math.sqrt(e / (to - from)); };
    const early = rms(start + Math.round(4.1 * SR), start + Math.round(5.1 * SR)), late = rms(start + Math.round(7.2 * SR), start + Math.round(8.2 * SR));
    expect(early).toBeGreaterThan(1e-3);
    expect(20 * Math.log10(late / early)).toBeLessThan(-20);
    // every echo click lands on A's (= B's) beat grid
    let hits = 0;
    for (let i = start + Math.round(4.2 * SR); i < start + Math.round(6 * SR); i++) if (Math.abs(r.L[i]) > early * 2) {
      hits++;
      const phase = ((i - start) / SR - p.aExit % beat + a.analysis!.beat!.downbeats[0] + 1000 * beat) % beat;
      expect(Math.min(phase, beat - phase)).toBeLessThan(0.02);
    }
    expect(hits).toBeGreaterThan(0);
    for (const [x, y] of [[118, 156], [118, 140]]) expect(planTransition(song('a', x), song('b', y), S).echo).toBeUndefined();
  });

  it('on a lock B’s voice may start over A’s instrumental early instead of waiting half the blend', () => {
    const a = song('a', 124), b = song('b', 124);
    // A stops singing 40 s before its end, B sings from its first second
    a.analysis!.vocalActivity!.values = a.analysis!.vocalActivity!.values.map((v, i) => (i / 10 > 135 ? 0.03 : v));
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    const stems = p.debug.stems as { bVoiceStart: number; lostB: number };
    expect(stems.bVoiceStart).toBeLessThan(p.duration * 0.2);
    expect(stems.lostB).toBeLessThan(1);
    checkSeparatedVoices(p);
  });
});

describe('DJ timing maps', () => {
  it('integrates ramps and holds the final native rate, and inverts source-time targets', () => {
    const map: [number, number][] = [[0, 0.9], [4, 1.1], [8, 1]];
    expect(integrateTempo(map, 4)).toBeCloseTo(4, 10);
    expect(integrateTempo(map, 8)).toBeCloseTo(8.2, 10);
    expect(integrateTempo(map, 10)).toBeCloseTo(10.2, 10);
    expect(integrateTempo(undefined, -1)).toBe(-1);
    for (const time of [0, 1.7, 4, 6.2, 9.5]) expect(outputTimeAt(map, integrateTempo(map, time), 10)).toBeCloseTo(time, 6);
  });
});

describe('DJ policy: one voice at a time, heard in the rendered mix', () => {
  const SR = 22050;
  /** Goertzel magnitude of one frequency in x[a, b), Hann windowed. */
  function tone(x: Float32Array, a: number, b: number, hz: number): number {
    const c = 2 * Math.cos((2 * Math.PI * hz) / SR);
    let s1 = 0, s2 = 0;
    for (let i = a; i < b; i++) {
      const s0 = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a))) + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / ((b - a) / 4);
  }
  /** Voice = sine at `voiceHz` wherever the measured activity says "singing"; band = sine at `bandHz`. */
  function pcm(an: TrackAnalysis, voiceHz: number, bandHz: number) {
    const n = Math.round(an.duration * SR), v = an.vocalActivity!;
    const voice = Float32Array.from({ length: n }, (_, i) => (v.values[Math.floor((i / SR) * v.rate)] ?? 0) > 0.5 ? 0.12 * Math.sin((2 * Math.PI * voiceHz * i) / SR) : 0);
    const mix = Float32Array.from(voice, (x, i) => x + 0.12 * Math.sin((2 * Math.PI * bandHz * i) / SR));
    return { L: mix, R: mix, sampleRate: SR, vocals: { L: voice, R: voice } };
  }

  it('ends A in its breath, throws the last word, and lets B sing from its phrase start without overlap', () => {
    const a = song('a', 118), b = song('b', 121);
    const base = planTransition(a, b, { ...S, stemMixing: false });
    // A breathes ~2 beats before the swap; B starts a phrase right after the swap
    const breathA = base.aExit + integrateTempo(base.tempoA, base.swapAt - 1);
    const phraseB = base.bEntry + integrateTempo(base.tempoB, base.swapAt + 1.5);
    a.analysis!.vocalActivity!.values = a.analysis!.vocalActivity!.values.map((_, i) => i / 10 >= breathA && i / 10 < breathA + 0.6 ? 0.03 : 0.85);
    b.analysis!.vocalActivity!.values = b.analysis!.vocalActivity!.values.map((_, i) => i / 10 < phraseB ? 0.03 : 0.85);
    const p = applyVocalHandoff(base, a.analysis, b.analysis, S);
    const stems = p.debug.stems as { vocalHandoff: number; bVoiceStart: number; aBreath: boolean; lostB: number; voiceEcho: { delay: number } | null };
    expect(stems.aBreath).toBe(true);
    expect(stems.vocalHandoff).toBeLessThanOrEqual(p.swapAt);
    expect(stems.lostB).toBeLessThan(0.15); // B's phrase is not swallowed (10 Hz activity grid)
    expect(stems.bVoiceStart).toBeGreaterThan(base.swapAt + 1.2);
    expect(p.voiceEcho).toBeDefined();
    checkSeparatedVoices(p);

    const r = renderTransitionOffline(pcm(a.analysis!, 880, 110), pcm(b.analysis!, 660, 165), p, 4, 4);
    const at = (t: number) => r.transitionStartFrame + Math.round(t * SR);
    const ref = tone(r.L, at(-2), at(-1), 880);
    expect(ref).toBeGreaterThan(0.03);
    // the last word of A is really repeated by the throw...
    const echoAt = stems.vocalHandoff + p.voiceEcho!.delay;
    expect(tone(r.L, at(echoAt - 0.15), at(echoAt + 0.05), 880) / ref).toBeGreaterThan(0.05);
    // ...and both A's dry voice and its echo are below -40 dB once B sings
    const bSing = Math.max(stems.bVoiceStart + 0.35, base.swapAt + 1.6);
    expect(tone(r.L, at(bSing), at(Math.min(p.duration, bSing + 1)), 880) / ref).toBeLessThan(0.01);
    expect(tone(r.L, at(bSing), at(Math.min(p.duration, bSing + 1)), 660)).toBeGreaterThan(0.01);
    expect(r.metrics.underruns).toBe(0);
  });
});

describe('DJ policy: loudness through the band handoff', () => {
  it('keeps broadband material from sagging in the middle of a band-handoff crossfade', () => {
    const SR = 22050;
    const a = song('a', 118, { voice: false, global: false }), b = song('b', 121, { voice: false, global: false });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('crossfade');
    expect(p.automation.some((l) => l.lane === 'high')).toBe(true);
    // flat broadband noise at the analysed level (-16 dB): any sag comes from the plan
    let seed = 7;
    const noise = (seconds: number) => Float32Array.from({ length: Math.round(seconds * SR) }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return 0.274 * (seed / 2 ** 31 - 1);
    });
    const pcm = (an: TrackAnalysis) => { const x = noise(an.duration); return { L: x, R: noise(an.duration), sampleRate: SR }; };
    const r = renderTransitionOffline(pcm(a.analysis!), pcm(b.analysis!), p, 4, 4);
    const rms = (t: number) => { const s = r.transitionStartFrame + Math.round(t * SR), n = Math.round(0.5 * SR); let e = 0; for (let i = s; i < s + n; i++) e += r.L[i] ** 2 + r.R[i] ** 2; return 10 * Math.log10(e / (2 * n)); };
    const edge = Math.min(rms(-2), rms(p.duration + 1));
    let worst = 0;
    for (let t = 0; t + 0.5 <= p.duration; t += 0.25) worst = Math.min(worst, rms(t) - edge);
    expect(worst).toBeGreaterThan(-3);
  });
});
