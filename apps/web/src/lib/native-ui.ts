import { api, type Track } from './api.ts';
import { nativePlaybackControls } from './playback-trace.ts';
import { startRadio, useRadio } from './radio.ts';
import { heldStation, offlineNow, setNetworkOffline, startOffline, watchNetwork } from './offline-wave.ts';
import { trackAlbumHref, trackArtistHref, trackArtistLinks } from './router.ts';
import { controller, phone, trackOf, useApp } from '../store/app.ts';
import { usePublicPlayback, useCatalogPlayback } from '../store/catalog.ts';
import { react } from '../components/TrackList.tsx';
import { useVersionPanel, openVersionPanel } from '../components/VersionPanel.tsx';
import { actions, describe, describeWaveSettings, type ActResult } from './native-pages.ts';
import { nativeVersionCommands } from './native-versions.ts';
import { nativeCatalogCommands } from './native-catalog.ts';
import { playSplash, splashing, splashEnabled } from './splash.ts';
import { useDownloads } from '../store/downloads.ts';
import { waveDownloadIds } from './native-downloads.ts';

/**
 * iPhone native shell (ios/App/App/NativeShell.swift). Data path: this page stays the only owner of
 * the library, playlists, likes and the wave (the server worker answers it over /api). It pushes a
 * compact snapshot to native whenever the store changes, and native calls `window.moraNativeUi`
 * (WKWebView.callAsyncJavaScript) for actions. Both only run while the app is in the foreground,
 * which is the only time native screens can be touched; native keeps the last snapshot meanwhile.
 */

export interface NativeUiTrack { id: string; title: string; artist: string; album: string; duration: number; reaction: number; likedAt?: number; addedAt?: number; cover: string | null; ok: boolean; binding?: string; offline?: boolean }
type Wave = 'own' | 'yandex' | 'online';

export const uiTrack = (t: Track): NativeUiTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, reaction: t.reaction, likedAt: t.likedAt, addedAt: t.addedAt, cover: t.coverUrl, ok: t.status === 'ok', binding: t.binding?.assetId,
  // Plays without the internet: a downloaded online track or a file of the library (CarPlay «Загрузки»).
  offline: t.status === 'ok' && (!!t.pinned || t.sourceKind !== 'remote' || [...useDownloads.getState().jobs.values()].some(job => job.trackId === t.id && job.state === 'done')),
});

/** Everything but the library and playlists, which are sent only when they change. */
export function uiState(s = useApp.getState(), radio = useRadio.getState(), preparing = usePublicPlayback.getState()) {
  const catalogPreparation = useCatalogPlayback.getState();
  // While the offline wave stands in for a station, Home still shows that station as playing.
  const p = s.player, ctx = (heldStation() ?? p.context)?.type;
  const [path, query] = (location.hash.replace(/^#/, '') || '/').split('?');
  const params = new URLSearchParams(query);
  const current = trackOf(p.queue[p.index]?.trackId);
  const playing = p.status === 'playing' || p.status === 'buffering';
  const toast = s.toasts.at(-1);
  return {
    path,
    search: { q: params.get('q'), source: path === '/yandex' ? 'yandex' : params.get('src'), type: params.get('type') },
    loaded: s.loaded,
    station: {
      context: ctx ?? 'library', source: ctx === 'yandex-wave' ? 'yandex' : ctx === 'online-radio' ? 'online' : ctx === 'wave' ? 'own' : null,
      index: 0, position: p.position, contextId: p.context?.id ?? null,
      settings: { mood: s.settings?.wave?.mood ?? 'normal', diversity: s.settings?.wave?.diversity ?? 'balanced', mode: s.settings?.wave?.mode ?? 'normal' },
      tracks: p.queue.slice(p.index, p.index + 50).flatMap(entry => {
        const t = trackOf(entry.trackId);
        return t ? [{ trackId: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration }] : [];
      }),
    },
    // The web full player, side panels and the version picker cover everything: native steps aside while they are open.
    overlay: splashing || s.fullPlayer || s.queueOpen || s.panel !== null || useVersionPanel.getState().target !== null,
    splash: splashing,
    wave: {
      own: s.order.length > 0,
      yandex: s.providers.some((v) => v.id === 'yandex' && v.status === 'connected'),
      active: (radio.active || ctx === 'online-radio' ? 'online' : ctx === 'yandex-wave' ? 'yandex' : ctx === 'wave' ? 'own' : null) as Wave | null,
      playing,
      loading: !!p.waveLoading || radio.loading,
      error: p.error ?? radio.error,
    },
    playback: { shuffle: p.shuffle, repeat: p.repeat, automix: s.settings?.automix.enabled ?? true, canShuffle: !radio.active && !['wave', 'yandex-wave', 'online-radio'].includes(ctx ?? '') },
    now: current ? { id: current.id, entryId: p.queue[p.index]?.entryId, position: p.position, duration: current.duration, title: current.title, artist: current.artist, cover: current.coverUrl, playing, label: p.context?.label ?? '' } : null,
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
  openTrack: async (a) => {
    const id = str(a.id); if (!trackOf(id)) throw Error('Трек не найден в медиатеке');
    await controller.playTracks([id], 0, { type: 'library', label: 'Медиатека' });
  },
  playPlaylist: async (a) => {
    const playlist = await api.playlist(str(a.id));
    await controller.playTracks(playlist.entries.map(entry => entry.trackId), 0, { type: 'playlist', id: playlist.id, label: playlist.name });
  },
  downloadCurrent: async () => {
    const id = controller.state.queue[controller.state.index]?.trackId;
    if (!id) throw Error('Сейчас ничего не играет');
    return api.download({ trackId: id });
  },
  backup: async () => {
    const response = await fetch('/api/backup/playlists?library=1');
    if (!response.ok) throw Error('Не удалось собрать резервную копию');
    return response.text();
  },
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
  recent: async () => {
    const { items } = await api.history(50);
    return [...new Set(items.map(item => item.trackId))].flatMap(id => { const t = trackOf(id); return t ? [uiTrack(t)] : []; });
  },
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
  /** The native player's queue: remove, play next, play now, or move an entry after another one (by entry ids, so a list that changed meanwhile cannot hit the wrong row). */
  queueEdit: (a) => {
    const q = controller.state.queue, from = q.findIndex((e) => e.entryId === str(a.entry));
    if (from < 0) throw new Error('Трека уже нет в очереди');
    const cur = controller.state.index;
    if (a.action === 'remove') controller.removeAt(from);
    else if (a.action === 'jump') controller.jumpTo(from);
    else if (a.action === 'next') { if (from > cur + 1) controller.move(from, cur + 1); }
    else if (a.action === 'move') {
      const after = q.findIndex((e) => e.entryId === str(a.after));
      if (after < 0) throw new Error('Очередь изменилась, попробуйте ещё раз');
      if (after !== from) controller.move(from, from < after ? after : after + 1);
    } else throw new Error('Неизвестное действие с очередью');
  },
  react: (a) => {
    const t = trackOf(str(a.id));
    const value = Number(a.value);
    return t && [-1, 0, 1].includes(value) ? react(t, value) : undefined;
  },
  /** «Добавить в плейлист» from the native track menu: an existing playlist or a new one with this track. */
  addToPlaylist: async (a) => {
    const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string' && !!trackOf(x)) : [];
    if (!ids.length) throw new Error('Трек не найден');
    const st = useApp.getState();
    const playlistId = str(a.playlistId);
    if (playlistId) {
      const name = st.playlists.find((p) => p.id === playlistId)?.name ?? '';
      const result = await api.addToPlaylist(playlistId, ids);
      await st.loadPlaylists();
      st.toast(`Добавлено в «${name}»: ${result.added}`, 'success');
      return { added: result.added };
    }
    const name = str(a.name).trim().slice(0, 120);
    if (!name) throw new Error('Введите название плейлиста');
    const created = await api.createPlaylist(name, ids);
    await st.loadPlaylists();
    st.toast(`Создан плейлист «${name}»`, 'success');
    return { id: created.id };
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
    if (want !== 'own' && offlineNow()) return startOffline(want);
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
  playerCommand: (a) => {
    if (a.action === 'play') return controller.resume();
    if (a.action === 'pause') return controller.pause();
    if (a.action === 'nexttrack') return controller.nextTrack();
    if (a.action === 'previoustrack') return controller.prevTrack();
    if (a.action === 'seekto' && typeof a.time === 'number' && Number.isFinite(a.time) && a.time >= 0) return controller.seek(a.time);
    throw Error('Неизвестная команда плеера');
  },
  toggle: () => controller.toggle(),
  /** The iPhone's network monitor: without a network the wave goes on with songs on the device. */
  network: (a) => setNetworkOffline(a.offline === true),
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
  watchNetwork();
  window.moraNativeUi = async (name, args) => {
    const fn = commands[name];
    if (!fn) throw new Error(`Unknown command ${name}`);
    return (await fn(args ?? {})) ?? null;
  };
  let tracks: unknown, order: unknown, playlists: unknown, queue: unknown, last = '', timer: ReturnType<typeof setTimeout> | null = null;
  let launchRequested = false, pendingIntro = false;
  let syncedWiFi: boolean | undefined;
  let keepingWave = false, keptWave = '';
  const keepWave = async () => {
    const s = useApp.getState(), native = nativePlaybackControls()?.downloads;
    if (keepingWave || !native || !['wave', 'yandex-wave', 'online-radio'].includes(s.player.context?.type ?? '')) return;
    const count = s.settings?.downloads?.keepWave ?? 0;
    const available = new Set([...useDownloads.getState().jobs.values()].filter(job => !['failed', 'cancelled'].includes(job.state)).flatMap(job => job.trackId ? [job.trackId] : []));
    const next = s.player.queue.slice(s.player.index + 1).map(entry => entry.trackId);
    const todo = waveDownloadIds(next, count, available).filter(id => { const t = trackOf(id); return t?.sourceKind === 'remote' && !t.pinned; });
    const key = JSON.stringify([todo, !!s.settings?.downloads?.wifiOnly]);
    if (key === keptWave) return;
    keptWave = key; keepingWave = true;
    try {
      await native.settings(!!s.settings?.downloads?.wifiOnly);
      for (const trackId of todo) { const { job } = await api.download({ trackId }); useDownloads.getState().upsert(job); }
    } catch (error) { s.toast(`Не удалось сохранить волну: ${(error as Error).message}`, 'error'); }
    finally { keepingWave = false; }
  };
  const send = (enable = false) => {
    timer = null;
    const s = useApp.getState();
    if (s.settings && syncedWiFi !== !!s.settings.downloads?.wifiOnly && nativePlaybackControls()?.downloads) {
      syncedWiFi = !!s.settings.downloads?.wifiOnly;
      void nativePlaybackControls()!.downloads!.settings(syncedWiFi).catch(() => { syncedWiFi = undefined; });
    }
    void keepWave();
    const state: Record<string, unknown> = uiState(s);
    const key = JSON.stringify(state);
    state.launchIntro = !launchRequested;
    state.launchHidden = document.hidden;
    if (pendingIntro) { state.splash = true; state.overlay = true; }
    const libraryChanged = s.tracks !== tracks || s.order !== order;
    if (!enable && !libraryChanged && s.playlists === playlists && s.player.queue === queue && key === last) return;
    if (libraryChanged) state.library = s.order.map((id) => s.tracks.get(id)).filter((t): t is Track => !!t).map(uiTrack);
    if (s.playlists !== playlists) state.playlists = s.playlists.map((p) => ({ id: p.id, name: p.name, count: p.count, cover: p.coverUrl }));
    if (enable) state.enable = true;
    if (s.player.queue !== queue) state.queue = s.player.queue.map(({ entryId, trackId }) => ({ entryId, trackId }));
    tracks = s.tracks; order = s.order; playlists = s.playlists; queue = s.player.queue; last = key;
    push(state).then(({ shown, nativeContent, launchSplash }) => {
      if (!launchRequested) {
        launchRequested = true;
        if (launchSplash && splashEnabled()) {
          const start = () => { pendingIntro = false; playSplash({ ready: () => useApp.getState().loaded || !useApp.getState().serverOnline,
            target: () => document.querySelector('.wave-hero-title span') }); };
          if (!document.hidden) start();
          else {
            pendingIntro = true;
            const visible = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', visible); start(); last = ''; schedule(); } };
            document.addEventListener('visibilitychange', visible);
          }
        }
        if (launchSplash !== undefined) { last = ''; schedule(); }
      }
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
  useDownloads.subscribe(() => { tracks = undefined; schedule(); });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('mora-splash', schedule);
  schedule();
}
