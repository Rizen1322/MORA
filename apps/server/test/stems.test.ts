import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, analyzePcm } from '@automix/core';
import { createApp } from '../src/app.ts';
import { kvGet, kvSet, q } from '../src/db.ts';
import { StemService, type VocalMetadata } from '../src/stems.ts';
import { EventHub, type ServerEvent } from '../src/events.ts';
import type { Library } from '../src/library.ts';

type App = Awaited<ReturnType<typeof createApp>>;
const hashFor = (name: string) => crypto.createHash('sha256').update(`stem-test-${name}`).digest('hex');

describe('local separated vocal cache and PCM API', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-stems-'));
  let a: App;
  const samples = [1.25, -1.5, 0.25, -0.75, -0.5, 0.875, 0, 0, 0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];
  const pcm = Buffer.alloc(samples.length * 4);
  samples.forEach((value, i) => pcm.writeFloatLE(value, i * 4));

  function seed(name: string, patch: Record<string, unknown> = {}, audio = pcm): string {
    const hash = hashFor(name);
    const dir = path.join(dataDir, 'cache', 'stems', hash, 'hdemucs-v1');
    fs.mkdirSync(dir, { recursive: true });
    const metadata: VocalMetadata = {
      version: 'hdemucs-v1', model: 'HDEMUCS_HIGH_MUSDB_PLUS', sampleRate: 44100, frames: audio.length / 8,
      device: 'test-cache', seconds: 0, activity: { source: 'demucs', model: 'HDEMUCS_HIGH_MUSDB_PLUS', rate: 10, values: [0.7] },
    };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ ...metadata, ...patch }));
    fs.writeFileSync(path.join(dir, 'vocals.f32'), audio);
    return hash;
  }

  function track(id: string, hash: string, provider = 'local') {
    q(a.services.db, 'INSERT INTO tracks(id, content_hash, title, duration, provider, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, hash, id, 3, provider, Date.now(), Date.now());
  }

  beforeAll(async () => {
    // Explicitly disable local Python even if the developer's .env enables CUDA.
    a = await createApp({ dataDir, stemsPython: null, port: 0, analysisWorkers: 1 }, { startWorkers: false });
    track('ready', seed('ready'));
    track('unavailable', hashFor('unavailable'));
    track('restricted', hashFor('ready'), 'spotify');
    track('cache-a', hashFor('cache-a'));
    track('cache-b', hashFor('cache-b'));
  });

  afterAll(async () => {
    await a?.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-stems-')) {
      throw new Error('test cleanup target is outside its temporary workspace');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('serves cached stereo f32 without clipping or reducing to 16 bit while Python is disabled', async () => {
    expect(a.services.stems.stats().available).toBe(false);
    const status = await a.app.inject('/api/tracks/ready/stems');
    expect(status.json()).toEqual({ status: 'ready', model: 'HDEMUCS_HIGH_MUSDB_PLUS' });
    const response = await a.app.inject('/api/tracks/ready/vocals/pcm?sr=44100&start=0&frames=8');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-pcm-format']).toBe('f32le');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-automix-vocal-revision']).toBe(a.services.stems.revision(hashFor('ready')));
    expect(response.rawPayload.equals(pcm)).toBe(true);
    expect(response.rawPayload.readFloatLE(0)).toBe(1.25);
    expect(response.rawPayload.readFloatLE(4)).toBe(-1.5);
  });

  it('supports public-source voice PCM through the same policy and cache as local tracks', async () => {
    for (const provider of ['youtube', 'soundcloud']) {
      const id = `voice-${provider}`;
      track(id, hashFor('ready'), provider);
      expect(a.services.stems.supports(a.services.lib.get(id)!)).toBe(true);
      expect((await a.app.inject(`/api/tracks/${id}/stems`)).json().status).toBe('ready');
      const pcm = await a.app.inject(`/api/tracks/${id}/vocals/pcm?sr=44100&start=0&frames=8`);
      expect(pcm.statusCode).toBe(200);
    }
    expect(a.services.stems.supports(a.services.lib.get('restricted')!)).toBe(false);
  });

  it('requeues a changed public recording under its verified hash before starting inference', async () => {
    const old = { id: 'changed-public', content_hash: hashFor('old-public'), provider: 'youtube', status: 'ok' } as Parameters<StemService['ensure']>[0];
    const current = { ...old, content_hash: hashFor('new-public') };
    const fake = { mixingPolicy: new Map([['youtube', true]]), all: () => [current], get: () => current, resolveMediaPath: async () => 'verified.webm' } as unknown as Library;
    const service = new StemService({ ...a.services.cfg, stemsPython: 'fake-python' }, fake, new EventHub());
    const launch = vi.fn((_exe: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { child.emit('close', 1); return true; } });
      return child;
    });
    (service as unknown as { spawnSeparation: typeof spawn }).spawnSeparation = launch as unknown as typeof spawn;
    try {
      service.ensure(old, 100);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      const args = launch.mock.calls[0][1];
      expect(args[args.indexOf('--output') + 1]).toContain(current.content_hash);
      expect(args.join(' ')).not.toContain(old.content_hash);
    } finally { service.stop(); }
  });

  it('runs the downloaded CUDA pack with shifts=1 and moves the job to the CPU pack when it cannot start', async () => {
    const t = { id: 'cuda-track', content_hash: hashFor('cuda-track'), provider: 'local', status: 'ok' } as Parameters<StemService['ensure']>[0];
    const fake = { mixingPolicy: new Map([['local', true]]), all: () => [t], get: () => t, resolveMediaPath: async () => 'track.flac' } as unknown as Library;
    const service = new StemService({ ...a.services.cfg, stemsPython: 'cpu-python', stemsModels: 'models' }, fake, new EventHub());
    const cuda = { python: vi.fn(() => 'cuda-python'), markBroken: vi.fn(() => { cuda.python.mockReturnValue(null as unknown as string); }) };
    Object.assign(service, { cuda });
    const launch = vi.fn((exe: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      if (exe === 'cuda-python') setTimeout(() => { child.stderr!.emit('data', Buffer.from('ImportError: DLL load failed')); child.emit('close', 1); }, 0);
      return child;
    });
    (service as unknown as { spawnSeparation: typeof spawn }).spawnSeparation = launch as unknown as typeof spawn;
    try {
      service.ensure(t, 100);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
      expect(launch.mock.calls.map(c => c[0])).toEqual(['cuda-python', 'cpu-python']);
      for (const [, args] of launch.mock.calls) expect(args.slice(args.indexOf('--shifts'), args.indexOf('--shifts') + 2)).toEqual(['--shifts', '1']);
      expect(cuda.markBroken).toHaveBeenCalledWith(expect.stringContaining('DLL load failed'));
      expect(service.status(t.content_hash).status).not.toBe('error');
    } finally { service.stop(); }
  });

  it('rejects a PCM response if the vocal generation changes during preparation', async () => {
    const previous=a.services.stems.revision(hashFor('ready'));
    const revision=vi.spyOn(a.services.stems,'revision').mockReturnValueOnce(previous).mockReturnValueOnce('new-generation');
    try{
      const response=await a.app.inject('/api/tracks/ready/vocals/pcm?sr=44100&start=0&frames=8');
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('обновилась');
    }finally{revision.mockRestore();}
  });

  it('serves an explicitly pinned vocal revision and rejects an unknown revision', async () => {
    const revision=a.services.stems.revision(hashFor('ready'))!;
    const response=await a.app.inject(`/api/tracks/ready/vocals/pcm?sr=44100&start=0&frames=8&revision=${encodeURIComponent(revision)}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-automix-vocal-revision']).toBe(revision);
    expect(response.rawPayload.equals(pcm)).toBe(true);
    const unknown=await a.app.inject('/api/tracks/ready/vocals/pcm?sr=44100&start=0&frames=8&revision=../../metadata.json');
    expect(unknown.statusCode).toBe(409);
  });

  it('returns a short complete frame at the end and an empty range beyond EOF', async () => {
    const tail = await a.app.inject('/api/tracks/ready/vocals/pcm?sr=44100&start=7&frames=16');
    expect(tail.statusCode).toBe(200);
    expect(tail.rawPayload.equals(pcm.subarray(7 * 8))).toBe(true);
    const eof = await a.app.inject('/api/tracks/ready/vocals/pcm?sr=44100&start=8&frames=16');
    expect(eof.statusCode).toBe(200);
    expect(eof.rawPayload.length).toBe(0);
    expect((await a.services.stems.read(hashFor('ready'), 44100, 1000, 3)).length).toBe(0);
  });

  const tone = (frames: number, amp = 1.3) => {
    const b = Buffer.alloc(frames * 8);
    for (let i = 0; i < frames; i++) {
      b.writeFloatLE(amp * Math.sin(2 * Math.PI * 440 * i / 44100), i * 8);
      b.writeFloatLE(-0.4 * Math.sin(2 * Math.PI * 3000 * i / 44100), i * 8 + 4);
    }
    return b;
  };
  const floats = (b: Buffer) => Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
  const stemDir = (hash: string) => path.join(dataDir, 'cache', 'stems', hash, 'hdemucs-v1');

  it('compacts a legacy f32 party to peak-scaled s16 in place and drops resampled copies', async () => {
    const source = tone(30000);
    const hash = seed('compact', {}, source);
    fs.writeFileSync(path.join(stemDir(hash), 'vocals_48000.f32'), Buffer.alloc(64));
    // phase 1 while an older server may still read vocals.f32: legacy files stay
    expect(await a.services.stems.compact(hash, false)).toBe(true);
    expect(fs.readdirSync(stemDir(hash)).sort()).toEqual(['metadata.json', 'vocals.f32', 'vocals.s16', 'vocals_48000.f32']);
    expect(a.services.stems.get(hash)?.storage?.format).toBe('s16le');
    // phase 2 by a current server: nothing to convert, legacy copies go
    expect(await a.services.stems.compact(hash)).toBe(false);
    expect(fs.readdirSync(stemDir(hash)).sort()).toEqual(['metadata.json', 'vocals.s16']);
    expect(fs.statSync(path.join(stemDir(hash), 'vocals.s16')).size).toBe(30000 * 4);
    const meta = a.services.stems.get(hash)!;
    expect(meta.storage?.format).toBe('s16le');
    expect(meta.storage!.scale).toBeGreaterThan(1.29); // peak above full scale is not clipped
    expect(meta.activity.values).toEqual([0.7]);
    const back = floats(await a.services.stems.read(hash, 44100, 0, 30000)), want = floats(source);
    expect(back).toHaveLength(want.length);
    let err = 0;
    for (let i = 0; i < want.length; i++) err = Math.max(err, Math.abs(back[i] - want[i]));
    expect(20 * Math.log10(err)).toBeLessThan(-93); // the residual the vocal mask leaves in the accompaniment
    expect(await a.services.stems.compact(hash)).toBe(false); // already compact
    track('compact', hash);
    const route = await a.app.inject('/api/tracks/compact/vocals/pcm?sr=44100&start=0&frames=30000');
    expect(route.headers['x-pcm-format']).toBe('f32le');
    expect(floats(route.rawPayload)).toEqual(back);
  });

  it('compacts a party larger than one block exactly like converting it whole', async () => {
    const source = tone(400000, 0.6); // 3.2 MB of f32: several 1 MiB steps
    source.writeFloatLE(1.4, 300001 * 8); // peak in a later block still sets the scale
    const hash = seed('compact-blocks', {}, source);
    expect(await a.services.stems.compact(hash)).toBe(true);
    const scale = a.services.stems.get(hash)!.storage!.scale;
    expect(scale).toBeCloseTo(1.4 * 32768 / 32767, 6);
    const want = Buffer.alloc(source.length / 2);
    for (let i = 0; i < want.length; i += 2) want.writeInt16LE(Math.round(source.readFloatLE(i * 2) * 32768 / scale), i);
    expect(fs.readFileSync(path.join(stemDir(hash), 'vocals.s16')).equals(want)).toBe(true);
  });

  it('resamples device-rate ranges on read, bit-identical to resampling the whole party', async () => {
    const hash = seed('resampled', {}, tone(50000, 0.8));
    await a.services.stems.compact(hash);
    const total = Math.round(50000 * 48000 / 44100);
    const whole = await a.services.stems.read(hash, 48000, 0, total + 100);
    expect(Math.abs(whole.length / 8 - total)).toBeLessThanOrEqual(1);
    for (const [start, frames] of [[0, 4096], [12345, 8192], [whole.length / 8 - 1000, 4096]]) {
      const part = await a.services.stems.read(hash, 48000, start, frames);
      expect(part.equals(whole.subarray(start * 8, (start + frames) * 8))).toBe(true);
    }
    expect((await a.services.stems.read(hash, 48000, total + 10, 16)).length).toBe(0);
    expect(fs.readdirSync(stemDir(hash)).some((f) => f.startsWith('vocals_'))).toBe(false);
  });

  it('serves a repeated resampled range from memory until the party changes', async () => {
    const hash = seed('resample-repeat', {}, tone(50000, 0.8));
    const first = await a.services.stems.read(hash, 48000, 1000, 4096);
    expect(await a.services.stems.read(hash, 48000, 1000, 4096)).toBe(first);
    // a new generation of the same track: same request, new audio
    const louder = tone(50000, 0.4);
    for (let i = 0; i < louder.length; i += 4) louder.writeFloatLE(louder.readFloatLE(i) * 2, i);
    seed('resample-repeat', { seconds: 12.5 }, louder); // longer metadata.json: a new stamp even within one millisecond
    const again = await a.services.stems.read(hash, 48000, 1000, 4096);
    expect(again).not.toBe(first);
    expect(again.equals(first)).toBe(false);
  });

  it('keeps the f32 party when it cannot be replaced', async () => {
    const bad = Buffer.from(tone(1000));
    bad.writeFloatLE(Number.NaN, 400);
    const hash = seed('compact-nan', {}, bad);
    expect(await a.services.stems.compact(hash)).toBe(false);
    expect(fs.readdirSync(stemDir(hash)).sort()).toEqual(['metadata.json', 'vocals.f32']);
    expect(a.services.stems.get(hash)?.storage).toBeUndefined();
  });

  it('keeps serving a party that another process compacted under a stale cache', async () => {
    const hash = seed('cross-process', {}, tone(2000));
    const other = new StemService({ ...a.services.cfg, stemsPython: null }, {} as Library, new EventHub());
    expect(other.get(hash)?.storage).toBeUndefined(); // the other process caches the legacy f32
    expect(await a.services.stems.compact(hash)).toBe(true);
    expect(fs.existsSync(path.join(stemDir(hash), 'vocals.f32'))).toBe(false);
    expect(other.readNative(hash, 0, 2000).equals(a.services.stems.readNative(hash, 0, 2000))).toBe(true);
    expect(other.get(hash)?.storage?.format).toBe('s16le');
  });

  it.each([
    'sr=12345&start=0&frames=8', 'sr=Infinity&start=0&frames=8', 'sr=44100&start=-1&frames=8',
    'sr=44100&start=0.5&frames=8', 'sr=44100&start=Infinity&frames=8', 'sr=44100&start=0&frames=0',
    'sr=44100&start=0&frames=1.5', 'sr=44100&start=0&frames=1048577', 'sr=44100&frames=8',
  ])('rejects an invalid PCM range: %s', async (query) => {
    const response = await a.app.inject(`/api/tracks/ready/vocals/pcm?${query}`);
    expect(response.statusCode).toBe(400);
  });

  it('reports unavailable audio and rejects a provider that does not allow processing', async () => {
    expect((await a.app.inject('/api/tracks/unavailable/stems')).json().status).toBe('unavailable');
    expect((await a.app.inject('/api/tracks/unavailable/vocals/pcm?sr=44100&start=0&frames=8')).statusCode).toBe(409);
    expect((await a.app.inject('/api/tracks/restricted/vocals/pcm?sr=44100&start=0&frames=8')).statusCode).toBe(409);
    expect((await a.app.inject('/api/tracks/absent/vocals/pcm?sr=44100&start=0&frames=8')).statusCode).toBe(404);
    expect((await a.app.inject({method:'POST',url:'/api/tracks/absent/stems/rebuild'})).statusCode).toBe(404);
    expect((await a.app.inject({method:'POST',url:'/api/tracks/restricted/stems/rebuild'})).statusCode).toBe(409);
    expect((await a.app.inject({method:'POST',url:'/api/tracks/ready/stems/rebuild'})).statusCode).toBe(409); // Python disabled
  });

  it.each([
    ['version', { version: 'wrong-model-version' }], ['sample-rate', { sampleRate: 48000 }], ['negative-frames', { frames: -8 }],
    ['activity-source', { activity: { source: 'guessed', model: 'x', rate: 10, values: [0.5] } }],
    ['activity-rate', { activity: { source: 'demucs', model: 'x', rate: 20, values: [0.5] } }],
    ['activity-nan', { activity: { source: 'demucs', model: 'x', rate: 10, values: [null] } }],
    ['activity-range', { activity: { source: 'demucs', model: 'x', rate: 10, values: [1.5] } }],
  ] as [string, Record<string, unknown>][])('rejects corrupt cache metadata: %s', (name, patch) => {
    const hash = seed(name, patch);
    expect(a.services.stems.get(hash)).toBeNull();
    expect(a.services.stems.status(hash).status).not.toBe('ready');
  });

  const measured = (patch: Record<string, unknown> = {}) => ({
    version: 'vocal-activity-2', source: 'demucs', model: 'HDEMUCS_HIGH_MUSDB_PLUS', rate: 10,
    values: [0.7], vocalRmsDb: [-18], accompanimentRmsDb: [-22], phrases: [], ...patch,
  });

  it('publishes a rebuilt generation atomically, preserves old audio and notices cross-process metadata', async () => {
    const hash=seed('quality-publish');
    const t={id:'quality-publish',content_hash:hash,provider:'local',status:'ok'} as Parameters<StemService['ensure']>[0];
    const alias={...t,id:'quality-publish-yandex',provider:'yandex'};
    const unrelated={...t,id:'other-content',content_hash:hashFor('other-content')};
    const fake={mixingPolicy:new Map([['local',true]]),all:()=>[t,alias,alias,unrelated],resolveMediaPath:async()=>'fixture.wav'} as unknown as Library;
    const events=new EventHub(),published:ServerEvent[]=[];
    events.on(event=>published.push(event));
    const service=new StemService({...a.services.cfg,stemsPython:'fake-python'},fake,events);
    const other=new StemService({...a.services.cfg,stemsPython:null},fake,new EventHub());
    expect(other.get(hash)?.inference).toBeUndefined();
    const oldRevision=service.revision(hash)!;
    let finish!:(code:number)=>void, directory='';
    const launch=vi.fn((_command:string,args:string[])=>{
      directory=args[args.indexOf('--output')+1];
      const child=new EventEmitter() as ChildProcess;
      Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true});
      finish=code=>{child.emit('close',code);};
      return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.rebuild(t);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(1));
      expect(service.status(hash)).toMatchObject({status:'ready',quality:{status:'running'}});
      expect(service.readNative(hash,0,8).equals(pcm)).toBe(true);
      service.rebuild(t); // repeated clicks join the existing GPU job
      expect(launch).toHaveBeenCalledTimes(1);
      fs.mkdirSync(directory,{recursive:true});
      const next=Buffer.alloc(pcm.length);for(let i=0;i<next.length;i+=4)next.writeFloatLE(.2,i);
      fs.writeFileSync(path.join(directory,'vocals.f32'),next);
      fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({
        version:'hdemucs-v1',model:'HDEMUCS_HIGH_MUSDB_PLUS',sampleRate:44100,frames:8,device:'fake',seconds:1,
        activity:measured(),inference:{version:'context-overlap-2',segment:8,context:.35,overlap:.25,shifts:2},
      }));
      finish(0);
      await vi.waitFor(()=>expect(service.status(hash).quality?.status).toBe('ready'), { timeout: 5000 });
      expect(service.get(hash)?.storage?.file).toMatch(/^vocals-[a-f\d-]{36}\.s16$/);
      expect(fs.readFileSync(path.join(stemDir(hash),'vocals.f32')).equals(pcm)).toBe(true);
      expect(other.get(hash)?.inference?.version).toBe('context-overlap-2');
      expect(other.readNative(hash,0,8).readFloatLE(0)).toBeCloseTo(.2,4);
      expect((await service.read(hash,44100,0,8,oldRevision)).equals(pcm)).toBe(true);
      await expect(service.read(hash,44100,0,8,'missing-generation')).rejects.toMatchObject({statusCode:409});
      const vocalEvents=published.filter(event=>event.type==='analysis'&&event.asset==='vocals');
      expect(vocalEvents.map(event=>event.type==='analysis'?event.trackId:null).sort()).toEqual([t.id,alias.id].sort());
      expect(vocalEvents.every(event=>event.type==='analysis'&&event.revision===service.revision(hash))).toBe(true);
      service.rebuild(t);
      expect(launch).toHaveBeenCalledTimes(1); // already upgraded: no new inference
    }finally{service.stop();other.stop();}
  });

  it('yields optional word recognition to the next missing vocal separation', async () => {
    const hash=seed('preempt-lyrics',{activity:measured()});
    const ready={id:'ready-words',content_hash:hash,provider:'local',status:'ok'} as Parameters<StemService['ensure']>[0];
    const next={...ready,id:'next-missing',content_hash:hashFor('preempt-next')};
    const fake={mixingPolicy:new Map([['local',true]]),all:()=>[],resolveMediaPath:async()=> 'recording.wav'} as unknown as Library;
    const service=new StemService({...a.services.cfg,stemsPython:'fake-python'},fake,new EventHub());
    const children:ChildProcess[]=[];
    const launch=vi.fn(()=>{
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),
        kill:vi.fn(()=>{queueMicrotask(()=>child.emit('close',null));return true;})}) as unknown as ChildProcess;
      children.push(child);return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try {
      service.ensure(ready,100);expect(launch).toHaveBeenCalledOnce();
      service.ensure(next,90);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(2));
      const args=launch.mock.calls as unknown as [string,string[]][];
      expect(args[0][1][0]).toMatch(/transcribe-vocals\.py$/);
      expect(args[1][1][0]).toMatch(/separate-vocals\.py$/);
      expect(service.status(hash).status).toBe('ready');
      expect(service.stats().lyricsErrors).toBe(0);
      expect(service.stats().lyricsQueued).toBe(1);
    } finally {service.stop();await new Promise(resolve=>setImmediate(resolve));}
  });

  it('adds recognised word timing to the vocal activity without touching PCM or metadata', async () => {
    const hash=seed('lyrics',{activity:measured()}),other=seed('lyrics-missing-model',{activity:measured()});
    const t={id:'lyrics',content_hash:hash,provider:'local',status:'ok'} as Parameters<StemService['ensure']>[0];
    const u={...t,id:'lyrics-missing-model',content_hash:other};
    const fake={mixingPolicy:new Map([['local',true]]),all:()=>[],resolveMediaPath:async()=>{throw new Error('lyrics must not fetch the source');}} as unknown as Library;
    const events=new EventHub(),published:ServerEvent[]=[];events.on(event=>published.push(event));
    const service=new StemService({...a.services.cfg,stemsPython:'fake-python'},fake,events);
    const before=fs.readFileSync(path.join(stemDir(hash),'metadata.json'),'utf8');
    const launch=vi.fn((_command:string,args:string[])=>{
      const child=new EventEmitter() as ChildProcess;
      Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true});
      const output=args[args.indexOf('--output')+1];
      setTimeout(()=>{
        if(output.includes(other)){child.stdout!.emit('data',Buffer.from('{"type":"error","message":"whisper model missing: x"}\n'));child.emit('close',1);return;}
        fs.writeFileSync(output,JSON.stringify({version:'whisper-words-1',model:'large-v3-turbo',language:'ru',confidence:.97,
          words:[{start:.1,end:.3,word:' секрет',p:.99},{start:.35,end:.6,word:' слово',p:.95}],lines:[{start:.1,end:.6,text:'секрет слово',words:2}]}));
        child.emit('close',0);
      },0);
      return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      expect(service.activity(hash)?.lyrics).toBeUndefined();
      service.ensure(t,95);
      await vi.waitFor(()=>expect(service.activity(hash)?.lyrics).toBeTruthy());
      expect(published).toEqual([{type:'lyrics',trackId:t.id,hash}]);
      expect(launch.mock.calls[0][1][0]).toMatch(/transcribe-vocals\.py$/);
      // timing only: the recognised text never reaches plans or caches
      expect(service.activity(hash)?.lyrics).toEqual({version:'whisper-words-1',language:'ru',confidence:.97,words:[[.1,.3],[.35,.6]],lines:[[.1,.6]]});
      expect(JSON.stringify(service.activity(hash))).not.toContain('секрет');
      expect(service.activity(hash)).toBe(service.activity(hash));
      expect(fs.readFileSync(path.join(stemDir(hash),'metadata.json'),'utf8')).toBe(before);
      expect(service.readNative(hash,0,8).equals(pcm)).toBe(true);
      service.ensure(t,95);
      expect(launch).toHaveBeenCalledTimes(1); // done: no second recognition
      // a missing local model disables the pass instead of failing every track
      service.ensure(u,95);
      await vi.waitFor(()=>expect(service.stats().lyricsAvailable).toBe(false));
      expect(service.status(other).status).toBe('ready');
    }finally{service.stop();}
  });

  it('ignores oversized cached lyric JSON for both planner activity and lyrics reads', () => {
    const hash=seed('oversized-lyrics',{activity:measured()}),file=path.join(stemDir(hash),'lyrics.json');
    fs.writeFileSync(file,Buffer.alloc(2*1024*1024+1,0x20));
    expect(a.services.stems.activity(hash)?.lyrics).toBeUndefined();
    expect(a.services.stems.wordLyrics(hash)).toBeNull();
  });

  it('keeps an existing generation playable when a rebuild fails', async () => {
    const hash=seed('quality-failure');
    const t={id:'quality-failure',content_hash:hash,provider:'local',status:'ok'} as Parameters<StemService['ensure']>[0];
    const fake={mixingPolicy:new Map([['local',true]]),all:()=>[t],resolveMediaPath:async()=>'fixture.wav'} as unknown as Library;
    const service=new StemService({...a.services.cfg,stemsPython:'fake-python'},fake,new EventHub());
    const launch=vi.fn(()=>{
      const child=new EventEmitter() as ChildProcess;
      Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true});
      setTimeout(()=>{child.stderr!.emit('data',Buffer.from('GPU failure'));child.emit('close',1);},0);
      return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.rebuild(t);
      await vi.waitFor(()=>expect(service.status(hash).quality?.status).toBe('error'));
      expect(service.status(hash).status).toBe('ready');
      expect(service.readNative(hash,0,8).equals(pcm)).toBe(true);
      expect(service.get(hash)?.inference).toBeUndefined();
    }finally{service.stop();}
  });

  it('accepts measured vocal and accompaniment metadata without rewriting legacy audio', () => {
    const hash = seed('measured', { activity: measured() });
    const before = fs.readFileSync(path.join(stemDir(hash), 'vocals.f32'));
    expect(a.services.stems.get(hash)?.activity).toEqual(measured());
    expect(a.services.stems.readNative(hash, 0, 8).equals(before)).toBe(true);
    expect(a.services.stems.get(hash)?.storage).toBeUndefined();
  });

  it.each([
    ['invalid-revision', { revision: '../../escape' }],
    ['missing-measured-curve', { accompanimentRmsDb: undefined }],
    ['mismatched-count', { vocalRmsDb: [-18, -19] }],
    ['invalid-db', { vocalRmsDb: [null] }],
    ['invalid-phrase-end', { phrases: [{ start: 0, end: 20, confidence: .8 }] }],
    ['invalid-phrase-confidence', { phrases: [{ start: 0, end: .0001, confidence: 2 }] }],
    ['overlapping-phrases', { phrases: [{ start: 0, end: .0001, confidence: .8 }, { start: 0, end: .0001, confidence: .8 }] }],
  ] as [string, Record<string, unknown>][])('rejects malformed v2 vocal measurements: %s', (name, patch) => {
    const hash = seed(name, { activity: measured(patch) });
    expect(a.services.stems.get(hash)).toBeNull();
  });

  it('rejects truncated stereo data, fractional frames and invalid hash paths', async () => {
    const truncated = seed('truncated', { frames: 8 }, pcm.subarray(0, pcm.length - 1));
    expect(a.services.stems.get(truncated)).toBeNull();
    const fractional = seed('fractional', { frames: 1.5 }, pcm.subarray(0, 12));
    expect(a.services.stems.get(fractional)).toBeNull();
    for (const hash of ['../../escape', 'remote:123', 'x'.repeat(64), '']) {
      expect(a.services.stems.get(hash)).toBeNull();
      await expect(a.services.stems.read(hash, 44100, 0, 1)).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('persists stemMixing opt-out across unrelated settings changes', async () => {
    kvSet(a.services.db, 'settings', { version: 2, automix: { ...DEFAULT_AUTOMIX_SETTINGS } });
    const saved = await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { stemMixing: false } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().automix.stemMixing).toBe(false);
    await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { maxBlendSeconds: 24 } } });
    expect((await a.app.inject('/api/settings')).json().automix.stemMixing).toBe(false);
    expect(kvGet<{ automix: { stemMixing: boolean } } | null>(a.services.db, 'settings', null)?.automix.stemMixing).toBe(false);
    await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { stemMixing: true } } });
  });

  it('invalidates a cached pair when separated vocal activity becomes available', async () => {
    const tone = Float32Array.from({ length: 3 * 44100 }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 220 * i / 44100));
    const analysis = analyzePcm(tone, tone);
    for (const name of ['cache-a', 'cache-b']) {
      q(a.services.db, 'INSERT INTO analysis(content_hash, version, status, data, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(hashFor(name), ANALYZER_VERSION, 'done', JSON.stringify(analysis), Date.now());
    }
    const url = '/api/automix/plan?from=cache-a&to=cache-b';
    expect((await a.app.inject(url)).json().cached).toBe(false);
    expect((await a.app.inject(url)).json().cached).toBe(true);
    expect(a.services.analysis.get(hashFor('cache-a'))?.vocalActivity).toBeUndefined();
    seed('cache-a'); seed('cache-b');
    expect(a.services.analysis.get(hashFor('cache-a'))?.vocalActivity?.source).toBe('demucs');
    expect((await a.app.inject(url)).json().cached).toBe(false);
    expect((await a.app.inject(url)).json().cached).toBe(true);
  });

  it('keeps offline/current vocal parties but evicts old generated library caches over budget', async () => {
    const big = Buffer.alloc(64 * 1024);
    const kept = seed('library-old', {}, big);
    track('library-old', kept);
    q(a.services.db, 'UPDATE tracks SET pinned = 1 WHERE id = ?').run('library-old');
    const cold = seed('library-cold', {}, big); track('library-cold', cold);
    const orphan = seed('orphan', {}, big);
    const dir = (hash: string) => path.join(dataDir, 'cache', 'stems', hash, 'hdemucs-v1');
    // the library separation is the oldest entry: the old policy removed it first
    const old = new Date(Date.now() - 3600_000);
    for (const file of fs.readdirSync(dir(kept))) fs.utimesSync(path.join(dir(kept), file), old, old);
    const stems = a.services.stems as unknown as { cfg: { stemsCacheBytes: number }; prune(): Promise<void> };
    const budget = stems.cfg.stemsCacheBytes;
    stems.cfg.stemsCacheBytes = 1;
    try { await stems.prune(); } finally { stems.cfg.stemsCacheBytes = budget; }
    expect(fs.existsSync(path.join(dir(kept), 'vocals.f32'))).toBe(true);
    expect(fs.existsSync(dir(orphan))).toBe(false); // not in the library
    expect(fs.existsSync(dir(cold))).toBe(false); // ordinary library metadata is not an offline pin
    expect(fs.existsSync(path.join(dir(hashFor('ready')), 'vocals.f32'))).toBe(true);
  });
});

describe('bounded background upgrades of ready vocal caches', () => {
  it('does not separate the entire library on startup but still prepares the playing track', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-stem-demand-'));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const tracks = Array.from({ length: 40 }, (_, i) => ({ id: `demand-${i}`, provider: 'local', status: 'ok', content_hash: hashFor(`demand-${i}`) }));
    const resolveMediaPath = vi.fn(async () => { await blocked; return 'unused.wav'; });
    const fake = { all: () => tracks, mixingPolicy: new Map([['local', true]]), resolveMediaPath } as unknown as Library;
    const cfg = { dataDir, stemsPython: process.execPath, ffmpeg: 'unused', pcmCacheBytes: 1024 * 1024 } as ConstructorParameters<typeof StemService>[0];
    const service = new StemService(cfg, fake, new EventHub());
    const ensure = vi.spyOn(service, 'ensure');
    try {
      service.start();
      await vi.waitFor(() => expect((service as unknown as { starting: boolean }).starting).toBe(false));
      expect(ensure).not.toHaveBeenCalled();
      expect(resolveMediaPath).not.toHaveBeenCalled();
      service.ensure(tracks[0] as Parameters<StemService['ensure']>[0], 100);
      await vi.waitFor(() => expect(resolveMediaPath).toHaveBeenCalledOnce());
    } finally {
      service.stop(); release(); await new Promise(resolve => setTimeout(resolve, 10));
      if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('automix-stem-demand-')) throw new Error('Unsafe cleanup path');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  it('keeps ready PCM readable, bounds background work and promotes the playing track', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-upgrade-'));
    let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const tracks=Array.from({length:12},(_,i)=>({id:`upgrade-${i}`,provider:'local',status:'ok',content_hash:hashFor(`upgrade-${i}`)}));
    const fake={all:()=>tracks,mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>{await blocked;return 'unused.wav';}} as unknown as Library;
    const cfg={dataDir,stemsPython:process.execPath,ffmpeg:'unused',pcmCacheBytes:1024*1024} as ConstructorParameters<typeof StemService>[0];
    const service=new StemService(cfg,fake,new EventHub());
    for(const t of tracks){
      const directory=path.join(dataDir,'cache','stems',t.content_hash,'hdemucs-v1');
      fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,'vocals.f32'),Buffer.alloc(16));
      fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
        activity:{source:'demucs',model:'test',rate:10,values:[.7]}}));
    }
    try{
      service.start();
      await vi.waitFor(()=>expect(service.stats().activityUpgrading).toBe(true), { timeout: 5000 });
      const internals=service as unknown as {queue:Map<string,{priority:number;analyzeOnly:boolean}>;activityBacklog:unknown[]};
      expect(internals.queue.size).toBeLessThanOrEqual(4);
      expect(internals.activityBacklog.length).toBeGreaterThan(0);
      expect(service.status(tracks[0].content_hash).status).toBe('ready');
      expect(service.readNative(tracks[0].content_hash,0,2).length).toBe(16);
      service.ensure(tracks[11] as Parameters<StemService['ensure']>[0],100);
      expect(internals.queue.get(tracks[11].content_hash)).toMatchObject({priority:100,analyzeOnly:true});
      expect(service.status(tracks[11].content_hash).status).toBe('ready');
    }finally{
      service.stop();release();
      await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-upgrade-'))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  });

  it('does not transcribe cached library vocals on startup; requests word timing for playback', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-lyrics-demand-'));
    const track={id:'words-on-demand',provider:'local',status:'ok',content_hash:hashFor('words-on-demand')};
    const fake={all:()=>[track],mixingPolicy:new Map([['local',true]])} as unknown as Library;
    const directory=path.join(dataDir,'cache/stems',track.content_hash,'hdemucs-v1');
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'vocals.f32'),Buffer.alloc(16));
    fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
      activity:{version:'vocal-activity-2',source:'demucs',model:'test',rate:10,values:[.7],vocalRmsDb:[-20],accompanimentRmsDb:[-22],phrases:[]}}));
    const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    let child:ChildProcess|null=null;
    const launch=vi.fn(()=>{child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true}) as unknown as ChildProcess;return child;});
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.start();
      await vi.waitFor(()=>expect((service as unknown as {starting:boolean}).starting).toBe(false),{timeout:5000});
      expect(launch).not.toHaveBeenCalled(); expect(service.stats().lyricsQueued).toBe(0);
      service.ensure(track as Parameters<StemService['ensure']>[0],50);
      expect(launch).not.toHaveBeenCalled();
      service.ensure(track as Parameters<StemService['ensure']>[0],100);
      expect(launch).toHaveBeenCalledOnce();
    }finally{service.stop();(child as ChildProcess|null)?.emit('close',1);await new Promise(resolve=>setTimeout(resolve,20));fs.rmSync(dataDir,{recursive:true,force:true});}
  });

  it('keeps vocal work focused on current, next, and two eligible candidates', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-focus-'));
    let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const make=(name:string)=>({id:name,provider:'local',status:'ok',content_hash:hashFor(name)} as NonNullable<Parameters<StemService['focus']>[0]>);
    const current=make('focus-current'),next=make('focus-next'),candidate=make('focus-candidate');
    const readyCandidate=make('focus-ready'),extra=make('focus-extra'),replacement=make('focus-replacement');
    const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>{await blocked;return 'unused.wav';}} as unknown as Library;
    const service=new StemService({dataDir,stemsPython:process.execPath,ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    const readyDir=path.join(dataDir,'cache','stems',readyCandidate.content_hash,'hdemucs-v1');
    fs.mkdirSync(readyDir,{recursive:true});
    fs.writeFileSync(path.join(readyDir,'vocals.f32'),Buffer.alloc(16));
    fs.writeFileSync(path.join(readyDir,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
      activity:{version:'vocal-activity-2',source:'demucs',model:'test',rate:10,values:[.7],vocalRmsDb:[-20],accompanimentRmsDb:[-22],phrases:[]}}));
    try{
      service.focus(current,next,[candidate,readyCandidate,extra]);
      const internals=service as unknown as {queue:Map<string,{track:typeof current;priority:number;analyzeOnly:boolean;lyrics?:boolean}>;activeHash:string|null;focusedHashes:Set<string>;pins:Map<string,number>};
      expect(internals.activeHash).toBe(current.content_hash);
      expect([...internals.queue.entries()].map(([hash,item])=>[hash,item.priority]).sort()).toEqual([
        [next.content_hash,95],[candidate.content_hash,70],
      ].sort());
      expect(internals.queue.has(readyCandidate.content_hash)).toBe(false); // priority 70 never starts Whisper
      expect(internals.queue.has(extra.content_hash)).toBe(false); // only two candidates are retained
      internals.queue.set(readyCandidate.content_hash,{track:readyCandidate,priority:100,analyzeOnly:false,lyrics:true});
      internals.queue.set(extra.content_hash,{track:extra,priority:100,analyzeOnly:false});
      service.focus(replacement,undefined,[readyCandidate,extra]);
      expect(internals.queue.get(extra.content_hash)?.priority).toBe(70); // obsolete playback urgency is demoted
      expect(internals.queue.has(readyCandidate.content_hash)).toBe(false); // candidate ASR is dropped
      expect(internals.queue.has(replacement.content_hash)).toBe(true);
      expect(internals.focusedHashes.has(next.content_hash)).toBe(false);
      expect(internals.focusedHashes.has(candidate.content_hash)).toBe(false);
      expect(internals.pins.get(current.content_hash)).toBeLessThanOrEqual(Date.now()+30_000);
      expect(internals.pins.get(next.content_hash)).toBeLessThanOrEqual(Date.now()+30_000);
    }finally{
      service.stop();release();await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-focus-'))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  });

  it('queues current and next before starting optional Whisper for the current cache', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-focus-batch-'));
    const current={id:'batch-current',provider:'local',status:'ok',content_hash:hashFor('batch-current')} as NonNullable<Parameters<StemService['focus']>[0]>;
    const next={id:'batch-next',provider:'local',status:'ok',content_hash:hashFor('batch-next')} as NonNullable<Parameters<StemService['focus']>[0]>;
    const dir=path.join(dataDir,'cache','stems',current.content_hash,'hdemucs-v1');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'vocals.f32'),Buffer.alloc(16));
    fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
      activity:{version:'vocal-activity-2',source:'demucs',model:'test',rate:10,values:[.7],vocalRmsDb:[-20],accompanimentRmsDb:[-22],phrases:[]}}));
    const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>'unused.wav'} as unknown as Library;
    const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    const launch=vi.fn((_command:string,args:string[])=>{
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true}) as unknown as ChildProcess;
      return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.focus(current,next);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
      expect(launch.mock.calls[0][1][0]).toMatch(/separate-vocals\.py$/);
      expect(service.stats().lyricsQueued).toBe(1); // recognition waits behind next's missing vocal
    }finally{
      service.stop();await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-focus-batch-'))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  });

  it('does not requeue Whisper for a track after playback focus has moved on', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-stale-lyrics-'));
    const make=(name:string)=>({id:name,provider:'local',status:'ok',content_hash:hashFor(name)} as NonNullable<Parameters<StemService['focus']>[0]>);
    const old=make('stale-lyrics'),current=make('stale-new-current'),next=make('stale-new-next');
    for(const t of [old,current]){
      const dir=path.join(dataDir,'cache','stems',t.content_hash,'hdemucs-v1');fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'vocals.f32'),Buffer.alloc(16));
      fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
        activity:{version:'vocal-activity-2',source:'demucs',model:'test',rate:10,values:[.7],vocalRmsDb:[-20],accompanimentRmsDb:[-22],phrases:[]}}));
    }
    const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>'unused.wav'} as unknown as Library;
    const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    const launch=vi.fn((_command:string,args:string[])=>{
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true;}}) as unknown as ChildProcess;
      return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.focus(old);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
      expect(launch.mock.calls[0][1][0]).toMatch(/transcribe-vocals\.py$/);
      service.focus(current,next);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(2));
      expect(launch.mock.calls[1][1][0]).toMatch(/separate-vocals\.py$/);
      const internals=service as unknown as {queue:Map<string,{track:typeof old;lyrics?:boolean}>};
      expect(internals.queue.has(old.content_hash)).toBe(false);
      expect(service.stats().lyricsQueued).toBe(1); // only the new current track remains eligible
    }finally{
      service.stop();await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-stale-lyrics-'))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  });

  it('drops a candidate whose queued local input disappears without resolving media', async () => {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-local-only-'));
    let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const make=(name:string)=>({id:name,provider:'local',status:'ok',content_hash:hashFor(name)} as NonNullable<Parameters<StemService['focus']>[0]>);
    const current=make('local-only-current'),candidate=make('local-only-candidate');
    const audioPath=path.join(dataDir,'candidate.wav');fs.writeFileSync(audioPath,'audio');
    const resolveMediaPath=vi.fn(async()=>{await blocked;return 'current.wav';});
    const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath} as unknown as Library;
    const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    let active:ChildProcess|null=null;
    const launch=vi.fn(()=>{
      active=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true}) as unknown as ChildProcess;
      return active;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{
      service.focus(current,undefined,[candidate],new Map([[candidate.content_hash,audioPath]]));
      const internals=service as unknown as {queue:Map<string,{localOnly?:boolean;localInput?:string}>};
      expect(internals.queue.get(candidate.content_hash)).toMatchObject({localOnly:true,localInput:audioPath});
      fs.rmSync(audioPath);
      release();
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
      active!.emit('close',1);
      await vi.waitFor(()=>expect(service.stats().queued).toBe(0));
      expect(resolveMediaPath).toHaveBeenCalledOnce(); // only the actual current track reached the resolver
      expect(launch).toHaveBeenCalledOnce(); // the vanished candidate never started inference
      expect(service.status(candidate.content_hash).status).toBe('pending'); // retryable by a future foreground focus
    }finally{
      service.stop();release();await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-local-only-'))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  });
});

describe('vocal readiness before transitions', () => {
  const make=(name:string)=>({id:name,title:name,provider:'local',status:'ok',content_hash:hashFor(name)} as NonNullable<Parameters<StemService['focus']>[0]>);
  async function withService(prefix:string,run:(service:StemService,launch:ReturnType<typeof vi.fn>,children:ChildProcess[],dataDir:string)=>Promise<void>,write=false){
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
    const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>'recording.wav'} as unknown as Library;
    const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
    const children:ChildProcess[]=[];
    const launch=vi.fn((_command:string,args:string[])=>{
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),
        kill:vi.fn(()=>{queueMicrotask(()=>child.emit('close',null));return true;})}) as unknown as ChildProcess;
      if(write){
        const out=args[args.indexOf('--output')+1];fs.mkdirSync(out,{recursive:true});
        fs.writeFileSync(path.join(out,'vocals.f32'),Buffer.alloc(16));
        fs.writeFileSync(path.join(out,'metadata.json'),JSON.stringify({version:'hdemucs-v1',model:'test',sampleRate:44100,frames:2,device:'test',seconds:0,
          activity:{version:'vocal-activity-2',source:'demucs',model:'test',rate:10,values:[.7],vocalRmsDb:[-20],accompanimentRmsDb:[-22],phrases:[]}}));
        setTimeout(()=>child.emit('close',0),5);
      }
      children.push(child);return child;
    });
    (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
    try{await run(service,launch,children,dataDir);}
    finally{
      service.stop();await new Promise(resolve=>setTimeout(resolve,10));
      if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith(prefix))throw new Error('Unsafe test cleanup');
      fs.rmSync(dataDir,{recursive:true,force:true});
    }
  }

  it('preempts a candidate separation for the next track and requeues the candidate', async () => {
    await withService('automix-stem-preempt-',async(service,launch,children)=>{
      const candidate=make('preempt-candidate'),next=make('preempt-next');
      service.ensure(candidate,70);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
      service.ensure(next,95);
      expect(children[0].kill).toHaveBeenCalled();
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(2));
      const internals=service as unknown as {activeHash:string|null;queue:Map<string,{priority:number}>};
      expect(internals.activeHash).toBe(next.content_hash);
      expect(internals.queue.get(candidate.content_hash)?.priority).toBe(70);
      expect(service.status(candidate.content_hash).status).toBe('pending');
    });
  });

  it('retries a failed separation for current/next after a minute, not for candidates', async () => {
    await withService('automix-stem-retry-',async(service,launch,children)=>{
      const current=make('retry-current'),candidate=make('retry-candidate');
      service.ensure(current,100);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
      children[0].emit('close',1);
      await vi.waitFor(()=>expect(service.status(current.content_hash).status).toBe('error'));
      service.ensure(current,100);expect(launch).toHaveBeenCalledOnce();
      const timing=(service as unknown as {timing:Map<string,{errorAt?:number}>}).timing;
      timing.get(current.content_hash)!.errorAt=Date.now()-61_000;
      service.ensure(current,70);expect(launch).toHaveBeenCalledOnce();
      service.ensure(current,100);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(2));
      children[1].emit('close',1);
      await vi.waitFor(()=>expect(service.status(current.content_hash).status).toBe('error'));
      service.ensure(candidate,70);
      await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(3));
    });
  });

  it('stores queue/start/finish times in metadata and reports how long before use the voice was ready', async () => {
    await withService('automix-stem-timing-',async(service,_launch,_children,dataDir)=>{
      const next=make('timing-next'),before=Date.now();
      service.ensure(next,95);
      await vi.waitFor(()=>expect(service.status(next.content_hash).status).toBe('ready'));
      await vi.waitFor(()=>expect(JSON.parse(fs.readFileSync(path.join(dataDir,'cache','stems',next.content_hash,'hdemucs-v1','metadata.json'),'utf8')).prepared).toBeTruthy());
      const meta=service.get(next.content_hash)!;
      expect(meta.prepared!.queuedAt).toBeGreaterThanOrEqual(before);
      expect(meta.prepared!.startedAt).toBeGreaterThanOrEqual(meta.prepared!.queuedAt);
      expect(meta.prepared!.doneAt).toBeGreaterThanOrEqual(meta.prepared!.startedAt);
      expect(meta.prepared!.priority).toBe(95);
      const r=service.readiness(next.content_hash,meta.prepared!.doneAt+42_000);
      expect(r).toEqual({status:'ready',readyAgoS:42});
      expect(service.readiness(hashFor('timing-missing')).status).not.toBe('ready');
    },true);
  });
});

it('stops separating a skipped recording when playback focus moves on (dislike 250)', async () => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'automix-stem-skip-'));
  const make=(name:string)=>({id:name,title:name,provider:'local',status:'ok',content_hash:hashFor(name)} as NonNullable<Parameters<StemService['focus']>[0]>);
  const fake={all:()=>[],mixingPolicy:new Map([['local',true]]),resolveMediaPath:async()=>'recording.wav'} as unknown as Library;
  const service=new StemService({dataDir,stemsPython:'fake',ffmpeg:'unused',pcmCacheBytes:1024} as ConstructorParameters<typeof StemService>[0],fake,new EventHub());
  const children:ChildProcess[]=[];
  const launch=vi.fn(()=>{const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),
    kill:vi.fn(()=>{queueMicrotask(()=>child.emit('close',null));return true;})}) as unknown as ChildProcess;children.push(child);return child;});
  (service as unknown as {spawnSeparation:typeof spawn}).spawnSeparation=launch as unknown as typeof spawn;
  try{
    const skipped=make('skip-old'),current=make('skip-current');
    service.focus(skipped);
    await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
    service.focus(current);
    expect(children[0].kill).toHaveBeenCalled();
    await vi.waitFor(()=>expect(launch).toHaveBeenCalledTimes(2));
    expect((service as unknown as {activeHash:string|null}).activeHash).toBe(current.content_hash);
    expect((service as unknown as {queue:Map<string,unknown>}).queue.has(skipped.content_hash)).toBe(false);
    expect(service.status(skipped.content_hash).status).toBe('pending'); // a later focus may still prepare it
  }finally{
    service.stop();await new Promise(resolve=>setTimeout(resolve,10));
    if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('automix-stem-skip-'))throw new Error('Unsafe test cleanup');
    fs.rmSync(dataDir,{recursive:true,force:true});
  }
});
