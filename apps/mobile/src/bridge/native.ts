import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FetchArgs, FetchResult } from '../shared/protocol.ts';

/**
 * The native side of the iOS app (ios/App/App/MoraAudioPlugin.swift):
 * Audio interruptions, route changes and power state. WebKit owns Now Playing
 * and lock-screen commands; publishing a second native player made the clock
 * and the enabled commands refer to different players.
 */

interface MoraAudio {
  setPlaybackState(o: { playing: boolean; webAudioSession: boolean }): Promise<void>;
  addListener(ev: 'command', fn: (e: { action: MediaSessionAction; seekTime?: number }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'power', fn: (e: Power) => void): Promise<PluginListenerHandle>;
  power(): Promise<Power>;
  secretKey(): Promise<{ key: string }>;
}
/** ProcessInfo.thermalState (0 nominal … 3 critical) and Low Power Mode. */
interface Power { thermal: number; lowPower: boolean }
const MoraAudio = registerPlugin<MoraAudio>('MoraAudio');

export const isNative = (): boolean => Capacitor.isNativePlatform();

/** The Keychain key for provider secrets. null in a browser, or with a native build that predates it:
 * the library then starts as before (sealed secrets stay sealed, plain ones readable). */
export async function secretKey(): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const r = await Promise.race([MoraAudio.secretKey(), new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
    return r && /^[0-9a-f]{64}$/i.test(r.key) ? r.key : null;
  } catch { return null; }
}

/** Native HTTP (no CORS, any User-Agent); body comes back as base64. */
export async function nativeRequest(a: FetchArgs, signal: AbortSignal): Promise<FetchResult> {
  signal.throwIfAborted();
  if (a.body instanceof ArrayBuffer) throw new Error('двоичное тело запроса не поддерживается');
  const r = await CapacitorHttp.request({
    url: a.url, method: a.method, headers: a.headers, data: a.body ?? undefined,
    responseType: 'arraybuffer', connectTimeout: 20000, readTimeout: 60000, disableRedirects: false,
  });
  signal.throwIfAborted();
  const data = r.data as unknown;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
  // Capacitor parses application/json bodies itself (ignoring responseType): those are never base64.
  const json = /application\/json/i.test(headers['content-type'] ?? '');
  const body = typeof data === 'string' && !json ? await (await fetch(`data:application/octet-stream;base64,${data}`)).arrayBuffer()
    : data instanceof ArrayBuffer ? data : new TextEncoder().encode(JSON.stringify(data ?? '')).buffer as ArrayBuffer;
  return { status: r.status, url: r.url ?? a.url, headers, body };
}

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function artworkBase64(src: string | undefined, apiFetch: ApiFetch): Promise<{ base64: string; mime: string } | undefined> {
  if (!src) return undefined;
  try {
    const u = new URL(src, location.href);
    // remote artwork through native HTTP: no CORS, and no Referer (YouTube Music artwork refuses one)
    let buf: ArrayBuffer;
    let mime: string;
    if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
      const res = await apiFetch(u.pathname + u.search);
      if (!res.ok) return undefined;
      buf = await res.arrayBuffer();
      mime = res.headers.get('content-type') ?? 'image/jpeg';
    } else {
      const res = await nativeRequest({ url: u.href, method: 'GET', headers: {}, body: null }, new AbortController().signal);
      if (res.status < 200 || res.status >= 300) return undefined;
      buf = res.body;
      mime = res.headers['content-type'] ?? 'image/jpeg';
    }
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(s), mime: /^image\/(jpeg|png|webp)$/i.test(mime) ? mime : 'image/jpeg' };
  } catch { return undefined; }
}

export function setupNative(apiFetch: ApiFetch, onPower: (saver: boolean) => void): void {
  if (!isNative()) return;
  // Apple: from "fair" on (and in Low Power Mode) cut animations and deferrable work.
  // html[data-power=saver] stills the canvas backdrops (useReducedMotion); the worker defers render checks.
  const power = ({ thermal, lowPower }: Power) => {
    const saver = thermal >= 1 || lowPower;
    if (saver) document.documentElement.dataset.power = 'saver'; else delete document.documentElement.dataset.power;
    window.dispatchEvent(new Event('mora-power'));
    onPower(saver);
  };
  void MoraAudio.addListener('power', power);
  void MoraAudio.power().then(power, () => {});
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const webAudioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession?.type === 'playback';
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const registerAction = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (action, handler) => {
    handlers.set(action, handler);
    try { registerAction(action, handler); } catch { /* action unsupported by this WebKit */ }
  };
  void MoraAudio.addListener('command', ({ action, seekTime }) => {
    handlers.get(action)?.({ action, seekTime } as MediaSessionActionDetails);
  });

  let duration = 0, position = 0, rate = 1, playing = false, nowKey = '', sentAt = 0, publishedAt = -Infinity;
  const origPos = ms.setPositionState?.bind(ms);
  const publishPosition = () => {
    if (!(duration > 0)) return;
    const elapsed = playing ? (performance.now() - sentAt) / 1000 * rate : 0;
    try { origPos?.({ duration, position: Math.max(0, Math.min(duration, position + elapsed)), playbackRate: rate }); }
    catch { /* WebKit may reject position state during startup */ }
    publishedAt = performance.now();
  };
  let current: MediaMetadata | null = null;
  const metadata = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ms), 'metadata');
  Object.defineProperty(ms, 'metadata', {
    configurable: true,
    get: () => current,
    set: (m: MediaMetadata | null) => {
      current = m;
      if (!m) { nowKey = ''; metadata?.set?.call(ms, null); origPos?.(); return; }
      // artwork in the key: a wave track's cover often arrives after its title
      const key = `${m.title}\u0000${m.artist}\u0000${m.album}\u0000${m.artwork?.[0]?.src ?? ''}`;
      if (key === nowKey) return;
      nowKey = key;
      // WebKit may publish WebAudio's own Now Playing: without metadata it uses "localhost".
      metadata?.set?.call(ms, m);
      publishPosition();
      void artworkBase64(m.artwork?.[0]?.src, apiFetch).then((artwork) => {
        if (artwork && nowKey === key) {
          metadata?.set?.call(ms, new MediaMetadata({ title: m.title, artist: m.artist, album: m.album,
            artwork: [{ src: `data:${artwork.mime};base64,${artwork.base64}`, sizes: '512x512' }] }));
          publishPosition();
        }
      });
    },
  });
  ms.setPositionState = (s?: MediaPositionState) => {
    if (!s) return;
    const d = s.duration ?? duration, p = s.position ?? position, r = s.playbackRate ?? rate;
    // The player reports ~20×/s; iOS advances Now Playing's clock by itself, so a seek or rate change
    // publishes immediately, with a bounded 2 s correction for the system clock.
    const expected = position + (playing ? ((performance.now() - sentAt) / 1000) * rate : 0);
    if (d === duration && r === rate && Math.abs(p - expected) < 0.5 && performance.now() - publishedAt < 2000) return;
    duration = d; position = p; rate = r; sentAt = performance.now();
    publishPosition();
  };

  // play/pause state comes from the player itself (window.automix = controller, see apps/web main.tsx)
  const attach = () => {
    const c = (window as unknown as { automix?: { subscribe(fn: (s: { status: string; position?: number }) => void): void } }).automix;
    if (!c) { setTimeout(attach, 300); return; }
    c.subscribe((s) => {
      const now = s.status === 'playing';
      if (now === playing) return;
      playing = now;
      ms.playbackState = playing ? 'playing' : 'paused';
      if (typeof s.position === 'number') position = s.position;
      sentAt = performance.now();
      publishPosition();
      void MoraAudio.setPlaybackState({ playing, webAudioSession });
    });
  };
  attach();
}
