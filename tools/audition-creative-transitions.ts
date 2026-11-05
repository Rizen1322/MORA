import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, finalistSpans, renderTransitionOffline, type PlannerTrack, type StereoPcm, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/index.ts';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from '../packages/core/src/plan/creative.ts';
import { planForSourceWindows } from './review-source-window.ts';
import { inspectAudio } from './audition-audio-check.ts';
import { measureLibraryStereo } from './inventory-creative-stereo.ts';
import { assertOutputOutsideProfile } from './audition-output-path.ts';
import { rankAuditions } from './audition-rank.ts';

const SR = 44100, PRE = 6, POST = 6;
interface Track { id:string; title:string; artist:string; assetTitle:string; assetArtist:string; hash:string; file:string; duration:number; album:string; albumArtist:string; trackNo:number|null; discNo:number|null; analysis:TrackAnalysis }
interface Candidate { a:Track; b:Track; plan:TransitionPlan; score:number; reasons:string[] }
const esc = (s:unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const stamp=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')} (${seconds.toFixed(2)} с)`;
const measuredLabels:Record<string,string>={bpmA:'Темп A, BPM',bpmB:'Темп B, BPM',pickupSeconds:'Затакт B, с',outgoingRmsDb:'RMS A, дБ',incomingRmsDb:'RMS B, дБ',outgoingMidDensity:'Плотность середины A',incomingMidDensity:'Плотность середины B',outgoingOnset:'Атаки A',incomingOnset:'Атаки B',breakDropDb:'Падение в брейке, дБ',breathSeconds:'Длительность дыхания, с',tempoRelation:'Отношение темпов',outgoingLowDb:'Низ A, дБ',incomingLowDb:'Низ B, дБ',finalEchoDelay:'Последняя задержка эха, с',energyRiseDb:'Подъём энергии, дБ',arrivalSeconds:'Время до подъёма, с',loopDifferenceDb:'Разница повторов, дБ',loopCycles:'Повторы',thresholdDb:'Порог хвоста, дБ',tailRmsDb:'RMS хвоста, дБ',brakeSeconds:'Торможение, с',attackSeconds:'Атака B, с',stereoWindowsChecked:'Проверенных стереоокон',minimumCorrelation:'Минимальная стереокорреляция'};
function measuredSummary(m:Record<string,unknown>) {return Object.entries(measuredLabels).flatMap(([key,label])=>typeof m?.[key]==='number'&&Number.isFinite(m[key])?[`${label}: ${(m[key] as number).toFixed(2)}`]:[]).join('; ');}
const name = (t:Track) => `${t.artist} — ${t.title}${t.title !== t.assetTitle || t.artist !== t.assetArtist ? ` (recording: ${t.assetArtist} — ${t.assetTitle})` : ''}`;
function arg(key:string, fallback:string):string { const i=process.argv.indexOf(key); if(i<0)return fallback; const v=process.argv[i+1]; if(!v || v.startsWith('--'))throw Error(`Missing ${key}`); return v; }
function loadTracks(dir:string):Track[] {
  const db=new DatabaseSync(path.join(dir,'automix.sqlite'),{readOnly:true});
  try {
    const rows=db.prepare(`SELECT t.id,t.title,t.artist, a.title AS assetTitle,a.artist AS assetArtist,a.content_hash AS hash,a.provider,a.duration,a.album,a.album_artist AS albumArtist,a.track_no AS trackNo,a.disc_no AS discNo,n.data,
      (SELECT path FROM track_sources WHERE track_id=a.id AND path IS NOT NULL LIMIT 1) AS sourcePath
      FROM tracks t LEFT JOIN track_bindings b ON b.track_id=t.id JOIN tracks a ON a.id=COALESCE(b.asset_id,t.id)
      JOIN analysis n ON n.content_hash=a.content_hash AND n.version=? AND n.status='done'
      WHERE t.saved=1 AND t.status='ok' AND a.status='ok' ORDER BY t.id`).all(ANALYZER_VERSION) as unknown as (Omit<Track,'analysis'|'file'> & {provider:string;data:string;sourcePath:string|null})[];
    const caches=new Map<string,Map<string,string>>();
    return rows.flatMap(r=>{
      if(!['local','yandex','youtube','soundcloud'].includes(r.provider)||!/^[a-f0-9]{64}$/.test(r.hash))return [];
      let file:string|undefined;
      if(r.provider==='local')file=r.sourcePath??undefined;
      else {
        if(!caches.has(r.provider)){const folder=path.join(dir,'remote',r.provider);caches.set(r.provider,new Map(fs.existsSync(folder)?fs.readdirSync(folder).map(f=>[path.parse(f).name,path.join(folder,f)]):[]));}
        file=caches.get(r.provider)!.get(r.hash);
      }
      if(!file || !fs.existsSync(file))return [];
      try {const analysis=JSON.parse(r.data) as TrackAnalysis; if(analysis.version!==ANALYZER_VERSION)return [];return [{...r,file,analysis}];}catch{return [];}
    });
  } finally {db.close();}
}
function pt(t:Track):PlannerTrack {return {id:t.id,duration:t.duration,mixingAllowed:true,analysis:t.analysis,album:t.album,albumArtist:t.albumArtist||t.assetArtist,trackNo:t.trackNo,discNo:t.discNo};}
function verified(t:Track):boolean {return crypto.createHash('sha256').update(fs.readFileSync(t.file)).digest('hex')===t.hash;}
function decode(file:string,start:number,end:number,ffmpeg:string):StereoPcm {
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw Error('Invalid source window');
  const buf=execFileSync(ffmpeg,['-v','error','-ss',String(start),'-i',file,'-t',String(end-start),'-ac','2','-ar',String(SR),'-f','f32le','pipe:1'],{maxBuffer:256*1024*1024,windowsHide:true,timeout:120_000});
  if(!buf.length||buf.length%8)throw Error('Incomplete stereo PCM'); const n=buf.length/8,L=new Float32Array(n),R=new Float32Array(n);
  for(let i=0;i<n;i++){L[i]=buf.readFloatLE(i*8);R[i]=buf.readFloatLE(i*8+4);}return {L,R,sampleRate:SR};
}
function wav(L:Float32Array,R:Float32Array):Buffer {
  const out=Buffer.alloc(44+L.length*4);out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(2,22);out.writeUInt32LE(SR,24);out.writeUInt32LE(SR*4,28);out.writeUInt16LE(4,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(L.length*4,40);
  for(let i=0;i<L.length;i++){out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(L[i]*32767))),44+i*4);out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(R[i]*32767))),46+i*4);}return out;
}
function render(c:Candidate,ffmpeg:string) {
  const plan=c.plan;if(plan.vocalA||plan.vocalB||plan.voiceEcho||plan.automation.some(l=>l.lane==='voiceEcho'))throw Error('Plan requires separated vocals');
  if(!Number.isFinite(plan.gainA)||!Number.isFinite(plan.gainB))throw Error('Invalid normalization gain');
  const spans=finalistSpans([plan]);const startA=Math.floor(Math.max(0,Math.min(spans.a[0],plan.aExit-PRE,plan.loopA ? plan.loopA.start-plan.loopA.crossfade-.05 : Infinity,plan.tapeStopA?.start??Infinity))*SR)/SR;const startB=Math.floor(Math.max(0,Math.min(spans.b[0],plan.bEntry))*SR)/SR;
  const endA=Math.max(spans.a[1],plan.loopA?.end??0,plan.tapeStopA?.end??0);
  const a=decode(c.a.file,startA,Math.min(c.a.duration,endA+.05),ffmpeg),b=decode(c.b.file,startB,Math.min(c.b.duration,spans.b[1]+POST),ffmpeg);
  const r=renderTransitionOffline(a,b,planForSourceWindows(plan,startA,startB),PRE,POST);const check=inspectAudio(r.L,r.R,SR);
  if(r.transitionStartFrame<0||!r.events.some(e=>e.type==='transitionEnd'&&!e.forced)||r.events.some(e=>e.type==='fallback'||e.type==='transitionAborted')||r.metrics.underruns||!Number.isFinite(r.metrics.maxLimiterReductionDb)||r.metrics.maxLimiterReductionDb>4||!check.finite||check.peak>=1||check.longestSilence>=1)throw Error(`Render quality check failed: ${JSON.stringify({...r.metrics,...check})}`);
  return {plan,r,check};
}
function main(){
  const dir=path.resolve(arg('--data-dir', 'C:/Users/aivaz/AppData/Local/MORA/data'));
  const out=path.resolve(arg('--out','data-bench-results/creative-transitions-2026-11-04'));
  assertOutputOutsideProfile(dir,out);
  const ffmpeg=arg('--ffmpeg',process.env.FFMPEG_PATH||'ffmpeg'),tracks=loadTracks(dir);if(tracks.length<2)throw Error('Fewer than two saved, analyzed, cached tracks');
  fs.mkdirSync(out,{recursive:true});console.log(`Eligible saved tracks with cached audio: ${tracks.length}`);
  const inventoryFile=path.join(out,'stereo-inventory.json');if(!fs.existsSync(inventoryFile))measureLibraryStereo(dir,out,ffmpeg);
  let inventory=JSON.parse(fs.readFileSync(inventoryFile,'utf8'));if(inventory.version!==1||inventory.sampleRate!==16000)throw Error('Unsupported stereo inventory');
  if(tracks.some(t=>!inventory.items[t.hash])){measureLibraryStereo(dir,out,ffmpeg);inventory=JSON.parse(fs.readFileSync(inventoryFile,'utf8'));}
  for(const track of tracks)if(inventory.items[track.hash])track.analysis={...track.analysis,stereo:inventory.items[track.hash]};
  const all=new Map(CREATIVE_TRANSITION_STYLES.map(s=>[s.id,[] as Candidate[]]));
  for(const a of tracks)for(const b of tracks){if(a.id===b.id||a.hash===b.hash)continue;for(const style of CREATIVE_TRANSITION_STYLES){const plan=planCreativeTransition(pt(a),pt(b),DEFAULT_AUTOMIX_SETTINGS,style.id);if(!plan||plan.vocalA||plan.vocalB||plan.voiceEcho||plan.automation.some(l=>l.lane==='voiceEcho'))continue;const detail=plan.debug.creative as {score:number;reasons:string[]};if(!Number.isFinite(detail?.score)||!Array.isArray(detail.reasons))continue;const list=all.get(style.id)!;list.push({a,b,plan,score:detail.score,reasons:detail.reasons});}}
  const used=new Map<string,number>(),usedTracks=new Map<string,number>(),verifiedHashes=new Map<string,boolean>(),manifest:any[]=[];
  for(const style of CREATIVE_TRANSITION_STYLES){const candidates=all.get(style.id)!,candidateCount=candidates.length;console.log(`${style.id}: ${candidates.length} measured candidates`);const entries:any[]=[];
    while(entries.length<2&&candidates.length){rankAuditions(candidates,entries,used,usedTracks);const c=candidates.shift()!;if(entries.some(e=>e.fromHash===c.a.hash&&e.toHash===c.b.hash))continue;
      for(const t of [c.a,c.b])if(!verifiedHashes.has(t.hash))verifiedHashes.set(t.hash,verified(t));if(!verifiedHashes.get(c.a.hash)||!verifiedHashes.get(c.b.hash))continue;
      try {const {plan,r,check}=render(c,ffmpeg);const audio=`${style.id}-${entries.length+1}.wav`;fs.writeFileSync(path.join(out,audio),wav(r.L,r.R));const row={from:name(c.a),to:name(c.b),fromHash:c.a.hash,toHash:c.b.hash,aExit:plan.aExit,bEntry:plan.bEntry,transitionStart:r.transitionStartFrame/SR,score:c.score,reasons:c.reasons,metrics:{...r.metrics,...check},audio,plan};entries.push(row);used.set(`${c.a.hash}/${c.b.hash}`,(used.get(`${c.a.hash}/${c.b.hash}`)??0)+1);for(const t of [c.a,c.b])usedTracks.set(t.hash,(usedTracks.get(t.hash)??0)+1);console.log(`  rendered ${entries.length}`);}catch(e){console.warn('  rejected render due to source or quality check');}
    }manifest.push({id:style.id,name:style.name,description:style.description,candidateCount,entries});
  }
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({analyzer:ANALYZER_VERSION,tracks:tracks.length,styles:manifest},null,2));
  const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Прослушивание переходов</title><style>body{font:16px/1.5 system-ui;max-width:65rem;margin:auto;padding:1rem;background:#10151d;color:#e8edf3}section{border-top:1px solid #536174;padding:1rem 0}audio{width:min(100%,38rem)}small{color:#bec9d8}</style><h1>Прослушивание переходов</h1><p>Это экспериментальные примеры по измерениям. Окончательную музыкальную пригодность нужно оценить на слух. До перехода сохранено до 6 секунд первого трека, после перехода — 6 секунд второго. Звук не запускается автоматически.</p>${manifest.map(s=>`<section><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p>${s.entries.length?s.entries.map((e:any)=>`<article><h3>${esc(e.from)} → ${esc(e.to)}</h3><p>Выход A: ${stamp(e.aExit)}; вход B: ${stamp(e.bEntry)}; начало перехода в примере: ${stamp(e.transitionStart)}. Оценка по измерениям: ${e.score.toFixed(2)}.</p><p>${e.reasons.map(esc).join('; ')}</p><p>Измерения: ${esc(measuredSummary(e.plan.debug.creative?.measured))}.</p>${e.plan.debug.creative?.measured?.vocalActivityKnown===false?'<p>Наложение вокала не измерено отдельно — проверьте на слух.</p>':''}<audio controls preload="none" aria-label="${esc(e.from)} → ${esc(e.to)}" src="${esc(e.audio)}">Ваш браузер не поддерживает аудио.</audio></article>`).join(''):'<p>Подходящая проверенная пара не найдена.</p>'}</section>`).join('')}<script>document.addEventListener('play',e=>{if(e.target instanceof HTMLAudioElement)document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>`;
  fs.writeFileSync(path.join(out,'index.html'),html);console.log(`Done: ${manifest.reduce((n,s)=>n+s.entries.length,0)} renders in ${out}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();














