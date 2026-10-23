import { expect,it } from 'vitest';
import { beatAttacks } from '../src/mir/attacks.ts';
import { withMicroOnset } from '../src/plan/micro-onset.ts';
import { withVoiceAnswer } from '../src/plan/answer.ts';
import { withTapeStop } from '../src/plan/tape-stop.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S,type TrackAnalysis,type TransitionPlan } from '../src/types.ts';

function track(offset:number):TrackAnalysis {
  const beats=Array.from({length:40},(_,i)=>i*.5);
  const curve=Array(400).fill(-18);
  return {version:'test',duration:20,audibleStart:0,audibleEnd:20,bodyRmsDb:-18,
    loudness:{integratedLufs:-16,samplePeakDb:-4,truePeakDb:-3},rhythmStrength:.9,
    key:{tonic:-1,mode:'unknown',name:'unknown',camelot:'',confidence:0},phrases:[],phraseConfidence:0,sectionBoundaries:[],
    intro:{start:0,end:0},outro:{start:18,end:20},cues:{entry:[],exit:[]},
    curves:{rate:20,rmsDb:curve,lowDb:curve,midDb:curve,highDb:curve,midDensity:curve.map(()=>.2)},peaks:curve.map(()=>.8),
    features:{energy:.6,brightness:.5,rhythmStrength:.9,onsetRate:.4,bassWeight:.6,midDensity:.2,dynamics:.2,acousticness:.1},warnings:[],elapsedMs:0,
    beat:{bpm:120,period:.5,confidence:.95,stable:true,jitterMs:2,beats,downbeats:beats.filter((_,i)=>i%4===0),downbeatConfidence:.9,downbeatPhase:0,alternatives:[],
      attacks:{version:'lf-attack-1',offsetsMs:beats.map(()=>offset),strength:beats.map(()=>.95)}},
    vocalActivity:{rate:10,values:Array(200).fill(0),source:'demucs',model:'test'}};
}
function plan():TransitionPlan {return {id:'onset',version:'test',fromTrackId:'a',toTrackId:'b',method:'beatmatch_blend',confidence:.95,reasons:[],
  aExit:2,bEntry:2,duration:6,gap:0,swapAt:3,tempoB:[[0,1]],automation:[],gainA:0,gainB:0,debug:{},
  beatAlign:{bpmA:120,bpmB:120,relation:1,ratio:1,stretchPercent:0,overlapBeats:12,phraseAligned:true}};}

it.each([-12,-5,5,12])('corrects %i ms of repeated kick attack offset without moving A, speed maps or automation',offset=>{
  const p=plan(),q=withMicroOnset(p,track(0),track(offset),S);
  expect(q.bEntry-p.bEntry).toBeCloseTo(offset/1000,6);expect(q.aExit).toBe(p.aExit);
  expect(q.tempoB).toBe(p.tempoB);expect(q.automation).toBe(p.automation);expect(q.duration).toBe(p.duration);
  expect(q.debug.microOnset).toMatchObject({pairs:8,shiftMs:offset,residualMs:0});
  expect(withMicroOnset(q,track(0),track(offset),S)).toBe(q);
});
it('leaves unknown features, swing/alternating attacks, outliers, huge and imperceptible offsets unchanged',()=>{
  const p=plan();
  for(const offset of [0,1,16,26])expect(withMicroOnset(p,track(0),track(offset),S)).toBe(p);
  const missing=track(0);delete missing.beat!.attacks;expect(withMicroOnset(p,missing,track(10),S)).toBe(p);
  for(const offsets of [Array(40).fill(null),Array.from({length:40},(_,i)=>i%2?12:-12),Array(40).fill(NaN)]){
    const b=track(10);b.beat!.attacks!.offsetsMs=offsets;expect(withMicroOnset(p,track(0),b,S)).toBe(p);
  }
  const few=track(10);few.beat!.attacks!.strength.fill(0);few.beat!.attacks!.strength.fill(.95,4,7);
  expect(withMicroOnset(p,track(0),few,S)).toBe(p);
});
it('does not trim a cue word, move a manual/loop transition or infer silence from an unknown vocal map',()=>{
  const p=plan(),a=track(0),b=track(10);
  for(const side of ['a','b']){
    const x=track(side==='a'?0:10);x.vocalActivity!.values[20]=.8;
    expect(withMicroOnset(p,side==='a'?x:a,side==='b'?x:b,S)).toBe(p);
    // P8: an unknown map is not silence, it takes the stricter full-mix path (6 kicks, 2 ms residual)
    delete x.vocalActivity;const q=withMicroOnset(p,side==='a'?x:a,side==='b'?x:b,S);
    expect(q.debug.microOnset).toMatchObject({policy:'lf-attack-fullmix-1',shiftMs:10});expect(q.aExit).toBe(p.aExit);
    const loose=track(10);delete loose.vocalActivity;loose.beat!.attacks!.offsetsMs=loose.beat!.attacks!.offsetsMs.map((_,i)=>i%2?14.5:10);
    expect(withMicroOnset(p,a,loose,S)).toBe(p);
    const few=track(10);delete few.vocalActivity;few.beat!.attacks!.strength.fill(0);few.beat!.attacks!.strength.fill(.95,4,9);
    expect(withMicroOnset(p,a,few,S)).toBe(p);
  }
  expect(withMicroOnset(p,a,b,S,2)).toBe(p);
  const loop={...p,loopA:{start:2,end:3,until:8,crossfade:.006}};
  expect(withMicroOnset(loop,a,b,S)).toBe(loop);
  for(const change of [{stable:false},{jitterMs:20},{confidence:.5}]){
    const bad={...b,beat:{...b.beat!,...change}};expect(withMicroOnset(p,a,bad,S)).toBe(p);
  }
});
it('extracts sparse millisecond LF peaks and rejects missing/ambiguous/edge attacks',()=>{
  const rate=1000,env=new Float32Array(2500),beats=[.5,1,1.5,2];
  env[507]=1;env[1007]=1;env[1016]=.9;env[1525]=1;
  const a=beatAttacks({rate,env},beats);
  expect(a.offsetsMs).toEqual([7,null,null,null]);expect(a.strength[0]).toBeGreaterThan(.9);
  env[507]=NaN;expect(beatAttacks({rate,env},beats).offsetsMs[0]).toBeNull();
  expect(beatAttacks({rate:20,env},beats).offsetsMs.every(x=>x===null)).toBe(true);
});
it('rejects malformed vocal-echo periods/speeds instead of looping while normalizing the delay',()=>{
  const a=track(0),b=track(0),p=plan();p.duration=6;p.vocalA=[[0,1],[2,0],[6,0]];p.vocalB=[[0,0],[3,0],[3.5,1],[6,1]];
  a.vocalActivity!.values.fill(.9,35,41);b.vocalActivity!.values.fill(.9,70);
  expect(withVoiceAnswer(p,a,b,S).voiceEcho).toBeDefined();
  for(const period of [0,-1,NaN,Infinity])expect(withVoiceAnswer(p,{...a,beat:{...a.beat!,period}},b,S)).toBe(p);
  for(const rate of [0,-1,NaN,Infinity]){
    const bad={...p,tempoA:[[0,rate]] as [number,number][]};expect(withVoiceAnswer(bad,a,b,S)).toBe(bad);
  }
});
it('only stops the instrumental tail after the incoming gain and EQ are already open',()=>{
  const a=track(0),b=track(0),p={...plan(),method:'crossfade' as const,duration:6};
  a.audibleEnd=6;a.beat!.downbeats=[3];b.beat!.bpm=150;
  a.vocalActivity!.vocalRmsDb=Array(200).fill(-90);a.vocalActivity!.accompanimentRmsDb=Array(200).fill(-20);
  expect(withTapeStop(p,a,b,S).tapeStopA).toBeDefined();
  for(const lane of ['gain','low','mid','high','filter'] as const){
    const pending={...p,automation:[{deck:'B' as const,lane,points:[[0,lane==='filter'?-.5:.1],[6,lane==='filter'?0:1]] as [number,number][]}]};
    expect(withTapeStop(pending,a,b,S)).toBe(pending);
    const laterDip={...p,automation:[{deck:'B' as const,lane,points:[[0,lane==='filter'?0:1],[3,lane==='filter'?0:1],[4,lane==='filter'?-.5:.1],[6,lane==='filter'?0:1]] as [number,number][]}]};
    expect(withTapeStop(laterDip,a,b,S)).toBe(laterDip);
  }
});
