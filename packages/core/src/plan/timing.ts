export type TempoMap = [number, number][];

/** Runs a step generator (work split for an in-process server) to completion synchronously. */
export function drain<T>(g: Generator<void, T>): T {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

const linear = new WeakMap<number[], Float64Array>();
/** 10^(dB/10) of an analysis dB curve, once per curve array: power sums spent half the planning time in Math.pow.
 * Analysed curves are never edited in place; code that changes one must give it a new array. */
export function linearPower(curve: number[]): Float64Array {
  let v = linear.get(curve);
  if (!v) {
    v = new Float64Array(curve.length);
    for (let i = 0; i < curve.length; i++) v[i] = Math.pow(10, curve[i] / 10);
    linear.set(curve, v);
  }
  return v;
}

export function pointValue(points: TempoMap, time: number): number {
  if(!points.length)return 1;
  if(time<=points[0][0])return points[0][1];
  for(let i=1;i<points.length;i++)if(time<=points[i][0]){
    const [a,x]=points[i-1],[b,y]=points[i];
    return b>a?x+(y-x)*(time-a)/(b-a):y;
  }
  return points[points.length-1][1];
}

/** Source seconds consumed by a piecewise-linear speed map. */
export function integrateTempo(points: TempoMap|undefined, time: number): number {
  if(time<=0)return time;
  const map=points?.length?points:[[0,1]] as TempoMap;
  const knots=[0,...map.map(([t])=>t).filter(t=>t>0&&t<time),time];
  let total=0;
  for(let i=1;i<knots.length;i++)total+=(knots[i]-knots[i-1])*(pointValue(map,knots[i])+pointValue(map,knots[i-1]))/2;
  return total;
}

export function outputTimeAt(points: TempoMap|undefined, sourceDelta: number, limit: number): number {
  let lo=0,hi=limit;
  for(let i=0;i<32;i++){const mid=(lo+hi)/2;if(integrateTempo(points,mid)<sourceDelta)lo=mid;else hi=mid;}
  return (lo+hi)/2;
}
