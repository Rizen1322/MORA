import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FetchArgs, FetchResult } from '../shared/protocol.ts';
import { setupDiagnostics, type NativeDiagnostics } from './diagnostics.ts';
import { createNativeProbe, type NativeProbePort } from './native-probe.ts';
import { playbackDiagnostics, tracePlayback, withPlaybackId, type NativePlaybackControls, type NavigationRoute } from '../../../web/src/lib/playback-trace.ts';

/**
 * The native side of the iOS app (ios/App/App/MoraAudioPlugin.swift):
 * Audio interruptions, route changes, power state and remote navigation.
 * WebKit owns Now Playing metadata. Diagnostic routes compare all-WebKit
 * commands with the previous split navigation path; neither proves ownership.
 */

interface MoraAudio extends NativeDiagnostics, NativeProbePort {
  setRemoteNavigation(o: { actions: MediaSessionAction[]; seekable: boolean; route: NavigationRoute; epoch?: number }): Promise<void>;
  setPlaybackState(o: { playing: boolean; intentPlaying: boolean; webAudioSession: boolean }): Promise<void>;
  addListener(ev: 'command', fn: (e: { action: MediaSessionAction; seekTime?: number; id?: string; source?: string; routeEpoch?: number }) => void): Promise<PluginListenerHandle>;
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
  void setupDiagnostics(MoraAudio);
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
  const dispatch = (action: MediaSessionAction, details: MediaSessionActionDetails, source: string, nativeId?: string) => {
    if (window.moraNativePlayback?.probeActive) { tracePlayback('js.command.probeBlocked', { action, source }); return; }
    const d = playbackDiagnostics(), handler = handlers.get(action);
    if (!d) { handler?.(details); return; }
    const id = nativeId ?? d.nextId();
    tracePlayback('js.command.received', { id, action, source, seekTime: details.seekTime });
    if (!handler) { tracePlayback('js.command.missingHandler', { id, action }); return; }
    try {
      const result = withPlaybackId(id, () => handler(details));
      void Promise.resolve(result).then(
        () => tracePlayback('js.handler.resolved', { id, action }),
        () => tracePlayback('js.handler.rejected', { id, action }),
      );
    } catch { tracePlayback('js.handler.threw', { id, action }); }
  };
  const wrapped = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    if (!handler) return null;
    const epoch = routeEpoch;
    return (details: MediaSessionActionDetails) => {
      if (navigation.has(action) && (epoch !== routeEpoch || nativeNavigation || switching)) {
        tracePlayback('js.command.oldRoute', { action, source: 'webkit' }); return;
      }
      dispatch(action, details, 'webkit');
    };
  };
  const navigation = new Set<MediaSessionAction>(['nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward']);
  let nativeNavigation = false, seekable = false, switching = false;
  let routeEpoch = 0;
  let routeQueue = MoraAudio.setRemoteNavigation({ actions: [], seekable: false, route: 'webkit', epoch: routeEpoch }).catch(() => {});
  const registerHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    const blocked = !!window.moraNativePlayback?.probeActive || ((nativeNavigation || switching) && navigation.has(action));
    let outcome = 'accepted';
    try { registerAction(action, blocked ? null : wrapped(action, handler)); } catch { outcome = 'rejected'; }
    tracePlayback('js.handler.register', { action, allowed: !!handler, source: blocked ? 'native' : 'webkit', outcome });
  };
  const registerNavigation = () => {
    for (const [action, handler] of handlers) if (navigation.has(action)) registerHandler(action, handler);
  };
  const nativeActions = () => [...handlers].filter(([action, handler]) => navigation.has(action) && handler).map(([action]) => action);
  const controls: NativePlaybackControls = {
    route: 'webkit',
    setRoute(route) {
      const change = routeQueue.then(async () => {
        if (controls.probeActive) throw new Error('Stop native audio probe before changing routes');
        if (route !== 'webkit' && route !== 'native') throw new Error('Unknown navigation route');
        switching = true;
        routeEpoch++;
        registerNavigation(); // Remove WebKit navigation before enabling the other route.
        try {
          await MoraAudio.setRemoteNavigation({ actions: [], seekable: false, route: 'webkit', epoch: routeEpoch });
          if (route === 'native') await MoraAudio.setRemoteNavigation({ actions: nativeActions(), seekable, route, epoch: routeEpoch });
          nativeNavigation = route === 'native';
          controls.route = route;
          tracePlayback('js.route.changed', { route, outcome: 'accepted' });
        } catch {
          nativeNavigation = false; controls.route = 'webkit';
          tracePlayback('js.route.changed', { route, outcome: 'rejected' });
          throw new Error('Navigation route unavailable');
        } finally { switching = false; registerNavigation(); }
      });
      routeQueue = change.catch(() => {});
      return change;
    },
  };
  window.moraNativePlayback = controls;
  const syncNavigation = () => {
    if (!nativeNavigation || switching) return;
    void MoraAudio.setRemoteNavigation({
      actions: nativeActions(), seekable, route: 'native', epoch: routeEpoch,
    }).catch(() => {
      if (nativeNavigation && !switching) void controls.setRoute('webkit').catch(() => {});
    });
  };
  ms.setActionHandler = (action, handler) => {
    handlers.set(action, handler);
    // Exactly one navigation route at a time; Play/Pause stay with WebKit.
    registerHandler(action, handler);
    if (navigation.has(action)) syncNavigation();
  };
  void MoraAudio.addListener('command', ({ action, seekTime, id, source, routeEpoch: eventEpoch }) => {
    if (source === 'remote' && (switching || !nativeNavigation || (eventEpoch !== undefined && eventEpoch !== routeEpoch))) {
      tracePlayback('js.command.oldRoute', { id, action, source }); return;
    }
    dispatch(action, { action, seekTime } as MediaSessionActionDetails, source ?? 'native', id);
  });

  let duration = 0, position = 0, rate = 1, playing = false, nowKey = '', sentAt = 0, publishedAt = -Infinity;
  let intentPlaying = false, metadataSeq = 0, forceNextPosition = false;
  const origPos = ms.setPositionState?.bind(ms);
  const publishPosition = (reason = 'tick') => {
    if (controls.probeActive) return;
    if (!(duration > 0) || !Number.isFinite(duration) || !Number.isFinite(position) || !Number.isFinite(rate) || rate === 0) return;
    const elapsed = playing ? (performance.now() - sentAt) / 1000 * rate : 0;
    const p = Math.max(0, Math.min(duration, position + elapsed));
    let outcome = 'unavailable';
    try {
      if (origPos) { origPos({ duration, position: p, playbackRate: rate }); outcome = 'accepted'; }
    } catch { outcome = 'rejected'; }
    tracePlayback('js.media.publish', { kind: 'position', position: p, duration, rate, playing,
      mediaState: ms.playbackState, route: controls.route, reason, seq: metadataSeq, outcome });
    if (outcome === 'accepted') publishedAt = performance.now();
    seekable = outcome === 'accepted';
    syncNavigation();
  };
  let current: MediaMetadata | null = null;
  const metadata = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ms), 'metadata');
  Object.defineProperty(ms, 'metadata', {
    configurable: true,
    get: () => current,
    set: (m: MediaMetadata | null) => {
      current = m;
      if (controls.probeActive) return;
      if (!m) {
        nowKey = ''; duration = 0; seekable = false; metadata?.set?.call(ms, null); origPos?.(); syncNavigation();
        tracePlayback('js.media.publish', { kind: 'metadata', reason: 'clear', seq: metadataSeq, route: controls.route }); return;
      }
      // artwork in the key: a wave track's cover often arrives after its title
      const key = `${m.title}\u0000${m.artist}\u0000${m.album}\u0000${m.artwork?.[0]?.src ?? ''}`;
      if (key === nowKey) return;
      nowKey = key;
      metadataSeq++;
      // WebKit may publish WebAudio's own Now Playing: without metadata it uses "localhost".
      metadata?.set?.call(ms, m);
      tracePlayback('js.media.publish', { kind: 'metadata', reason: 'track', seq: metadataSeq, route: controls.route });
      publishPosition('metadata');
      void artworkBase64(m.artwork?.[0]?.src, apiFetch).then((artwork) => {
        if (artwork && nowKey === key) {
          metadata?.set?.call(ms, new MediaMetadata({ title: m.title, artist: m.artist, album: m.album,
            artwork: [{ src: `data:${artwork.mime};base64,${artwork.base64}`, sizes: '512x512' }] }));
          tracePlayback('js.media.publish', { kind: 'metadata', reason: 'artwork', seq: metadataSeq, route: controls.route });
          publishPosition('artwork');
        }
      });
    },
  });
  ms.setPositionState = (s?: MediaPositionState) => {
    if (controls.probeActive) return;
    if (!s) return;
    const d = s.duration ?? duration, p = s.position ?? position, r = s.playbackRate ?? rate;
    // The player reports ~20×/s; iOS advances Now Playing's clock by itself, so a seek or rate change
    // publishes immediately, with a bounded 2 s correction for the system clock.
    const expected = position + (playing ? ((performance.now() - sentAt) / 1000) * rate : 0);
    if (seekable && !forceNextPosition && d === duration && r === rate && Math.abs(p - expected) < (playing ? 0.5 : 1e-6) && (!playing || performance.now() - publishedAt < 2000)) return;
    forceNextPosition = false;
    duration = d; position = p; rate = r; sentAt = performance.now();
    publishPosition('tick');
  };

  const syncPlayback = (reason: string, currentPosition?: number) => {
    if (controls.probeActive) return;
    const context = controls.contextState;
    const now = intentPlaying && (context === undefined || context === 'running');
    if (now === playing && reason !== 'context') return;
    // Freeze/resume the system clock at the real last engine position. This is
    // effective playback state; it does not infer or overwrite the user's intent.
    const actualPosition = currentPosition ?? controls.snapshot?.().position;
    if (typeof actualPosition === 'number') position = actualPosition;
    else if (playing) position = Math.max(0, Math.min(duration, position + (performance.now() - sentAt) / 1000 * rate));
    playing = now; sentAt = performance.now(); forceNextPosition = true;
    try { ms.playbackState = playing ? 'playing' : 'paused'; }
    catch { tracePlayback('js.media.stateRejected', { playing, context }); }
    tracePlayback('js.media.publish', { kind: 'state', playing, context, mediaState: ms.playbackState, route: controls.route, reason });
    publishPosition(reason);
    void MoraAudio.setPlaybackState({ playing, intentPlaying, webAudioSession });
  };
  let lastContext = controls.contextState;
  window.addEventListener('mora-context-state', () => {
    if (controls.contextState === lastContext) return;
    lastContext = controls.contextState;
    syncPlayback('context');
  });

  // play/pause state comes from the player itself (window.automix = controller, see apps/web main.tsx)
  const attach = () => {
    const c = (window as unknown as { automix?: { subscribe(fn: (s: { status: string; position?: number }) => void): void } }).automix;
    if (!c) { setTimeout(attach, 300); return; }
    c.subscribe((s) => {
      const now = s.status === 'playing';
      if (now === intentPlaying) return;
      intentPlaying = now;
      tracePlayback('js.playbackState', { status: s.status, playing: now, position: s.position, webAudioSession });
      syncPlayback('intent', s.position);
    });
  };
  attach();

  const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  let previousAudioType: string | undefined;
  controls.probe = createNativeProbe(MoraAudio, {
    async prepare() {
      await controls.setRoute('webkit');
      controls.probeActive = true;
      await controls.suspend?.();
      if (controls.contextState === 'running') throw new Error('Web audio is still running');
      for (const [action] of handlers) registerHandler(action, null);
      metadata?.set?.call(ms, null); origPos?.(); ms.playbackState = 'none';
      previousAudioType = audioSession?.type;
      if (audioSession) audioSession.type = 'auto';
      tracePlayback('js.probe.prepared', { context: controls.contextState, probeActive: true });
    },
    restore() {
      controls.probeActive = false;
      if (audioSession && previousAudioType !== undefined) audioSession.type = previousAudioType;
      previousAudioType = undefined;
      for (const [action, handler] of handlers) registerHandler(action, handler);
      intentPlaying = false;
      syncPlayback('probe-stop');
      const cached = current; nowKey = '';
      ms.metadata = cached;
      tracePlayback('js.probe.restored', { context: controls.contextState, probeActive: false });
    },
  });
  // WebContent can reload independently while the native player continues.
  // Recover the guard before allowing a new WebAudio session in that page.
  controls.ready = Promise.resolve().then(() => MoraAudio.nativeProbeState()).then(async (state) => {
    if (!state.active) return;
    controls.probeActive = true;
    await controls.suspend?.();
    previousAudioType = audioSession?.type;
    if (audioSession) audioSession.type = 'auto';
    for (const [action] of handlers) registerHandler(action, null);
    tracePlayback('js.probe.recovered', { context: controls.contextState, probeActive: true });
  }).catch(() => {});
}
