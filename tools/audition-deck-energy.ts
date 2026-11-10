export function windowRmsDb(L:Float32Array,R:Float32Array,start:number,sampleRate:number):number|null {
  const from=Math.max(0,Math.floor(start*sampleRate)),end=Math.min(L.length,from+Math.round(sampleRate/2));
  if(end<=from)return null;
  let sum=0;for(let i=from;i<end;i++)sum+=(L[i]**2+R[i]**2)/2;
  return Math.round(10*Math.log10(Math.max(sum/(end-from),1e-12))*10)/10;
}
