import { api, type PublicSource, type PublicTrack, type Track } from './api.ts';
import { nativePlaybackControls } from './playback-trace.ts';
import { startRadio, useRadio } from './radio.ts';
import { trackAlbumHref, trackArtistHref } from './router.ts';
import { controller, phone, trackOf, useApp } from '../store/app.ts';
import { publicPlayer, usePublicPlayback } from '../store/catalog.ts';
import { react } from '../components/TrackList.tsx';
import { asCatalog, SOURCE_LABEL, TAG_TEXT } from '../pages/Search.tsx';
import { resolveVersion, searchVersions, useVersionPanel, VERSION_SOURCES, versionFormat, type Candidate, type VersionSource } from '../components/VersionPanel.tsx';
import { actions, describe, offline, type ActResult } from './native-pages.ts';

/**
 * iPhone native shell (ios/App/App/NativeShell.swift). Data path: this page stays the only owner of
 * the library, playlists, likes and the wave (the server worker answers it over /api). It pushes a
 * compact snapshot to native whenever the store changes, and native calls `window.moraNativeUi`
 * (WKWebView.callAsyncJavaScript) for actions. Both only run while the app is in the foreground,
 * which is the only time native screens can be touched; native keeps the last snapshot meanwhile.
 */

export interface NativeUiTrack { id: string; title: string; artist: string; album: string; duration: number; reaction: number; cover: string | null; ok: boolean; offline: boolean }
type Wave = 'own' | 'yandex' | 'online';

export const uiTrack = (t: Track): NativeUiTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, reaction: t.reaction, cover: t.coverUrl, ok: t.status === 'ok', offline: offline(t),
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
      // Only a start under way: a refill while playing or paused keeps the Pause/«Продолжить» button.
      loading: radio.loading || p.status === 'loading' || (!!p.waveLoading && !playing && p.status !== 'paused'),
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
/** Queue index of an entry after the audible one; -1 otherwise. */
const upcoming = (id: unknown) => {
  const i = controller.state.queue.findIndex((e) => e.entryId === id);
  return i > controller.state.index ? i : -1;
};
const source = (v: unknown): PublicSource => {
  if (v === 'ytmusic' || v === 'youtube' || v === 'soundcloud') return v;
  throw new Error('Неизвестный источник');
};

// The native version picker (NativeVersionPicker.swift): search and the binding stay here, as in VersionPanel.
const versionTrack = (a: Args) => {
  const t = trackOf(str(a.id) || controller.state.queue.find((e) => e.entryId === a.entryId)?.trackId);
  if (!t) throw new Error('Трек не найден');
  return t;
};
/** Results of the picker's last search; the picker shows one source at a time. */
const candidates = new Map<string, Candidate>();
/** A preview plays in the page; music it paused comes back unless the listener used the transport meanwhile. */
const preview = { audio: null as HTMLAudioElement | null, resume: null as number | null, request: 0 };
const stopPreview = (resume = true) => {
  preview.request++;
  preview.audio?.pause();
  const back = preview.resume !== null && controller.intentVersion === preview.resume;
  preview.resume = null;
  if (back && resume) void controller.resume();
  return back;
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
  /** Native player queue sheet: rows are upcoming entries, addressed by entryId; played ones are ignored. */
  queueJump: (a) => { const i = upcoming(a.entryId); if (i >= 0) controller.jumpTo(i); },
  queueRemove: (a) => { const i = upcoming(a.entryId); if (i >= 0) controller.removeAt(i); },
  queueMove: (a) => {
    const from = upcoming(a.entryId), to = upcoming(a.to);
    if (from >= 0 && to >= 0) controller.move(from, to);
  },
  versions: async (a) => {
    const t = versionTrack(a), src = a.source;
    if (!VERSION_SOURCES.includes(src as VersionSource)) throw new Error('Неизвестный источник');
    const items = await searchVersions(src as VersionSource, str(a.q).trim().slice(0, 200) || `${t.artist} ${t.title}`.trim(), t.title);
    candidates.clear();
    for (const c of items) candidates.set(c.key, c);
    return { bound: !!t.binding, items: items.map((c) => {
      const r = (c.remote ?? c.yandex)!;
      return { key: c.key, title: r.title, artist: c.remote?.uploader || r.artist, duration: r.duration, cover: r.coverUrl, explicit: r.explicit,
        labels: (c.remote?.labels ?? []).filter((l) => l.tag !== 'explicit').map((l) => TAG_TEXT[l.tag] ?? l.tag) };
    }) };
  },
  /** An empty key stops the preview. Resolves with the recording's format once it plays. */
  versionPreview: async (a) => {
    const key = str(a.key);
    stopPreview();
    if (!key) return null;
    const c = candidates.get(key);
    if (!c) throw new Error('Результат поиска устарел');
    const request = preview.request, intent = controller.intentVersion;
    const t = await resolveVersion(c);
    if (request !== preview.request || intent !== controller.intentVersion) return null;
    if (controller.state.status === 'playing' || controller.state.status === 'buffering') { controller.pause(); preview.resume = controller.intentVersion; }
    const audio = preview.audio ??= new Audio();
    audio.onended = () => { if (request === preview.request) stopPreview(); };
    audio.src = `/api/tracks/${t.id}/audio`;
    await audio.play();
    return { format: versionFormat(t).replace(/^ · /, '') };
  },
  /** A key binds that recording to the track for good; none restores the original. The queue swaps at once. */
  versionApply: async (a) => {
    const t = versionTrack(a), key = str(a.key), c = key ? candidates.get(key) : undefined;
    if (key && !c) throw new Error('Результат поиска устарел');
    const resume = stopPreview(false);
    await api.bindRecording(t.id, c ? (await resolveVersion(c)).id : null);
    await useApp.getState().loadLibrary();
    await controller.recordingChanged(t.id);
    if (resume) void controller.resume();
    useApp.getState().toast(c ? 'Эта версия будет играть для трека' : 'Вернули исходную запись', 'success');
  },
  /** Native player «Текст»: synced lines (seconds, already shifted by the saved offset) or plain text. */
  lyrics: async (a) => {
    const t = trackOf(str(a.id));
    if (!t) throw new Error('Трек не найден');
    const l = await api.lyrics(t.id);
    const shift = l.offsetMs / 1000;
    return { synced: l.status === 'synced', lines: l.lines.map((x) => ({ t: x.t - shift, text: x.text })), plain: l.plain };
  },
  /** Track row «Скачать на телефон»: the same download job as the web track menu. */
  download: async (a) => {
    const t = trackOf(str(a.id));
    if (!t) throw new Error('Трек не найден');
    await api.download({ trackId: t.id });
    useApp.getState().toast(`«${t.title}» скачивается на телефон`);
  },
  swap: () => {
    if (!controller.swapNext()) throw new Error('Заменить следующий трек сейчас нельзя');
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
