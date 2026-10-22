import {expect,it} from 'vitest';
import {methodShort} from '../src/lib/format.ts';
it('shows a real tempo glide or intermediate lock as a tempo bridge',()=>{
  const p={method:'beatmatch_blend',duration:8,beatAlign:{overlapBeats:16,glide:true}};
  expect(methodShort(p)).toContain('Мост темпа');
  expect(methodShort({...p,beatAlign:{overlapBeats:16,glide:false}})).toContain('Сведение по битам');
  expect(methodShort({...p,beatAlign:{overlapBeats:16,bridge:{commonBpm:120}}})).toContain('Мост темпа');
});
