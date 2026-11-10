import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_AUTOMIX_SETTINGS } from '../packages/core/src/index.ts';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from '../packages/core/src/plan/creative.ts';
import { loadTracks, pt, verified, render, wav, type Candidate } from './audition-creative-transitions.ts';
import { assertOutputOutsideProfile } from './audition-output-path.ts';
import { windowRmsDb } from './audition-deck-energy.ts';
import { handoffCropStart } from './audition-handoff-crop.ts';

const arg=(name:string)=>{const i=process.argv.indexOf(name),v=process.argv[i+1];if(i<0||!v||v.startsWith('--'))throw Error(`Missing ${name}`);return path.resolve(v)};
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const db=(r:ReturnType<typeof render>,t:number)=>windowRmsDb(r.r.L,r.r.R,t,44100);
function diagnostics(c:Candidate,ffmpeg:string){const a=render(c,ffmpeg,'A'),b=render(c,ffmpeg,'B'),end=a.r.transitionStartFrame/44100+(c.plan.swapAt??c.plan.duration);return {aBeforeEnd:db(a,end-.5),bBeforeEnd:db(b,end-.5),aAfterEnd:db(a,end+.5),bAfterEnd:db(b,end+.5)}}
const digest=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copyOnce(source:string,dest:string){if(fs.existsSync(dest)){if(digest(source)!==digest(dest))throw Error(`Existing old file differs: ${dest}`)}else fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL)}
function main(){
 const dir=arg('--data-dir'),out=arg('--out'),original=arg('--original'),ffmpeg=arg('--ffmpeg');assertOutputOutsideProfile(dir,out);
 const source=path.dirname(original),old=path.join(out,'old');if(path.resolve(source).toLowerCase()===path.resolve(out).toLowerCase())throw Error('Output must differ from original');
 fs.mkdirSync(old,{recursive:true});copyOnce(original,path.join(old,'manifest.json'));
 const manifest=JSON.parse(fs.readFileSync(original,'utf8'));
 const tracks=new Map(loadTracks(dir).map(t=>{return [t.id,t]})),checked=new Map<string,boolean>(),styles:any[]=[];
 for(const style of manifest.styles){if(!CREATIVE_TRANSITION_STYLES.some(s=>s.id===style.id))continue;const entries:any[]=[];for(const e of style.entries){
   if(path.basename(e.audio)!==e.audio)throw Error('Invalid original audio path');copyOnce(path.join(source,e.audio),path.join(old,e.audio));
   const a=tracks.get(e.plan.fromTrackId),b=tracks.get(e.plan.toTrackId);if(!a||!b||a.hash!==e.fromHash||b.hash!==e.toHash)throw Error(`Source mismatch: ${e.audio}`);
   for(const t of [a,b])if(!checked.has(t.hash))checked.set(t.hash,verified(t));if(!checked.get(a.hash)||!checked.get(b.hash))throw Error(`Source hash mismatch: ${e.audio}`);
   const before:Candidate={a,b,plan:e.plan,score:e.score,reasons:e.reasons};let oldDecks=null;try{oldDecks=diagnostics(before,ffmpeg)}catch{console.warn(`Old deck diagnostic unavailable: ${e.audio}`)}
   const plan=planCreativeTransition(pt(a),pt(b),DEFAULT_AUTOMIX_SETTINGS,style.id,e.plan.aExit+(e.plan.swapAt??0));let result:any={from:e.from,to:e.to,oldAudio:`old/${e.audio}`,oldPlan:e.plan,oldHandoffInClip:e.transitionStart+(e.plan.swapAt??e.plan.duration),oldDecks,newPlan:null,newAudio:null,newDecks:null};
   if(plan){try{const c:Candidate={a,b,plan,score:plan.debug.creative?.score??0,reasons:plan.reasons};const rendered=render(c,ffmpeg);const audio=`new-${e.audio}`,crop=handoffCropStart(rendered.r.transitionStartFrame,plan.swapAt??plan.duration,44100);fs.writeFileSync(path.join(out,audio),wav(rendered.r.L.subarray(crop),rendered.r.R.subarray(crop)));result={...result,newPlan:plan,newAudio:audio,cropSeconds:crop/44100,newHandoffInClip:(rendered.r.transitionStartFrame/44100+(plan.swapAt??plan.duration)-crop/44100),newDecks:diagnostics(c,ffmpeg),metrics:{...rendered.r.metrics,...rendered.check}}}catch{console.warn(`New render rejected: ${e.audio}`)}}
   entries.push(result);console.log(`${style.id} ${e.audio}: ${result.newAudio?'rendered':'unavailable'}`);
 }styles.push({id:style.id,name:style.name,entries})}
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({styles},null,2));
 const changes=(a:any,b:any)=>[['Выход A',a.aExit,b.aExit],['Вход B',a.bEntry,b.bEntry],['Длительность',a.duration,b.duration],['Задержка B',a.bDelay??0,b.bDelay??0],['Передача',a.aExit+(a.swapAt??0),b.aExit+(b.swapAt??0)]].filter(([,x,y])=>Math.abs(Number(x)-Number(y))>.001).map(([label,x,y])=>`${label}: ${Number(x).toFixed(2)} → ${Number(y).toFixed(2)} с`).join('; ')||'Время основных событий не изменилось';
 const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Сравнение переходов</title><style>body{font:16px/1.5 system-ui;max-width:70rem;margin:auto;padding:1rem;background:#10151d;color:#e8edf3}section{border-top:1px solid #536174;padding:1rem 0}article{border-top:1px solid #394758}audio{width:min(100%,32rem)}.pair{display:flex;flex-wrap:wrap;gap:2rem}.pair>div{flex:1;min-width:min(100%,20rem)}small{color:#bec9d8}</style><h1>Сравнение переходов</h1><p>Одни и те же записи; участки A могут различаться. Старые примеры сохранены без изменений. Новые обрезаны в начале, чтобы передача начиналась примерно на шестой секунде; громкость не менялась. Вокал отдельно не измерен. Звук запускается только вручную.</p>${styles.map(s=>`<section><h2>${esc(s.name)}</h2>${s.entries.map((e:any)=>`<article><h3>${esc(e.from)} → ${esc(e.to)}</h3><div class="pair"><div><h4>Было</h4><p>Выход A: ${e.oldPlan.aExit.toFixed(2)} с; вход B: ${e.oldPlan.bEntry.toFixed(2)} с; передача: ${(e.oldPlan.aExit+(e.oldPlan.swapAt??0)).toFixed(2)} с; длительность: ${e.oldPlan.duration.toFixed(2)} с.</p><p>Передача в файле: ${e.oldHandoffInClip.toFixed(2)} с.</p><audio controls preload="none" aria-label="Было: ${esc(e.from)} → ${esc(e.to)}" src="${esc(e.oldAudio)}"></audio></div><div><h4>Стало</h4>${e.newAudio?`<p>Выход A: ${e.newPlan.aExit.toFixed(2)} с; вход B: ${e.newPlan.bEntry.toFixed(2)} с; передача: ${(e.newPlan.aExit+(e.newPlan.swapAt??0)).toFixed(2)} с; длительность: ${e.newPlan.duration.toFixed(2)} с.</p><p>Изменения: ${esc(changes(e.oldPlan,e.newPlan))}.</p><p>${esc(e.newPlan.reasons.join('; '))}</p><p>Передача в файле: ${e.newHandoffInClip.toFixed(2)} с; обрезано в начале: ${e.cropSeconds.toFixed(2)} с.</p><audio controls preload="none" aria-label="Стало: ${esc(e.from)} → ${esc(e.to)}" src="${esc(e.newAudio)}"></audio>`:'<p>Подходящий новый план или проверенный рендер недоступен.</p>'}</div></div></article>`).join('')}</section>`).join('')}<script>document.addEventListener('play',e=>{if(e.target instanceof HTMLAudioElement)document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>`;
 fs.writeFileSync(path.join(out,'index.html'),html);
}
main();
