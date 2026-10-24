import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { integrateTempo,pointValue } from '../src/plan/timing.ts';
import { applyVocalHandoff, BLEED_MID, lyricTiming, splitsWord, VERIFIED_TIMING } from '../src/plan/vocals.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

/**
 * A legato singer: words of 0.85 s with 0.15 s boundaries (0.6 s between lines) the activity curve cannot see,
 * and a 0.3 s acoustic dip in the middle of every word (a held vowel, a breathy consonant).
 * Activity alone takes the dips for phrase gaps; recognised word timing must not.
 */
function singer(id: string, withLyrics: boolean, confidence = 0.95, verified = true): PlannerTrack {
  const duration = 180, rate = 10;
  const values = Array.from({ length: duration * rate }, (_, i) => { const x = (i / rate) % 1; return x >= 0.35 && x < 0.65 ? 0 : 0.85; });
  // lines of four words; the last word of a line is short, leaving a 0.6 s pause before the next line
  const words = Array.from({ length: duration }, (_, k) => [k, k + (k % 4 === 3 ? 0.4 : 0.85)] as [number, number]);
  const lines = Array.from({ length: duration / 4 }, (_, k) => [k * 4, k * 4 + 3.4] as [number, number]);
  const rmsDb = Array.from({ length: duration * 20 }, () => -16);
  const analysis: TrackAnalysis = {
    version: 'lyrics-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: null, beatRegions: [], rhythmStrength: 0.2,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: [], phraseConfidence: 0, sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: 170, end: duration }, bodyRmsDb: -16,
    curves: { rate: 20, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10), midDensity: rmsDb.map(() => 0.3) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }], exit: [{ time: 160, score: 0.8, kind: 'downbeat', tags: [] }] },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.2, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.3, dynamics: 0.2, acousticness: 0.1 },
    vocalActivity: { rate, values, source: 'demucs', model: 'measured-test',
      // verified: the word pauses were also measured on the separated voice (stem-verified timing)
      ...(withLyrics ? { lyrics: { version: 'whisper-words-1', language: 'ru', confidence, words, lines, ...(verified ? { timing: VERIFIED_TIMING, voiced: words } : {}) } } : {}) },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

const handoff = (a: PlannerTrack, b: PlannerTrack) => {
  // Isolate word-boundary selection from the public B-first policy: these fixtures sing from cue 0.
  const base=planTransition(a,b,{...S,stemMixing:false}),p=applyVocalHandoff(base,a.analysis,b.analysis,S);
  const st = p.debug.stems as { vocalHandoff: number; bVoiceStart: number; bleedGuard: { from: number; to: number } | null; lyrics?: { lostWordsA: number | null } };
  return { p, st, aEnd: p.aExit + integrateTempo(p.tempoA, st.vocalHandoff), bStart: p.bEntry + integrateTempo(p.tempoB, st.bVoiceStart) };
};

describe('recognised words in the vocal handoff', () => {
  it('smoothly opens a cue-zero incoming word without waiting for A',()=>{
    const p=planTransition(singer('a',true),singer('b',true),{...S,entryMode:'preserve'});
    const policy=p.debug.firstWords as {attack:number;wholeDeckFade:boolean;declickSeconds:number;gainRiseSeconds:number};
    const gainB=p.automation.find(l=>l.deck==='B'&&l.lane==='gain')!.points;
    const gainA=p.automation.find(l=>l.deck==='A'&&l.lane==='gain')!.points;
    expect(p.bEntry).toBe(0);expect(policy.attack).toBe(0);expect(policy.wholeDeckFade).toBe(true);
    expect(policy.declickSeconds).toBe(.012);expect(policy.gainRiseSeconds).toBe(.3);
    expect(p.vocalB).toBeUndefined(); // the first voice is not held behind A's later word boundary
    expect(pointValue(gainB,0)).toBe(0);expect(pointValue(gainB,.012)).toBeLessThan(.1);expect(pointValue(gainB,.3)).toBe(1);
    expect(pointValue(gainA,.04)).toBeGreaterThan(.9);expect(pointValue(gainA,.3)).toBe(0);
    let previous=0;for(let t=.01;t<=.3;t+=.01){const current=pointValue(gainB,t);expect(current).toBeGreaterThanOrEqual(previous);previous=current;}

    // The word is attenuated during the de-click ramp, then its PCM continues
    // without a mask or a discontinuity once the smooth ramp has reached unity.
    const sr=32000,n=Math.ceil(sr*.6),silence=new Float32Array(n);
    const word=Float32Array.from({length:n},(_,i)=>.15*Math.sin(2*Math.PI*660*i/sr));
    const a={L:silence,R:silence,sampleRate:sr},b={L:word,R:word,sampleRate:sr,vocals:{L:word,R:word}};
    const rendered=renderTransitionOffline(a,b,p,0,.6),reference=renderTransitionOffline(a,b,{...p,
      automation:p.automation.map(l=>l.deck==='B'&&l.lane==='gain'?{...l,points:[[0,1]] as [number,number][]}:l)},0,.6);
    let earlyEnergy=0,error=0;for(let i=0;i<n;i++){if(i<sr*.1)earlyEnergy+=rendered.L[i]**2;if(i>=sr*.35&&i<sr*.55)error=Math.max(error,Math.abs(rendered.L[i]-reference.L[i]));}
    expect(earlyEnergy).toBeGreaterThan(0);expect(error).toBeLessThan(1e-5);expect(rendered.metrics.underruns).toBe(0);
  });
  it.each([[44100,false],[48000,false],[44100,true],[48000,true]] as const)('finds sub-grid word pauses and preserves word PCM at %i Hz (glide: %s)', (sr,glide) => {
    const A=singer('dense-a',true).analysis!,B=singer('dense-b',true).analysis!;
    const tempoA:[number,number][]|undefined=glide?[[0,1.08],[2,1]]:undefined;
    const tempoB:[number,number][]=glide?[[0,0.94],[2,1]]:[[0,1]];
    const cueA=glide?5:0,cueB=glide?3:0;
    const srcA=(t:number)=>cueA+integrateTempo(tempoA,t),srcB=(t:number)=>cueB+integrateTempo(tempoB,t);
    // A has 42 ms gaps; B has 67 ms gaps. Neither fixed candidate grid has
    // enough fade room at this handoff. Acoustic phrases remain continuous.
    const wordsA=Array.from({length:20},(_,i)=>[srcA(i*0.443),srcA(i*0.443+0.401)] as [number,number]);
    const wordsB=Array.from({length:20},(_,i)=>[srcB(0.1+i*0.441),srcB(0.474+i*0.441)] as [number,number]);
    for(const [an,words] of [[A,wordsA],[B,wordsB]] as const){
      an.vocalActivity!.values.fill(0.9);
      an.vocalActivity!.phrases=[{start:0,end:20,confidence:0.95}];
      an.vocalActivity!.lyrics={version:'test',language:null,confidence:0.95,words,lines:[[0,20]],timing:VERIFIED_TIMING,voiced:words};
    }
    const base:TransitionPlan={id:'dense-words',version:'test',fromTrackId:'a',toTrackId:'b',method:'beatmatch_blend',
      confidence:1,reasons:[],debug:{},aExit:cueA,bEntry:cueB,duration:2,gap:0,swapAt:0.445,tempoA,tempoB,gainA:0,gainB:0,
      automation:[{deck:'A',lane:'gain',points:[[0,1]]},{deck:'B',lane:'gain',points:[[0,1]]}]};
    const p=applyVocalHandoff(base,A,B,S);
    expect(p.vocalA![1][0]).toBeGreaterThanOrEqual(0.401);
    expect(p.vocalA![2][0]).toBeLessThan(0.443);
    expect(p.vocalB![1][0]).toBeGreaterThanOrEqual(0.474);
    expect(p.vocalB![2][0]).toBeLessThanOrEqual(0.541);
    expect(p.vocalB![1][0]).toBeGreaterThanOrEqual(p.vocalA![2][0]);
    const voice=(from:number,to:number,hz:number)=>Float32Array.from({length:sr*(cueA+3)},(_,i)=>
      i>=Math.ceil(from*sr)&&i<Math.floor(to*sr)?0.12*Math.sin(2*Math.PI*hz*i/sr):0);
    const a=voice(srcA(0.3),srcA(0.401),440),b=voice(srcB(0.541),srcB(0.7),660);
    const pcm=(voice:Float32Array)=>({L:voice,R:voice,sampleRate:sr,vocals:{L:voice,R:voice}});
    const isolated={...p,voiceEcho:undefined,automation:base.automation};
    const fixed=renderTransitionOffline(pcm(a),pcm(b),isolated,0,0.2);
    const reference=renderTransitionOffline(pcm(a),pcm(b),{...isolated,vocalA:undefined,vocalB:undefined},0,0.2);
    let error=0;
    for(let i=Math.ceil(sr*0.3);i<Math.floor(sr*0.7);i++)error=Math.max(error,Math.abs(fixed.L[i]-reference.L[i]));
    expect(error).toBeLessThan(1e-6);
    expect(fixed.metrics.underruns).toBe(0);
  });

  it('ends the old voice between words, not in an acoustic dip inside a word', () => {
    const timing = lyricTiming(singer('x', true).analysis!)!;
    const without = handoff(singer('a', false), singer('b', false));
    expect(splitsWord(timing, without.aEnd - 0.08, without.aEnd)).toBe(true); // the old policy cut a word
    const words = handoff(singer('a', true), singer('b', true));
    expect(splitsWord(timing, words.aEnd - 0.08, words.aEnd)).toBe(false);
    expect(splitsWord(timing, words.bStart - 0.04, words.bStart + 0.155)).toBe(false);
    expect(words.st.lyrics?.lostWordsA).toBeTypeOf('number');
  });

  it('does not edit in a Whisper-only pause that the measured voice contradicts', () => {
    // same synthetic words, but nothing measured them on the stem: the 0.15 s word gaps are
    // sung according to the activity, so only the line pauses that both agree on remain (0.4-0.7 s after a line)
    const timing = lyricTiming(singer('x', true, 0.95, false).analysis!)!;
    expect(timing.verified).toBe(false);
    const gaps = timing.edit.slice(1).map(([a], i) => [timing.edit[i][1], a]);
    expect(gaps.length).toBeGreaterThan(10);
    for (const [a, b] of gaps) { expect(a % 4).toBeCloseTo(3.4, 5); expect(b - a).toBeCloseTo(0.3, 5); }
    const unverified = handoff(singer('a', true, 0.95, false), singer('b', true, 0.95, false));
    const fadeA = (unverified.st as unknown as { fadeA: number }).fadeA;
    const inside = (x: number) => timing.edit.some(([a, b]) => x > a + 1e-3 && x < b - 1e-3);
    expect(inside(unverified.aEnd) || inside(unverified.p.aExit + integrateTempo(unverified.p.tempoA, (unverified.st.vocalHandoff - fadeA)))).toBe(false);
    // a 27 s "word" with a short measured voice inside is limited to that voice
    const long = singer('x', true, 0.95, false).analysis!;
    long.vocalActivity!.lyrics!.words = [[0, 27], ...long.vocalActivity!.lyrics!.words.slice(27)];
    long.vocalActivity!.values.fill(0, 0, 270); long.vocalActivity!.values.fill(0.9, 100, 120);
    expect(lyricTiming(long)!.words[0]).toEqual([9.95, 12.05]);
  });

  it('ignores untrustworthy recognition', () => {
    expect(lyricTiming(singer('x', true, 0.3).analysis!)).toBeNull();
    const low = handoff(singer('a', true, 0.3), singer('b', true, 0.3)), plain = handoff(singer('a', false), singer('b', false));
    expect(low.aEnd).toBe(plain.aEnd);
  });

  it('pulls down the outgoing voice band (bleed guard) once both voices meet', () => {
    const { p, st } = handoff(singer('a', true), singer('b', true));
    expect(st.bleedGuard).toBeTruthy();
    const mid = p.automation.find((l) => l.deck === 'A' && l.lane === 'mid')!.points;
    const at = (t: number) => { for (let i = 1; i < mid.length; i++) if (t <= mid[i][0]) return mid[i - 1][1] + (mid[i][1] - mid[i - 1][1]) * (t - mid[i - 1][0]) / (mid[i][0] - mid[i - 1][0]); return mid[mid.length - 1][1]; };
    expect(at(st.bleedGuard!.to + 0.01)).toBeLessThanOrEqual(BLEED_MID + 1e-3);
    expect(at(st.bleedGuard!.to + 0.01)).toBeLessThan(at(Math.max(0, st.bleedGuard!.from - 0.01)));
    // the user's "no EQ" setting is respected
    const noEq = planTransition(singer('a', true), singer('b', true), { ...S, eqHandoff: false });
    expect((noEq.debug.stems as { bleedGuard: unknown }).bleedGuard).toBeNull();
  });
});
