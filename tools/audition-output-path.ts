import fs from 'node:fs';
import path from 'node:path';
/** Resolve existing ancestors as well as the target so a junction cannot redirect output into the profile. */
export function assertOutputOutsideProfile(dir:string,out:string) {
  let ancestor=out;while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw Error('Output ancestor not found');ancestor=parent;}
  const target=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,out));
  const profile=fs.realpathSync(dir);const normalize=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
  const a=normalize(target),b=normalize(profile);if(a===b||a.startsWith(b+path.sep))throw Error('Output must be outside profile data');
}
