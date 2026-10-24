// Read-only local planner audit. No playback, DB updates, decoding or external upload.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planTransition, ANALYZER_VERSION, type PlannerTrack } from '../packages/core/src/index.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { getSettings } from '../apps/server/src/automix.ts';
import type { Library } from '../apps/server/src/library.ts';

const cfg = loadConfig(), db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const rows = db.prepare(`SELECT t.id,t.title,t.duration,t.content_hash,a.data FROM tracks t JOIN analysis a
  ON a.content_hash=t.content_hash WHERE a.version=? AND a.status='done' AND t.status='ok'
  AND t.provider IN ('local','yandex','youtube','soundcloud')`).all(ANALYZER_VERSION) as {id:string;title:string;duration:number;content_hash:string;data:string}[];
const seen = new Set<string>();
const tracks = rows.filter(t => {if(seen.has(t.content_hash))return false;seen.add(t.content_hash);return !!stems.get(t.content_hash);}).slice(0, 60).map(t => ({...t,
  track: { id:t.id,duration:t.duration,mixingAllowed:true,analysis:{...JSON.parse(t.data),vocalActivity:stems.activity(t.content_hash)} } as PlannerTrack}));
const settings=getSettings(db).automix, candidates:unknown[]=[], variants:Record<string,number>={};
let pairs=0;
const started=performance.now();
for(const a of tracks)for(const b of tracks){
  if(a.id===b.id||pairs>=1200)continue;
  const plan=planTransition(a.track,b.track,settings);pairs++;variants[plan.method]=(variants[plan.method]??0)+1;
  if(plan.loopA)candidates.push({a:a.title,b:b.title,plan});
}
const result={tracks:tracks.length,pairs,loops:candidates.length,elapsedMs:Math.round(performance.now()-started),variants,candidates};
const out=path.resolve('tools/.cache/loop-review-0.3.4');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'candidates.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,candidates:undefined}));db.close();stems.stop();
