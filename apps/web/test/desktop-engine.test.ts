import { expect, it, vi } from 'vitest';
import { createDesktopEngine, DesktopAnalyser, DesktopAudioContext } from '../src/audio/desktop-engine.ts';
import type { DesktopBridge } from '../src/lib/desktop.ts';

it('uses native commands and events without constructing a browser AudioContext', async () => {
  let emit!: (event: any) => void;
  const unsubscribe = vi.fn(), command = vi.fn(async () => {}), errors = vi.fn(), events = vi.fn();
  const bridge = { audioStart: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })), audioCommand: command,
    onAudio: (cb: typeof emit) => { emit = cb; return unsubscribe; } } as unknown as DesktopBridge;
  const engine = await createDesktopEngine(bridge, events, errors);
  engine.node.port.postMessage({ cmd: 'pause', paused: true });
  expect(command).toHaveBeenCalledWith({ cmd: 'pause', paused: true });
  await engine.context.suspend(); expect(engine.context.state).toBe('suspended');
  await engine.context.resume(); expect(engine.context.state).toBe('running');
  emit({ type: 'tick', clock: 128 }); expect(events).toHaveBeenCalledWith({ type: 'tick', clock: 128 });
  emit({ type: 'fatal', error: 'device lost' }); emit({ type: 'fatal', error: 'again' });
  engine.node.port.postMessage({ cmd: 'stop' });
  expect(errors).toHaveBeenCalledTimes(1);
  engine.unsubscribe();expect(unsubscribe).toHaveBeenCalledOnce();
});

it('keeps the spectrum and waveform connected to native PCM', () => {
  const analyser = new DesktopAnalyser(new DesktopAudioContext(48000, 2048, {} as DesktopBridge));
  analyser.feed(Array.from({ length: 2048 }, (_, i) => .5 * Math.sin(2 * Math.PI * 32 * i / 2048)));
  const bins = new Float32Array(1024), waveform = new Float32Array(2048), bytes = new Uint8Array(1024);
  analyser.getFloatFrequencyData(bins);analyser.getFloatTimeDomainData(waveform);analyser.getByteFrequencyData(bytes);
  expect(bins.indexOf(Math.max(...bins))).toBe(32);
  expect(Math.max(...waveform)).toBeCloseTo(.5);
  expect(bytes[32]).toBeGreaterThan(0);
  analyser.feed([NaN]);analyser.getFloatTimeDomainData(waveform);
  expect(Math.max(...waveform)).toBeCloseTo(.5);
});

it('rejects readiness when the native child failed before the start promise resumed', async () => {
  let emit!: (event: any) => void;
  const unsubscribe = vi.fn(), errors = vi.fn();
  const bridge = { onAudio: (cb: typeof emit) => { emit = cb; return unsubscribe; },
    audioStart: async () => { emit({ type: 'fatal', error: 'startup crash' }); return { sampleRate: 48000, queueFrames: 2048 }; } } as unknown as DesktopBridge;
  await expect(createDesktopEngine(bridge, vi.fn(), errors)).rejects.toThrow('startup crash');
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledOnce();
});
