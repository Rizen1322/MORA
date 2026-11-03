import { describe, expect, it, vi } from 'vitest';
import { createNativeProbe } from '../src/bridge/native-probe.ts';

const state = { active: true, playing: true, index: 0, position: 0, duration: 90 };
function setup() {
  const order: string[] = [];
  const port = {
    nativeProbeStart: vi.fn(async () => { order.push('start'); return state; }),
    nativeProbeStop: vi.fn(async () => { order.push('stop'); }),
    nativeProbeState: vi.fn(async () => state),
    nativeProbeCommand: vi.fn(async (_o: unknown) => state),
  };
  const hooks = { prepare: vi.fn(async () => { order.push('prepare'); }), restore: vi.fn(() => { order.push('restore'); }) };
  return { port, hooks, order, probe: createNativeProbe(port, hooks) };
}
describe('independent native playback probe', () => {
  it('silences WebKit before native audio and restores it only after native audio stops', async () => {
    const { probe, order } = setup();
    await probe.start(); await probe.stop();
    expect(order).toEqual(['prepare', 'start', 'stop', 'restore']);
  });
  it('cleans up native ownership and restores WebKit after a failed native start', async () => {
    const { probe, port, order } = setup();
    port.nativeProbeStart.mockImplementationOnce(async () => { order.push('start'); throw new Error('failed'); });
    await expect(probe.start()).rejects.toThrow('failed');
    expect(order).toEqual(['prepare', 'start', 'stop', 'restore']);
  });
  it('does not restart WebKit if native stop failed and the owner is uncertain', async () => {
    const { probe, port, hooks } = setup();
    await probe.start();
    port.nativeProbeStop.mockRejectedValueOnce(new Error('stop failed'));
    await expect(probe.stop()).rejects.toThrow('stop failed');
    expect(hooks.restore).not.toHaveBeenCalled();
  });
  it('sends commands directly to the native host, independent of the controller', async () => {
    const { probe, port } = setup();
    await probe.command('seekto', 60);
    expect(port.nativeProbeCommand).toHaveBeenCalledExactlyOnceWith({ action: 'seekto', seekTime: 60 });
    expect(await probe.state()).toEqual(state);
  });
  it('serializes Stop after an outstanding Start and does not start an active probe twice', async () => {
    const { probe, port, order } = setup();
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { ready = resolve; });
    port.nativeProbeStart.mockImplementationOnce(async () => { order.push('start'); await gate; return state; });
    const start = probe.start();
    const stop = probe.stop();
    await Promise.resolve(); await Promise.resolve();
    expect(port.nativeProbeStop).not.toHaveBeenCalled();
    ready(); await start; await stop;
    expect(order).toEqual(['prepare', 'start', 'stop', 'restore']);
    await probe.start(); await probe.start();
    expect(port.nativeProbeStart).toHaveBeenCalledTimes(2);
  });
});
