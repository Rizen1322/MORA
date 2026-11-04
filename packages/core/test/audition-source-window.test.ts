import {expect,it} from 'vitest';
import {DEFAULT_AUTOMIX_SETTINGS,planTransition,renderTransitionOffline} from '../src/index.ts';
import {planForSourceWindows} from '../../../tools/review-source-window.ts';
it('renders a tape stop identically after source-window shifts on both decks',()=>{
  const sr=8000,t={id:'a',duration:20,analysis:null,mixingAllowed:true};
  const p={...planTransition(t,{...t,id:'b'},DEFAULT_AUTOMIX_SETTINGS),method:'crossfade' as const,aExit:6,bEntry:3,duration:4,gap:0,swapAt:2,gainA:0,gainB:0,tempoB:[[0,1]] as [number,number][],tempoA:undefined,tapeStopA:{start:7,end:7.75,crossfade:.025},vocalA:undefined,vocalB:undefined,
    automation:[{deck:'A' as const,lane:'gain' as const,points:[[0,1],[4,0]] as [number,number][]},{deck:'B' as const,lane:'gain' as const,points:[[0,0],[4,1]] as [number,number][]}]};
  const L=Float32Array.from({length:sr*20},(_,i)=>.2*Math.sin(i*.13));const pcm={L,R:L,sampleRate:sr};const crop=(offset:number)=>({L:L.slice(offset*sr),R:L.slice(offset*sr),sampleRate:sr});
  const full=renderTransitionOffline(pcm,pcm,p,1,1),windowed=renderTransitionOffline(crop(4),crop(2),planForSourceWindows(p,4,2),1,1);
  expect(windowed.metrics.underruns).toBe(0);expect(windowed.L.length).toBe(full.L.length); let delta=0; for(let i=0;i<full.L.length;i++)delta=Math.max(delta,Math.abs(full.L[i]-windowed.L[i])); expect(delta).toBeLessThan(1e-6);
});

