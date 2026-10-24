import { useSyncExternalStore } from 'react';
import { controller, useApp } from '../store/app.ts';

/**
 * "Послушать переход" in the queue: the server renders the planned blend into a short WAV
 * (same mixer core as the player). The player pauses meanwhile and resumes afterwards.
 */

type Snap = { playing: string | null; loading: string | null };
let snap: Snap = { playing: null, loading: null };
let current: { audio: HTMLAudioElement; url: string; resume: boolean } | null = null;
let request: AbortController | null = null;
const listeners = new Set<() => void>();
const set = (s: Snap) => { snap = s; for (const l of listeners) l(); };

export function stopPreview(): void {
  request?.abort();
  request = null;
  const c = current;
  current = null;
  if (c) {
    c.audio.pause();
    URL.revokeObjectURL(c.url);
    if (c.resume && controller.state.status === 'paused') controller.toggle();
  }
  set({ playing: null, loading: null });
}

export async function togglePreview(fromTrackId: string, toTrackId: string): Promise<void> {
  const key = `${fromTrackId}>${toTrackId}`;
  const again = snap.playing === key || snap.loading === key;
  stopPreview();
  if (again) return;
  const ctl = new AbortController();
  request = ctl;
  set({ playing: null, loading: key });
  try {
    const res = await fetch(`/api/automix/preview?from=${encodeURIComponent(fromTrackId)}&to=${encodeURIComponent(toTrackId)}&sr=44100`, { signal: ctl.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `ошибка ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (ctl.signal.aborted) { URL.revokeObjectURL(url); return; }
    request = null;
    const resume = controller.state.status === 'playing' || controller.state.status === 'buffering';
    if (resume) controller.pause();
    const audio = new Audio(url);
    current = { audio, url, resume };
    audio.onended = () => { if (current?.audio === audio) stopPreview(); };
    set({ playing: key, loading: null });
    await audio.play();
  } catch (e) {
    if (ctl.signal.aborted) return;
    stopPreview();
    useApp.getState().toast(`Не удалось подготовить переход: ${(e as Error).message}`, 'error');
  }
}

// The listener pressed Play meanwhile: the preview yields without resuming anything itself.
controller.subscribe((s) => {
  if (current && s.status === 'playing') { current.resume = false; stopPreview(); }
});

export function usePreview(): Snap {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snap);
}
