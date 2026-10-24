import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {DEFAULT_AUTOMIX_SETTINGS} from '@automix/core';
import type {Services} from '../src/app.ts';
import {registerPlaybackRoutes} from '../src/routes/playback.ts';
import {getSettings} from '../src/automix.ts';
vi.mock('../src/automix.ts',()=>({getSettings:vi.fn(()=>({automix:{enabled:true}}))}));

it('focuses current/next plus locally available candidates without fetching remote audio or decoding extra PCM',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mora-prefetch-')),file=path.join(dir,'local.mp3');fs.writeFileSync(file,'cached');
  const rows=new Map(['a','b','c','d','e'].map((id,i)=>[id,{id,content_hash:String(i).repeat(64),status:'ok',provider:'local'}]));
  const focus=vi.fn(),pcmFocus=vi.fn(),prioritize=vi.fn();
  let cached=false,ready=false;
  const services={db:{},lib:{media:(id:string)=>rows.get(id),sources:(id:string)=>id==='c'?[{kind:'linked',path:file}]:[]},
    pcm:{focus:pcmFocus},analysis:{demote:vi.fn(),prioritize,stats:()=>({queued:0})},stems:{focus,get:()=>ready?{}:null},
    publicMusic:{cachedAudioPath:()=>cached?file:null,pcmKey:(_id:string,hash:string)=>hash}} as unknown as Services;
  const app=Fastify();registerPlaybackRoutes(app,services);
  try{
    vi.mocked(getSettings).mockReturnValue({automix:DEFAULT_AUTOMIX_SETTINGS} as ReturnType<typeof getSettings>);
    const send=()=>app.inject({method:'POST',url:'/api/analysis/focus',payload:{current:'a',next:['b','e'],candidates:['c','d','e']}});
    expect((await send()).statusCode).toBe(200);
    expect(focus).toHaveBeenLastCalledWith(rows.get('a'),rows.get('b'),[rows.get('c')],new Map([[rows.get('c')!.content_hash,file]]));
    expect([...pcmFocus.mock.calls[0][0]]).toEqual([rows.get('a')!.content_hash,rows.get('b')!.content_hash]);
    cached=true;await send();expect(focus.mock.calls.at(-1)!.slice(0,3)).toEqual([rows.get('a'),rows.get('b'),[rows.get('c'),rows.get('d')]]);
    cached=false;ready=true;await send();expect(focus.mock.calls.at(-1)!.slice(0,3)).toEqual([rows.get('a'),rows.get('b'),[rows.get('c'),rows.get('d')]]);
    vi.mocked(getSettings).mockReturnValue({automix:{...DEFAULT_AUTOMIX_SETTINGS,enabled:false}} as ReturnType<typeof getSettings>);
    await send();expect(focus).toHaveBeenLastCalledWith();
    expect((await app.inject({method:'POST',url:'/api/analysis/focus',payload:{next:'bad',candidates:{}}})).statusCode).toBe(200);
  }finally{
    await app.close();fs.rmSync(file);fs.rmdirSync(dir);
  }
});
