import { useSyncExternalStore } from 'react';
import { controller, useApp } from '../store/app.ts';
import type { PhraseMixRecipe } from '@automix/core';

/**
 * "Послушать переход" in the queue: the server renders the planned blend into a short WAV
 * (same mixer core as the player). The player pauses meanwhile and resumes afterwards.
 */

type Snap = { playing: string | null; loading: string | null; position?: number; transitionStart?: number; transitionDuration?: number };
let snap: Snap = { playing: null, loading: null };
let current: { audio: HTMLAudioElement; url: string; resume: boolean } | null = null;
let request: AbortController | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const set = (s: Snap) => { snap = s; for (const l of listeners) l(); };

export function stopPreview(): void {
  generation++;
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
  return playPreviewRequest(key, signal => fetch(`/api/automix/preview?from=${encodeURIComponent(fromTrackId)}&to=${encodeURIComponent(toTrackId)}&sr=44100`, { signal }));
}

/** An isolated rendered WAV; never replaces the user's queue or transport pair. */
export async function previewPhraseDraft(from: string, to: string, recipe?: PhraseMixRecipe): Promise<void> {
  const key = `phrase:${from}>${to}:${recipe ? 'draft' : 'auto'}`;
  return playPreviewRequest(key, signal => fetch('/api/automix/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, recipe }), signal }));
}

async function playPreviewRequest(key: string, render: (signal: AbortSignal) => Promise<Response>): Promise<void> {
  const again = snap.playing === key || snap.loading === key;
  stopPreview();
  if (again) return;
  const owner = generation;
  const ctl = new AbortController();
  request = ctl;
  set({ playing: null, loading: key });
  try {
    const res = await render(ctl.signal);
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `ошибка ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (ctl.signal.aborted || owner !== generation) { URL.revokeObjectURL(url); return; }
    request = null;
    const resume = controller.state.status === 'playing' || controller.state.status === 'buffering';
    if (resume) controller.pause();
    const audio = new Audio(url);
    const transitionStart = Number(res.headers.get('X-Transition-Start-Seconds') ?? res.headers.get('X-Transition-Start') ?? 0);
    const transitionDuration = Number(res.headers.get('X-Transition-Duration') ?? 0);
    current = { audio, url, resume };
    audio.onended = () => { if (current?.audio === audio) stopPreview(); };
    audio.onerror = () => {
      if (current?.audio !== audio) return;
      stopPreview();
      useApp.getState().toast('Не удалось воспроизвести переход', 'error');
    };
    audio.ontimeupdate = () => { if (current?.audio === audio) set({ ...snap, position: audio.currentTime }); };
    set({ playing: key, loading: null, position: 0, transitionStart, transitionDuration });
    await audio.play();
  } catch (e) {
    // A rejected play() from an already stopped Audio must not stop its successor.
    if (ctl.signal.aborted || owner !== generation) return;
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
