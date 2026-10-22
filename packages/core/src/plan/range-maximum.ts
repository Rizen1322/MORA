/** Immutable range maximum. Equal scores keep the first candidate, matching
 * a left-to-right exhaustive search. Built once per vocal handoff, not per deck. */
export class RangeMaximum {
  private readonly size: number;
  private readonly tree: Int32Array;
  constructor(private readonly weights: readonly number[]) {
    let size=1;while(size<weights.length)size*=2;
    this.size=size;this.tree=new Int32Array(size*2).fill(-1);
    for(let i=0;i<weights.length;i++)this.tree[size+i]=Number.isFinite(weights[i])?i:-1;
    for(let i=size-1;i>0;i--)this.tree[i]=this.better(this.tree[i*2],this.tree[i*2+1]);
  }
  private better(a:number,b:number):number {
    if(a<0)return b;if(b<0)return a;
    return this.weights[a]>this.weights[b]?a:this.weights[a]<this.weights[b]?b:Math.min(a,b);
  }
  /** Half-open candidate index range. */
  best(from:number,to:number):number {
    let l=Math.max(0,Math.ceil(from))+this.size,r=Math.min(this.weights.length,Math.floor(to))+this.size,result=-1;
    while(l<r){if(l&1)result=this.better(result,this.tree[l++]);if(r&1)result=this.better(result,this.tree[--r]);l>>=1;r>>=1;}
    return result;
  }
}
