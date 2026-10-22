// Read-only, bounded audit of existing local measurements. Never starts inference.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planTransition, ANALYZER_VERSION, PLANNER_VERSION, type PlannerTrack, type TransitionPlan } from '../packages/core/src/index.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { getSettings } from '../apps/server/src/automix.ts';
import type { Library } from '../apps/server/src/library.ts';

const cfg=loadConfig(),db=new DatabaseSync(path.join(cfg.dataDir,'automix.sqlite'),{readOnly:true});
const stems=new StemService({...cfg,stemsPython:null},{} as Library,new EventHub());
const rows=db.prepare(`SELECT t.id,t.title,t.duration,t.content_hash,a.data FROM tracks t JOIN analysis a ON a.content_hash=t.content_hash
  WHERE a.version=? AND a.status='done' AND t.status='ok' AND t.provider IN ('local','yandex','youtube','soundcloud')`).all(ANALYZER_VERSION) as {id:string;title:string;duration:number;content_hash:string;data:string}[];
const seen=new Set<string>();
const tracks=rows.filter(t=>{if(seen.has(t.content_hash))return false;seen.add(t.content_hash);return !!stems.get(t.content_hash);}).slice(0,40)
  .map(t=>({...t,track:{id:t.id,duration:t.duration,mixingAllowed:true,analysis:{...JSON.parse(t.data),vocalActivity:stems.activity(t.content_hash)}} as PlannerTrack}));
const settings=getSettings(db).automix,counts:Record<string,number>={},timings:number[]=[],selected=new Map<string,{a:string;b:string;mode:string;plan:TransitionPlan}>();
let pairs=0,partial=0;
const started=performance.now();
for(const a of tracks)for(const b of tracks){
  if(a.id===b.id||pairs>=1200)continue;
  for(const mode of ['both','only-a','only-b'] as const){
    if(mode!=='both'&&partial>=600)continue;
    const pa=mode==='only-b'?{...a.track,analysis:{...a.track.analysis!,vocalActivity:undefined}}:a.track;
    const pb=mode==='only-a'?{...b.track,analysis:{...b.track.analysis!,vocalActivity:undefined}}:b.track;
    const t=performance.now(),p=planTransition(pa,pb,settings);timings.push(performance.now()-t);
    if(mode==='both')pairs++;else partial++;
    const policy=(p.debug.stems as {policy?:string}|undefined)?.policy;
    const technique=p.debug.djFilterRelease?'dj-filter-release':p.beatAlign?.masterDeck?'master-tempo':policy?.startsWith('one-sided')?policy:p.loopA?'loop':p.method;
    const key=`${mode}:${technique}`;counts[key]=(counts[key]??0)+1;
    if(technique==='dj-filter-release'||technique==='master-tempo'||technique.startsWith('one-sided')||technique==='loop'){
      const identity=`${technique}:${a.id}`;
      if(!selected.has(identity)&&selected.size<50)selected.set(identity,{a:a.title,b:b.title,mode,plan:p});
    }
  }
}
timings.sort((a,b)=>a-b);
const candidates=[...selected.values()].sort((a,b)=>Number(!!b.plan.beatAlign?.masterDeck)-Number(!!a.plan.beatAlign?.masterDeck));
const result={version:PLANNER_VERSION,tracks:tracks.length,pairs,partialScenarios:partial,elapsedMs:Math.round(performance.now()-started),
  planMs:{median:timings[Math.floor(timings.length*.5)],p95:timings[Math.floor(timings.length*.95)],max:timings.at(-1)},counts,candidates};
const out=path.resolve('tools/.cache/pc-readiness-0.3.5');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'candidates.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,candidates:candidates.map(c=>({a:c.a,b:c.b,mode:c.mode,master:!!c.plan.beatAlign?.masterDeck,policy:(c.plan.debug.stems as {policy?:string})?.policy}))}));
db.close();stems.stop();
