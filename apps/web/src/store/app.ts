import { create } from 'zustand';
import { PlayerController, type PlayerSnapshot } from '../audio/controller.ts';
import { api, type AppSettings, type PlaylistSummary, type ProviderInfo, type Track } from '../lib/api.ts';
import { sanitizePlayback, type PlaybackSettings, type ToneSettings } from '@automix/core';
import { useDownloads } from './downloads.ts';

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  text: string;
}

export interface UploadJob {
  total: number;
  done: number;
  failed: { name: string; error: string }[];
  duplicates: number;
  current: string | null;
  active: boolean;
}

interface AppState {
  tracks: Map<string, Track>;
  order: string[];
  loaded: boolean;
  loadError: string | null;
  playlists: PlaylistSummary[];
  providers: ProviderInfo[];
  settings: AppSettings | null;
  player: PlayerSnapshot;
  toasts: Toast[];
  upload: UploadJob | null;
  queueOpen: boolean;
  /** One side panel at a time in the right column: the queue (queueOpen), sound or lyrics. */
  panel: 'sound' | 'lyrics' | null;
  fullPlayer: boolean;
  serverOnline: boolean;
  ffmpegMissing: boolean;
  lyricsReady:{trackId:string;hash:string}|null;
  loadLibrary: () => Promise<void>;
  loadPlaylists: () => Promise<void>;
  loadProviders: (force?: boolean) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  patchTrack: (id: string, patch: Partial<Track>) => void;
  /** Adds or refreshes one track without reloading the whole library. */
  upsertTrack: (t: Track) => void;
  /** Applies tone at once; saving to the server is debounced while a slider moves. */
  setTone: (tone: ToneSettings) => void;
  setPlayback: (settings: PlaybackSettings) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setUpload: (u: UploadJob | null) => void;
  setQueueOpen: (v: boolean) => void;
  setPanel: (p: 'sound' | 'lyrics' | null) => void;
  setFullPlayer: (v: boolean) => void;
}

let toastId = 0;
let toneTimer: ReturnType<typeof setTimeout> | null = null;
let playbackTimer: ReturnType<typeof setTimeout> | null = null;
let settingsRevision = 0;
let settingsSaves: Promise<unknown> = Promise.resolve();

export const useApp = create<AppState>((set, get) => ({
  tracks: new Map(),
  order: [],
  loaded: false,
  loadError: null,
  playlists: [],
  providers: [],
  settings: null,
  player: null as unknown as PlayerSnapshot,
  toasts: [],
  upload: null,
  queueOpen: false,
  panel: null,
  fullPlayer: false,
  serverOnline: true,
  ffmpegMissing: false,
  lyricsReady:null,

  loadLibrary: async () => {
    try {
      const { tracks } = await api.library();
      // Search results that were only played stay playable (map) but out of the collection (order).
      set({ tracks: new Map(tracks.map((t) => [t.id, t])), order: tracks.filter((t) => t.saved !== false).map((t) => t.id), loaded: true, loadError: null, serverOnline: true });
    } catch (e) {
      set({ loaded: true, loadError: (e as Error).message, serverOnline: false });
    }
  },
  loadPlaylists: async () => {
    try {
      set({ playlists: (await api.playlists()).playlists });
    } catch {
      /* offline */
    }
  },
  loadProviders: async (force = false) => {
    try {
      set({ providers: (await api.providers(force)).providers });
    } catch {
      /* offline */
    }
  },
  loadSettings: async () => {
    try {
      const s = await api.settings();
      set({ settings: s });
      controller.setLoudnessTarget(s.automix.loudnessTarget);
      controller.instantNext = s.automix.mixOnNext === false;
      controller.setTone(s.sound.tone);
      controller.setPlayback(s.sound.playback);
    } catch {
      /* offline */
    }
  },
  saveSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const merged: AppSettings = {
      automix: { ...cur.automix, ...(patch.automix ?? {}) },
      wave: { ...cur.wave, ...(patch.wave ?? {}) },
      ui: { ...cur.ui, ...(patch.ui ?? {}) },
      sound: { ...cur.sound, ...(patch.sound ?? {}) },
    };
    const revision = ++settingsRevision;
    set({ settings: merged });
    try {
      // Persist in order; an older reply cannot undo a slider the user is moving.
      const pending = settingsSaves.catch(() => {}).then(() => api.saveSettings(merged));
      settingsSaves = pending;
      const saved = await pending;
      if (revision !== settingsRevision) return;
      set({ settings: saved });
      controller.onSettingsChanged(saved.automix.loudnessTarget);
      controller.instantNext = saved.automix.mixOnNext === false;
      controller.setPlayback(saved.sound.playback);
    } catch (e) {
      get().toast(`Настройки не сохранены: ${(e as Error).message}`, 'error');
    }
  },
  setPlayback: (settings) => {
    const cur = get().settings;
    if (!cur) return;
    settingsRevision++;
    const playback = sanitizePlayback(settings);
    controller.setPlayback(playback);
    set({ settings: { ...cur, sound: { ...cur.sound, playback } } });
    if (playbackTimer) clearTimeout(playbackTimer);
    playbackTimer = setTimeout(() => void get().saveSettings({ sound: get().settings!.sound }), 400);
  },
  setTone: (tone) => {
    const cur = get().settings;
    if (!cur) return;
    settingsRevision++;
    controller.setTone(tone);
    set({ settings: { ...cur, sound: { ...cur.sound, tone } } });
    if (toneTimer) clearTimeout(toneTimer);
    toneTimer = setTimeout(() => void get().saveSettings({ sound: { ...get().settings!.sound, tone } }), 400);
  },
  upsertTrack: (t) => {
    const m = new Map(get().tracks);
    m.set(t.id, t);
    const order = get().order;
    set({ tracks: m, order: t.saved !== false && !order.includes(t.id) ? [t.id, ...order] : t.saved === false ? order.filter((id) => id !== t.id) : order });
  },
  patchTrack: (id, patch) => {
    const t = get().tracks.get(id);
    if (!t) return;
    const m = new Map(get().tracks);
    m.set(id, { ...t, ...patch });
    set({ tracks: m });
  },
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setUpload: (u) => set({ upload: u }),
  setQueueOpen: (v) => set(v ? { queueOpen: true, panel: null } : { queueOpen: false }),
  setPanel: (p) => set(p ? { panel: p, queueOpen: false } : { panel: null }),
  setFullPlayer: (v) => set({ fullPlayer: v }),
}));

export const controller = new PlayerController(
  (id) => useApp.getState().tracks.get(id),
  (msg, kind) => useApp.getState().toast(msg, kind === 'error' ? 'error' : 'info'),
  () => useApp.getState().loadLibrary(),
);
useApp.setState({ player: controller.state });
controller.subscribe((s) => useApp.setState({ player: s }));

export function trackOf(id: string | undefined | null): Track | undefined {
  return id ? useApp.getState().tracks.get(id) : undefined;
}

/** Subscribes to server-sent events and keeps the store in sync. */
export function connectEvents(): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let libTimer: ReturnType<typeof setTimeout> | null = null;
  const reloadLib = () => {
    if (libTimer) clearTimeout(libTimer);
    libTimer = setTimeout(() => void useApp.getState().loadLibrary(), 250);
  };
  const open = () => {
    es = new EventSource('/api/events');
    es.onopen = () => {
      const reconnect=!useApp.getState().serverOnline;
      useApp.setState({serverOnline:true});
      if(reconnect)void useApp.getState().loadLibrary().then(()=>{
        const p=useApp.getState().player,ids=p.queue.slice(Math.max(0,p.index),p.index+2).map(e=>e.trackId);
        for(const id of ids)controller.onAnalysisDone(id);
        if(ids[0])useApp.setState({lyricsReady:{trackId:ids[0],hash:''}});
      });
    };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      const st = useApp.getState();
      if (e.type === 'library') reloadLib();
      else if(e.type==='lyrics'&&typeof e.trackId==='string'&&typeof e.hash==='string')useApp.setState({lyricsReady:{trackId:e.trackId,hash:e.hash}});
      else if (e.type === 'download') {
        useDownloads.getState().upsert(e.job);
        if (e.job.state === 'done') reloadLib();
      }
      else if (e.type === 'playlists') void st.loadPlaylists();
      else if (e.type === 'providers') void st.loadProviders(true);
      else if (e.type === 'analysis') {
        if (e.trackId) {
          const t = st.tracks.get(e.trackId);
          if (t) st.patchTrack(e.trackId, { analysis: { ...t.analysis, status: e.status, progress: e.progress, error: e.error } });
          if (e.status === 'done' || e.status === 'error') {
            reloadLib();
            if (e.status === 'done') {
              if (e.asset === 'vocals' && typeof e.revision === 'string') controller.onVocalsChanged(e.trackId, e.revision);
              else {
                // The event has status only. Fetch LUFS/peaks before applying
                // normalization, rather than marking stale metadata as done.
                void api.track(e.trackId).then(fresh => {
                  const current = useApp.getState().tracks.get(e.trackId);
                  if ((current?.binding?.assetId ?? e.trackId) !== (fresh.binding?.assetId ?? fresh.id)) return;
                  useApp.getState().patchTrack(e.trackId, { analysis: fresh.analysis });
                  controller.onAnalysisDone(e.trackId);
                }).catch(() => { reloadLib(); });
              }
            }
          }
        }
      }
    };
    es.onerror = () => {
      useApp.setState({ serverOnline: false });
      es?.close();
      retry = setTimeout(open, 3000);
    };
  };
  open();
  return () => {
    es?.close();
    if (retry) clearTimeout(retry);
    if(libTimer)clearTimeout(libTimer);
  };
}
