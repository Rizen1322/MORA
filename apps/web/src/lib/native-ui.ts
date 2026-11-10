import { api, type Track } from './api.ts';
import { nativePlaybackControls } from './playback-trace.ts';
import { startRadio, useRadio } from './radio.ts';
import { trackAlbumHref, trackArtistHref, trackArtistLinks } from './router.ts';
import { controller, phone, trackOf, useApp } from '../store/app.ts';
import { usePublicPlayback, useCatalogPlayback } from '../store/catalog.ts';
import { react } from '../components/TrackList.tsx';
import { useVersionPanel, openVersionPanel } from '../components/VersionPanel.tsx';
import { actions, describe, describeWaveSettings, type ActResult } from './native-pages.ts';
import { nativeVersionCommands } from './native-versions.ts';
import { nativeCatalogCommands } from './native-catalog.ts';

/**
 * iPhone native shell (ios/App/App/NativeShell.swift). Data path: this page stays the only owner of
 * the library, playlists, likes and the wave (the server worker answers it over /api). It pushes a
 * compact snapshot to native whenever the store changes, and native calls `window.moraNativeUi`
 * (WKWebView.callAsyncJavaScript) for actions. Both only run while the app is in the foreground,
 * which is the only time native screens can be touched; native keeps the last snapshot meanwhile.
 */

export interface NativeUiTrack { id: string; title: string; artist: string; album: string; duration: number; reaction: number; likedAt?: number; addedAt?: number; cover: string | null; ok: boolean; binding?: string }
type Wave = 'own' | 'yandex' | 'online';

export const uiTrack = (t: Track): NativeUiTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, reaction: t.reaction, likedAt: t.likedAt, addedAt: t.addedAt, cover: t.coverUrl, ok: t.status === 'ok', binding: t.binding?.assetId,
});

/** Everything but the library and playlists, which are sent only when they change. */
export function uiState(s = useApp.getState(), radio = useRadio.getState(), preparing = usePublicPlayback.getState()) {
  const catalogPreparation = useCatalogPlayback.getState();
  const p = s.player, ctx = p.context?.type;
  const [path, query] = (location.hash.replace(/^#/, '') || '/').split('?');
  const params = new URLSearchParams(query);
  const current = trackOf(p.queue[p.index]?.trackId);
  const playing = p.status === 'playing' || p.status === 'buffering';
  const toast = s.toasts.at(-1);
  return {
    path,
    search: { q: params.get('q'), source: path === '/yandex' ? 'yandex' : params.get('src'), type: params.get('type') },
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
    playback: { shuffle: p.shuffle, repeat: p.repeat, automix: s.settings?.automix.enabled ?? true, canShuffle: !radio.active && !['wave', 'yandex-wave', 'online-radio'].includes(ctx ?? '') },
    now: current ? { id: current.id, title: current.title, artist: current.artist, cover: current.coverUrl, playing, label: p.context?.label ?? '' } : null,
    toast: toast ? { id: toast.id, text: toast.text, kind: toast.kind } : null,
    preparing: catalogPreparation.phase === 'starting' ? catalogPreparation.title : preparing.phase === 'starting' ? preparing.title : null,
  };
}

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
/** Native → page. Arguments come from our own Swift code, but are still checked: a wrong call must fail, not misplay. */
export const commands: Record<string, (a: Args) => unknown> = {
  ...nativeVersionCommands,
  ...nativeCatalogCommands,
  go: (a) => { location.hash = str(a.path) || '/'; },
  back: () => history.back(),
  trackLinks: (a) => {
    const track = trackOf(str(a.id));
    if (!track) throw Error('Трек не найден');
    return { album: track.album ? trackAlbumHref(track).replace(/^#/, '') : null,
      artists: trackArtistLinks(track).map(link => ({ id: link.href, title: link.name, path: link.href.replace(/^#/, '') })) };
  },
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
  waveSettings: (a) => describeWaveSettings(a.source),
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
  reactSaved: async (a) => {
    const id = str(a.id), value = Number(a.value);
    if (!trackOf(id) || ![-1, 0, 1].includes(value)) throw new Error('Трек или реакция недоступны');
    const result = await api.react(id, value);
    useApp.getState().patchTrack(id, { reaction: result.value, reactionSync: result.sync });
    if (value < 0 && controller.currentEntry?.trackId === id && ['wave', 'yandex-wave', 'online-radio'].includes(controller.state.context?.type ?? '')) void controller.nextTrack('dislike');
    return { saved: true };
  },
  wave: (a) => {
    const want = a.source === 'yandex' || a.source === 'online' ? a.source : 'own';
    if (uiState().wave.active === want) return controller.toggle();
    return want === 'online' ? startRadio() : controller.startWave(want);
  },
  playbackMode: async (a) => {
    if (a.mode === 'shuffle') { if (uiState().playback.canShuffle) controller.toggleShuffle(); }
    else if (a.mode === 'repeat') controller.cycleRepeat();
    else if (a.mode === 'automix') {
      const settings = useApp.getState().settings;
      if (!settings) throw Error('Настройки ещё загружаются');
      await useApp.getState().saveSettings({ automix: { ...settings.automix, enabled: !settings.automix.enabled } });
    } else throw Error('Неизвестный режим воспроизведения');
    return uiState().playback;
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
  /** «Заменить трек»: the web version picker takes over the screen (uiState.overlay), native steps aside. */
  versions: (a) => {
    const t = trackOf(str(a.id));
    if (!t) throw new Error('Трек не найден');
    openVersionPanel({ trackId: t.id, title: t.title, artist: t.artist, duration: t.duration });
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
  let tracks: unknown, order: unknown, playlists: unknown, queue: unknown, last = '', timer: ReturnType<typeof setTimeout> | null = null;
  const send = (enable = false) => {
    timer = null;
    const s = useApp.getState();
    const state: Record<string, unknown> = uiState(s);
    const key = JSON.stringify(state);
    const libraryChanged = s.tracks !== tracks || s.order !== order;
    if (!enable && !libraryChanged && s.playlists === playlists && s.player.queue === queue && key === last) return;
    if (libraryChanged) state.library = s.order.map((id) => s.tracks.get(id)).filter((t): t is Track => !!t).map(uiTrack);
    if (s.playlists !== playlists) state.playlists = s.playlists.map((p) => ({ id: p.id, name: p.name, count: p.count, cover: p.coverUrl }));
    if (enable) state.enable = true;
    if (s.player.queue !== queue) state.queue = s.player.queue.map(({ entryId, trackId }) => ({ entryId, trackId }));
    tracks = s.tracks; order = s.order; playlists = s.playlists; queue = s.player.queue; last = key;
    push(state).then(({ shown, nativeContent }) => {
      disabled = !shown;
      document.documentElement.classList.toggle('mora-native-shell', shown);
      const root = document.getElementById?.('root');
      if (root) {
        const owned = shown && nativeContent === true;
        if (owned && !root.inert) (document.activeElement as HTMLElement | null)?.blur();
        root.inert = owned; // Hidden web controls must not steal focus from native fields.
      }
    }, () => { tracks = order = playlists = queue = undefined; last = ''; }); // resent whole on the next change
  };
  const schedule = () => { timer ??= setTimeout(send, 120); };
  resend = (enable) => { if (timer) clearTimeout(timer); tracks = order = playlists = queue = undefined; send(enable); };
  useApp.subscribe(schedule);
  useRadio.subscribe(schedule);
  usePublicPlayback.subscribe(schedule);
  useCatalogPlayback.subscribe(schedule);
  useVersionPanel.subscribe(schedule);
  window.addEventListener('hashchange', schedule);
  schedule();
}
