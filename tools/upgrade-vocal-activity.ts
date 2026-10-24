/** Upgrade measured activity for exactly the tracks in an audit report. No inference.
 * npx tsx tools/upgrade-vocal-activity.ts --report data-dev/reports/user-library-TAG.json
 * --dry-run prints the selection without changing metadata. One CPU subprocess at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, ROOT } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import type { Library } from '../apps/server/src/library.ts';
import { EventHub } from '../apps/server/src/events.ts';

const position=process.argv.indexOf('--report'),reportPath=position<0?'':process.argv[position+1];
if(!reportPath||reportPath.startsWith('--'))throw new Error('Нужен --report с существующим отчётом аудита');
const report=JSON.parse(fs.readFileSync(path.resolve(reportPath),'utf8')) as {tracks?:{id:string;contentHash:string}[]};
if(!Array.isArray(report.tracks)||!report.tracks.length)throw new Error('Отчёт не содержит tracks');
const cfg=loadConfig(),dry=process.argv.includes('--dry-run');
if(!cfg.stemsPython)throw new Error('STEMS_PYTHON не настроен');
const service=new StemService({...cfg,stemsPython:null},{} as Library,new EventHub());
const database=new DatabaseSync(path.join(cfg.dataDir,'automix.sqlite'),{readOnly:true});
const lookup=database.prepare("SELECT t.id,t.title,t.content_hash,t.provider,(SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE id=? AND status='ok'");
const digest=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const results:{id:string;title:string;status:string;seconds?:number;phrases?:number;error?:string}[]=[];
try{
  for(const selected of report.tracks){
    const row=lookup.get(selected.id) as {id:string;title:string;content_hash:string;provider:string;file:string}|undefined;
    if(!row||row.content_hash!==selected.contentHash||!['local','yandex'].includes(row.provider))throw new Error(`Трек отчёта ${selected.id} не соответствует медиатеке`);
    if(!/^[a-f\d]{64}$/i.test(row.content_hash))throw new Error('Нужен проверенный SHA-256 аудио');
    if(row.provider==='yandex')row.file=path.join(cfg.dataDir,'remote','yandex',`${row.content_hash}.mp3`);
    const meta=service.get(row.content_hash);
    if(!meta||!row.file||!fs.existsSync(row.file)){results.push({id:row.id,title:row.title,status:'unavailable'});continue;}
    if(digest(row.file)!==row.content_hash)throw new Error(`Хеш исходного аудио не совпал: ${row.id}`);
    if(meta.activity.version==='vocal-activity-2'){results.push({id:row.id,title:row.title,status:'current'});continue;}
    if(dry){results.push({id:row.id,title:row.title,status:'selected'});continue;}
    const directory=path.join(cfg.dataDir,'cache','stems',row.content_hash,'hdemucs-v1');
    const pcm=path.join(directory,meta.storage?.format==='s16le'?meta.storage.file??'vocals.s16':'vocals.f32');
    const before=digest(pcm),started=Date.now();
    try{
      execFileSync(cfg.stemsPython,[path.join(ROOT,'tools','separate-vocals.py'),'--analyze-only','--input',row.file,'--output',directory,'--ffmpeg',cfg.ffmpeg],
        {windowsHide:true,encoding:'utf8',timeout:120_000,maxBuffer:65536});
      if(digest(pcm)!==before)throw new Error('Изменился PCM вокальной партии');
      const updated=JSON.parse(fs.readFileSync(path.join(directory,'metadata.json'),'utf8'));
      if(updated.activity?.version!=='vocal-activity-2'||JSON.stringify(updated.storage)!==JSON.stringify(meta.storage))throw new Error('Некорректный результат обновления');
      results.push({id:row.id,title:row.title,status:'upgraded',seconds:(Date.now()-started)/1000,phrases:updated.activity.phrases.length});
      console.log(`${results.length}/${report.tracks.length}: ${row.title}`);
    }catch(error){results.push({id:row.id,title:row.title,status:'error',error:(error as Error).message.slice(0,700)});}
  }
}finally{database.close();service.stop();}
const output={activityVersion:'vocal-activity-2',sourceReport:path.resolve(reportPath),dryRun:dry,results};
const destination=path.join(cfg.dataDir,'reports','vocal-activity-upgrade.json');
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(output,null,2));
console.log(JSON.stringify({selected:results.length,upgraded:results.filter(r=>r.status==='upgraded').length,errors:results.filter(r=>r.status==='error').length,report:destination}));
if(results.some(r=>r.status==='error'))process.exitCode=1;
