import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {stereoWindows} from './audition-stereo.ts';
import {ANALYZER_VERSION} from '../packages/core/src/types.ts';
import {assertOutputOutsideProfile} from './audition-output-path.ts';
import {fileURLToPath} from 'node:url';
export function measureLibraryStereo(dir:string,out:string,ffmpeg:string) {
  assertOutputOutsideProfile(dir,out);fs.mkdirSync(out,{recursive:true});
const db=new DatabaseSync(path.join(dir,'automix.sqlite'),{readOnly:true});
const rows=db.prepare(`SELECT DISTINCT a.content_hash hash,a.provider,(SELECT path FROM track_sources WHERE track_id=a.id AND path IS NOT NULL LIMIT 1) sourcePath
 FROM tracks t LEFT JOIN track_bindings b ON b.track_id=t.id JOIN tracks a ON a.id=COALESCE(b.asset_id,t.id)
 JOIN analysis n ON n.content_hash=a.content_hash AND n.version=? AND n.status='done'
 WHERE t.saved=1 AND t.status='ok' AND a.status='ok'`).all(ANALYZER_VERSION) as {hash:string;provider:string;sourcePath:string|null}[];db.close();
const items:Record<string,ReturnType<typeof stereoWindows>>={};let invalid=0;
for(const row of rows){if(!['local','yandex','youtube','soundcloud'].includes(row.provider)||!/^[a-f0-9]{64}$/.test(row.hash))continue;const folder=path.join(dir,'remote',row.provider);const filename=row.provider==='local'?row.sourcePath:fs.existsSync(folder)?fs.readdirSync(folder).find(f=>path.parse(f).name===row.hash):null;const file=filename&&(row.provider==='local'?filename:path.join(folder,filename));if(!file||!fs.existsSync(file))continue;
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==row.hash){invalid++;continue;}
  try{const pcm=execFileSync(ffmpeg,['-v','error','-i',file,'-ac','2','-ar','16000','-f','f32le','pipe:1'],{maxBuffer:256*1024*1024,windowsHide:true,timeout:120_000});items[row.hash]=stereoWindows(pcm,16000);console.log(`Measured ${Object.keys(items).length}`);}catch{invalid++;console.warn('Could not measure one cached recording');}
}
fs.writeFileSync(path.join(out,'stereo-inventory.json'),JSON.stringify({version:1,sampleRate:16000,items}));console.log(`Stereo inventory: ${Object.keys(items).length} measured, ${invalid} rejected`);

}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=(key:string,fallback:string)=>{const i=process.argv.indexOf(key);if(i<0)return fallback;const v=process.argv[i+1];if(!v||v.startsWith('--'))throw Error(`Missing ${key}`);return v;};
  const dir=path.resolve(arg('--data-dir','C:/Users/aivaz/AppData/Local/MORA/data')),out=path.resolve(arg('--out','data-bench-results/creative-transitions-2026-11-04'));
  measureLibraryStereo(dir,out,arg('--ffmpeg',process.env.FFMPEG_PATH||'ffmpeg'));
}




