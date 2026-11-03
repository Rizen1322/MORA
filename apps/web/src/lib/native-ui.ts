import { api, type PublicSource, type PublicTrack, type Track } from './api.ts';
import { nativePlaybackControls } from './playback-trace.ts';
import { startRadio, useRadio } from './radio.ts';
import { trackAlbumHref, trackArtistHref } from './router.ts';
import { controller, phone, trackOf, useApp } from '../store/app.ts';
import { publicPlayer, usePublicPlayback } from '../store/catalog.ts';
import { react } from '../components/TrackList.tsx';
import { asCatalog, SOURCE_LABEL } from '../pages/Search.tsx';
import { useVersionPanel } from '../components/VersionPanel.tsx';
import { actions, describe, type ActResult } from './native-pages.ts';

/**
 * iPhone native shell (ios/App/App/NativeShell.swift). Data path: this page stays the only owner of
 * the library, playlists, likes and the wave (the server worker answers it over /api). It pushes a
 * compact snapshot to native whenever the store changes, and native calls `window.moraNativeUi`
 * (WKWebView.callAsyncJavaScript) for actions. Both only run while the app is in the foreground,
 * which is the only time native screens can be touched; native keeps the last snapshot meanwhile.
 */

export interface NativeUiTrack { id: string; title: string; artist: string; album: string; duration: number; reaction: number; cover: string | null; ok: boolean }
type Wave = 'own' | 'yandex' | 'online';

export const uiTrack = (t: Track): NativeUiTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, reaction: t.reaction, cover: t.coverUrl, ok: t.status === 'ok',
});

/** Everything but the library and playlists, which are sent only when they change. */
export function uiState(s = useApp.getState(), radio = useRadio.getState(), preparing = usePublicPlayback.getState()) {
  const p = s.player, ctx = p.context?.type;
  const current = trackOf(p.queue[p.index]?.trackId);
  const playing = p.status === 'playing' || p.status === 'buffering';
  const toast = s.toasts.at(-1);
  return {
    path: (location.hash.replace(/^#/, '') || '/').split('?')[0],
    loaded: s.loaded,
    // The web full player, side panels and the version picker cover everything: native steps aside while they are open.
    overlay: s.fullPlayer || s.queueOpen || s.panel !== null || useVersionPanel.getState().target !== null,
    wave: {
      own: s.order.length > 0,
      yandex: s.providers.some((v) => v.id === 'yandex' && v.status === 'connected'),
      active: (radio.active || ctx === 'online-radio' ? 'online' : ctx === 'yandex-wave' ? 'yandex' : ctx === 'wave' ? 'own' : null) as Wave | null,
      playing,
      loading: !!p.waveLoading || radio.loading,
      error: p.error ?? radio.error,
    },
    now: current ? { id: current.id, title: current.title, artist: current.artist, cover: current.coverUrl, playing, label: p.context?.label ?? '' } : null,
    toast: toast ? { id: toast.id, text: toast.text, kind: toast.kind } : null,
    preparing: preparing.phase === 'starting' ? preparing.title : null,
  };
}

const results = new Map<PublicSource, { q: string; items: PublicTrack[] }>();
const publicItem = (source: PublicSource, id: string) => {
  const r = results.get(source);
  const index = r?.items.findIndex((t) => t.externalId === id) ?? -1;
  if (!r || index < 0) throw new Error('Результат поиска устарел');
  return { ...r, index };
};

async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const source = (v: unknown): PublicSource => {
  if (v === 'ytmusic' || v === 'youtube' || v === 'soundcloud') return v;
  throw new Error('Неизвестный источник');
};

/** Native → page. Arguments come from our own Swift code, but are still checked: a wrong call must fail, not misplay. */
export const commands: Record<string, (a: Args) => unknown> = {
  go: (a) => { location.hash = str(a.path) || '/'; },
  back: () => history.back(),
  open: (a) => {
    const t = trackOf(str(a.id));
    if (t) location.hash = (a.to === 'artist' ? trackArtistHref(t) : trackAlbumHref(t)).replace(/^#/, '');
  },
  play: (a) => {
    const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : [];
    const type = (['liked', 'search', 'album', 'artist', 'playlist', 'history'] as const).find((x) => x === a.type) ?? 'library';
    return controller.playTracks(ids, Math.max(0, Math.min(ids.length - 1, Number(a.index) || 0)), { type, id: str(a.id) || undefined, label: str(a.label) || 'Медиатека' });
  },
  /** The native page for the current route (native-pages.ts); null when it stays web. */
  page: () => describe(),
  /** A row action of a native page. Its errors become toasts, as on the web page. */
  act: async (a): Promise<ActResult | null> => {
    const fn = actions[str(a.name)];
    if (!fn) throw new Error(`Unknown action ${str(a.name)}`);
    try { return ((await fn(a.args && typeof a.args === 'object' ? a.args as Args : {})) ?? null) as ActResult | null; }
    catch (e) { useApp.getState().toast((e as Error).message, 'error'); return null; }
  },
  queue: (a) => {
    const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string' && trackOf(x)?.status === 'ok') : [];
    controller.addToQueue(ids, a.next === true);
    useApp.getState().toast(a.next === true ? 'Сыграет следующим' : 'Добавлено в очередь');
  },
  react: (a) => {
    const t = trackOf(str(a.id));
    const value = Number(a.value);
    return t && [-1, 0, 1].includes(value) ? react(t, value) : undefined;
  },
  wave: (a) => {
    const want = a.source === 'yandex' || a.source === 'online' ? a.source : 'own';
    if (uiState().wave.active === want) return controller.toggle();
    return want === 'online' ? startRadio() : controller.startWave(want);
  },
  toggle: () => controller.toggle(),
  /** Pushes everything again, e.g. after the shell was switched off or on. */
  resync: () => resend(),
  next: () => controller.nextTrack(),
  /** The web full player, when native playback is not running (the SwiftUI sheet needs it). */
  player: () => useApp.setState({ fullPlayer: true }),
  cover: async (a) => {
    const url = str(a.url);
    if (!url.startsWith('/api/')) throw new Error('Не обложка медиатеки');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return base64(await res.blob());
  },
  search: async (a) => {
    const src = source(a.source), q = str(a.q).trim().slice(0, 200);
    const { items } = await api.publicSearch(src, q);
    results.set(src, { q, items });
    return items.map((t) => ({ id: t.externalId, title: t.title, artist: t.artist, album: t.album, duration: t.duration, reaction: 0, cover: t.coverUrl, ok: t.playable }));
  },
  publicPlay: (a) => {
    const src = source(a.source), { q, items, index } = publicItem(src, str(a.id));
    return publicPlayer.play(items.map(asCatalog), index, { type: 'search', label: `${SOURCE_LABEL[src]} · ${q}` });
  },
  publicQueue: async (a) => {
    const { items, index } = publicItem(source(a.source), str(a.id));
    await publicPlayer.enqueue(asCatalog(items[index]));
    useApp.getState().toast('Добавлено в очередь');
  },
};

declare global { interface Window { moraNativeUi?: (name: string, args: Args) => Promise<unknown> } }

let disabled = false;
/** «Ещё» on the web shows a way back to the native interface after it was switched off there. */
export const nativeUiDisabled = () => disabled;
let resend: (enable?: boolean) => void = () => {};
export const enableNativeUi = () => resend(true);

export function startNativeUi(): void {
  const push = nativePlaybackControls()?.uiState;
  if (!phone || !push) return;
  window.moraNativeUi = async (name, args) => {
    const fn = commands[name];
    if (!fn) throw new Error(`Unknown command ${name}`);
    return (await fn(args ?? {})) ?? null;
  };
  let tracks: unknown, order: unknown, playlists: unknown, last = '', timer: ReturnType<typeof setTimeout> | null = null;
  const send = (enable = false) => {
    timer = null;
    const s = useApp.getState();
    const state: Record<string, unknown> = uiState(s);
    const key = JSON.stringify(state);
    const libraryChanged = s.tracks !== tracks || s.order !== order;
    if (!enable && !libraryChanged && s.playlists === playlists && key === last) return;
    if (libraryChanged) state.library = s.order.map((id) => s.tracks.get(id)).filter((t): t is Track => !!t).map(uiTrack);
    if (s.playlists !== playlists) state.playlists = s.playlists.map((p) => ({ id: p.id, name: p.name, count: p.count, cover: p.coverUrl }));
    if (enable) state.enable = true;
    tracks = s.tracks; order = s.order; playlists = s.playlists; last = key;
    push(state).then(({ shown }) => {
      disabled = !shown;
      document.documentElement.classList.toggle('mora-native-shell', shown);
    }, () => { tracks = order = playlists = undefined; last = ''; }); // resent whole on the next change
  };
  const schedule = () => { timer ??= setTimeout(send, 120); };
  resend = (enable) => { if (timer) clearTimeout(timer); tracks = order = playlists = undefined; send(enable); };
  useApp.subscribe(schedule);
  useRadio.subscribe(schedule);
  usePublicPlayback.subscribe(schedule);
  useVersionPanel.subscribe(schedule);
  window.addEventListener('hashchange', schedule);
  schedule();
}
