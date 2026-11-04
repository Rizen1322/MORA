/** One source-second per window; absent tail windows remain unmeasured. */
export function stereoWindows(pcm:Buffer,sampleRate:number) {
  if(pcm.length%8 || !Number.isInteger(sampleRate) || sampleRate<1)throw Error('Invalid stereo PCM');
  const correlation:number[]=[],sideToMidDb:number[]=[];const frames=pcm.length/8;
  for(let start=0;start<frames;start+=sampleRate){let ll=0,rr=0,lr=0;const end=Math.min(frames,start+sampleRate);
    for(let i=start;i<end;i++){const l=pcm.readFloatLE(i*8),r=pcm.readFloatLE(i*8+4);if(!Number.isFinite(l)||!Number.isFinite(r))throw Error('Non-finite source PCM');ll+=l*l;rr+=r*r;lr+=l*r;}
    if((ll+rr)/(2*(end-start))<=1e-12){correlation.push(1);sideToMidDb.push(-120);continue;}
    const mid=Math.max(0,ll+rr+2*lr),side=Math.max(0,ll+rr-2*lr);
    correlation.push(ll*rr>0?Math.max(-1,Math.min(1,lr/Math.sqrt(ll*rr))):0);
    sideToMidDb.push(10*Math.log10(Math.max(1e-12,side/Math.max(1e-12,mid))));
  }return {rate:1,correlation,sideToMidDb};
}
