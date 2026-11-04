import { describe,it,expect } from 'vitest';
import { stereoWindows } from '../../../tools/audition-stereo.ts';
function pcm(samples:number[][]){const b=Buffer.alloc(samples.length*8);samples.forEach(([l,r],i)=>{b.writeFloatLE(l,i*8);b.writeFloatLE(r,i*8+4);});return b;}
describe('measured stereo windows',()=>{it('distinguishes mono, antiphase, silence and a partial window',()=>{
  const m=stereoWindows(pcm([[1,1],[1,1],[1,-1],[1,-1],[0,0],[0,0],[.5,.5]]),2);
  expect(m.correlation).toEqual([1,-1,1,1]);expect(m.sideToMidDb[0]).toBe(-120);expect(m.sideToMidDb[1]).toBeGreaterThan(100);expect(m.sideToMidDb[2]).toBe(-120);expect(m.sideToMidDb).toHaveLength(4);
});});
