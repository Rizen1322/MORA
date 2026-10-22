/** Local library audit; private outputs only. All pairs planned, <=64 rendered by default.
 * --tag NAME --render --pairs 64|all --from ID --to ID --manual --at .5 --analyze --audio --resume --voice-tail --variant NAME
 * --voice-tail: renders each stem plan again with A = its separated voice only and B silent, and
 * measures what is still audible of the old voice (mask, vocal echo, deck echo) after B's voice opens.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, ROOT } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import { ANALYZER_VERSION, PLANNER_VERSION, DEFAULT_AUTOMIX_SETTINGS, analyzePcm, planTransition, planRequestedTransition,
  renderTransitionOffline, type TrackAnalysis, type PlannerTrack, type TransitionPlan, type StereoPcm } from '../packages/core/src/index.ts';
import { decode, shortTermLoudness } from './eval-transitions.ts';

const arg=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);if(i<0)return fallback;const v=process.argv[i+1];if(!v||v.startsWith('--'))throw new Error(`нет значения ${name}`);return v;};
const cfg=loadConfig(),tag=arg('--tag','current');
if(!/^[\p{L}\p{N}_-]+$/u.test(tag))throw new Error('некорректное имя отчёта');
const out=path.join(cfg.dataDir,'reports'),analysisCache=path.join(out,'analysis-cache');fs.mkdirSync(analysisCache,{recursive:true});
const reportFile=path.join(out,`user-library-${tag}.json`),manual=process.argv.includes('--manual'),saveAudio=process.argv.includes('--audio');
const shouldRender=process.argv.includes('--render')||saveAudio,shouldAnalyze=process.argv.includes('--analyze');
const sourceSet = arg('--providers', 'local');
if (!['local', 'yandex', 'all'].includes(sourceSet)) throw new Error('--providers: local, yandex или all');
const trackLimit = Number(arg('--track-limit', '0'));
if (!Number.isSafeInteger(trackLimit) || trackLimit < 0 || trackLimit === 1) throw new Error('--track-limit: 0 (все) или целое число от 2');
const fraction=Math.max(0,Math.min(.99,Number(arg('--at','.5'))||0)),pairsArg=arg('--pairs','64'),limit=pairsArg==='all'?Infinity:Number(pairsArg);
if(!(limit>0)||(Number.isFinite(limit)&&!Number.isSafeInteger(limit)))throw new Error('--pairs: нужно положительное целое число или all');
interface Track {id:string;title:string;artist:string;provider:string;content_hash:string;file:string;duration:number;album:string;album_artist:string;track_no:number|null;disc_no:number|null;analysis:TrackAnalysis|null}
interface Metrics {peak:number;maxLimiterReductionDb:number;underruns:number;peakDbFS:number;truePeakDbTP?:number;bumpLU:number;dipLU:number;completed:boolean;finite:boolean}
interface Row {from:string;to:string;fromId:string;toId:string;requestedAt?:number;plan:TransitionPlan;render?:Metrics;renderError?:string;audio?:string}
// 4x true peak, independent of the limiter's short detector: Hann-windowed sinc, 32 taps per side.
const TP_KERNEL=[1,2,3].map(k=>{const h=Array.from({length:64},(_,j)=>{const d=j-31-k/4;return Math.sin(Math.PI*d)/(Math.PI*d)*(.5+.5*Math.cos(Math.PI*d/33));}),s=h.reduce((a,b)=>a+b);return h.map(v=>v/s);});
function truePeakDbTP(...chs:Float32Array[]):number{
  let mx=0;
  for(const x of chs)for(let n=0;n<x.length;n++){
    mx=Math.max(mx,Math.abs(x[n]));
    for(const h of TP_KERNEL){let y=0;for(let j=0;j<64;j++){const m=n-31+j;if(m>=0&&m<x.length)y+=h[j]*x[m];}mx=Math.max(mx,Math.abs(y));}
  }
  return 20*Math.log10(Math.max(1e-10,mx));
}
type ReviewRow=Row & {withoutVocalMask?:Metrics;sourceLevels?:Record<string,unknown>;voiceTail?:{voiceDbFS:number;tailRmsDb:number;tailPeakDb:number}};
// Never start Python jobs from the audit. Reuse the server's cache validation.
const stems=new StemService({...cfg,stemsPython:null},{} as Library,new EventHub());
const db=new DatabaseSync(path.join(cfg.dataDir,'automix.sqlite'),{readOnly:true}),demoDir=path.join(ROOT,'examples/library');
const demos=new Set(fs.readdirSync(demoDir).filter(f=>/\.(flac|mp3|wav)$/i.test(f)).map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(demoDir,f))).digest('hex')));
const saved=db.prepare("SELECT value FROM kv WHERE key='settings'").get() as {value:string}|undefined;
const settings={...DEFAULT_AUTOMIX_SETTINGS,...(saved?JSON.parse(saved.value).automix:{})};
// Test the optional musical Next path without changing the listener's setting.
if(process.argv.includes('--musical-next'))settings.mixOnNext=true;
const lookup=db.prepare("SELECT data FROM analysis WHERE content_hash=? AND version=? AND status='done'");
const availableTracks=(db.prepare("SELECT t.*, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE provider IN ('local','yandex') AND status='ok' ORDER BY added_at,id").all() as unknown as Track[])
  .map(t=>t.provider==='yandex'&&/^[a-f\d]{64}$/.test(t.content_hash)?{...t,file:path.join(cfg.dataDir,'remote','yandex',`${t.content_hash}.mp3`)}:t)
  .filter(t=>(sourceSet==='all'||t.provider===sourceSet)&&!demos.has(t.content_hash)&&t.file&&fs.existsSync(t.file));
// Deterministic coverage of both providers without decoding hundreds of songs.
// Interleave evenly spaced local and imported Yandex records before applying a cap.
const groups=['local','yandex'].map(provider=>availableTracks.filter(t=>t.provider===provider));
const sampled: Track[]=[];
if(trackLimit&&availableTracks.length>trackLimit){
  const allocation=groups.map(group=>Math.min(group.length,Math.floor(trackLimit/groups.filter(g=>g.length).length)));
  let left=trackLimit-allocation.reduce((a,b)=>a+b,0);
  for(let i=0;left>0;i=(i+1)%groups.length)if(allocation[i]<groups[i].length){allocation[i]++;left--;}
  for(let i=0;i<Math.max(...allocation);i++)for(let g=0;g<groups.length;g++)if(i<allocation[g])sampled.push(groups[g][Math.floor(i*groups[g].length/allocation[g])]);
}
const selectionReport = arg('--selection-report', '');
const selection = selectionReport ? (JSON.parse(fs.readFileSync(path.resolve(selectionReport), 'utf8')) as { tracks: { id: string; contentHash: string }[] }).tracks : null;
if(selection && (!Array.isArray(selection) || selection.length<2)) throw new Error('Отчёт выборки должен содержать минимум два трека');
const selectedTracks = selection ? selection.map(item=>{
  const found=availableTracks.find(t=>t.id===item.id && t.content_hash===item.contentHash);
  if(!found)throw new Error(`Трек выборки изменился или недоступен: ${item.id}`);
  return found;
}) : sampled.length?sampled:availableTracks;
const tracks=selectedTracks.map(t=>{
    const row=lookup.get(t.content_hash,ANALYZER_VERSION) as {data:string}|undefined;let analysis:TrackAnalysis|null=null;
    try{const a=row?JSON.parse(row.data) as TrackAnalysis:null;if(a?.version===ANALYZER_VERSION)analysis=a;}catch{/* do not reuse corrupt/stale analysis */}
    const voice=settings.stemMixing!==false?stems.get(t.content_hash):null,activity=voice?stems.activity(t.content_hash):undefined;
    return {...t,analysis:analysis&&activity?{...analysis,vocalActivity:activity}:analysis};
  });db.close();
const fromFilter=arg('--from',''),toFilter=arg('--to','');
for(const id of [fromFilter,toFilter])if(id&&!tracks.some(t=>t.id===id))throw new Error(`трек ${id} не найден среди доступных локальных файлов`);

/** Three records maximum; 320 MiB target. Only the two pinned active records
 * may exceed that target. Voice deinterleaving uses a 512 KiB scratch buffer. */
class PcmLru {
  entries=new Map<string,StereoPcm>();peakBytes=0;peakRecords=0;decodes=0;
  bytes(p:StereoPcm){return p.L.byteLength+p.R.byteLength+(p.vocals?p.vocals.L.byteLength+p.vocals.R.byteLength:0);}
  total(){return [...this.entries.values()].reduce((s,p)=>s+this.bytes(p),0);}
  room(extra:number,pinned:Set<string>,adding:boolean){for(const [id] of this.entries){if(this.total()+extra<=320*1048576&&this.entries.size+Number(adding)<=3)break;if(!pinned.has(id))this.entries.delete(id);}}
  get(t:Track,voice:boolean,pinned=new Set([t.id])):StereoPcm {
    let pcm=this.entries.get(t.id);
    if(!pcm){
      if(t.provider==='yandex'&&crypto.createHash('sha256').update(fs.readFileSync(t.file)).digest('hex')!==t.content_hash)throw new Error(`версия аудио изменилась: ${t.title}`);
      this.room(Math.ceil(t.duration*44100)*(voice?16:8),pinned,true);pcm={...decode(t.file),sampleRate:44100};this.decodes++;this.entries.set(t.id,pcm);
    }
    if(voice&&!pcm.vocals){
      const meta=stems.get(t.content_hash);if(!meta||meta.frames!==pcm.L.length)throw new Error(`нет совмещённого вокального PCM: ${t.title} (${meta?.frames??0}/${pcm.L.length} кадров)`);
      this.room(pcm.L.byteLength+pcm.R.byteLength,pinned,false);
      const L=new Float32Array(meta.frames),R=new Float32Array(meta.frames);
      for(let frame=0;frame<meta.frames;frame+=65536){const count=Math.min(65536,meta.frames-frame),scratch=stems.readNative(t.content_hash,frame,count);if(scratch.length!==count*8)throw new Error(`обрезан вокальный PCM: ${t.title}`);for(let i=0;i<count;i++){L[frame+i]=scratch.readFloatLE(i*8);R[frame+i]=scratch.readFloatLE(i*8+4);}}
      pcm.vocals={L,R};
    }
    this.entries.delete(t.id);this.entries.set(t.id,pcm);this.peakBytes=Math.max(this.peakBytes,this.total());this.peakRecords=Math.max(this.peakRecords,this.entries.size);return pcm;
  }
}
const cache=new PcmLru();
if(shouldAnalyze)for(const t of tracks){
  const file=path.join(analysisCache,`${t.content_hash}_${ANALYZER_VERSION}.json`);let analysis:TrackAnalysis|null=null;
  try{const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.hash===t.content_hash&&c.version===ANALYZER_VERSION&&c.analysis?.version===ANALYZER_VERSION)analysis=c.analysis;}catch{/* resumable per-hash analysis */}
  if(!analysis){const pcm=cache.get(t,false);analysis=analyzePcm(pcm.L,pcm.R);fs.writeFileSync(file,JSON.stringify({hash:t.content_hash,version:ANALYZER_VERSION,analysis}));}
  const v=settings.stemMixing!==false?stems.activity(t.content_hash):undefined;t.analysis=v?{...analysis,vocalActivity:v}:analysis;console.log(`analysis ${t.title}: ${t.analysis.beat?.bpm??'no global beat'}`);
}
const pt=(t:Track):PlannerTrack=>({id:t.id,duration:t.duration,mixingAllowed:true,analysis:t.analysis,album:t.album,albumArtist:t.album_artist||t.artist,trackNo:t.track_no,discNo:t.disc_no});
const rows:Row[]=[],byPair=new Map<string,Row>();
for(let i=0;i<tracks.length;i++)for(let j=0;j<tracks.length;j++){
  const A=tracks[i],B=tracks[j];if(i===j||(fromFilter&&A.id!==fromFilter)||(toFilter&&B.id!==toFilter))continue;
  const position=A.duration*fraction,plan=manual?planRequestedTransition(pt(A),pt(B),position,settings):planTransition(pt(A),pt(B),settings);
  const row:Row={from:A.title,to:B.title,fromId:A.id,toId:B.id,...(manual?{requestedAt:position}:{}),plan};rows.push(row);byPair.set(`${i}/${j}`,row);
}
// Cyclic rounds balance both from/to coverage. Walking cycles reuses B as A.
const ordered:Row[]=[],n=tracks.length,gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
let step=Math.max(1,Math.floor((n-1)/2)+1);while(n>2&&gcd(step,n-1)!==1)step++;
for(let round=0;round<n-1;round++){
  const offset=1+(round*step)%(n-1),seen=new Set<number>();
  for(let seed=0;seed<n;seed++){let from=seed;while(!seen.has(from)){seen.add(from);const to=(from+offset)%n,row=byPair.get(`${from}/${to}`);if(row)ordered.push(row);from=to;}}
}
// --variant NAME renders only plans of that kind (beatmatch_blend, intro-drop, echo-tail, washout, fade, crossfade)
const variantOf=(p:TransitionPlan)=>typeof p.debug.variant==='string'?p.debug.variant:p.method==='crossfade'?(p.debug.washout?'washout':p.debug.naturalFade?'fade':'crossfade'):p.method;
const variantFilter=arg('--variant','');
const selected=shouldRender?ordered.filter(r=>!variantFilter||variantOf(r.plan)===variantFilter||r.plan.method===variantFilter).slice(0,limit):[];
if(process.argv.includes('--resume')&&fs.existsSync(reportFile))try{
  const p=JSON.parse(fs.readFileSync(reportFile,'utf8'));
  if(p.analyzer===ANALYZER_VERSION&&p.planner===PLANNER_VERSION&&JSON.stringify(p.settings)===JSON.stringify(settings)){
    const old=new Map<string,Row>((p.rows??[]).map((r:Row)=>[r.plan.id,r]));
    for(const row of selected){const r=old.get(row.plan.id);if(r?.render&&JSON.stringify(r.plan)===JSON.stringify(row.plan)&&(!saveAudio||(r.audio&&fs.existsSync(r.audio)))){row.render=r.render;row.audio=r.audio;}}
  }
}catch{/* ignore partial report */}
const summary=()=>{
  const variants=rows.reduce<Record<string,number>>((c,r)=>{const v=variantOf(r.plan);c[v]=(c[v]??0)+1;return c;},{});
  const rendered=rows.filter(r=>r.render).map(r=>r.render!),counts=(items:Row[])=>items.reduce<Record<string,number>>((c,r)=>{c[r.plan.method]=(c[r.plan.method]??0)+1;return c;},{}),mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/Math.max(1,x.length);
  return {tracks:tracks.length,availableTracks:availableTracks.length,providers:tracks.reduce<Record<string,number>>((all,t)=>{all[t.provider]=(all[t.provider]??0)+1;return all;},{}),pairs:rows.length,planned:rows.length,rendered:rendered.length,selected:selected.length,methods:counts(rows),renderedMethods:counts(rows.filter(r=>r.render)),variants,
    renderedVariants:rows.filter(r=>r.render).reduce<Record<string,number>>((c,r)=>{const v=variantOf(r.plan);c[v]=(c[v]??0)+1;return c;},{}),
    analysisVersions:tracks.reduce<Record<string,number>>((all,t)=>{const v=t.analysis?.version??'missing';all[v]=(all[v]??0)+1;return all;},{}),
    coverage:{from:new Set(selected.map(r=>r.fromId)).size,to:new Set(selected.map(r=>r.toId)).size},
    quality:{completed:rendered.filter(r=>r.completed).length,incomplete:rendered.filter(r=>!r.completed).length,underruns:rendered.reduce((s,r)=>s+r.underruns,0),nonFiniteRenders:rendered.filter(r=>!r.finite).length,renderErrors:rows.filter(r=>r.renderError).length,
      maxPeakDbFS:rendered.length?Math.max(...rendered.map(r=>r.peakDbFS)):null,maxTruePeakDbTP:rendered.some(r=>r.truePeakDbTP!==undefined)?Math.max(...rendered.map(r=>r.truePeakDbTP??-Infinity)):null,maxLimiterReductionDb:rendered.length?Math.max(...rendered.map(r=>r.maxLimiterReductionDb)):null,
      meanDipLU:rendered.length?mean(rendered.map(r=>r.dipLU)):null,minDipLU:rendered.length?Math.min(...rendered.map(r=>r.dipLU)):null,meanBumpLU:rendered.length?mean(rendered.map(r=>r.bumpLU)):null,maxBumpLU:rendered.length?Math.max(...rendered.map(r=>r.bumpLU)):null},
    voices:(()=>{const st=rows.map(r=>r.plan.debug.stems as {lostA?:number;lostB?:number;aBreath?:boolean;bBreath?:boolean;voiceEcho?:unknown}|undefined).filter(x=>x&&x.lostA!==undefined) as {lostA:number;lostB:number;aBreath:boolean;bBreath:boolean;voiceEcho:unknown}[];
      return {plans:st.length,meanMaskedA:st.length?mean(st.map(x=>x.lostA)):null,meanMaskedB:st.length?mean(st.map(x=>x.lostB)):null,maxMaskedB:st.length?Math.max(...st.map(x=>x.lostB)):null,
        aEndsInBreath:st.filter(x=>x.aBreath).length,bOpensAtBreath:st.filter(x=>x.bBreath).length,vocalEcho:st.filter(x=>x.voiceEcho).length};})(),
    meanDuration:mean(rows.map(r=>r.plan.duration)),
    voiceTail:(()=>{const t=rows.map(r=>(r as ReviewRow).voiceTail).filter(Boolean) as {tailRmsDb:number;tailPeakDb:number}[];
      return t.length?{rendered:t.length,maxTailRmsDb:Math.max(...t.map(x=>x.tailRmsDb)),maxTailPeakDb:Math.max(...t.map(x=>x.tailPeakDb)),meanTailRmsDb:mean(t.map(x=>x.tailRmsDb))}:null;})(),
    pcmCache:{maxRecords:3,targetMiB:320,peakRecords:cache.peakRecords,peakMiB:cache.peakBytes/1048576,decodes:cache.decodes}};
};
const checkpoint=()=>fs.writeFileSync(reportFile,JSON.stringify({analyzer:ANALYZER_VERSION,planner:PLANNER_VERSION,mode:manual?'next':'automatic',fraction:manual?fraction:undefined,settings,summary:summary(),tracks:tracks.map(t=>({id:t.id,title:t.title,contentHash:t.content_hash,analysis:t.analysis})),rows},null,2));
checkpoint();console.log(`Planned ${rows.length}; rendering ${selected.length}; from/to coverage ${summary().coverage.from}/${summary().coverage.to} of ${n}.`);
const byId=new Map(tracks.map(t=>[t.id,t]));
for(let index=0;index<selected.length;index++){
  const row=selected[index];if(row.render)continue;
  try{
    const A=byId.get(row.fromId)!,B=byId.get(row.toId)!,pinned=new Set([A.id,B.id]);
    const a=cache.get(A,!!row.plan.vocalA?.some(([,g])=>g!==1),pinned),b=cache.get(B,!!row.plan.vocalB?.some(([,g])=>g!==1),pinned);
    const r=renderTransitionOffline(a,b,row.plan,8,12),levels=shortTermLoudness(r.L,r.R);
    const t0=Math.max(1,Math.round(r.transitionStartFrame/4410)-30),t1=Math.min(levels.length-1,t0+Math.round((row.plan.duration+row.plan.gap)*10)+30);
    const median=(x:number[])=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)]??-90,before=median(levels.slice(Math.max(0,t0-40),Math.max(1,t0-5))),after=median(levels.slice(t1)),during=levels.slice(t0,t1);
    row.render={...r.metrics,peakDbFS:20*Math.log10(Math.max(1e-10,r.metrics.peak)),truePeakDbTP:truePeakDbTP(r.L,r.R),bumpLU:Math.max(0,...during.map(v=>v-Math.max(before,after))),dipLU:Math.min(0,...during.map(v=>v-Math.min(before,after))),completed:r.events.some(e=>e.type==='transitionEnd'),finite:r.L.every(Number.isFinite)&&r.R.every(Number.isFinite)};
    if(process.argv.includes('--compare-vocals')){
      const plain=renderTransitionOffline(a,b,{...row.plan,vocalA:undefined,vocalB:undefined},8,12),st=shortTermLoudness(plain.L,plain.R);
      const p0=Math.max(1,Math.round(plain.transitionStartFrame/4410)-30),p1=Math.min(st.length-1,p0+Math.round((row.plan.duration+row.plan.gap)*10)+30);
      const beforePlain=median(st.slice(Math.max(0,p0-40),Math.max(1,p0-5))),afterPlain=median(st.slice(p1)),window=st.slice(p0,p1);
      (row as ReviewRow).withoutVocalMask={...plain.metrics,peakDbFS:20*Math.log10(Math.max(1e-10,plain.metrics.peak)),bumpLU:Math.max(0,...window.map(v=>v-Math.max(beforePlain,afterPlain))),dipLU:Math.min(0,...window.map(v=>v-Math.min(beforePlain,afterPlain))),completed:plain.events.some(e=>e.type==='transitionEnd'),finite:plain.L.every(Number.isFinite)&&plain.R.every(Number.isFinite)};
      const integral=(points:[number,number][]|undefined,t:number)=>{const p=points?.length?points:[[0,1]] as [number,number][];const value=(at:number)=>{for(let i=1;i<p.length;i++)if(at<=p[i][0])return p[i-1][1]+(p[i][1]-p[i-1][1])*(at-p[i-1][0])/(p[i][0]-p[i-1][0]);return p[p.length-1][1];};const knots=[0,...p.map(([at])=>at).filter(at=>at>0&&at<t),t];let sum=0;for(let i=1;i<knots.length;i++)sum+=(knots[i]-knots[i-1])*(value(knots[i])+value(knots[i-1]))/2;return sum;};
      const levelsAt=(pcm:StereoPcm,center:number)=>{const first=Math.max(0,Math.round((center-1)*44100)),end=Math.min(pcm.L.length,Math.round((center+1)*44100));let original=0,vocal=0,bed=0;for(let i=first;i<end;i++){const l=pcm.L[i],r=pcm.R[i],vl=pcm.vocals?.L[i]??0,vr=pcm.vocals?.R[i]??0;original+=l*l+r*r;vocal+=vl*vl+vr*vr;bed+=(l-vl)**2+(r-vr)**2;}const db=(power:number)=>10*Math.log10(Math.max(1e-12,power/Math.max(1,2*(end-first))));return {centerSeconds:center,originalDbFS:db(original),vocalDbFS:db(vocal),accompanimentDbFS:db(bed),accompanimentVsOriginalDb:db(bed)-db(original)};};
      (row as ReviewRow).sourceLevels={outgoingAtHandoff:levelsAt(a,row.plan.aExit+integral(row.plan.tempoA,row.plan.swapAt)),incomingAtHandoff:levelsAt(b,row.plan.bEntry+integral(row.plan.tempoB,row.plan.swapAt)),incomingAtEntry:levelsAt(b,row.plan.bEntry+1)};
    }
    if(process.argv.includes('--voice-tail')&&a.vocals&&row.plan.vocalA){
      const zero=new Float32Array(b.L.length),voiceOnly={L:a.vocals.L,R:a.vocals.R,sampleRate:44100,vocals:a.vocals};
      const v=renderTransitionOffline(voiceOnly,{L:zero,R:zero,sampleRate:44100,vocals:{L:zero,R:zero}},row.plan,8,12);
      const rms=(from:number,to:number)=>{let e=0;const lo=Math.max(0,from),hi=Math.min(v.L.length,to);for(let i=lo;i<hi;i++)e+=v.L[i]*v.L[i]+v.R[i]*v.R[i];return 10*Math.log10(Math.max(1e-12,e/Math.max(1,2*(hi-lo))));};
      const start=v.transitionStartFrame,open=start+Math.round(((row.plan.debug.stems as {bVoiceStart?:number})?.bVoiceStart??row.plan.swapAt)*44100);
      // reference: A's voice in the 4 s before the transition (only singing blocks count)
      const blocks=(from:number,to:number)=>Array.from({length:Math.floor((to-from)/4410)},(_,k)=>rms(from+k*4410,from+(k+1)*4410));
      const ref=Math.max(...blocks(start-4*44100,start)),tail=blocks(open,open+2*44100);
      // without singing before the transition there is nothing to measure a tail against
      if(ref>-50)(row as ReviewRow).voiceTail={voiceDbFS:ref,tailRmsDb:rms(open,open+2*44100)-ref,tailPeakDb:Math.max(...tail)-ref};
    }
    if(saveAudio){
      const dir=path.join(out,'previews',tag);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${String(index+1).padStart(3,'0')}_${A.id.slice(0,8)}_${B.id.slice(0,8)}.mp3`),inter=new Float32Array(r.L.length*2);
      for(let i=0;i<r.L.length;i++){inter[2*i]=r.L[i];inter[2*i+1]=r.R[i];}
      execFileSync(cfg.ffmpeg,['-v','error','-y','-f','f32le','-ar','44100','-ac','2','-i','pipe:0','-codec:a','libmp3lame','-q:a','2',file],{input:Buffer.from(inter.buffer),windowsHide:true,maxBuffer:16*1048576});row.audio=file;
    }
  }catch(e){row.renderError=(e as Error).message;console.error(`${row.from} → ${row.to}: ${row.renderError}`);}
  if((index+1)%8===0||index===selected.length-1){checkpoint();console.log(`Rendered ${index+1}/${selected.length}; RSS ${(process.memoryUsage().rss/1048576).toFixed(0)} MiB; PCM ${cache.peakRecords} records / ${(cache.peakBytes/1048576).toFixed(0)} MiB.`);}
}
checkpoint();console.log(JSON.stringify(summary(),null,2));console.log(reportFile);
