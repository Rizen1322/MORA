import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ intent: 1, owner: null as number | null, left: 15, items: [] as any[], tracks: new Map<string, any>(), callbacks: [] as (()=>void)[], play: vi.fn(), extend: vi.fn(), search: vi.fn(), related: vi.fn(), toast: vi.fn() }));
vi.mock('../src/store/app.ts',()=>({controller:{unlockAudio:async()=>{},get intentVersion(){return h.intent},subscribe:(fn:()=>void)=>h.callbacks.push(fn)},useApp:{getState:()=>({tracks:h.tracks,settings:{wave:{mood:'normal',diversity:'balanced',mode:'mix'}},toast:h.toast})}}));
vi.mock('../src/store/catalog.ts',()=>({publicPlayer:{get sessionVersion(){return h.owner},get remaining(){return h.left},get sessionItems(){return h.items},play:(...args:any[])=>h.play(...args),extend:(...args:any[])=>h.extend(...args)}}));
vi.mock('../src/pages/Search.tsx',()=>({asCatalog:(t:any)=>t}));
vi.mock('../src/lib/api.ts',()=>({api:{publicSearch:(...args:any[])=>h.search(...args),publicRadio:(...args:any[])=>h.related(...args)}}));
const candidate=(id:string,artist='artist')=>({externalId:id,title:id,artist,playable:true,audioProvider:'youtube'});
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();h.callbacks.length=0;h.tracks.clear();h.intent=1;h.owner=null;h.left=15;h.items=[];
  h.tracks.set('liked',{id:'liked',title:'liked',artist:'favourite',reaction:1,status:'ok',addedAt:1,playCount:0,analysis:{}});
  h.search.mockImplementation(async()=>({items:[candidate('seed','favourite')]}));
  h.related.mockResolvedValue({items:[candidate('new','new artist')]});
  h.play.mockImplementation(async(items)=>{h.owner=1;h.items=items});h.extend.mockReturnValue(true);
});
describe('personal radio session ownership',()=>{
  it('starts a personal station using another liked seed if the first search fails',async()=>{
    h.tracks.set('second',{id:'second',title:'second',artist:'another',reaction:1,status:'ok',addedAt:2,playCount:0,analysis:{}});
    h.search.mockRejectedValueOnce(new Error('temporary search failure')).mockResolvedValue({items:[candidate('backup','favourite')]});
    const {startRadio,useRadio}=await import('../src/lib/radio.ts'); await startRadio();
    expect(h.play).toHaveBeenCalledOnce(); expect(useRadio.getState().active).toBe(true);
  });
  it('uses several liked artists and can start when one recommendation source fails',async()=>{
    h.tracks.set('second',{id:'second',title:'second',artist:'another',reaction:1,status:'ok',addedAt:2,playCount:0,analysis:{}});
    h.search.mockImplementation(async(_source,q:string)=>({items:[candidate(q,q.includes('another')?'another':'favourite')]}));
    h.related.mockRejectedValueOnce(new Error('one seed failed')).mockResolvedValue({items:[candidate('fresh','fresh artist')]});
    const {startRadio,useRadio}=await import('../src/lib/radio.ts');await startRadio();
    expect(h.search).toHaveBeenCalledTimes(2);expect(h.play).toHaveBeenCalledTimes(1);expect(useRadio.getState().active).toBe(true);
  });
  it('does not start a delayed radio after another playback command',async()=>{
    let resolve!:(v:any)=>void;h.related.mockReturnValueOnce(new Promise(r=>{resolve=r}));
    const {startRadio,useRadio}=await import('../src/lib/radio.ts');const task=startRadio();
    await vi.waitFor(()=>expect(h.related).toHaveBeenCalled());h.intent++;
    resolve({items:[candidate('late')]});await task;
    expect(h.play).not.toHaveBeenCalled();expect(useRadio.getState().loading).toBe(false);
  });
  it('rejects a refill if playback changed while its network request was pending',async()=>{
    const {startRadio}=await import('../src/lib/radio.ts');await startRadio();
    let resolve!:(v:any)=>void;h.related.mockImplementation(()=>new Promise(r=>{resolve=r}));h.left=2;
    h.callbacks.forEach(fn=>fn());await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
    h.owner=2;resolve({items:[candidate('stale')]});await new Promise(r=>setTimeout(r,0));
    expect(h.extend).not.toHaveBeenCalled();
  });
  it('shows a helpful empty-profile state instead of starting arbitrary popular songs',async()=>{
    h.tracks.clear();const {startRadio,useRadio}=await import('../src/lib/radio.ts');await startRadio();
    expect(h.search).not.toHaveBeenCalled();expect(h.play).not.toHaveBeenCalled();expect(useRadio.getState().error).toContain('лайк');
  });
  it('cancels old recommendation requests when a replacement station starts',async()=>{
    let oldSignal!:AbortSignal;
    h.related.mockImplementationOnce((_id:string,signal:AbortSignal)=>new Promise((_,reject)=>{
      oldSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }));
    const {startRadio}=await import('../src/lib/radio.ts');const old=startRadio();
    await vi.waitFor(()=>expect(oldSignal).toBeInstanceOf(AbortSignal));
    await startRadio();await old;
    expect(oldSignal.aborted).toBe(true);expect(h.play).toHaveBeenCalledOnce();
  });
  it('cancels refill networking when another playback session takes ownership',async()=>{
    const {startRadio}=await import('../src/lib/radio.ts');await startRadio();
    let refillSignal!:AbortSignal;
    h.related.mockImplementation((_id:string,signal:AbortSignal)=>new Promise((_,reject)=>{
      refillSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }));
    h.left=2;h.callbacks.forEach(fn=>fn());await vi.waitFor(()=>expect(refillSignal).toBeInstanceOf(AbortSignal));
    h.owner=2;h.callbacks.forEach(fn=>fn());await new Promise(r=>setTimeout(r,0));
    expect(refillSignal.aborted).toBe(true);expect(h.extend).not.toHaveBeenCalled();
  });
  it('does not cancel its own future refill when play changes transport intent',async()=>{
    h.play.mockImplementation(async(items)=>{h.owner=1;h.items=items;h.intent++;h.callbacks.forEach(fn=>fn())});
    const {startRadio}=await import('../src/lib/radio.ts');await startRadio();
    h.left=2;h.callbacks.forEach(fn=>fn());await vi.waitFor(()=>expect(h.extend).toHaveBeenCalled());
    expect(h.related.mock.calls.at(-1)?.[1].aborted).toBe(false);
  });
});
