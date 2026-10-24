import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/audio/controller.ts',()=>({PlayerController:class{
  state={queue:[{trackId:'a'},{trackId:'b'}],index:0};
  subscribe(){return ()=>{};}
  onAnalysisDone=vi.fn();
}}));
vi.mock('../src/lib/api.ts',()=>({api:{library:vi.fn(async()=>({tracks:[]}))}}));
import {connectEvents,controller,useApp} from '../src/store/app.ts';
import {api} from '../src/lib/api.ts';

class Stream {
  static all:Stream[]=[];
  onopen:(()=>void)|null=null;
  onmessage:((e:{data:string})=>void)|null=null;
  onerror:(()=>void)|null=null;
  close=vi.fn();
  constructor(){Stream.all.push(this);}
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();Stream.all=[];});
it('refreshes ready words without sending a word-completion notification into the audio planner',()=>{
  vi.stubGlobal('EventSource',Stream);useApp.setState({serverOnline:true,lyricsReady:null});
  const close=connectEvents();
  try{
    Stream.all[0].onmessage!({data:JSON.stringify({type:'lyrics',trackId:'a',hash:'abc'})});
    expect(useApp.getState().lyricsReady).toEqual({trackId:'a',hash:'abc'});
    expect(controller.onAnalysisDone).not.toHaveBeenCalled();
    expect(api.library).not.toHaveBeenCalled();
  }finally{close();}
});
it('resynchronizes current/next readiness after a dropped SSE connection',async()=>{
  vi.useFakeTimers();vi.stubGlobal('EventSource',Stream);useApp.setState({serverOnline:true});
  const close=connectEvents();
  try{
    Stream.all[0].onerror!();expect(useApp.getState().serverOnline).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);Stream.all[1].onopen!();
    await Promise.resolve();await Promise.resolve();
    expect(api.library).toHaveBeenCalledOnce();
    expect(controller.onAnalysisDone).toHaveBeenCalledWith('a');expect(controller.onAnalysisDone).toHaveBeenCalledWith('b');
    expect(useApp.getState().lyricsReady?.trackId).toBe('a');
  }finally{close();}
});
it('cancels a pending library reload when the event subscription closes',async()=>{
  vi.useFakeTimers();vi.stubGlobal('EventSource',Stream);
  const close=connectEvents();
  Stream.all[0].onmessage!({data:JSON.stringify({type:'library',reason:'test'})});
  close();await vi.advanceTimersByTimeAsync(1000);
  expect(api.library).not.toHaveBeenCalled();
});
