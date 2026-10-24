import type { BeatGrid } from '../types.ts';

/** Sparse millisecond attacks from the existing low-frequency onset envelope. */
export function beatAttacks(h:{rate:number;env:Float32Array},beats:number[]):NonNullable<BeatGrid['attacks']> {
  const offsetsMs:(number|null)[]=[],strength:number[]=[];
  const radius=Math.ceil(h.rate*.025);
  for(const t of beats){
    const center=Math.round(t*h.rate),lo=center-radius,hi=center+radius;
    let peak=0,index=-1,total=0,valid=Number.isFinite(t)&&h.rate>=900&&h.rate<=1100&&lo>=0&&hi<h.env.length;
    if(valid)for(let i=lo;i<=hi;i++){
      const x=h.env[i];if(!Number.isFinite(x)||x<0){valid=false;break;}
      total+=x;if(x>peak){peak=x;index=i;}
    }
    let rival=0;
    if(valid)for(let i=lo;i<=hi;i++)if(Math.abs(i-index)>Math.ceil(h.rate*.004))rival=Math.max(rival,h.env[i]);
    const confidence=peak>1e-5?1-total/(hi-lo+1)/peak:0;
    const accepted=valid&&index>lo+1&&index<hi-1&&confidence>=.65&&rival<peak*.7;
    offsetsMs.push(accepted?Math.round((index/h.rate-t)*1e6)/1000:null);
    strength.push(accepted?Math.round(confidence*1000)/1000:0);
  }
  return {version:'lf-attack-1',offsetsMs,strength};
}
