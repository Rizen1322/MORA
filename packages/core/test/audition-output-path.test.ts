import {it,expect} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {assertOutputOutsideProfile} from '../../../tools/audition-output-path.ts';
it('prevents direct and junction paths into the profile',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'mora-output-')),profile=path.join(base,'profile'),link=path.join(base,'link');
  try{fs.mkdirSync(profile);fs.symlinkSync(profile,link,'junction');expect(()=>assertOutputOutsideProfile(profile,path.join(base,'output'))).not.toThrow();expect(()=>assertOutputOutsideProfile(profile,path.join(profile,'child'))).toThrow();expect(()=>assertOutputOutsideProfile(profile,path.join(link,'child'))).toThrow();}finally{fs.rmSync(base,{recursive:true,force:true});}
});
