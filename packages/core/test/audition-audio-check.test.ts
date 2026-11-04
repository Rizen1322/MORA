import { describe, it, expect } from 'vitest';
import { inspectAudio } from '../../../tools/audition-audio-check.ts';
describe('audition render checks',()=>{
  it('measures peak, consecutive silence and non-finite samples',()=>{
    const l=Float32Array.from([.5,.5,0,0,0,0,.25,.25]);
    expect(inspectAudio(l,l,4)).toEqual({peak:.5,finite:true,longestSilence:1});
    l[0]=NaN; expect(inspectAudio(l,l,4).finite).toBe(false);
    expect(()=>inspectAudio(l,new Float32Array(1),4)).toThrow();
  });
});

