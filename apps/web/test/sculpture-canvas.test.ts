import { expect,it,vi } from 'vitest';
vi.mock('../src/store/app.ts',()=>({controller:{state:{status:'paused'},analyser:null}}));
import { projectSculpture,SCULPTURE_RINGS,SCULPTURE_SEGMENTS,type SculptureMotion } from '../src/lib/sculpture-canvas.ts';

it('projects closed, finite filaments and responds to audio without allocating another vertex array',()=>{
  const motion:SculptureMotion={bass:0,mid:0,high:0,kick:0,level:0,bands:new Float32Array(16)};
  const out=new Float32Array(SCULPTURE_RINGS*(SCULPTURE_SEGMENTS+1)*2);
  for(const [w,h] of [[320,260],[1280,640],[400,900]]){
    projectSculpture(out,1,motion,w,h);const quiet=out.slice();
    for(let j=0;j<SCULPTURE_RINGS;j++){
      const first=j*(SCULPTURE_SEGMENTS+1)*2,last=first+SCULPTURE_SEGMENTS*2;
      expect(out[first]).toBe(out[last]);expect(out[first+1]).toBe(out[last+1]);
    }
    projectSculpture(out,1,{...motion,bass:.8,kick:1,mid:.5},w,h);
    expect(out.every(Number.isFinite)).toBe(true);expect(out).not.toEqual(quiet);
    for(let i=0;i<out.length;i+=2){expect(out[i]).toBeGreaterThan(-w*.05);expect(out[i]).toBeLessThan(w*1.05);expect(out[i+1]).toBeGreaterThan(-h*.05);expect(out[i+1]).toBeLessThan(h*1.05);}
    projectSculpture(out,2,motion,w,h);expect(out).not.toEqual(quiet);
  }
});
