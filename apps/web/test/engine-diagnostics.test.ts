import { afterEach, expect, it, vi } from 'vitest';
import type { EngineCommand, EngineEvent } from '../src/audio/engine.worklet.ts';
import { CHUNK_FRAMES } from '@automix/core';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('distinguishes command receipt from rendering the completed pause fade, without exporting tokens', async () => {
  const events: EngineEvent[] = [];
  let Processor: any;
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { postMessage: (event: EngineEvent) => events.push(event), onmessage: null };
  });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: unknown) => { Processor = ctor; });
  await import('../src/audio/engine.worklet.ts');
  const processor = new Processor();
  const send = (data: EngineCommand) => processor.port.onmessage({ data });
  send({ cmd: 'load', deck: 0, token: 'private-track-token', totalFrames: 48000, gainDb: 0, cueFrame: 0 });
  send({ cmd: 'feed', deck: 0, token: 'private-track-token', chunk: 0, L: new Float32Array(CHUNK_FRAMES).fill(.25), R: new Float32Array(CHUNK_FRAMES).fill(.25) });
  send({ cmd: 'start', deck: 0, token: 'private-track-token', frame: 0 });
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < 12; i++) processor.process([], [[L, R]]);
  expect(Math.max(...L)).toBeGreaterThan(.01);
  send({ cmd: 'pause', paused: true, diagnostic: { id: 'native-1', seq: 1 } });
  const diagnostic = () => events.filter((e) => e.type === 'diagnostic');
  expect(diagnostic()).toEqual([expect.objectContaining({ stage: 'engine.ack', id: 'native-1', seq: 1, paused: false })]);
  for (let i = 0; i < 200; i++) processor.process([], [[L, R]]);
  expect(diagnostic()).toEqual([
    expect.objectContaining({ stage: 'engine.ack', id: 'native-1', seq: 1 }),
    expect.objectContaining({ stage: 'engine.render', id: 'native-1', seq: 1, command: 'pause', paused: true, peak: 0 }),
  ]);
  expect(JSON.stringify(diagnostic())).not.toContain('private-track-token');
  send({ cmd: 'pause', paused: false });
  processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
  expect(diagnostic()).toHaveLength(2); // No diagnostic work in ordinary commands.
});
