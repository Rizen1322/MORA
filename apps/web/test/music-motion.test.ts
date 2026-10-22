import { describe, expect, it } from 'vitest';
import { MusicMotion } from '../src/lib/music-motion.ts';
describe('music motion envelopes',()=>{
  it('reacts to actual waveform attacks and decays to rest on pause',()=>{
    const motion=new MusicMotion(), bins=new Float32Array(1024).fill(-35), quiet=new Float32Array(2048), loud=new Float32Array(2048).fill(.16);
    for(let i=0;i<30;i++)motion.update(bins,quiet,48000,2048,1/30);
    expect(motion.kick).toBe(0);
    motion.update(bins,loud,48000,2048,1/30);
    expect(motion.kick).toBeGreaterThan(.2);expect(motion.bass).toBeGreaterThan(.1);
    for(let i=0;i<120;i++)motion.update(null,null,48000,2048,1/30);
    expect(motion.bass).toBeLessThan(.001);expect(motion.kick).toBeLessThan(.001);
  });
  it('maps spectral bands in Hz independently of sample rate and remains bounded',()=>{
    for(const sr of [44100,48000,96000]){
      const motion=new MusicMotion(), bins=new Float32Array(1024).fill(-Infinity); bins.fill(-20,Math.ceil(50*2048/sr),Math.floor(180*2048/sr)+1);
      for(let i=0;i<10;i++)motion.update(bins,new Float32Array(2048).fill(.2),sr,2048,1/45);
      expect(motion.bass).toBeGreaterThan(motion.high);
      expect([...motion.bands,motion.bass,motion.kick].every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);
    }
  });
});
