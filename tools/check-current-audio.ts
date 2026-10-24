import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { MixerCore, CHUNK_FRAMES, LoudnessMeter } from '../packages/core/src/index.ts';
import { loadConfig } from '../apps/server/src/config.ts';
const cfg=loadConfig(), root='http://localhost:4730';
const queue=await(await fetch(root+'/api/queue')).json();
const id=queue.items[queue.index].trackId, track=await(await fetch(root+'/api/tracks/'+id)).json();
const settings=await(await fetch(root+'/api/settings')).json();
const db=new DatabaseSync(path.resolve('data-dev/automix.sqlite'),{readOnly:true});
const source=db.prepare("SELECT provider,meta FROM track_sources WHERE track_id=? AND kind='remote'").get(id) as {provider:string;meta:string};db.close();
const meta=JSON.parse(source.meta), file=path.resolve('data-dev/remote',source.provider,`${meta.audioHash}${meta.ext}`);
const reference=execFileSync(cfg.ffmpeg,['-v','error','-nostdin','-i',file,'-vn','-ar','48000','-ac','2','-f','f32le','pipe:1'],{windowsHide:true,maxBuffer:256*1024*1024});
let squares=0,error=0,maxError=0,nonfinite=0,sourceOver=0,peak=0;
const n=Math.floor(reference.length/8);
for(let start=0;start<n;start+=1<<19){
  const response=await fetch(`${root}/api/tracks/${id}/pcm?sr=48000&start=${start}&frames=${Math.min(1<<19,n-start)}&format=f32le`);
  if(!response.ok)throw new Error(`PCM ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  for(let i=0;i<bytes.length/4;i++){
    const a=reference.readFloatLE(start*8+i*4),b=bytes.readFloatLE(i*4),d=a-b;
    if(!Number.isFinite(b))nonfinite++;squares+=a*a;error+=d*d;maxError=Math.max(maxError,Math.abs(d));peak=Math.max(peak,Math.abs(a));if(Math.abs(a)>=1)sourceOver++;
  }
}
const begin=Math.max(0,Math.floor(queue.position)-12),length=Math.min(24,track.duration-begin),frames=Math.floor(length*48000);
const L=Float32Array.from({length:frames},(_,i)=>reference.readFloatLE((begin*48000+i)*8)),R=Float32Array.from({length:frames},(_,i)=>reference.readFloatLE((begin*48000+i)*8+4));
const target=settings.automix.loudnessTarget;
const gain=target===null?0:Math.max(-18,Math.min(12,target-track.analysis.lufs,-1-track.analysis.truePeak+3));
let underruns=0;
const mixer=new MixerCore(48000,e=>{if(e.type==='underrun')underruns++;if(e.type==='need')for(const c of e.chunks)mixer.feed(e.deck,e.token,c,L.slice(c*CHUNK_FRAMES,(c+1)*CHUNK_FRAMES),R.slice(c*CHUNK_FRAMES,(c+1)*CHUNK_FRAMES));});
mixer.setTone(settings.sound.tone);mixer.setPlayback(settings.sound.playback);mixer.setVolume(queue.volume??1);mixer.load(0,'check',frames,gain);mixer.start(0,'check',0);
const outL=L.slice(),outR=R.slice();for(let i=0;i<frames;i+=128)mixer.process(outL.subarray(i,i+128),outR.subarray(i,i+128),Math.min(128,frames-i));
const meter=new LoudnessMeter(48000);meter.push([outL,outR]);
const report={track:track.title,artist:track.artist,position:queue.position,sourceSamplePeak:peak,sourceOver,cacheMaxError:maxError,cacheSnrDb:error?10*Math.log10(squares/error):'identical',nonfinite,targetLUFS:target,gainDb:gain,output:meter.result(),limiter:mixer.getMetering(),underruns};
const out=path.resolve('tools/.cache/current-audio-0.3.1');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
