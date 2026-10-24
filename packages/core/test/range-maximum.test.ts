import { expect,it } from 'vitest';
import { RangeMaximum } from '../src/plan/range-maximum.ts';

it('matches exhaustive candidate selection for every window, including ties and missing values',()=>{
  const weights=Array.from({length:97},(_,i)=>i%11===0?NaN:i%7===0?4:Math.sin(i*1.7)*3);
  const index=new RangeMaximum(weights);
  for(let from=0;from<=weights.length;from++)for(let to=from;to<=weights.length;to++){
    let best=-1;
    for(let i=from;i<to;i++)if(Number.isFinite(weights[i])&&(best<0||weights[i]>weights[best]))best=i;
    expect(index.best(from,to)).toBe(best);
  }
  expect(new RangeMaximum([]).best(0,0)).toBe(-1);
});
