import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { computeSpectral, ANALYSIS_RATE } from '../packages/core/src/mir/spectral.ts';
import { onsetEnvelope, estimateTempo, trackBeats, fitGridRobust } from '../packages/core/src/mir/tempo.ts';
const cfg = loadConfig();
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const tracks = db.prepare("SELECT t.id,t.title,t.duration,(SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t ORDER BY added_at DESC LIMIT 5").all() as unknown as {id:string;title:string;duration:number;file:string}[];
db.close();
const rows: object[] = [];
for (const t of tracks) {
  const buf = execFileSync(cfg.ffmpeg, ['-v','fatal','-i',t.file,'-ac','1','-ar',String(ANALYSIS_RATE),'-f','f32le','pipe:1'],{maxBuffer:1<<28,windowsHide:true});
  const mono = new Float32Array(buf.buffer,buf.byteOffset,buf.byteLength/4);
  const o = onsetEnvelope(computeSpectral(mono));
  const rankGrid = (start:number,end:number) => {
    const rows:{bpm:number;score:number;phase:number}[]=[];
    for(let bpm=65;bpm<=180;bpm+=0.25){
      const period=60/bpm*o.fps;let best=-Infinity,phase=0;
      const at=(p:number)=>{const i=Math.round(p);return Math.max(o.lowMid[i-1]??0,o.lowMid[i]??0,o.lowMid[i+1]??0)};
      for(let ph=0;ph<period;ph+=1){let on=0,off=0,n=0;for(let p=(start-o.t0)*o.fps+ph;p<(end-o.t0)*o.fps-period;p+=period){on+=at(p);off+=(at(p+period/4)+at(p+period/2)+at(p+period*3/4))/3;n++}const score=(on-off*.6)/Math.max(1,n);if(score>best){best=score;phase=ph}}
      rows.push({bpm,score:best,phase});
    }
    rows.sort((a,b)=>b.score-a.score);const selected:typeof rows=[];for(const r of rows)if(selected.every(x=>Math.abs(r.bpm-x.bpm)>1))selected.push(r);
    return selected.slice(0,6);
  };
  console.log('phase comb',t.title,rankGrid(12,36));
  let trial = estimateTempo(o.env,o.fps).bpm;
  const fits: object[]=[];
  for (let i=0;i<4;i++) {
    const times=trackBeats(o.env,o.fps,trial).map(f=>f/o.fps+o.t0); const fit=fitGridRobust(times,60/trial);
    fits.push({trial,bpm:60/fit.period,share:fit.inlierShare,jitter:fit.jitterMs}); trial=60/fit.period;
  }
  console.log('iterative global fits',t.title,fits);
  const windows: object[]=[];
  for (let start=0;start+16<t.duration;start+=12) {
    const end = Math.min(t.duration,start+24); const lo=Math.max(0,Math.round((start-o.t0)*o.fps)); const hi=Math.min(o.env.length,Math.round((end-o.t0)*o.fps));
    const results = [o.env,o.lowMid,o.low].map((env,i)=>{
      const e=estimateTempo(env,o.fps,lo,hi); const times=trackBeats(env,o.fps,e.bpm,100,lo,hi).map(f=>f/o.fps+o.t0);
      const fit=fitGridRobust(times,60/e.bpm);
      return {band:['all','low-mid','low'][i],bpm:e.bpm,strength:+e.strength.toFixed(2),fitBpm:+(60/fit.period).toFixed(2),share:+fit.inlierShare.toFixed(2),jitter:+fit.jitterMs.toFixed(1)};
    });
    windows.push({start,end,results});
  }
  rows.push({title:t.title,windows});
  console.log(t.title);console.table(windows.map((w:any)=>({start:w.start,...Object.fromEntries(w.results.map((r:any)=>[r.band,`${r.bpm}/${r.fitBpm} strength${r.strength} share${r.share} jit${r.jitter}`]))})));
}
fs.mkdirSync(path.join(cfg.dataDir,'reports'),{recursive:true});
fs.writeFileSync(path.join(cfg.dataDir,'reports/rhythm-windows.json'),JSON.stringify(rows,null,2));
