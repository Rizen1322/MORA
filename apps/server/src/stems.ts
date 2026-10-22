import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TrackAnalysis } from '@automix/core';
import { ROOT, type AppConfig } from './config.ts';
import type { EventHub } from './events.ts';
import type { Library, TrackRow } from './library.ts';
import { parseWhisperLyrics, type TimedLyricLine } from './lyrics.ts';
import { VocalCuda } from './vocal-cuda.ts';

export interface VocalMetadata {
  version: string; model: string; sampleRate: number; frames: number;
  device: string; seconds: number; activity: NonNullable<TrackAnalysis['vocalActivity']>;
  /** Absent on legacy caches (vocals.f32). vocals.s16 holds round(value*32768/scale). */
  storage?: { format: 's16le'; scale: number; file?: string };
  inference?: { version: string; segment: number; context: number; overlap: number; shifts: number };
  /** Wall-clock ms of this separation's queue/start/finish, for "ready N s before the transition". */
  prepared?: { queuedAt: number; startedAt: number; doneAt: number; priority: number };
}
const gcd=(a: number, b: number): number=>b?gcd(b,a%b):a;
const s16=(m: VocalMetadata)=>m.storage?.format==='s16le'&&Number.isFinite(m.storage.scale)&&m.storage.scale>=1;
const stemFile=(m: VocalMetadata)=>s16(m)?m.storage!.file??'vocals.s16':'vocals.f32';
const revisionOf=(m: VocalMetadata)=>`${stemFile(m)}:${m.storage?.scale??1}:${m.activity.revision??m.activity.version??'legacy'}`;
const ACTIVITY_VERSION='vocal-activity-2';
function validActivity(m: VocalMetadata): boolean {
  const a=m.activity;
  if(a?.source!=='demucs'||a.rate!==10||!Array.isArray(a.values)||!a.values.length
    ||!a.values.every(v=>Number.isFinite(v)&&v>=0&&v<=1))return false;
  if(a.revision!==undefined&&(typeof a.revision!=='string'||!/^[a-f\d]{24}$/.test(a.revision)))return false;
  // Legacy PCM remains usable. Strict extra measurements apply only to v2.
  if(a.version!==ACTIVITY_VERSION)return true;
  const n=Math.ceil(m.frames/4410),duration=m.frames/44100;
  if(a.values.length!==n)return false;
  for(const db of [a.vocalRmsDb,a.accompanimentRmsDb])
    if(!Array.isArray(db)||db.length!==n||!db.every(v=>Number.isFinite(v)&&v>=-120&&v<=60))return false;
  if(!Array.isArray(a.phrases))return false;
  let end=0;
  for(const phrase of a.phrases){
    if(!Number.isFinite(phrase.start)||!Number.isFinite(phrase.end)||phrase.start<end||phrase.end<=phrase.start
      ||phrase.end>duration+.001||!Number.isFinite(phrase.confidence)||phrase.confidence<0||phrase.confidence>1)return false;
    end=phrase.end;
  }
  return true;
}
const LYRICS_VERSION='whisper-words-1';
const MAX_LYRICS_BYTES=2*1024*1024;
type LyricTiming=NonNullable<NonNullable<TrackAnalysis['vocalActivity']>['lyrics']>;
/** Timing-only view of lyrics.json (the recognised text stays on disk); null when absent or invalid. */
function readLyrics(dir: string, duration: number): LyricTiming | null {
  try{
    const file=path.join(dir,'lyrics.json');if(fs.statSync(file).size>MAX_LYRICS_BYTES)return null;
    const raw=JSON.parse(fs.readFileSync(file,'utf8')) as {version?:string;language?:unknown;confidence?:unknown;words?:{start:number;end:number}[];lines?:{start:number;end:number}[];timing?:unknown;voiced?:unknown};
    const ok=(x:{start:number;end:number})=>Number.isFinite(x?.start)&&Number.isFinite(x?.end)&&x.start>=0&&x.end>=x.start&&x.end<=duration+1;
    if(raw.version!==LYRICS_VERSION||!Array.isArray(raw.words)||!Array.isArray(raw.lines)||!raw.words.every(ok)||!raw.lines.every(ok))return null;
    const pair=(x:{start:number;end:number})=>[x.start,x.end] as [number,number];
    return {version:raw.version,language:typeof raw.language==='string'?raw.language:null,
      confidence:typeof raw.confidence==='number'&&Number.isFinite(raw.confidence)?raw.confidence:0,words:raw.words.map(pair),lines:raw.lines.map(pair),
      // measured voice spans are kept only as a whole; the planner validates their order
      ...(typeof raw.timing==='string'&&Array.isArray(raw.voiced)&&raw.voiced.every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite))
        ?{timing:raw.timing,voiced:raw.voiced as [number,number][]}:{})};
  }catch{return null;}
}
interface QualityState {status:'queued'|'running'|'ready'|'error';progress?:number;error?:string;revision?:string}
interface VocalState { status: 'pending' | 'running' | 'ready' | 'error' | 'unavailable'; progress?: number; error?: string;quality?:QualityState }

/** Desktop pipes backend stdout into logs/automix.log: the only record of when a voice was prepared. */
const note=(line: string)=>console.log(`[stems] ${line}`);

/** One local GPU/CPU job at a time. Original audio and inference stay local. */
export class StemService {
  private states = new Map<string, VocalState>();
  private metadata = new Map<string, VocalMetadata>();
  private metadataStamps = new Map<string,string>();
  private history = new Map<string,Map<string,{metadata:VocalMetadata;until:number}>>();
  private quality = new Map<string,QualityState>();
  private queue = new Map<string, { track: TrackRow; priority: number; analyzeOnly: boolean; rebuild?:boolean; lyrics?:boolean; localOnly?:boolean; localInput?:string }>();
  /** Word timing (local Whisper on the separated voice): failures, backlog and the merged activity view. */
  private lyricsFailures = new Set<string>();
  private lyricsDisabled = false;
  private lyrics = new Map<string,{stamp:string;activity:NonNullable<TrackAnalysis['vocalActivity']>}>();
  private activityFailures = new Set<string>();
  private activityBacklog: TrackRow[] = [];
  private proc: ChildProcess | null = null;
  private spawnSeparation = spawn;
  /** Optional downloaded NVIDIA runtime; only next to the bundled desktop pack. */
  readonly cuda: VocalCuda | null;
  private stopped = false;
  private starting = false;
  private batchingFocus = false;
  private activeLyrics = false;
  private deferLyrics = false;
  private demos = new Set<string>();
  private timing = new Map<string,{queuedAt:number;priority:number;startedAt?:number;doneAt?:number;errorAt?:number}>();
  private activePriority = 0;
  private activeRebuild = false;
  private preempted = false;
  /** Playback demand replaces stale prefetch work; null means no playback focus yet. */
  private focusedHashes: Set<string> | null = null;
  private focusedLyricsHashes: Set<string> | null = null;
  private pins = new Map<string, number>();
  private lastUse = new Map<string, number>();
  /** Last resampled vocal ranges (at most 8 x 1 MiB). */
  private resampled = new Map<string, { meta: VocalMetadata; data: Promise<Buffer> }>();
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly root: string;

  constructor(private cfg: AppConfig, private lib: Library, private events: EventHub) {
    this.root=path.join(cfg.dataDir,'cache','stems');
    this.cuda=process.platform==='win32'&&cfg.stemsPython&&cfg.stemsModels?new VocalCuda(path.join(cfg.dataDir,'runtime','vocal-cuda'),cfg.stemsPython,cfg.stemsModels):null;
    fs.mkdirSync(this.root,{recursive:true});
    const examples=path.join(ROOT,'examples','library');
    if(fs.existsSync(examples)) for(const file of fs.readdirSync(examples).filter(f=>/\.(flac|mp3|wav)$/i.test(f))) {
      this.demos.add(crypto.createHash('sha256').update(fs.readFileSync(path.join(examples,file))).digest('hex'));
    }
  }

  private directory(hash: string): string {
    if(!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('некорректный хеш аудио');
    return path.join(this.root,hash,'hdemucs-v1');
  }

  get(hash: string): VocalMetadata | null {
    try {
      const dir=this.directory(hash);
      const stat=fs.statSync(path.join(dir,'metadata.json'));
      const stamp=`${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if(this.metadata.has(hash)&&this.metadataStamps.get(hash)===stamp)return this.metadata.get(hash)!;
      const m=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8')) as VocalMetadata;
      if(m.version!=='hdemucs-v1'||m.sampleRate!==44100||!Number.isSafeInteger(m.frames)||m.frames<1
        ||(m.storage?.file!==undefined&&(!s16(m)||!/^vocals-[a-f\d-]{36}\.s16$/i.test(m.storage.file)))
        ||fs.statSync(path.join(dir,stemFile(m))).size!==m.frames*(s16(m)?4:8)||!validActivity(m))return null;
      this.metadata.set(hash,m);this.metadataStamps.set(hash,stamp);this.states.set(hash,{status:'ready'});return m;
    }catch{return null;}
  }

  /** Vocal activity for the planner: metadata activity plus recognised word timing when present. */
  activity(hash: string): TrackAnalysis['vocalActivity'] {
    const m=this.get(hash);
    if(!m)return undefined;
    const dir=this.directory(hash);
    let stamp='';try{const st=fs.statSync(path.join(dir,'lyrics.json'));stamp=`${st.mtimeMs}:${st.size}`;}catch{/* no lyrics */}
    const key=`${stamp}|${m.activity.revision??''}`,cached=this.lyrics.get(hash);
    // the same object while nothing changed: the plan cache keys on it
    if(cached&&cached.stamp===key&&cached.activity.values===m.activity.values)return cached.activity;
    const lyrics=stamp?readLyrics(dir,m.frames/44100):null;
    const activity=lyrics?{...m.activity,lyrics}:m.activity;
    this.lyrics.set(hash,{stamp:key,activity});
    return activity;
  }

  /** Read-only access to an existing local Whisper transcript for the lyrics view. */
  wordLyrics(hash: string): TimedLyricLine[] | null {
    const meta=this.get(hash);
    if(!meta)return null;
    try {
      const file=path.join(this.directory(hash),'lyrics.json');if(fs.statSync(file).size>MAX_LYRICS_BYTES)return null;
      const raw=JSON.parse(fs.readFileSync(file,'utf8')) as unknown;
      return parseWhisperLyrics(raw,meta.frames/44100);
    } catch { return null; }
  }

  private needsLyrics(hash: string): boolean {
    if(this.lyricsDisabled||this.lyricsFailures.has(hash))return false;
    const m=this.get(hash);
    return !!m&&m.activity.version===ACTIVITY_VERSION&&!readLyrics(this.directory(hash),m.frames/44100);
  }

  status(hash: string): VocalState {
    const meta=this.get(hash);
    const quality=this.quality.get(hash)??(meta?.inference?.version==='context-overlap-2'?{status:'ready' as const,revision:meta.storage?.file??'context-overlap-2'}:undefined);
    if(meta)return {status:'ready',...(quality?{quality}:{})};
    if(this.demos.has(hash))return {status:'unavailable'};
    return this.states.get(hash)??{status:this.cfg.stemsPython?'pending':'unavailable'};
  }

  revision(hash: string, requested?:string): string | null {
    const meta=requested?this.selectedMetadata(hash,requested):this.get(hash);
    if(!meta)return null;
    return this.remember(hash,meta);
  }

  private remember(hash:string,meta:VocalMetadata):string {
    const revision=revisionOf(meta),now=Date.now();
    const history=this.history.get(hash)??new Map<string,{metadata:VocalMetadata;until:number}>();
    for(const [key,item] of history)if(item.until<now)history.delete(key);
    history.delete(revision);history.set(revision,{metadata:meta,until:now+10*60*1000});
    while(history.size>3)history.delete(history.keys().next().value!);
    this.history.set(hash,history);return revision;
  }

  private selectedMetadata(hash:string,revision?:string):VocalMetadata {
    const current=this.get(hash);
    if(current&&(!revision||revisionOf(current)===revision)){this.remember(hash,current);return current;}
    const historical=revision?this.history.get(hash)?.get(revision):undefined;
    if(historical&&historical.until>Date.now()){
      this.remember(hash,historical.metadata);return historical.metadata;
    }
    throw Object.assign(new Error(revision?'Эта версия вокальной партии больше недоступна':'вокальная партия ещё не готова'),{statusCode:409});
  }

  private pinnedFile(hash:string,file:string):boolean {
    return [...(this.history.get(hash)?.values()??[])].some(item=>item.until>Date.now()&&stemFile(item.metadata)===file);
  }

  supports(t: TrackRow): boolean {
    return ['local', 'yandex', 'youtube', 'soundcloud'].includes(t.provider) && !!this.lib.mixingPolicy.get(t.provider)
      && /^[a-f0-9]{64}$/i.test(t.content_hash);
  }

  /** Keep inference demand aligned with playback; callers pass candidates only when their audio is local. */
  focus(current?: TrackRow, next?: TrackRow, candidates: TrackRow[] = [], localInputs?: Map<string,string>): void {
    const previous=this.focusedHashes;
    const primary=[current,next].filter((t):t is TrackRow=>!!t);
    const priorities=new Map(primary.map((t,i)=>[t.content_hash,i===0?100:95]));
    const eligible=candidates.filter(t=>t.status==='ok'&&this.supports(t)&&!priorities.has(t.content_hash)
      &&(!localInputs||!!localInputs.get(t.content_hash)||!!this.get(t.content_hash))).slice(0,2);
    for(const t of eligible)priorities.set(t.content_hash,70);
    const focused=new Set(priorities.keys());
    this.focusedHashes=focused;
    // Rapid skips (dislike 250): a separation for a recording that is no longer current/next/candidate
    // held the only slot (download + inference) while the real current waited minutes.
    if(this.proc&&this.activeHash&&!focused.has(this.activeHash)&&!this.activeLyrics&&this.activePriority>0&&!this.activeRebuild){
      this.preempted=true;this.proc.kill?.('SIGTERM');
    }
    this.focusedLyricsHashes=new Set(primary.map(t=>t.content_hash));
    this.activityBacklog=this.activityBacklog.filter(t=>focused.has(t.content_hash));
    for(const [hash,item] of this.queue){
      const priority=priorities.get(hash);
      if(priority===undefined||item.lyrics&&priority<90
        ||priority===70&&localInputs&&!localInputs.get(hash)&&!item.rebuild)this.queue.delete(hash);
      else item.priority=priority;
    }
    const now=Date.now();
    for(const [hash,until] of this.pins)if(until<=now)this.pins.delete(hash);
    for(const hash of previous??[])if(!focused.has(hash)&&this.pins.has(hash))this.pins.set(hash,now+30_000);
    this.batchingFocus=true;
    try{
      if(current)this.ensure(current,100);
      if(next&&next.content_hash!==current?.content_hash)this.ensure(next,95);
      for(const t of eligible){
        const input=localInputs?.get(t.content_hash);
        if(localInputs&&!input)continue; // a ready cached candidate stays protected without source work
        this.ensure(t,70);
        const item=this.queue.get(t.content_hash);
        if(item&&input){item.localOnly=true;item.localInput=input;}
      }
    }finally{this.batchingFocus=false;}
    // Candidates never schedule Whisper; ensure() only requests lyrics at >=90.
    for(const hash of focused)if(!primary.some(t=>t.content_hash===hash))this.lastUse.set(hash,now);
    void this.pump();
  }

  ensure(t: TrackRow, priority=1): void {
    if(priority>=90){this.pins.set(t.content_hash,Date.now()+10*60*1000);this.lastUse.set(t.content_hash,Date.now());}
    if(this.stopped||!this.cfg.stemsPython||!this.supports(t)||t.status!=='ok'||this.demos.has(t.content_hash))return;
    const cached=this.get(t.content_hash);
    if(cached&&(cached.activity.version===ACTIVITY_VERSION||this.activityFailures.has(t.content_hash))){
      // word timing is an optional later pass over the ready voice; it never blocks playback
      const queued=this.queue.get(t.content_hash);
      if(priority>=90&&this.needsLyrics(t.content_hash)&&this.activeHash!==t.content_hash&&(!queued||queued.lyrics)){
        this.queue.set(t.content_hash,{track:t,priority:Math.max(priority,this.queue.get(t.content_hash)?.priority??0),analyzeOnly:false,lyrics:true});
        void this.pump();
      }
      return;
    }
    const state=this.states.get(t.content_hash);
    if(state?.status==='running')return;
    // A failed separation (often a source fetch) used to stay failed for the whole session:
    // current/next retry it after a minute.
    if(state?.status==='error'&&(priority<90||Date.now()-(this.timing.get(t.content_hash)?.errorAt??0)<60_000))return;
    // get() marks usable caches ready, so a separate queue check also guards upgrades.
    if(this.proc&&this.activeHash===t.content_hash)return;
    if(!this.queue.has(t.content_hash)&&!cached){
      this.timing.set(t.content_hash,{queuedAt:Date.now(),priority});
      note(`queued ${t.content_hash.slice(0,8)} p=${priority} "${t.title}"`);
    }
    this.queue.set(t.content_hash,{track:t,priority:Math.max(priority,this.queue.get(t.content_hash)?.priority??0),analyzeOnly:!!cached});
    if(!cached)this.states.set(t.content_hash,{status:'pending'});
    // A candidate (<90) separation must not hold the only slot while current/next wait up to ~30 s.
    if(priority>=90&&this.proc&&!this.activeLyrics&&this.activePriority<90&&this.activeHash!==t.content_hash){
      this.preempted=true;this.proc.kill?.('SIGTERM');
    }
    // Optional word recognition must yield the only inference slot to the
    // current/next recording's missing voice, without poisoning its retry state.
    if(priority>=90&&this.activeLyrics){this.deferLyrics=true;this.proc?.kill?.('SIGTERM');}
    void this.pump();
  }

  /** Explicit quality upgrade. Existing audio remains readable until atomic publish. */
  rebuild(t: TrackRow,priority=100): VocalState {
    if(this.stopped||!this.cfg.stemsPython||!this.supports(t)||t.status!=='ok'||this.demos.has(t.content_hash))
      throw Object.assign(new Error('Улучшение вокальной партии сейчас недоступно'),{statusCode:409});
    const cached=this.get(t.content_hash);
    if(cached?.inference?.version==='context-overlap-2')return this.status(t.content_hash);
    if(this.activeHash===t.content_hash||this.queue.get(t.content_hash)?.rebuild)return this.status(t.content_hash);
    if(!cached){this.ensure(t,priority);return this.status(t.content_hash);}
    this.quality.set(t.content_hash,{status:'queued'});
    this.queue.set(t.content_hash,{track:t,priority,analyzeOnly:false,rebuild:true});
    void this.pump();return this.status(t.content_hash);
  }

  private activeHash: string | null = null;

  start(): void {
    // One subprocess globally, at most four background upgrades queued. Finish
    // compaction first so metadata-only analysis cannot race our own storage switch.
    this.starting=true;
    void this.compactAll().catch(()=>0).finally(()=>{
      this.starting=false;
      if(this.stopped)return;
      // Allow restored current/next decks to pin their files before cold LRU cleanup.
      this.cacheTimer=setTimeout(()=>{this.cacheTimer=null;void this.prune().catch(()=>{});},30_000);
      this.cacheTimer.unref?.();
      const tracks=this.lib.all();
      this.activityBacklog=tracks.filter(t=>this.get(t.content_hash)?.activity.version!==ACTIVITY_VERSION&&!!this.get(t.content_hash));
      // Word recognition is requested by current/next playback only. Opening a
      // library must not start Whisper over every cached vocal in the profile.
      // New separations are requested by playback preparation (current + next),
      // not by merely opening a large library. Ready cache upgrades remain bounded.
      this.fillActivityQueue();
      void this.pump();
    });
  }

  private fillActivityQueue(): void {
    if(this.stopped||!this.cfg.stemsPython||this.focusedHashes!==null)return;
    while(this.activityBacklog.length&&[...this.queue.values()].filter(t=>t.analyzeOnly).length<4){
      const t=this.activityBacklog.shift()!;
      this.ensure(t,0);
    }
  }

  /** All parties, one at a time; a failure keeps that party in f32. */
  async compactAll(dropLegacy=true): Promise<number> {
    let done=0;
    for(const hash of fs.readdirSync(this.root).filter(v=>/^[a-f0-9]{64}$/i.test(v))){
      if(this.stopped)break;
      if(await this.compact(hash,dropLegacy).catch(()=>false))done++;
    }
    return done;
  }

  /**
   * f32 → peak-scaled s16 (half the size). Quantization residual, which the
   * vocal mask leaves in the accompaniment, measured on the library: ≤ −98 dBFS
   * RMS, ≤ −93.6 dBFS peak. The s16 file is written, read back and checked
   * before metadata switches to it; legacy files go only once get() serves the
   * s16. dropLegacy=false keeps them for a still-running older server, which
   * reads only vocals.f32; the next compactAll() of a current server drops them.
   * Returns whether this call converted the party.
   */
  async compact(hash: string, dropLegacy=true): Promise<boolean> {
    const meta=this.get(hash);
    if(!meta)return false;
    const dir=this.directory(hash),converted=!s16(meta)&&await this.convert(hash,dir,meta);
    if(dropLegacy&&s16(this.get(hash)??meta))
      for(const f of await fsp.readdir(dir))if((f==='vocals.f32'||/^vocals_\d+\.f32(\.part)?$/.test(f))&&!this.pinnedFile(hash,f))await fsp.rm(path.join(dir,f),{force:true});
    return converted;
  }

  private async convert(hash: string, dir: string, meta: VocalMetadata): Promise<boolean> {
    const part=path.join(dir,`vocals.s16.${process.pid}.part`);
    for(const f of await fsp.readdir(dir)){
      const file=path.join(dir,f);
      // parts of a crashed run; a live writer in another process finishes in seconds
      if(/^vocals\.s16\.\d+\.part$/.test(f)&&Date.now()-(await fsp.stat(file)).mtimeMs>3600_000)await fsp.rm(file,{force:true});
    }
    const srcFile=path.join(dir,stemFile(meta)),total=meta.frames*8;
    if((await fsp.stat(srcFile)).size!==total)return false;
    // 1 MiB of f32 per step: memory stays flat and the event loop runs between reads.
    const BLOCK=1<<20,f32=Buffer.alloc(BLOCK),i16=Buffer.alloc(BLOCK/2);
    const read=async(fh:fsp.FileHandle,buf:Buffer,pos:number,len:number)=>{let n=0;while(n<len){const {bytesRead}=await fh.read(buf,n,len-n,pos+n);if(!bytesRead)throw new Error('16-битная партия обрезана');n+=bytesRead;}};
    const src=await fsp.open(srcFile,'r');
    try{
      let peak=0;
      for(let pos=0;pos<total;pos+=BLOCK){const len=Math.min(BLOCK,total-pos);await read(src,f32,pos,len);for(let i=0;i<len;i+=4)peak=Math.max(peak,Math.abs(f32.readFloatLE(i)));}
      if(!Number.isFinite(peak))return false;
      const scale=Math.max(1,peak*32768/32767);
      try{
        const out=await fsp.open(part,'w');
        try{
          for(let pos=0;pos<total;pos+=BLOCK){
            const len=Math.min(BLOCK,total-pos);await read(src,f32,pos,len);
            for(let i=0;i<len/2;i+=2)i16.writeInt16LE(Math.round(f32.readFloatLE(i*2)*32768/scale),i);
            await out.write(i16,0,len/2);
          }
        }finally{await out.close();}
        const back=await fsp.open(part,'r');
        try{
          if((await back.stat()).size!==total/2)throw new Error('16-битная партия обрезана');
          for(let pos=0;pos<total;pos+=BLOCK){
            const len=Math.min(BLOCK,total-pos);await read(src,f32,pos,len);await read(back,i16,pos/2,len/2);
            for(let i=0;i<len/2;i+=2)if(Math.abs(i16.readInt16LE(i)*scale/32768-f32.readFloatLE(i*2))>scale/65536*1.001)throw new Error('проверка 16-битной партии не прошла');
          }
        }finally{await back.close();}
        await fsp.rename(part,path.join(dir,'vocals.s16'));
        await this.writeMetadata(dir,part,JSON.stringify({...meta,storage:{format:'s16le',scale}}));
      }finally{await fsp.rm(part,{force:true});}
    }finally{await src.close();}
    this.metadata.delete(hash);
    const now=this.get(hash);
    if(!now||!s16(now)){
      // keep serving the untouched f32
      await this.writeMetadata(dir,part,JSON.stringify(meta));this.metadata.delete(hash);
      throw new Error('16-битная партия не прошла проверку кэша');
    }
    return true;
  }

  private async writeMetadata(dir: string, part: string, json: string): Promise<void> {
    try{await fsp.writeFile(`${part}.json`,json);await fsp.rename(`${part}.json`,path.join(dir,'metadata.json'));}
    finally{await fsp.rm(`${part}.json`,{force:true});}
  }

  /** Readiness of a recording's voice at `at`: how long ago it became ready, or how long it has waited. */
  readiness(hash: string, at = Date.now()): { status: VocalState['status']; readyAgoS?: number; waitedS?: number; error?: string } {
    const meta=this.get(hash),tm=this.timing.get(hash),s1=(ms:number)=>Math.round(ms/100)/10;
    if(meta){const done=meta.prepared?.doneAt??tm?.doneAt;return {status:'ready',...(done?{readyAgoS:s1(at-done)}:{})};}
    const state=this.status(hash);
    return {status:state.status,...(tm?{waitedS:s1(at-tm.queuedAt)}:{}),...(state.error?{error:state.error.slice(0,200)}:{})};
  }

  stats() {
    return { available:!!this.cfg.stemsPython, model:'HDEMUCS_HIGH_MUSDB_PLUS',
      runtime: this.cfg.stemsPython ? this.cfg.stemsModels ? 'bundled-cpu' : 'external' : null,
      ...(this.cuda?{gpu:this.cuda.status()}:{}),
      running:[...this.states].filter(([,s])=>s.status==='running').map(([hash,s])=>({hash,...s})),
      queued:this.queue.size,ready:[...this.metadata].length,errors:[...this.states.values()].filter(s=>s.status==='error').length,
      activityVersion:ACTIVITY_VERSION,activityQueued:this.activityBacklog.length+[...this.queue.values()].filter(t=>t.analyzeOnly).length,
      activityUpgrading:this.activeHash!==null&&!!this.get(this.activeHash),activityErrors:this.activityFailures.size,
      lyricsVersion:LYRICS_VERSION,lyricsAvailable:!this.lyricsDisabled,lyricsQueued:[...this.queue.values()].filter(t=>t.lyrics).length,lyricsErrors:this.lyricsFailures.size };
  }

  private async pump(): Promise<void> {
    if(this.proc||this.starting||this.batchingFocus||this.stopped||!this.queue.size||!this.cfg.stemsPython)return;
    const item=[...this.queue.values()].sort((a,b)=>Number(!!a.lyrics)-Number(!!b.lyrics)||b.priority-a.priority)[0];
    const t=item.track;this.queue.delete(t.content_hash);this.activeHash=t.content_hash;this.activePriority=item.priority;this.activeRebuild=!!item.rebuild;
    const separating=!item.lyrics&&!item.analyzeOnly&&!item.rebuild,startedAt=Date.now();
    if(separating){
      const tm=this.timing.get(t.content_hash)??{queuedAt:startedAt,priority:item.priority};
      this.timing.set(t.content_hash,{...tm,startedAt});
      note(`start ${t.content_hash.slice(0,8)} p=${item.priority} waited=${((startedAt-tm.queuedAt)/1000).toFixed(1)}s "${t.title}"`);
    }
    if(item.localOnly&&(!item.localInput||!fs.existsSync(item.localInput))){this.activeHash=null;void this.pump();return;}
    if(item.rebuild)this.quality.set(t.content_hash,{status:'running',progress:0});
    else if(!item.analyzeOnly&&!item.lyrics)this.states.set(t.content_hash,{status:'running',progress:0});
    // Hold the queue before the asynchronous source lookup too.
    const marker={} as ChildProcess;this.proc=marker;
    let staging:string|null=null,cudaPython:string|null=null,modelStarted=false;
    try {
      if(item.lyrics){
        this.activeLyrics=true;this.deferLyrics=false;
        // reads only the ready local voice: no source fetch; PCM and metadata are never written
        const dir=this.directory(t.content_hash);
        const proc=this.spawnSeparation(this.cfg.stemsPython,[path.join(ROOT,'tools','transcribe-vocals.py'),'--stem-dir',dir,'--output',path.join(dir,'lyrics.json')],
          {windowsHide:true,stdio:['ignore','pipe','pipe']});
        this.proc=proc;
        let out='';
        proc.stdout!.on('data',(b:Buffer)=>{out=(out+b.toString()).slice(-4000);});
        proc.stderr!.on('data',(b:Buffer)=>{out=(out+b.toString()).slice(-4000);});
        const code=await new Promise<number|null>((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve);});
        if(this.stopped)return;
        if(this.deferLyrics){
          if((this.focusedHashes===null||this.focusedHashes.has(t.content_hash))
            &&(this.focusedLyricsHashes===null||this.focusedLyricsHashes.has(t.content_hash))&&!this.queue.has(t.content_hash))this.queue.set(t.content_hash,item);
          return;
        }
        if(code!==0){
          // no local model or package: stop the backlog instead of failing every track
          if(/whisper model missing|No module named .?whisper/.test(out))this.lyricsDisabled=true;
          throw new Error(out.trim().slice(-500)||`распознавание слов завершилось с кодом ${code}`);
        }
        this.events.emit({type:'lyrics',trackId:t.id,hash:t.content_hash});
        return;
      }
      const input=item.localOnly?item.localInput!:await this.lib.resolveMediaPath(t.id);
      if(this.stopped)return;
      // A public recording can obtain a new verified hash during this fetch.
      // Never publish its voice under the old content's cache key.
      const current=this.lib.get?.(t.id);
      if(current && current.content_hash!==t.content_hash){this.ensure(current,item.priority);return;}
      if(this.preempted)throw new Error('preempted');
      if(item.rebuild)staging=path.join(this.root,'staging',crypto.randomUUID());
      const dir=staging?path.join(staging,'cache','stems',t.content_hash,'hdemucs-v1'):this.directory(t.content_hash);
      // Activity-only jobs never load torch; the CPU pack serves them.
      cudaPython=item.analyzeOnly?null:this.cuda?.python()??null;
      // The desktop packs run shifts=1 on every device: CUDA then matches CPU (docs/cuda-runtime-2026-10-22.md).
      const proc=this.spawnSeparation(cudaPython??this.cfg.stemsPython,[path.join(ROOT,'tools','separate-vocals.py'),'--input',input,'--output',dir,'--ffmpeg',this.cfg.ffmpeg,...(item.analyzeOnly?['--analyze-only']:this.cfg.stemsModels?['--shifts','1']:[])],
        {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TORCH_HOME:this.cfg.stemsModels||path.join(this.cfg.dataDir,'cache','models'),PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}});
      this.proc=proc;
      let pending='',stderr='';
      proc.stdout!.on('data',(chunk:Buffer)=>{
        pending+=chunk.toString();let newline:number;
        while((newline=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,newline);pending=pending.slice(newline+1);
          try {
            const msg=JSON.parse(line) as {type:string;progress?:number;message?:string;stage?:string};
            if(msg.type==='progress'){
              if(msg.stage==='model')modelStarted=true;
              if(item.rebuild)this.quality.set(t.content_hash,{status:'running',progress:msg.progress??0});
              else if(!item.analyzeOnly)this.states.set(t.content_hash,{status:'running',progress:msg.progress??0});
            }
            if(msg.type==='error')stderr=msg.message??'ошибка разделения';
          }catch{/* non-protocol stdout cannot change status */}
        }
      });
      proc.stderr!.on('data',(b:Buffer)=>{stderr=(stderr+b.toString()).slice(-3000);});
      const code=await new Promise<number|null>((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve);});
      if(this.stopped)return;
      if(code!==0)throw new Error(stderr.trim().slice(-700)||`разделение завершилось с кодом ${code}`);
      if(staging){
        const prepared=new StemService({...this.cfg,dataDir:staging,stemsPython:null},this.lib,this.events);
        try{
          if(!prepared.get(t.content_hash))throw new Error('Новая партия не прошла проверку');
          await prepared.compact(t.content_hash);
          const meta=prepared.get(t.content_hash)!;
          if(!s16(meta)||meta.inference?.version!=='context-overlap-2')throw new Error('Новая партия не готова к публикации');
          const target=this.directory(t.content_hash),file=`vocals-${crypto.randomUUID()}.s16`;
          await fsp.rename(path.join(dir,stemFile(meta)),path.join(target,file));
          await this.writeMetadata(target,path.join(target,`quality.${process.pid}.part`),JSON.stringify({...meta,storage:{...meta.storage!,file}}));
        }finally{prepared.stop();}
        this.quality.set(t.content_hash,{status:'ready',revision:JSON.parse(await fsp.readFile(path.join(this.directory(t.content_hash),'metadata.json'),'utf8')).storage.file});
      }
      this.metadata.delete(t.content_hash);
      if(!this.get(t.content_hash))throw new Error('результат разделения не прошёл проверку');
      if(!item.analyzeOnly&&!item.rebuild)await this.compact(t.content_hash).catch(()=>{/* the verified f32 stays usable */});
      if(separating){
        const tm=this.timing.get(t.content_hash),doneAt=Date.now(),dir=this.directory(t.content_hash),meta=this.get(t.content_hash);
        this.timing.set(t.content_hash,{queuedAt:tm?.queuedAt??startedAt,priority:item.priority,startedAt,doneAt});
        if(meta)await this.writeMetadata(dir,path.join(dir,`prepared.${process.pid}.part`),JSON.stringify({...meta,
          prepared:{queuedAt:tm?.queuedAt??startedAt,startedAt,doneAt,priority:item.priority}})).then(()=>this.metadata.delete(t.content_hash),()=>{});
        note(`done ${t.content_hash.slice(0,8)} separation=${((doneAt-startedAt)/1000).toFixed(1)}s total=${((doneAt-(tm?.queuedAt??startedAt))/1000).toFixed(1)}s "${t.title}"`);
      }
      // Local and imported aliases share the same content-addressed PCM. Notify
      // every library identity so a playing alias also drops its prepared cache.
      const revision=this.revision(t.content_hash)!;
      const aliases=new Set([t.id,...this.lib.all().filter(track=>track.content_hash===t.content_hash).map(track=>track.id)]);
      for(const trackId of aliases)this.events.emit({type:'analysis',trackId,hash:t.content_hash,status:'done',asset:'vocals',revision});
      await this.prune();
    }catch(e){
      if(cudaPython&&!modelStarted&&!this.preempted&&!this.stopped){
        // torch could not even start (broken or partial download): the same job goes to the CPU pack
        this.cuda!.markBroken((e as Error).message);
        this.queue.set(t.content_hash,item);
        if(separating)this.states.set(t.content_hash,{status:'pending'});
        note(`cuda runtime failed, using CPU: ${(e as Error).message.replace(/\s+/g,' ').slice(0,300)}`);
      }else if(this.preempted&&!this.stopped){
        // back in the queue at its own priority if it is still wanted; partial output is rewritten
        if(this.focusedHashes===null||this.focusedHashes.has(t.content_hash))this.queue.set(t.content_hash,item);
        if(separating)this.states.set(t.content_hash,{status:'pending'});
        note(`preempted ${t.content_hash.slice(0,8)} p=${item.priority}${this.queue.has(t.content_hash)?' for current/next':': no longer playing soon'}`);
      }else if(!this.stopped&&!this.deferLyrics&&!item.localOnly){
        if(separating){
          const tm=this.timing.get(t.content_hash);if(tm)this.timing.set(t.content_hash,{...tm,errorAt:Date.now()});
          note(`error ${t.content_hash.slice(0,8)} "${t.title}": ${(e as Error).message.replace(/\s+/g,' ').slice(0,300)}`);
        }
        if(item.lyrics)this.lyricsFailures.add(t.content_hash); // the voice and its activity stay ready
        else if(item.rebuild)this.quality.set(t.content_hash,{status:'error',error:(e as Error).message});
        else if(item.analyzeOnly)this.activityFailures.add(t.content_hash); // old PCM and activity stay ready
        else this.states.set(t.content_hash,{status:'error',error:(e as Error).message});
      }
    }finally{
      if(staging&&path.dirname(staging)===path.join(this.root,'staging'))await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{});
      this.proc=null;this.activeHash=null;this.activeLyrics=false;this.deferLyrics=false;this.preempted=false;this.activePriority=0;this.activeRebuild=false;if(!this.stopped){this.fillActivityQueue();void this.pump();}
    }
  }

  async read(hash: string, sr: number, start: number, frames: number, revision?:string): Promise<Buffer> {
    this.pins.set(hash,Date.now()+10*60*1000);
    const selected=this.selectedMetadata(hash,revision),pinned=this.remember(hash,selected);
    if(sr===44100)return this.readNative(hash,start,frames,true,pinned);
    // A plan refresh asks for the same startup chunks again; the metadata object changes with every new generation.
    const key=`${hash}|${sr}|${start}|${frames}`,hit=this.resampled.get(key);
    if(hit?.meta===selected){this.resampled.delete(key);this.resampled.set(key,hit);return hit.data;}
    const data=this.resample(hash,sr,start,frames,pinned);
    if(frames<=1<<17){
      this.resampled.delete(key);this.resampled.set(key,{meta:selected,data});
      while(this.resampled.size>8)this.resampled.delete(this.resampled.keys().next().value!);
      data.catch(()=>{if(this.resampled.get(key)?.data===data)this.resampled.delete(key);});
    }
    return data;
  }

  private async resample(hash: string, sr: number, start: number, frames: number, pinned: string): Promise<Buffer> {
    // No resampled copy on disk: ffmpeg resamples a range aligned to whole resampler
    // periods with a margin, which is bit-identical to resampling the whole file.
    const g=gcd(44100,sr),inStep=44100/g,outStep=sr/g,margin=4410;
    const s0=Math.max(0,Math.floor((Math.floor(start*44100/sr)-margin)/inStep)*inStep);
    const s1=Math.ceil((Math.ceil((start+frames)*44100/sr)+margin)/inStep)*inStep;
    const input=this.readNative(hash,s0,s1-s0,true,pinned);
    if(!input.length)return input;
    const proc=spawn(this.cfg.ffmpeg,['-v','error','-nostdin','-f','f32le','-ar','44100','-ac','2','-i','pipe:0','-ar',String(sr),'-ac','2','-f','f32le','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    const chunks:Buffer[]=[];proc.stdout!.on('data',(b:Buffer)=>chunks.push(b));
    proc.stdin!.on('error',()=>{/* exit code reports the failure */});proc.stdin!.end(input);
    await new Promise<void>((resolve,reject)=>{proc.once('error',reject);proc.once('close',code=>code===0?resolve():reject(new Error('не удалось подготовить частоту вокала')));});
    const from=(start-s0/inStep*outStep)*8;
    return Buffer.concat(chunks).subarray(from,from+frames*8);
  }

  /** Stereo f32le at 44.1 kHz from either cache format. */
  readNative(hash: string, start: number, frames: number, retry=true, revision?:string): Buffer {
    const meta=this.selectedMetadata(hash,revision);
    const small=s16(meta),width=small?4:8,count=Math.max(0,Math.min(frames,meta.frames-start));
    let raw:Buffer;
    try{
      const fd=fs.openSync(path.join(this.directory(hash),stemFile(meta)),'r');
      try{raw=Buffer.alloc(count*width);raw=raw.subarray(0,fs.readSync(fd,raw,0,raw.length,start*width));}finally{fs.closeSync(fd);}
    }catch(e){
      // another process compacted this party after we cached its metadata
      if(retry&&!small&&!revision&&(e as NodeJS.ErrnoException).code==='ENOENT'){this.metadata.delete(hash);return this.readNative(hash,start,frames,false);}
      throw e;
    }
    if(!small)return raw;
    const out=Buffer.alloc(raw.length*2),k=meta.storage!.scale/32768;
    for(let i=0;i<raw.length;i+=2)out.writeFloatLE(raw.readInt16LE(i)*k,i*2);
    return out;
  }

  /**
   * Generated cache only; originals and model weights are never removed.
   * LRU for generated stems, separately from source audio. Keep active revisions,
   * current/next tracks and explicitly offline recordings; saved metadata alone
   * must not turn a large library into an unlimited generated-audio archive.
   */
  private async prune(): Promise<void> {
    const root=fs.realpathSync(this.root).toLowerCase();
    const tracks=this.lib.all(), library=new Set(tracks.map(t=>t.content_hash));
    const offline=new Set(tracks.filter(t=>t.pinned).flatMap(t=>[t.content_hash,this.lib.media?.(t.id)?.content_hash??t.content_hash]));
    const entries:{hash:string;dir:string;bytes:number;modified:number}[]=[];
    for(const hash of fs.readdirSync(this.root).filter(v=>/^[a-f0-9]{64}$/i.test(v))){
      const dir=this.directory(hash);
      if(!fs.existsSync(dir))continue;
      const real=fs.realpathSync(dir).toLowerCase();
      if(!real.startsWith(root+path.sep.toLowerCase()))continue;
      let bytes=0,modified=0;
      for(const file of fs.readdirSync(dir)){
        const stat=fs.statSync(path.join(dir,file));if(!stat.isFile())continue;
        bytes+=stat.size;modified=Math.max(modified,stat.mtimeMs);
      }
      entries.push({hash,dir,bytes,modified});
    }
    let total=entries.reduce((sum,e)=>sum+e.bytes,0);
    const busy=(hash:string)=>this.activeHash===hash||this.focusedHashes?.has(hash)||(this.pins.get(hash)??0)>Date.now()||this.states.get(hash)?.status==='running'
      ||[...(this.history.get(hash)?.values()??[])].some(item=>item.until>Date.now());
    const limit=this.cfg.stemsCacheBytes??2048*1024*1024;
    for(const entry of entries.filter(e=>!offline.has(e.hash)&&!busy(e.hash)).sort((a,b)=>Number(library.has(a.hash))-Number(library.has(b.hash))||
      (this.lastUse.get(a.hash)??a.modified)-(this.lastUse.get(b.hash)??b.modified))){
      if(total<=limit)return;
      if(busy(entry.hash))continue;
      // Both the canonical root and generated target were verified above.
      await fsp.rm(entry.dir,{recursive:true,force:true});
      this.metadata.delete(entry.hash);this.states.delete(entry.hash);this.history.delete(entry.hash);this.lastUse.delete(entry.hash);
      this.lyrics.delete(entry.hash);this.quality.delete(entry.hash);this.pins.delete(entry.hash);
      total-=entry.bytes;
    }
  }

  stop(): void {this.stopped=true;if(this.cacheTimer)clearTimeout(this.cacheTimer);this.cacheTimer=null;this.queue.clear();this.activityBacklog=[];this.proc?.kill?.('SIGKILL');}
}
