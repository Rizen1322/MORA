import {it,expect} from 'vitest';import {rankAuditions} from '../../../tools/audition-rank.ts';
it('prefers fresh pairs within 0.08 of the best score, without choosing a poor fit',()=>{
  const pair=(a:string,b:string,score:number)=>({a:{hash:a},b:{hash:b},score});
  const used=new Map([['a/b',1]]),tracks=new Map([['a',4],['b',4]]),rows=[pair('a','b',.9),pair('c','d',.84),pair('e','f',.7)];rankAuditions(rows,[{fromHash:'a',toHash:'b'}],used,tracks);
  expect(rows[0].a.hash).toBe('c');expect(rows.at(-1)!.a.hash).toBe('e');
});
