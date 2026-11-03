import { nativePlaybackControls, safeTraceFields, type PlaybackDiagnostics, type TraceFields } from '../../../web/src/lib/playback-trace.ts';

export interface NativeDiagnostics {
  diagnosticsInfo(): Promise<{ enabled: boolean }>;
  diagnosticsRecord(o: { stage: string; fields: TraceFields }): Promise<void>;
  diagnosticsReport(): Promise<Record<string, unknown>>;
  diagnosticsClear(): Promise<void>;
  diagnosticsShare(): Promise<void>;
  diagnosticsTest(o: { action: MediaSessionAction; seekTime?: number }): Promise<void>;
}

export async function setupDiagnostics(native: NativeDiagnostics): Promise<void> {
  // An old or production shell simply has no diagnostic surface.
  try { if (!(await native.diagnosticsInfo()).enabled) return; } catch { return; }
  let counter = 0;
  const session = Date.now().toString(36);
  const pending = new Set<Promise<void>>();
  const drain = async () => { await Promise.all([...pending]); };
  const snapshot = (): TraceFields => ({ ...nativePlaybackControls()?.snapshot?.(),
    route: nativePlaybackControls()?.route, probeActive: nativePlaybackControls()?.probeActive ?? false, allowed: d.allowAutoResume,
    hidden: document.hidden, mediaState: navigator.mediaSession?.playbackState });
  const d: PlaybackDiagnostics = {
    allowAutoResume: false,
    nextId: () => `js-${session}-${++counter}`,
    record(stage, fields = {}) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(stage)) return;
      // Bound the queue too: a slow native bridge must not grow memory indefinitely.
      if (pending.size >= 64) return;
      const p = native.diagnosticsRecord({ stage, fields: safeTraceFields({ ...fields, monotonicMs: performance.now() }) }).catch(() => {});
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async mark() { d.record('js.test.marker', snapshot()); await drain(); },
    async report() { d.record('js.snapshot', snapshot()); await drain(); return native.diagnosticsReport(); },
    async clear() { await drain(); await native.diagnosticsClear(); d.record('js.test.cleared', snapshot()); },
    async share() { d.record('js.export', snapshot()); await drain(); await native.diagnosticsShare(); },
    async test(action, seekTime) {
      const controls = nativePlaybackControls();
      if (controls?.mixActive && controls.mix) { await controls.mix.command(action, seekTime); return; }
      if (controls?.probeActive && controls.probe) { await controls.probe.command(action, seekTime); return; }
      await native.diagnosticsTest({ action, seekTime });
    },
    setAutoResume(enabled) { d.allowAutoResume = enabled; d.record('js.autoResume.option', { allowed: enabled }); },
  };
  window.moraDiagnostics = d;
  d.record('js.ready', snapshot());
  window.dispatchEvent(new Event('mora-diagnostics-ready'));
}
