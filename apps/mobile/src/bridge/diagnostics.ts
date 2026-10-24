import { safeTraceFields, type PlaybackDiagnostics, type TraceFields } from '../../../web/src/lib/playback-trace.ts';

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
  const d: PlaybackDiagnostics = {
    allowAutoResume: true,
    nextId: () => `js-${session}-${++counter}`,
    record(stage, fields = {}) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(stage)) return;
      // Bound the queue too: a slow native bridge must not grow memory indefinitely.
      if (pending.size >= 64) return;
      const p = native.diagnosticsRecord({ stage, fields: safeTraceFields({ ...fields, monotonicMs: performance.now() }) }).catch(() => {});
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async report() { d.record('js.snapshot', { allowed: d.allowAutoResume, hidden: document.hidden, status: navigator.mediaSession?.playbackState }); await drain(); return native.diagnosticsReport(); },
    async clear() { await drain(); await native.diagnosticsClear(); d.record('js.test.begin', { allowed: d.allowAutoResume }); },
    async share() { d.record('js.export', { allowed: d.allowAutoResume, hidden: document.hidden, status: navigator.mediaSession?.playbackState }); await drain(); await native.diagnosticsShare(); },
    test: (action, seekTime) => native.diagnosticsTest({ action, seekTime }),
    setAutoResume(enabled) { d.allowAutoResume = enabled; d.record('js.autoResume.option', { allowed: enabled }); },
  };
  window.moraDiagnostics = d;
  d.record('js.ready', { allowed: true, hidden: document.hidden });
  window.dispatchEvent(new Event('mora-diagnostics-ready'));
}
