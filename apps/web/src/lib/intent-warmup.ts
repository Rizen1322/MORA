import { useEffect, useRef } from 'react';

/** Metadata only, after sustained mouse/keyboard intent; touch never starts hover work. */
export function useIntentWarmup(provider: string, externalId: string, active: boolean) {
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; abort?: AbortController }>({});
  const stop = () => {
    clearTimeout(pending.current.timer);
    pending.current.abort?.abort();
    pending.current = {};
  };
  const start = () => {
    if (pending.current.timer || pending.current.abort) return;
    pending.current.timer = setTimeout(() => {
      const abort = new AbortController();
      pending.current.abort = abort;
      void fetch('/api/public/warmup', { method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, externalId }) }).catch(() => {});
    }, 600);
  };
  useEffect(() => { if (active) start(); else stop(); return stop; }, [provider, externalId, active]);
  return {
    onPointerEnter: (event: { pointerType: string }) => { if (event.pointerType === 'mouse') start(); },
    onPointerLeave: stop,
    onFocus: start,
    onBlur: stop,
  };
}
