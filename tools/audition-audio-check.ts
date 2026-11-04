export function inspectAudio(L:Float32Array,R:Float32Array,sr:number) {
  if(L.length!==R.length || !L.length || !Number.isFinite(sr) || sr<=0)throw Error('Invalid stereo audio');
  let peak=0,finite=true,run=0,longestSilence=0; const window=Math.round(sr/2);
  for(let i=0;i<L.length;i+=window){let sum=0;const end=Math.min(L.length,i+window);for(let j=i;j<end;j++){const l=L[j],r=R[j];if(!Number.isFinite(l)||!Number.isFinite(r)){finite=false;continue;} peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=(l*l+r*r)/2;}const silent=Math.sqrt(sum/(end-i))<0.000316;run=silent?run+(end-i)/sr:0;longestSilence=Math.max(longestSilence,run);}
  return {peak,finite,longestSilence};
}
