import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDiagnostics, type NativeDiagnostics } from '../src/bridge/diagnostics.ts';
import { playbackDiagnostics, safeTraceFields, tracePlayback, withPlaybackId } from '../../web/src/lib/playback-trace.ts';

const adapter = () => ({
  diagnosticsInfo: vi.fn(async () => ({ enabled: true })),
  diagnosticsRecord: vi.fn(async (_event: unknown) => {}),
  diagnosticsReport: vi.fn(async () => ({ events: [] })),
  diagnosticsClear: vi.fn(async () => {}), diagnosticsShare: vi.fn(async () => {}),
  diagnosticsTest: vi.fn(async (_o: unknown) => {}),
}) satisfies NativeDiagnostics;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', { hidden: false }); });
afterEach(() => vi.unstubAllGlobals());

describe('diagnostic journal bridge', () => {
  it('marks a run without erasing existing events and defaults recovery off', async () => {
    const native = adapter();
    await setupDiagnostics(native);
    const d = window.moraDiagnostics!;
    expect(d.allowAutoResume).toBe(false);
    d.record('controller.action', { action: 'play' });
    await d.mark();
    expect(native.diagnosticsClear).not.toHaveBeenCalled();
    expect(native.diagnosticsRecord).toHaveBeenCalledWith(expect.objectContaining({ stage: 'js.test.marker', fields: expect.objectContaining({ allowed: false }) }));
    expect(safeTraceFields({ duration: 180, rate: 1, mediaState: 'paused', route: 'webkit', kind: 'position', title: 'private' }))
      .toEqual({ duration: 180, rate: 1, mediaState: 'paused', route: 'webkit', kind: 'position' });
  });
  it('does nothing in production or an older native shell', async () => {
    const native = adapter();
    native.diagnosticsInfo.mockResolvedValueOnce({ enabled: false });
    await setupDiagnostics(native);
    tracePlayback('controller.action', { action: 'pause' });
    expect(playbackDiagnostics()).toBeUndefined();
    expect(native.diagnosticsRecord).not.toHaveBeenCalled();
    native.diagnosticsInfo.mockRejectedValueOnce(new Error('unimplemented'));
    await setupDiagnostics(native);
    expect(playbackDiagnostics()).toBeUndefined();
  });

  it('shares correlation across separately bundled helpers, restores context on throw and exports after draining', async () => {
    const native = adapter();
    await setupDiagnostics(native);
    // Simulate the independently bundled web helper reading the same window object.
    const web = await import('../../web/src/lib/playback-trace.ts?independent');
    expect(() => withPlaybackId('native-1', () => { web.tracePlayback('controller.action', { action: 'pause' }); throw new Error('test'); })).toThrow();
    expect(window.moraDiagnostics?.currentId).toBeUndefined();
    await window.moraDiagnostics!.share();
    expect(native.diagnosticsRecord).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'controller.action', fields: expect.objectContaining({ id: 'native-1', action: 'pause' }),
    }));
    expect(native.diagnosticsShare).toHaveBeenCalledOnce();
    window.moraDiagnostics!.setAutoResume(false);
    expect(window.moraDiagnostics!.allowAutoResume).toBe(false);
    await window.moraDiagnostics!.clear();
    expect(native.diagnosticsRecord).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'js.test.cleared', fields: expect.objectContaining({ allowed: false }) }));
  });

  it('drops track identity, credentials, raw errors, URLs, unexpected types and non-finite numbers', () => {
    expect(safeTraceFields({ id: 'native-1', position: 12, paused: true, title: 'secret', token: 'secret',
      url: 'https://private.example', error: 'secret', action: 'https://secret', status: 'bad text', peak: NaN,
      clock: Infinity, allowed: 'true', reason: 'visibilitychange' })).toEqual({ id: 'native-1', position: 12, paused: true, reason: 'visibilitychange' });
  });

  it('bounds outstanding bridge writes and waits for them before report export', async () => {
    const native = adapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    native.diagnosticsRecord.mockImplementation(() => gate);
    await setupDiagnostics(native);
    for (let i = 0; i < 200; i++) tracePlayback('test.event', { seq: i });
    expect(native.diagnosticsRecord).toHaveBeenCalledTimes(64);
    const report = window.moraDiagnostics!.report();
    expect(native.diagnosticsReport).not.toHaveBeenCalled();
    release(); await report;
    expect(native.diagnosticsReport).toHaveBeenCalledOnce();
  });
});
