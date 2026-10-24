import { describe, expect, it } from 'vitest';
import { MixerCore } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
describe('PCM starvation de-clicking',()=>{
  it('drains the last sample smoothly and fades back in after a missing chunk arrives',()=>{
    const sr=48000, chunk=new Float32Array(CHUNK_FRAMES).fill(.3);let gaps=0;
    const m=new MixerCore(sr,e=>{
      if(e.type==='need'&&e.token==='A'&&e.chunks.includes(0))m.feed(0,'A',0,chunk,chunk.slice());
      if(e.type==='underrun')gaps++;
    });
    m.load(0,'A',CHUNK_FRAMES*3,0);m.start(0,'A',0);
    const L=new Float32Array(128),R=L.slice();let frame=0,previous=0,jump=0;
    for(let b=0;b<600;b++){
      if(b===340){m.feed(0,'A',1,chunk,chunk.slice());m.feed(0,'A',2,chunk,chunk.slice());}
      m.process(L,R,128);
      for(const x of L){if(frame>sr*.3)jump=Math.max(jump,Math.abs(x-previous));previous=x;frame++;expect(Number.isFinite(x)).toBe(true);}
    }
    expect(gaps).toBe(1);expect(jump).toBeLessThan(.025);expect(Math.abs(previous)).toBeGreaterThan(.2);
  });
});
