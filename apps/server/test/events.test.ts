import {EventEmitter} from 'node:events';
import type {FastifyReply} from 'fastify';
import {expect,it,vi} from 'vitest';
import {EventHub} from '../src/events.ts';

it('disconnects a backed-up SSE socket without starving healthy clients or local listeners',()=>{
  const hub=new EventHub(),listener=vi.fn();hub.on(listener);
  const slow=Object.assign(new EventEmitter(),{destroyed:false,writableLength:0,write:vi.fn(()=>{slow.writableLength+=100_000;return false;}),destroy:vi.fn()});
  const fast=Object.assign(new EventEmitter(),{destroyed:false,writableLength:0,write:vi.fn(()=>true),destroy:vi.fn()});
  hub.add({raw:slow} as unknown as FastifyReply);hub.add({raw:fast} as unknown as FastifyReply);
  for(let i=0;i<5;i++)hub.emit({type:'library',reason:'test'});
  expect(slow.write).toHaveBeenCalledTimes(3);expect(slow.destroy).toHaveBeenCalledOnce();
  expect(fast.write).toHaveBeenCalledTimes(5);expect(listener).toHaveBeenCalledTimes(5);
  hub.heartbeat();expect(slow.write).toHaveBeenCalledTimes(3);expect(fast.write).toHaveBeenCalledTimes(6);
});
