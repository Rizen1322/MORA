import { CHUNK_FRAMES, fallbackWithoutVocalStems, planToArmed, preampFor, skipPlanFrom, type MixerEvent, type ToneSettings, type TransitionPlan, type TransitionRating, type TransitionRatingReason } from '@automix/core';
import { DEFAULT_PLAYBACK, sanitizePlayback, type PlaybackSettings } from '@automix/core';
import workletUrl from './engine.worklet.ts?worker&url';
import type { EngineCommand, EngineEvent } from './engine.worklet.ts';
import { nativePlaybackControls, playbackDiagnostics, tracePlayback } from '../lib/playback-trace.ts';
import { api, ApiError, type AnalysisSummary, type Track } from '../lib/api.ts';
import { uploadNativePcm } from '../lib/native-pcm-preparation.ts';
import type { ArmedTransition } from '@automix/core/engine/mixer.ts';
import type { NativeMixConfig, NativeMixState, NativeMixTrack, NativeRadioConfig, NativeMixSettings } from '../lib/native-mix.ts';
import { desktop } from '../lib/desktop.ts';
import { createDesktopEngine, DesktopAudioContext, DesktopAnalyser } from './desktop-engine.ts';

export type RepeatMode = 'off' | 'all' | 'one';
import type { Origin, QueueEntry, PlayContext } from '../lib/queue-types.ts';
export type { Origin, QueueEntry, PlayContext } from '../lib/queue-types.ts';

export interface TransitionState {
  planId: string;
  plan: TransitionPlan;
  active: boolean;
  late: boolean;
  /** seconds until the transition starts (null once active) */
  startsIn: number | null;
  progress: number;
  fallback: string | null;
}

export interface PlayerSnapshot {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'buffering';
  error: string | null;
  queue: QueueEntry[];
  canUndoQueue?: boolean;
  index: number;
  context: PlayContext | null;
  shuffle: boolean;
  repeat: RepeatMode;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  ratio: number;
  limiterDb: number;
  transition: TransitionState | null;
  nextPlan: TransitionPlan | null;
  nextPending: string[];
  /** logId arrives once the server stored the row; rating is the listener's verdict on it. */
  lastTransition: { plan: TransitionPlan; outcome: Record<string, unknown>; at: number; logId?: number; rating?: TransitionRating | null; ratingReason?: TransitionRatingReason | null } | null;
  waveLoading: boolean;
  waveRefillError?: string | null;
  /** The finite queue ends: label of the station being chosen to continue it. */
  continuation?: string | null;
  engineReady: boolean;
  sampleRate: number;
  audioHealth?: { maxRenderMs: number; slowBlocks: number; pcmUnderruns: number; latencyMs: number; p95Ms?: number; p99Ms?: number; deviceUnderruns?: number };
}

interface ChunkFeed {
  pending: number[];
  inflight: number;
  fed: Set<number>;
  fetching: Set<number>;
  failed: string | null;
  revision?: string;
}

interface Slot extends ChunkFeed {
  deck: number;
  token: string;
  entryId: string;
  trackId: string;
  totalFrames: number;
  abort: AbortController;
  vocals: ChunkFeed;
}

interface NextPrep {
  entry: QueueEntry;
  index: number;
  slot: Slot;
  plan: TransitionPlan;
  pending: string[];
  sentPlans?: Map<string, TransitionPlan>;
}

interface BufferedChunk { chunk: number; L: Float32Array; R: Float32Array }
interface BufferedVocals { plan: TransitionPlan; A: BufferedChunk[]; B: BufferedChunk[] }
type PcmPart = 'original' | 'vocals';

type TrackLookup = (id: string) => Track | undefined;
type DeckTelemetry = Extract<MixerEvent, { type: 'tick' }>['decks'][number];

function tempoAt(points: [number, number][], time: number): number {
  if (!points.length) return 1;
  if (time <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (time <= points[i][0]) {
      const [t0, r0] = points[i - 1], [t1, r1] = points[i];
      return t1 === t0 ? r1 : r0 + (r1 - r0) * (time - t0) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

/** The server could not render-check this full-mix plan yet: B's PCM was not decoding (P10). */
const renderSkipped = (plan: TransitionPlan) => !!(plan.debug.renderCheck as { skipped?: string } | undefined)?.skipped;

function consumedSource(points: [number, number][], time: number): number {
  const knots = [0, ...points.map(([t]) => t).filter((t) => t > 0 && t < time), Math.max(0, time)];
  let source = 0;
  for (let i = 1; i < knots.length; i++) source += (knots[i] - knots[i - 1]) * (tempoAt(points, knots[i - 1]) + tempoAt(points, knots[i])) / 2;
  return source;
}

let seq = 0;
/** iPhone app (mora-mobile, set by its bridge before this module runs): the phone's buttons set the
 * volume, so the app has no volume control and plays at full level. */
export const systemVolume = typeof document !== 'undefined' && document.documentElement.classList.contains('mora-mobile');
/** Each save rewrites the whole library database image on the iPhone: store the position there less often. */
const POSITION_SAVE_MS = systemVolume ? 30_000 : 5000;
/** Paused or stopped this long: the AudioContext is suspended until the next Play. */
const IDLE_SUSPEND_MS = 3 * 60_000;
/** Next tracks that fail to load in a row before preparation stops instead of eating the queue. */
const MAX_SKIPS = 3;

/** iPhone: music plays in the app's native audio engine; Diagnostics can switch back to WebKit (after a restart). */
export const NATIVE_PLAYBACK_KEY = 'mora.nativePlayback';
const nativeWanted = (() => { try { return localStorage.getItem(NATIVE_PLAYBACK_KEY) !== 'off'; } catch { return true; } })();
const NATIVE_SR = 48000;
/** Tracks kept prepared after the audible one, so the queue (with its blends) survives a suspended page.
 * Each is a whole PCM file, about 23 MB per minute. */
const NATIVE_AHEAD = 2;
type NativeItem = NativeMixTrack & { entryId: string; trackId: string; file: number };

const uid = () => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function gainFromSummary(a: AnalysisSummary | undefined, target: number | null): number {
  if (target === null) return 0;
  // A new streamed master can be very hot before its loudness scan finishes.
  // Keep temporary headroom rather than driving the limiter on every bass hit.
  if (!a || a.lufs === undefined) return -6;
  if (a.lufs <= -69) return 0;
  let g = target - a.lufs;
  g = Math.min(g, -1 - (a.truePeak ?? -1) + 3);
  return Math.max(-18, Math.min(12, g));
}

/**
 * Owns the AudioContext and the AudioWorklet engine, the play queue, deck
 * bookkeeping, PCM streaming, transition preparation and play history.
 */
export class PlayerController {
  private ctx: AudioContext | DesktopAudioContext | null = null;
  private node: { port: { postMessage(command: EngineCommand, transfer?: Transferable[]): void } } | null = null;
  analyser: AnalyserNode | DesktopAnalyser | null = null;
  private desktopUnsubscribe: (() => void) | null = null;
  private slots: (Slot | null)[] = [null, null];
  private retirements: (Promise<void> | null)[] = [null, null];
  private current: Slot | null = null;
  private next: NextPrep | null = null;
  private preparing: Promise<void> | null = null;
  private preparationRevision = 0;
  private skipStreak = 0;
  private analysisRevision = 0;
  private resourceRevisions = new Map<string, number>();
  private vocalRevisions = new Map<string, string>();
  private dirtyVocals = new Set<string>();
  private resettingVocals = false;
  private vocalResetRequests = new Map<string, { resolve: (applied: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private engineStarting: Promise<void> | null = null;
  private generation = 0;
  private startingGeneration: number | null = null;
  private previewRevision = 0;
  private nextRequest: { current: Slot; generation: number; revision: number; quick: boolean } | null = null;
  private playId: number | null = null;
  private playRevision = 0;
  private maxPos = 0;
  private originalOrder: QueueEntry[] | null = null;
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaved = 0;
  private yandexSession: { sessionId: string; batchId: string | null } | null = null;
  private yandexSessionReset = false;
  private waveEpoch = 0;
  private waveRequest: Promise<void> | null = null;
  private waveRetryAt = 0;
  private waveFailures = 0;
  private waveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private radioPlay: { entryId: string; trackId: string; sessionId: string; batchId: string | null; seconds: number; tick: number } | null = null;
  private waveExhausted = false;
  private heardEntries = new Set<string>();
  private loudnessTarget: number | null = -16;
  private restoredPosition = 0;
  private deckTelemetry = new Map<string, DeckTelemetry>();
  private recovering: { token: string; endPosition: number } | null = null;
  private deferredLoudnessChange = false;
  private failedIncomingToken: string | null = null;
  state: PlayerSnapshot = {
    status: 'idle',
    error: null,
    queue: [],
    index: -1,
    context: null,
    shuffle: false,
    repeat: 'off',
    position: 0,
    duration: 0,
    volume: systemVolume ? 1 : 0.9,
    muted: false,
    ratio: 1,
    limiterDb: 0,
    transition: null,
    nextPlan: null,
    nextPending: [],
    lastTransition: null,
    waveLoading: false,
    engineReady: false,
    sampleRate: 48000,
  };

  constructor(
    private readonly track: TrackLookup,
    private readonly notify: (msg: string, kind?: 'error' | 'info') => void,
    private readonly refreshLibrary: () => Promise<void> = async () => {},
  ) {}

  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<PlayerSnapshot>): void {
    if (patch.queue || (patch.index !== undefined && patch.index !== this.state.index)) {
      this.queueUndo = null;
      patch.canUndoQueue = false;
    }
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setLoudnessTarget(t: number | null): void {
    this.loudnessTarget = t;
  }

  /** Equal content hashes keep the same PCM; only the library identity changes after a merge. */
  remapTracks(mapping: Record<string, string>): void {
    const remap = <T extends { trackId: string }>(entry: T): T => ({ ...entry, trackId: mapping[entry.trackId] ?? entry.trackId });
    for (const slot of this.slots) if (slot) slot.trackId = mapping[slot.trackId] ?? slot.trackId;
    if (this.next) this.next.entry = remap(this.next.entry);
    if (this.originalOrder) this.originalOrder = this.originalOrder.map(remap);
    this.nativeTracks = this.nativeTracks.map(remap);
    for (const [old, id] of Object.entries(mapping)) {
      const file = this.nativeFiles.get(old);
      if (file && !this.nativeFiles.has(id)) this.nativeFiles.set(id, file);
      this.nativeFiles.delete(old);
    }
    this.nativeManifestKey = '';
    this.nativeQueueEditRevision++;
    this.set({ queue: this.state.queue.map(remap), nextPlan: null, nextPending: [] });
  }

  /** A saved mix setting must affect the already prepared pair as well. */
  onSettingsChanged(target: number | null): void {
    this.previewRevision++;
    const targetChanged = this.loudnessTarget !== target;
    this.loudnessTarget = target;
    if (this.native && this.nativeAt >= 0) {
      if (desktop?.nativeMix && targetChanged) {
        const track = this.track(this.state.queue[this.state.index]?.trackId);
        void this.nativeMix.settings({ gainDb: track?.mixingAllowed === false ? 0 : gainFromSummary(track?.analysis, target) }).catch(() => {});
      }
      this.nativeManifestKey = ''; void this.nativeSync(); return;
    }
    if (this.native && this.nativeMix.startSource) {
      const track = this.track(this.state.queue[this.state.index]?.trackId);
      void this.nativeMix.settings({ gainDb: track?.mixingAllowed === false ? 0 : gainFromSummary(track?.analysis, target) }).catch(() => {});
      return;
    }
    if (this.state.transition?.active) {
      this.deferredLoudnessChange = true;
      return;
    }
    if (this.current) {
      const track = this.track(this.current.trackId);
      this.post({ cmd: 'gain', deck: this.current.deck, gainDb: track?.mixingAllowed === false ? 0 : gainFromSummary(track?.analysis, target) });
    }
    this.invalidateNext();
    if (this.current) void this.prepareNext();
  }

  get currentEntry(): QueueEntry | null {
    return this.state.queue[this.state.index] ?? null;
  }

  private recipeEdge(from: QueueEntry | null | undefined, to: QueueEntry | null | undefined) {
    if (this.state.shuffle || this.state.context?.type !== 'playlist' || !from || !to
      || !from.sourcePlaylistId || from.sourcePlaylistId !== to.sourcePlaylistId
      || from.sourcePlaylistId !== this.state.context.id || !from.playlistEntryId || !to.playlistEntryId) return undefined;
    return { playlistId: from.sourcePlaylistId, fromItemId: from.playlistEntryId, toItemId: to.playlistEntryId };
  }

  private planPair(fromId: string, toId: string, from?: QueueEntry | null, to?: QueueEntry | null) {
    const edge = this.recipeEdge(from, to);
    return edge ? api.plan(fromId, toId, edge) : api.plan(fromId, toId);
  }

  /** Saved edits replace only a transition still ahead; an audible blend keeps its exact plan. */
  refreshPlaylistTransitions(playlistId: string): void {
    if (this.state.context?.type !== 'playlist' || this.state.context.id !== playlistId) return;
    this.queueRevision++;
    if (this.native) {
      this.nativeManifestKey = '';
      if (this.nativeAt >= 0) void this.nativeSync();
      return;
    }
    if (this.state.transition?.active) return;
    this.invalidateNext();
    if (this.current) void this.prepareNext();
  }

  // ------------------------------------------------------------ native (iPhone)

  /** The native host plays the queue: whole tracks are uploaded to it with their planned blends. */
  get native(): boolean { return (!!desktop?.nativeMix || nativeWanted) && !!nativePlaybackControls()?.mix; }
  get autonomousRadio(): boolean { return !!desktop?.nativeMix?.startStation; }
  private desktopAudioReady: Promise<void> | null = null;
  private hydrateDesktopAudio(): Promise<void> {
    return this.desktopAudioReady ??= (async () => {
      const audio = (await desktop?.getSettings?.().catch(() => null))?.audio;
      if (!audio) return;
      this.outputDevice = audio.outputDevice;
      if (typeof audio.volume === 'number') this.set({ volume: audio.volume, muted: !!audio.muted });
      if (audio.tone) this.setTone(audio.tone);
      if (audio.playback) this.setPlayback(audio.playback);
    })();
  }

  async startDesktopStation(station: NativeRadioConfig, context?: PlayContext): Promise<void> {
    if (!desktop?.nativeMix?.startStation) return;
    const intent = ++this.previewRevision;
    const nativeRevision = ++this.nativeRevision;
    this.nativeAbort.abort(); this.nativeAbort = new AbortController(); this.nativePendingEntry = null;
    this.queueRevision++; this.resetWaveBuffer();
    await this.hydrateDesktopAudio();
    await this.ensureEngine();
    if (intent !== this.previewRevision || nativeRevision !== this.nativeRevision) return;
    this.nativeStarting = true;
    this.set({ waveLoading: true, waveRefillError: null, error: null });
    try {
      const state = await desktop.nativeMix.startStation(station, { sampleRate: NATIVE_SR, position: 0, ...this.nativeSettings() });
      // Pause, seek or a settings save also bump previewRevision; only a newer native start supersedes this one.
      if (nativeRevision !== this.nativeRevision) return;
      await this.refreshLibrary();
      if (nativeRevision !== this.nativeRevision) return;
      if (context) await desktop.nativeMix.setStation?.(station, context);
      this.finishPlay('skip'); this.nativeAt = state.index; this.nativeTracks = []; this.nativeManifestKey = '';
      this.set({ queue: (state.queue ?? []).map(e => ({ ...e, origin: e.origin ?? 'wave' })), index: state.index,
        context: context ?? state.context ?? null, repeat: 'off', shuffle: false });
      this.nativeStarting = false;
      this.onNativeState(state); this.nativePoll(state.sampleRate); this.scheduleSave();
    } catch (e) {
      if (nativeRevision === this.nativeRevision) { this.set({ error: (e as Error).message }); throw e; }
    } finally { if (nativeRevision === this.nativeRevision) { this.nativeStarting = false; this.set({ waveLoading: false }); } }
  }

  async configureDesktopStation(station: NativeRadioConfig, context?: PlayContext): Promise<void> {
    await desktop?.nativeMix?.setStation?.(station, context ?? this.state.context);
  }
  private nativeFiles = new Map<string, { file: number; frames: number }>();
  private nativeFileSeq = 0;
  private nativeTracks: NativeItem[] = [];
  /** Index of the audible track in nativeTracks; -1 while a new queue starts. */
  private nativeAt = -1;
  private nativeRevision = 0;
  private nativeStarting = false;
  private nativePendingEntry: string | null = null;
  private get nativePendingIndex(): number | null {
    const index = this.state.queue.findIndex(e => e.entryId === this.nativePendingEntry);
    return index < 0 ? null : index;
  }
  private nativeAbort = new AbortController();
  private nativeSyncing: Promise<void> | null = null;
  private nativeSyncAgain = false;
  private nativeTimer: ReturnType<typeof setInterval> | null = null;
  private nativePolledAt = 0;
  private nativeManifestKey = '';
  private nativeQueueRevision = 0;
  private nativeQueueEditRevision = 0;
  private nativeSkip = false;
  private nativeStation: NativeRadioConfig | null = null;
  private nativeLibraryRefresh: Promise<void> | null = null;
  /** Plans behind each native track's blend (page-side only, for the player UI). */
  private nativePlans = new WeakMap<NativeItem, TransitionPlan>();
  /** Tracks whose analysis finished after their blend was planned: plan them again. */
  private nativeStale = new Set<string>();
  private get nativeMix() { return nativePlaybackControls()!.mix!; }

  private async nativeFile(trackId: string, signal: AbortSignal, role: 'current' | 'next'): Promise<{ file: number; frames: number }> {
    const cached = this.nativeFiles.get(trackId);
    if (cached) return cached;
    const t = this.track(trackId);
    if (!t) throw new Error('трек не найден в медиатеке');
    if (t.status === 'missing') throw new ApiError(t.error ?? 'файл не найден', 410);
    // The role sets the analysis priority: a blend planned before analysis is only a crossfade.
    await api.prepare(trackId, NATIVE_SR, role);
    const file = ++this.nativeFileSeq;
    const frames = await uploadNativePcm(start => fetch(`/api/tracks/${encodeURIComponent(trackId)}/pcm?sr=${NATIVE_SR}&start=${start}&frames=${CHUNK_FRAMES}&format=f32le`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }),
    (offset, bytes) => this.nativeMix.upload(file, offset, bytes, signal), signal);
    const prepared = { file, frames };
    this.nativeFiles.set(trackId, prepared);
    return prepared;
  }

  private nativeItem(entry: QueueEntry, f: { file: number; frames: number }, transition?: ArmedTransition): NativeItem {
    const t = this.track(entry.trackId);
    return { title: t?.title ?? '', artist: t?.artist ?? '', totalFrames: f.frames, file: f.file, entryId: entry.entryId, trackId: entry.trackId,
      gainDb: t?.mixingAllowed === false ? 0 : gainFromSummary(t?.analysis, this.loudnessTarget),
      ...(t?.coverUrl ? { coverUrl: t.coverUrl } : {}), ...(transition ? { transition } : {}) };
  }

  /** A blend the native store can play, or none (the next track then follows gaplessly). */
  private async nativePlan(from: NativeItem, to: QueueEntry, frames: number): Promise<TransitionPlan | undefined> {
    try {
      const plan = fallbackWithoutVocalStems((await this.planPair(from.trackId, to.trackId,
        this.state.queue.find(e => e.entryId === from.entryId), to)).plan);
      if (plan.aExit * NATIVE_SR >= from.totalFrames || plan.bEntry * NATIVE_SR >= frames) return undefined;
      return plan;
    } catch { return undefined; }
  }

  /** Native files of tracks before the previous one are deleted by the host. */
  private pruneNativeFiles(): void {
    const kept = new Set(this.nativeTracks.slice(Math.max(0, this.nativeAt - 1)).map(t => t.file));
    for (const [id, f] of this.nativeFiles) if (!kept.has(f.file)) this.nativeFiles.delete(id);
  }

  private async nativeStartAt(index: number, seconds: number, endReason: string, startPaused: boolean): Promise<void> {
    const entry = this.state.queue[index];
    if (!entry) return;
    const revision = ++this.nativeRevision;
    this.nativeStarting = true;
    const desktopNative = !!desktop?.nativeMix;
    if (desktopNative) this.nativePendingEntry = entry.entryId;
    this.nativeAbort.abort();
    const abort = this.nativeAbort = new AbortController();
    if (!desktopNative) { this.finishPlay(endReason); this.nativeAt = -1; }
    this.set({ ...(!desktopNative || this.nativeAt < 0 ? { index, position: seconds, duration: this.track(entry.trackId)?.duration ?? 0 } : {}),
      status: startPaused ? 'paused' : 'loading',
      transition: null, nextPlan: null, nextPending: [], error: null });
    this.focusAnalysis();
    try {
      if (desktop?.getSettings) await this.hydrateDesktopAudio();
      if (revision !== this.nativeRevision) return;
      if (this.nativeMix.startSource) {
        const track = this.track(entry.trackId);
        if (!track) throw Error('трек не найден в медиатеке');
        if (track.status === 'missing') throw new ApiError(track.error ?? 'файл не найден', 410);
        const s = await this.nativeMix.startSource({ ...entry },
          { sampleRate: NATIVE_SR, position: seconds, paused: startPaused || this.state.status === 'paused',
            gainDb: track.mixingAllowed === false ? 0 : gainFromSummary(track.analysis, this.loudnessTarget),
            ...this.nativeSettings() }, abort.signal);
        if (revision !== this.nativeRevision) return;
        if (!s.active || s.failed || !s.currentTrack || s.currentTrack.entryId !== entry.entryId) throw Error('Нативный трек не подготовлен');
        if (desktopNative) {
          this.finishPlay(endReason);
          const confirmedIndex = this.state.queue.findIndex(e => e.entryId === entry.entryId);
          if (confirmedIndex >= 0) this.set({ index: confirmedIndex });
        }
        this.nativeTracks = [];
        this.nativeTracks[s.index] = { ...s.currentTrack, file: s.currentTrack.file ?? 0, entryId: entry.entryId, trackId: entry.trackId };
        this.nativeAt = s.index; this.nativeManifestKey = ''; this.nativeFiles.clear();
        if (desktopNative) { this.nativeStarting = false; this.nativePendingEntry = null; }
        this.skipStreak = 0; this.maxPos = s.position;
        this.set({ status: s.playing ? 'playing' : 'paused', position: s.position, duration: s.duration || this.state.duration,
          ...(desktop?.nativeMix ? { engineReady: true, sampleRate: s.sampleRate ?? NATIVE_SR } : {}) });
        this.beginPlay(entry); this.nativePoll(s.sampleRate); void this.nativeSync(); this.scheduleSave();
        return;
      }
      const f = await this.nativeFile(entry.trackId, abort.signal, 'current');
      if (revision !== this.nativeRevision) return;
      // Previous stays available to the lock screen when its file is still uploaded.
      const prev = this.state.queue[index - 1], pf = prev && this.nativeFiles.get(prev.trackId);
      const tracks = [...(prev && pf ? [this.nativeItem(prev, pf)] : []), this.nativeItem(entry, f)];
      // Pause pressed while the track was loading keeps it paused.
      const paused = startPaused || this.state.status === 'paused';
      const s = await this.nativeMix.start({ sampleRate: NATIVE_SR, position: seconds, index: tracks.length - 1, paused, tracks,
        ...this.nativeSettings() }, abort.signal);
      if (revision !== this.nativeRevision) return;
      this.nativeTracks = tracks;
      this.nativeAt = tracks.length - 1;
      this.nativeManifestKey = '';
      this.pruneNativeFiles();
      this.skipStreak = 0;
      this.maxPos = seconds;
      this.set({ status: paused ? 'paused' : 'playing', duration: s.duration || this.state.duration });
      this.beginPlay(entry);
      this.nativePoll();
      void this.nativeSync();
      this.scheduleSave();
    } catch (e) {
      // A failed first start releases the native session together with its files.
      if (!nativePlaybackControls()?.mixActive) { this.nativeFiles.clear(); this.nativeTracks = []; }
      if (revision !== this.nativeRevision) return;
      if (desktopNative && this.nativeAt >= 0) {
        this.notify(`Не удалось воспроизвести: ${(e as Error).message}`, 'error');
        void this.nativeMix.state().then(s => this.onNativeState(s), () => {});
        return;
      }
      if (unreachable(e)) {
        this.set({ status: startPaused ? 'paused' : 'buffering' });
        setTimeout(() => { if (revision === this.nativeRevision && this.state.status !== 'paused') void this.nativeStartAt(index, seconds, endReason, false); }, 2000);
        return;
      }
      this.notify(`Не удалось воспроизвести: ${(e as Error).message}`, 'error');
      this.set({ status: 'idle' });
      if (this.isWave() || this.state.queue.length > index + 1) {
        setTimeout(() => { if (revision === this.nativeRevision && this.state.status !== 'paused') void this.advanceAfterFailure(); }, 600);
      }
    } finally {
      if (revision === this.nativeRevision) { this.nativeStarting = false; this.nativePendingEntry = null; }
    }
  }

  /** Aligns the native tracks after the audible one with the page queue (one sync at a time). */
  private nativeSync(): Promise<void> {
    this.nativeSyncAgain = true;
    return this.nativeSyncing ??= (async () => {
      try {
        while (this.nativeSyncAgain) { this.nativeSyncAgain = false; await this.nativeSyncOnce(); }
      } finally { this.nativeSyncing = null; }
    })();
  }

  private async nativeSyncOnce(): Promise<void> {
    const revision = this.nativeRevision;
    if (this.nativeAt < 0 || (desktop?.nativeMix && this.nativeStarting)) return;
    if (this.isWave()) {
      if (desktop?.nativeMix) await this.topUpWave();
      // Refill reports its own errors; the iPhone must receive the ready tail before WebContent sleeps.
      else void this.topUpWave();
    }
    if (revision !== this.nativeRevision) return;
    const at = this.nativeAt, queueRevision = this.nativeQueueEditRevision;
    if (this.nativeMix.prepareQueue) {
      const manifestKey = () => JSON.stringify([this.queueRevision, this.state.queue.map(e => e.entryId), this.state.repeat, this.state.shuffle, this.loudnessTarget]);
      let key = manifestKey();
      if (key === this.nativeManifestKey) return;
      const current = this.state.queue[this.state.index];
      if (!current) return;
      const entries = this.state.repeat === 'one' ? [] : this.state.queue.slice(this.state.index + 1);
      const loop = this.state.repeat === 'one' ? [current] : this.state.repeat === 'all' ? this.state.queue : [];
      this.set({ nextPending: ['Подготовка очереди для фонового воспроизведения'] });
      try {
        const manifestEntry = (e: QueueEntry, previous?: QueueEntry) => {
          const transitionContext = this.recipeEdge(previous, e);
          return { ...e, transitionContext,
            ...(transitionContext && previous ? { fromEntryId: previous.entryId } : {}) };
        };
        const handoff = await this.nativeMix.prepareQueue(at + 1, entries.map((e, i) => manifestEntry(e, i ? entries[i - 1] : current)), current.trackId,
          loop.map((e, i) => manifestEntry(e, i ? loop[i - 1] : undefined)), this.nativeAbort.signal, queueRevision !== this.nativeQueueRevision,
          this.state.queue.map((e, i, queue) => manifestEntry(e, i ? queue[i - 1] : undefined)));
        if (desktop?.nativeMix?.setStation) {
          const type = this.state.context?.type;
          const station: NativeRadioConfig | null = type === 'wave' ? { kind: 'own' } : type === 'yandex-wave' ? { kind: 'yandex', yandexSessionId: current.yandexSessionId } : type === 'online-radio' ? { kind: 'online' } : null;
          await desktop.nativeMix.setStation(station && station.kind === this.nativeStation?.kind ? this.nativeStation : station, this.state.context);
        }
        if (revision !== this.nativeRevision) return;
        const dead = new Set(handoff?.dropped);
        if (dead.size) {
          const unchanged = key === manifestKey();
          const queue = this.state.queue.filter((e, i) => i <= this.state.index || !dead.has(e.entryId));
          this.set({ queue }); this.scheduleSave();
          // An edit made during handoff still needs its own sync.
          if (unchanged) key = manifestKey();
        }
        this.nativeQueueRevision = queueRevision; this.nativeManifestKey = key; this.set({ nextPending: [], error: null });
        tracePlayback('native.queue.handoff', { outcome: 'accepted' });
      } catch {
        if (revision !== this.nativeRevision || this.nativeAbort.signal.aborted) return;
        this.set({ error: 'Очередь ещё не передана для фонового воспроизведения. Откройте приложение и нажмите Play.', nextPending: [] });
        tracePlayback('native.queue.handoff', { outcome: 'rejected' });
      }
      return;
    }
    const wanted: QueueEntry[] = [];
    for (let i = this.state.index; wanted.length < NATIVE_AHEAD;) {
      const n = this.nextIndex(false, i);
      if (n === null) break;
      wanted.push(this.state.queue[n]); i = n;
    }
    let same = 0;
    const fresh = (i: number) => !this.nativeStale.has(this.nativeTracks[i].trackId) && !this.nativeStale.has(this.nativeTracks[i - 1].trackId);
    while (same < wanted.length && this.nativeTracks[at + 1 + same]?.entryId === wanted[same].entryId && fresh(at + 1 + same)) same++;
    let from = at + 1 + same;
    if (same === wanted.length && from === this.nativeTracks.length) return;
    try {
      if (same === wanted.length) {
        await this.nativeMix.update(from, []);
        this.nativeTracks = this.nativeTracks.slice(0, from);
        return;
      }
      for (const entry of wanted.slice(same)) {
        const f = await this.nativeFile(entry.trackId, this.nativeAbort.signal, 'next');
        if (revision !== this.nativeRevision) return;
        const previous = this.nativeTracks[from - 1];
        this.nativeStale.delete(entry.trackId); this.nativeStale.delete(previous.trackId);
        const plan = await this.nativePlan(previous, entry, f.frames);
        if (revision !== this.nativeRevision) return;
        const item = this.nativeItem(entry, f, plan && planToArmed(plan, NATIVE_SR, 'A', 'B'));
        if (plan) this.nativePlans.set(item, plan);
        // Publish each track at once: the native queue may need it while the page sleeps.
        await this.nativeMix.update(from, [item]);
        if (revision !== this.nativeRevision) return;
        this.nativeTracks = [...this.nativeTracks.slice(0, from), item];
        from++;
      }
    } catch (e) {
      if (revision !== this.nativeRevision || this.nativeAbort.signal.aborted) return;
      if (unreachable(e)) { setTimeout(() => { if (revision === this.nativeRevision) void this.nativeSync(); }, 3000); return; }
      // The track already blending in cannot be replaced; the queue realigns after it.
      // Its file may also be gone: upload it again next time.
      if (e instanceof Error && /Native playback operation failed/.test(e.message)) {
        const trackId = wanted[from - at - 1]?.trackId;
        if (trackId && !this.nativeTracks.some(t => t.trackId === trackId)) this.nativeFiles.delete(trackId);
        return;
      }
      const index = this.state.queue.findIndex(q => q.entryId === wanted[from - at - 1]?.entryId);
      if (index > this.state.index) { this.skipNext(index, (e as Error).message); this.nativeSyncAgain = this.skipStreak < MAX_SKIPS; }
    }
  }

  private nativePoll(sampleRate = NATIVE_SR): void {
    if (this.nativeTimer) return;
    if (desktop?.nativeMix && desktop.onAudio && !this.desktopUnsubscribe) {
      const analyser = new DesktopAnalyser(new DesktopAudioContext(sampleRate, 2048, desktop));
      this.analyser = analyser;
      this.desktopUnsubscribe = desktop.onAudio(event => {
        if (event.type === 'waveform') analyser.feed(event.samples);
        else if (event.type === 'audioHealth') this.onEngine(event);
      });
    }
    let polling = false;
    this.nativeTimer = setInterval(() => {
      // A hidden page (if iOS keeps it running) checks less often.
      if (polling || (document.hidden && performance.now() - this.nativePolledAt < 2000)) return;
      polling = true; this.nativePolledAt = performance.now();
      void this.nativeMix.state().then(s => this.onNativeState(s), () => {}).finally(() => { polling = false; });
    }, 500);
  }

  private onNativeState(s: NativeMixState): void {
    if (desktop?.nativeMix && this.nativeStarting) return;
    if (this.nativeAt < 0) return;
    if (!s.active || s.failed) {
      this.nativeRevision++; this.nativeAbort.abort(); this.nativeManifestKey = '';
      this.nativeAt = -1;
      this.nativeFiles.clear();
      this.nativeTracks = [];
      this.finishPlay('error');
      this.set({ status: 'idle' });
      if (s.failed) this.notify('Нативное воспроизведение остановилось с ошибкой. Нажмите Play, чтобы продолжить.', 'error');
      return;
    }
    if (s.queue && s.queue.some(e => !this.track(e.trackId))) {
      this.nativeLibraryRefresh ??= this.refreshLibrary().catch(() => {}).finally(() => { this.nativeLibraryRefresh = null; });
    }
    if (s.station !== undefined) this.nativeStation = s.station;
    const previousEntryId = this.state.queue[this.state.index]?.entryId;
    let queue = s.queue && s.station ? s.queue.map(e => ({ ...e, origin: e.origin ?? 'wave' as const })) : this.state.queue;
    if (s.context && s.station) this.set({ context: s.context });
    for (const [i, raw] of [[s.index, s.currentTrack], [s.index + 1, s.nextTrack]] as const) {
      if (raw?.entryId) {
        let entry = queue.find(e => e.entryId === raw.entryId);
        if (!entry && raw.trackId && this.track(raw.trackId)) {
          entry = { entryId: raw.entryId, trackId: raw.trackId, origin: 'user' };
          queue = [...queue, entry];
        }
        if (entry) this.nativeTracks[i] = { ...raw, file: raw.file ?? 0, entryId: entry.entryId, trackId: entry.trackId };
      }
    }
    if (queue !== this.state.queue) this.set({ queue });
    const entryId = s.entryId || this.nativeTracks[s.index]?.entryId, index = queue.findIndex(e => e.entryId === entryId);
    if (entryId && (entryId !== previousEntryId || s.index !== this.nativeAt || (index >= 0 && index !== this.state.index))) {
      if (entryId !== previousEntryId) this.finishPlay(!this.nativeSkip && s.index === this.nativeAt + 1 ? 'transition' : 'skip');
      this.nativeSkip = false;
      this.nativeAt = s.index;
      if (index >= 0) this.set({ index });
      this.maxPos = 0;
      if (index >= 0 && entryId !== previousEntryId) this.beginPlay(this.state.queue[index]);
      this.pruneNativeFiles();
      this.focusAnalysis();
      this.scheduleSave();
      void this.nativeSync();
    }
    const status = s.playing ? 'playing' : s.waitingForPreparation ? 'buffering' : s.ended ? 'idle' : 'paused';
    if (s.lastTransition && (s.lastTransition.at > (this.state.lastTransition?.at ?? 0) ||
      s.lastTransition.at === this.state.lastTransition?.at && s.lastTransition.logId && !this.state.lastTransition?.logId)) {
      this.set({ lastTransition: s.lastTransition });
    }
    this.maxPos = Math.max(this.maxPos, s.position);
    this.set({ position: s.position, duration: s.duration || this.state.duration, status,
      ...(desktop?.nativeMix ? { engineReady: true, sampleRate: s.sampleRate ?? NATIVE_SR } : {}), ...this.nativeTransition(s) });
    if (status === 'playing') void this.topUpWave();
    if (s.ended) void this.nativeSync();
    if (performance.now() - this.lastSaved > POSITION_SAVE_MS && status === 'playing') this.scheduleSave(true);
  }

  /** The audible blend for the player UI: the next one before its start, the incoming one until it ends. */
  private nativeTransition(s: NativeMixState): Pick<PlayerSnapshot, 'transition' | 'nextPlan'> {
    const frame = s.position * NATIVE_SR;
    const view = (item: NativeItem | undefined, progress: number, startsIn: number | null): TransitionState | null => {
      const plan = item?.plan ?? (item && this.nativePlans.get(item));
      return plan ? { planId: plan.id, plan, active: startsIn === null, late: false, startsIn, progress: Math.max(0, Math.min(1, progress)), fallback: null } : null;
    };
    const incoming = this.nativeTracks[s.index], next = this.nativeTracks[s.index + 1];
    if (s.blend) {
      const active = view(this.nativeTracks[s.blend.index], s.blend.progress, null);
      if (active) return { transition: active, nextPlan: active.plan };
    }
    const into = incoming?.transition;
    // After the swap the incoming track is audible while the blend finishes.
    if (s.blend === undefined && into && frame < into.entryFrame + into.durationFrames - into.swapFrame) {
      const active = view(incoming, (frame - into.entryFrame + into.swapFrame) / into.durationFrames, null);
      if (active) return { transition: active, nextPlan: active.plan };
    }
    const out = next?.transition;
    if (!out) return { transition: null, nextPlan: null };
    const pending = view(next, (frame - out.triggerFrame) / out.durationFrames,
      s.blend === undefined && frame >= out.triggerFrame ? null : Math.max(0, (out.triggerFrame - frame) / NATIVE_SR));
    return { transition: pending, nextPlan: pending?.plan ?? null };
  }

  private nativeSettings(): NativeMixSettings {
    return { playback: this.playback, volume: this.state.muted ? 0 : this.state.volume * this.fadeGain, userVolume: this.state.volume, muted: this.state.muted,
      ...(this.tone ? { tone: this.tone, preDb: preampFor(this.tone, NATIVE_SR) } : {}) };
  }

  private nativeCommand(action: MediaSessionAction, seekTime?: number): void {
    if (this.nativeAt >= 0 || this.nativeMix.startSource) void this.nativeMix.command(action, seekTime).catch(() => {});
  }

  // ------------------------------------------------------------------ engine

  get intentVersion(): number { return this.previewRevision; }
  /** Changes only when a new listening queue is selected, not on edits/seek/pause. */
  private queueRevision = 0;
  get queueVersion(): number { return this.queueRevision; }
  /** Recent queue entries that played to their end or into a transition (not skipped). */
  get heard(): ReadonlySet<string> { return this.heardEntries; }

  /** Unlock in the originating user gesture before a remote track is prepared. */
  async unlockAudio(): Promise<void> { await this.ensureEngine(); }

  private async ensureEngine(): Promise<void> {
    await nativePlaybackControls()?.ready;
    if (this.native) return;
    if (nativePlaybackControls()?.probeActive) throw new Error('Остановите нативный тест в диагностике перед запуском музыки');
    if (this.engineStarting) return this.engineStarting;
    this.engineStarting = this.createEngine().finally(() => { this.engineStarting = null; });
    return this.engineStarting;
  }

  private async createEngine(): Promise<void> {
    if (this.ctx && this.node) {
      // Safari also has 'interrupted' (call, Siri, another app's audio)
      // WebKit settles resume() from 'interrupted' only when the interruption ends: never block Play on it.
      if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
        tracePlayback('context.explicitResume.request', { id: this.diagnosticId, context: this.ctx.state });
        await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
        tracePlayback('context.explicitResume.returned', { id: this.diagnosticId, context: this.ctx.state });
      }
      return;
    }
    if (desktop?.audioStart && desktop.audioCommand && desktop.onAudio) {
      this.desktopUnsubscribe?.();
      const engine = await createDesktopEngine(desktop, event => this.onEngine(event), message => {
        this.desktopUnsubscribe?.();
        this.desktopUnsubscribe = null;
        this.pause();
        this.ctx = null;
        this.node = null;
        this.analyser = null;
        ++this.generation;
        this.startingGeneration = null;
        this.finishPlay('error');
        this.restoredPosition = this.state.position;
        for (const slot of this.slots) this.releaseSlot(slot);
        this.current = null;
        this.invalidateNext();
        void desktop?.audioStop?.();
        this.set({ engineReady: false, status: 'paused', transition: null, nextPlan: null, nextPending: [], error: `Аудиодвижок Rust: ${message}` });
      }, this.outputDevice);
      this.ctx = engine.context;
      this.node = engine.node;
      this.analyser = engine.analyser;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const detachIdle = this.subscribe(state => {
        if (state.status === 'paused' || state.status === 'idle') {
          idle ??= setTimeout(() => { idle = undefined; void engine.context.suspend().catch(() => {}); }, IDLE_SUSPEND_MS);
        } else { clearTimeout(idle); idle = undefined; }
      });
      this.desktopUnsubscribe = () => { engine.unsubscribe(); detachIdle(); clearTimeout(idle); };
      this.postVolume();
      if (this.tone) this.setTone(this.tone);
      this.setPlayback(this.playback);
      this.set({ engineReady: true, sampleRate: engine.context.sampleRate });
      this.setupMediaSession();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    tracePlayback('context.created', { id: this.diagnosticId, context: ctx.state });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'automix-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.45;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    node.port.onmessage = (ev: MessageEvent<EngineEvent>) => this.onEngine(ev.data);
    // A WebKit remote Pause may stop only the context. Report its actual state to
    // the native clock bridge without inventing a new user Play/Pause intent.
    const reportContext = () => {
      const controls = nativePlaybackControls();
      if (!controls) return;
      controls.contextState = ctx.state;
      controls.snapshot = () => ({ context: ctx.state, status: this.state.status,
        position: this.state.position, duration: this.state.duration, paused: this.diagnosticMixerPaused });
      controls.suspend = async () => {
        this.pause();
        if (ctx.state !== 'closed') {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([ctx.suspend(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audio suspension timeout')), 2000); })]); }
          finally { clearTimeout(timer); }
          if (!['suspended', 'closed'].includes(ctx.state)) throw new Error('Audio context is still active');
        }
        reportContext();
      };
      window.dispatchEvent(new Event('mora-context-state'));
    };
    const keepRunning = (event: Event) => {
      reportContext();
      tracePlayback('context.event', { reason: event.type, context: ctx.state, status: this.state.status, hidden: document.hidden });
      if (ctx.state !== 'running' && ctx.state !== 'closed' && (this.state.status === 'playing' || this.state.status === 'buffering')) {
        const allowed = !nativePlaybackControls()?.probeActive && (playbackDiagnostics()?.allowAutoResume ?? !nativePlaybackControls());
        if (!allowed) { tracePlayback('context.autoResume.suppressed', { context: ctx.state }); return; }
        tracePlayback('context.autoResume.request', { context: ctx.state });
        void ctx.resume().then(() => tracePlayback('context.autoResume.resolved', { context: ctx.state }), () => tracePlayback('context.autoResume.rejected', { context: ctx.state }));
      }
    };
    ctx.onstatechange = keepRunning;
    document.addEventListener('visibilitychange', keepRunning);
    this.ctx = ctx;
    this.node = node;
    this.analyser = analyser;
    reportContext();
    // Locked screen / background: 4 clock ticks a second instead of 20 (fewer main-thread wake-ups),
    // and the position is stored on the way out since the periodic save is sparse on the phone.
    const onVisibility = () => {
      this.post({ cmd: 'tickRate', seconds: document.hidden ? 0.25 : 0.05 });
      if (document.hidden && this.current) this.scheduleSave(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    // A paused context still renders silence and keeps the audio hardware (and on iOS the whole
    // backgrounded app) awake. After a long pause it sleeps; Play resumes it (ensureEngine).
    let idle: ReturnType<typeof setTimeout> | null = null;
    const quiet = () => this.state.status === 'paused' || this.state.status === 'idle';
    this.subscribe(() => {
      if (!quiet()) { if (idle) { clearTimeout(idle); idle = null; } return; }
      idle ??= setTimeout(() => { idle = null; if (quiet() && ctx.state === 'running') void ctx.suspend().catch(() => {}); }, IDLE_SUSPEND_MS);
    });
    this.postVolume();
    if (this.tone) this.setTone(this.tone);
    this.setPlayback(this.playback);
    if (ctx.state === 'suspended') await ctx.resume();
    this.set({ engineReady: true, sampleRate: ctx.sampleRate });
    this.setupMediaSession();
  }

  /** '' = the system default output. */
  outputDevice = '';
  async setOutputDevice(id: string): Promise<void> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    try {
      if (desktop?.nativeMix && desktop.audioCommand) await desktop.audioCommand({ cmd: 'output', device: id });
      else if (ctx?.setSinkId) await ctx.setSinkId(id);
      this.outputDevice = id;
    } catch {
      this.notify('Не удалось переключить устройство вывода. Звук идёт на устройство Windows по умолчанию.', 'error');
    }
  }

  private tone: ToneSettings | null = null;
  private playback = { ...DEFAULT_PLAYBACK };
  setPlayback(settings: PlaybackSettings): void {
    this.playback = sanitizePlayback(settings);
    if (this.native) void nativePlaybackControls()?.mix?.settings({ playback: this.playback }).catch(() => {});
    this.post({ cmd: 'playback', settings: this.playback });
  }
  /** Listener EQ on the final mix. The curve's measured peak is computed here, off the audio thread. */
  setTone(tone: ToneSettings): void {
    this.tone = tone;
    if (this.native) void nativePlaybackControls()?.mix?.settings({ tone, preDb: preampFor(tone, NATIVE_SR) }).catch(() => {});
    this.post({ cmd: 'tone', settings: tone, preDb: preampFor(tone, this.sr) });
  }

  private diagnosticId?: string;
  private diagnosticSeq = 0;
  private diagnosticTickAt = -Infinity;
  private diagnosticMixerPaused?: boolean;
  private traceAction(action: string): void {
    const d = playbackDiagnostics();
    if (!d) return;
    this.diagnosticId = d.currentId ?? d.nextId();
    tracePlayback('controller.action', { id: this.diagnosticId, action, context: this.ctx?.state ?? 'absent', status: this.state.status, position: this.state.position });
  }

  private post(cmd: EngineCommand, transfer: Transferable[] = []): void {
    if (cmd.cmd === 'arm' && this.next?.plan.id === cmd.transition.planId) {
      (this.next.sentPlans ??= new Map()).set(cmd.transition.planId, this.next.plan);
    }
    if (playbackDiagnostics() && ['start', 'seek', 'pause', 'arm', 'disarm', 'finish', 'stop'].includes(cmd.cmd)) {
      const id = this.diagnosticId ?? playbackDiagnostics()!.nextId(), seq = ++this.diagnosticSeq;
      tracePlayback('controller.post', { id, seq, command: cmd.cmd, paused: cmd.cmd === 'pause' ? cmd.paused : undefined, context: this.ctx?.state ?? 'absent', node: !!this.node });
      cmd = { ...cmd, diagnostic: { id, seq } };
    }
    this.node?.port.postMessage(cmd, transfer);
  }

  private get sr(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  // ------------------------------------------------------------ data feeding

  private async loadSlot(deck: number, entry: QueueEntry, cueSeconds: number, role: 'current' | 'next', gainDb: number | null, isRelevant = () => true): Promise<Slot> {
    const t = this.track(entry.trackId);
    if (!t) throw new Error('трек не найден в медиатеке');
    if (t.status === 'missing') throw new ApiError(t.error ?? 'файл не найден', 410);
    const prep = await api.prepare(t.id, this.sr, role);
    // The old deck can still be fading after seek/skip. Keep its PCM intact
    // until that fade has completed, even when the next HTTP request is fast.
    while (this.retirements[deck]) await this.retirements[deck];
    // A slow HTTP response must never replace a deck selected by a newer command.
    if (!isRelevant()) throw new Error('подготовка отменена');
    const old = this.slots[deck];
    if (old) old.abort.abort();
    const slot: Slot = {
      deck,
      token: `${entry.entryId}#${uid()}`,
      entryId: entry.entryId,
      trackId: t.id,
      totalFrames: Math.max(1, prep.totalFrames),
      abort: new AbortController(),
      pending: [],
      inflight: 0,
      fed: new Set(),
      fetching: new Set(),
      failed: null,
      vocals: { pending: [], inflight: 0, fed: new Set(), fetching: new Set(), failed: null },
    };
    this.slots[deck] = slot;
    const g = t.mixingAllowed === false ? 0 : gainDb ?? gainFromSummary(t.analysis, this.loudnessTarget);
    desktop?.reportMediaTrack?.({ token: slot.token, title: t.title, artist: t.artist, album: t.album, coverUrl: t.coverUrl });
    this.post({ cmd: 'load', deck, token: slot.token, totalFrames: slot.totalFrames, gainDb: g, cueFrame: Math.round(cueSeconds * this.sr) });
    return slot;
  }

  private slotByToken(token: string): Slot | null {
    return this.slots.find((s) => s?.token === token) ?? null;
  }

  private onNeed(deck: number, token: string, chunks: number[], part: PcmPart = 'original'): void {
    const slot = this.slots[deck];
    if (!slot || slot.token !== token) return;
    const stream = part === 'vocals' ? slot.vocals : slot;
    if (part === 'vocals' && stream.failed) {
      this.post({ cmd: 'disableVocals', deck, token });
      return;
    }
    for (const c of chunks) {
      // The worklet evicts old PCM. A request means this chunk is missing now,
      // even if it was fed earlier (for example after seeking backwards).
      stream.fed.delete(c);
      if (!stream.pending.includes(c) && !stream.fetching.has(c)) stream.pending.push(c);
    }
    stream.pending.sort((a, b) => a - b);
    this.pump(slot, part);
  }

  private pump(slot: Slot, part: PcmPart = 'original'): void {
    const stream = part === 'vocals' ? slot.vocals : slot;
    while (stream.inflight < 2 && stream.pending.length && !slot.abort.signal.aborted && !(part === 'vocals' && stream.failed)) {
      // take a run of consecutive chunks (up to 4) per request
      const first = stream.pending.shift()!;
      const run = [first];
      while (run.length < 4 && stream.pending[0] === run[run.length - 1] + 1) run.push(stream.pending.shift()!);
      for (const c of run) stream.fetching.add(c);
      stream.inflight++;
      void this.fetchChunks(slot, run, 0, part).finally(() => {
        for (const c of run) stream.fetching.delete(c);
        stream.inflight--;
        this.pump(slot, part);
      });
    }
  }

  private async fetchChunks(slot: Slot, run: number[], attempt = 0, part: PcmPart = 'original'): Promise<void> {
    const stream = part === 'vocals' ? slot.vocals : slot;
    try {
      const buffered = await this.readChunks(slot, run, part);
      if (slot.abort.signal.aborted) return;
      this.feedChunks(slot, buffered, part);
    } catch (e) {
      if (slot.abort.signal.aborted) return;
      if (part === 'vocals' && slot.vocals !== stream) return;
      if (part === 'vocals') {
        slot.vocals.failed = (e as Error).message;
        slot.vocals.pending = [];
        for (const chunk of run) this.post({ cmd: 'nack', deck: slot.deck, token: slot.token, chunk, part: 'vocals' });
        this.post({ cmd: 'disableVocals', deck: slot.deck, token: slot.token });
        return;
      }
      if (unreachable(e)) {
        // The deck reports buffering meanwhile; data flows again once the service is back.
        await new Promise((r) => setTimeout(r, Math.min(3000, 400 * (attempt + 1))));
        return this.fetchChunks(slot, run, attempt + 1);
      }
      const status = e instanceof ApiError ? e.status : 0;
      if ((status === 0 || status >= 500 || status === 502) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        return this.fetchChunks(slot, run, attempt + 1);
      }
      slot.failed = (e as Error).message;
      for (const c of run) this.post({ cmd: 'nack', deck: slot.deck, token: slot.token, chunk: c });
      this.onSlotFailed(slot, (e as Error).message);
    }
  }

  /** Decode first, then publish the whole range together when its cue is ready. */
  /** Replaces the metadata duration estimate with the decoder's exact length. */
  private setLength(slot: Slot, totalFrames: number): void {
    if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || totalFrames === slot.totalFrames) return;
    const edge = Math.floor((Math.min(slot.totalFrames, totalFrames) - 1) / CHUNK_FRAMES);
    slot.totalFrames = totalFrames;
    for (const c of slot.fed) if (c >= edge) slot.fed.delete(c);
    const deck = this.slots.indexOf(slot);
    if (deck >= 0) this.post({ cmd: 'length', deck, token: slot.token, totalFrames });
    if (slot === this.current) this.set({ duration: totalFrames / this.sr });
  }

  private async readChunks(slot: Slot, run: number[], part: PcmPart = 'original'): Promise<BufferedChunk[]> {
    if (!run.length) return [];
    const start = run[0] * CHUNK_FRAMES;
    const frames = run.length * CHUNK_FRAMES;
    const endpoint = part === 'vocals' ? 'vocals/pcm' : 'pcm';
    const vocalStream = slot.vocals;
    const pin = part === 'vocals' && vocalStream.revision ? `&revision=${encodeURIComponent(vocalStream.revision)}` : '';
    const format = part === 'original' ? '&format=f32le' : '';
    const res = await fetch(`/api/tracks/${slot.trackId}/${endpoint}?sr=${this.sr}&start=${start}&frames=${frames}${pin}${format}`, { signal: slot.abort.signal });
    if (!res.ok) {
      let msg = `ошибка ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* keep */
      }
      throw new ApiError(msg, res.status);
    }
    const buf = await res.arrayBuffer();
    if (slot.abort.signal.aborted) return [];
    if (part === 'vocals') {
      if (slot.vocals !== vocalStream) throw new Error('Версия вокальной партии обновилась');
      const revision = res.headers?.get('X-Automix-Vocal-Revision');
      if (revision) {
        if (vocalStream.revision && vocalStream.revision !== revision) throw new Error('Версия вокальной партии обновилась');
        vocalStream.revision = revision;
      }
    }
    // only a finished decode knows the real end; a short answer from a running one is not EOF
    if (part === 'original' && res.headers?.get('X-Complete') === '1') this.setLength(slot, Number(res.headers.get('X-Total-Frames')));
    const floating = part === 'vocals' || res.headers?.get('X-PCM-Format') === 'f32le';
    const pcm = floating ? new Float32Array(buf, 0, Math.floor(buf.byteLength / 8) * 2) : new Int16Array(buf, 0, Math.floor(buf.byteLength / 4) * 2);
    const got = pcm.length / 2;
    const buffered: BufferedChunk[] = [];
    for (let k = 0; k < run.length; k++) {
      const c = run[k];
      const c0 = k * CHUNK_FRAMES;
      // chunks past the real end are padded with silence up to the estimated length
      const expected = Math.max(0, Math.min(CHUNK_FRAMES, slot.totalFrames - c * CHUNK_FRAMES));
      if (expected === 0) continue;
      const L = new Float32Array(expected);
      const R = new Float32Array(expected);
      const avail = Math.max(0, Math.min(expected, got - c0));
      for (let i = 0; i < avail; i++) {
        const divisor = floating ? 1 : 32768;
        L[i] = pcm[(c0 + i) * 2] / divisor;
        R[i] = pcm[(c0 + i) * 2 + 1] / divisor;
        if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error('неверные данные звука');
      }
      buffered.push({ chunk: c, L, R });
    }
    return buffered;
  }

  private feedChunks(slot: Slot, chunks: BufferedChunk[], part: PcmPart = 'original'): void {
    const stream = part === 'vocals' ? slot.vocals : slot;
    if (chunks.length && part === 'vocals') stream.failed = null;
    for (const { chunk, L, R } of chunks) {
      stream.fed.add(chunk);
      this.post({ cmd: part === 'vocals' ? 'feedVocal' : 'feed', deck: slot.deck, token: slot.token, chunk, L, R }, [L.buffer, R.buffer]);
    }
  }

  private waitFed(slot: Slot, fromFrame: number, chunks = 2, timeoutMs = 20000): Promise<void> {
    const first = Math.floor(fromFrame / CHUNK_FRAMES);
    const last = Math.min(Math.ceil(slot.totalFrames / CHUNK_FRAMES) - 1, first + chunks - 1);
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const check = () => {
        if (slot.failed) return reject(new Error(slot.failed));
        if (slot.abort.signal.aborted) return reject(new Error('отменено'));
        let ok = true;
        for (let c = first; c <= last; c++) if (!slot.fed.has(c)) ok = false;
        if (ok) return resolve();
        if (performance.now() - t0 > timeoutMs) return reject(new Error('сервер слишком долго готовит звук'));
        setTimeout(check, 30);
      };
      check();
    });
  }

  private releaseSlot(slot: Slot | null): void {
    if (!slot) return;
    slot.abort.abort();
    this.deckTelemetry.delete(slot.token);
    if (this.slots[slot.deck] === slot) {
      this.slots[slot.deck] = null;
      this.post({ cmd: 'unload', deck: slot.deck });
    }
  }

  private retireSlot(slot: Slot | null, delayMs: number): void {
    if (!slot) return;
    const pending = new Promise<void>((resolve) => {
      setTimeout(() => { this.releaseSlot(slot); resolve(); }, delayMs);
    });
    this.retirements[slot.deck] = pending;
    void pending.then(() => { if (this.retirements[slot.deck] === pending) this.retirements[slot.deck] = null; });
  }

  private onSlotFailed(slot: Slot, msg: string): void {
    const t = this.track(slot.trackId);
    if (this.next?.slot === slot && this.current !== slot) {
      this.nextRequest = null;
      this.notify(`Пропущен «${t?.title ?? 'трек'}»: ${msg}`, 'error');
      if (this.state.transition?.active && this.current) {
        // B is audible but A is still the main deck. Seeking A aborts the
        // blend and fades B safely; an active engine ignores plain disarm.
        this.failedIncomingToken = slot.token;
        this.recovering = null;
        this.post({ cmd: 'seek', token: this.current.token, frame: Math.round(this.state.position * this.sr) });
        return;
      }
      // the prepared next track is broken: drop it so the queue keeps going
      const idx = this.state.queue.findIndex((entry) => entry.entryId === this.next!.entry.entryId);
      this.next = null;
      this.pendingEndReason = 'transition';
      this.post({ cmd: 'disarm' });
      this.releaseSlot(slot);
      this.removeIndexSilently(idx);
      if (this.keepPreparing(msg)) void this.prepareNext();
    } else if (this.current === slot) {
      this.notify(`Не удалось воспроизвести «${t?.title ?? 'трек'}»: ${msg}`, 'error');
      const generation = this.generation;
      setTimeout(() => {
        if (this.current === slot && this.generation === generation && this.state.status !== 'paused') void this.advanceAfterFailure();
      }, 800);
    }
  }

  // ---------------------------------------------------------------- playback

  async playTracks(trackIds: string[], startIndex: number, context: PlayContext, playlistEntryIds?: number[]): Promise<void> {
    this.queueRevision++;
    this.previewRevision++;
    this.resetWaveBuffer();
    const queue: QueueEntry[] = trackIds.map((id, i) => ({ entryId: uid(), trackId: id, origin: 'context',
      ...(context.type === 'playlist' && context.id && Number.isSafeInteger(playlistEntryIds?.[i]) && playlistEntryIds![i] > 0
        ? { sourcePlaylistId: context.id, playlistEntryId: playlistEntryIds![i] } : {}) }));
    this.originalOrder = null;
    let index = startIndex;
    if (this.state.shuffle) {
      const first = queue[startIndex];
      const rest = queue.filter((_, i) => i !== startIndex);
      shuffleInPlace(rest);
      this.originalOrder = queue;
      queue.splice(0, queue.length, first, ...rest);
      index = 0;
    }
    this.set({ queue, index, context, error: null });
    await this.startAt(index, 0);
  }

  /**
   * Plays another recording in place of the current queue entry, once (the
   * version panel's "only now"). The new entry carries no attribution of the
   * replaced one, so no service gets feedback for audio it did not provide.
   */
  async playInstead(trackId: string): Promise<void> {
    const i = this.state.index;
    if (!this.state.queue[i]) return this.playTracks([trackId], 0, { type: 'queue', label: 'Очередь' });
    const queue = [...this.state.queue];
    queue[i] = { entryId: uid(), trackId, origin: 'user' };
    this.set({ queue });
    await this.startAt(i, 0);
  }

  /** User-requested listening check using today's plan and the normal audio path. */
  /** Saves a listener rating (null clears it) for a logged transition; mirrors it on lastTransition. */
  async rateTransition(logId: number, rating: TransitionRating | null, reason: TransitionRatingReason | null = null): Promise<void> {
    await api.rateTransition(logId, rating, reason);
    const last = this.state.lastTransition;
    if (last?.logId === logId) this.set({ lastTransition: { ...last, rating, ratingReason: rating === 'bad' ? reason : null } });
  }

  async previewPair(fromId: string, toId: string): Promise<void> {
    const from = this.track(fromId);
    if (!from || !this.track(toId)) throw new Error('трек не найден в медиатеке');
    const revision = ++this.previewRevision;
    const generation = this.generation;
    // Start/resume the context while still handling the click gesture. Planning
    // can take longer than the browser's user-activation window.
    const [, result] = await Promise.all([this.ensureEngine(), api.plan(fromId, toId)]);
    if (revision !== this.previewRevision || generation !== this.generation) return;
    this.resetWaveBuffer();
    const seconds = Math.max(0, Math.min(result.plan.aExit - 8, Math.max(0, from.duration - 0.01)));
    const queue: QueueEntry[] = [fromId, toId].map((trackId) => ({ entryId: uid(), trackId, origin: 'user' }));
    this.originalOrder = null;
    this.queueRevision++;
    this.set({ queue, index: 0, context: { type: 'queue', id: 'preview', label: 'Прослушивание перехода' }, shuffle: false, repeat: 'off', waveLoading: false, error: null });
    await this.startAt(0, seconds);
  }

  async startWave(kind: 'own' | 'yandex' = 'own'): Promise<void> {
    if (this.autonomousRadio) return this.startDesktopStation({ kind });
    const revision = ++this.previewRevision;
    this.resetWaveBuffer();
    const epoch = this.waveEpoch;
    await this.ensureEngine();
    if (revision !== this.previewRevision) return;
    this.set({ waveLoading: true, waveRefillError: null, error: null });
    try {
      let entries: QueueEntry[] = [];
      if (kind === 'yandex') {
        const w = await api.yandexWave(null, this.native && !desktop?.nativeMix ? { count: 1 } : undefined);
        await this.refreshLibrary();
        if (revision !== this.previewRevision) return;
        this.yandexSession = { sessionId: w.sessionId, batchId: w.batchId };
        const known = new Set<string>();
        entries = w.items.filter((i) => {
          if (!i.trackId || known.has(i.trackId) || this.track(i.trackId)?.reaction === -1) return false;
          known.add(i.trackId); return true;
        }).slice(0, 4).map((i) => ({ entryId: uid(), trackId: i.trackId!, origin: 'yandex' as const, yandexId: i.yandexId,
          yandexSessionId: w.sessionId, yandexBatchId: w.batchId, reasons: ['из «Моей волны» Яндекса'] }));
        if (!entries.length) throw new Error('Яндекс пока не подготовил доступные полные треки. Попробуйте запустить волну ещё раз.');
      }
      if (kind === 'own') {
        this.yandexSession = null;
        const r = await api.waveNext({ currentId: null, session: [], count: 3, offline: this.offlineOnly || undefined });
        if (revision !== this.previewRevision) return;
        entries.push(...r.picks.map((p) => ({ entryId: uid(), trackId: p.id, origin: 'wave' as const, reasons: p.reasons })));
      }
      if (!entries.length) throw new Error('Для «Моей волны» нужны треки в медиатеке');
      this.originalOrder = null;
      this.queueRevision++;
      this.set({ queue: entries, index: 0, context: { type: kind === 'yandex' ? 'yandex-wave' : 'wave', label: kind === 'yandex' ? 'Моя волна Яндекса' : 'Моя волна' }, shuffle: false });
      await this.startAt(0, 0);
    } catch (e) {
      this.notify((e as Error).message, 'error');
    } finally {
      if (epoch === this.waveEpoch) {
        this.set({ waveLoading: false });
        if (this.isWave()) void this.topUpWave();
      }
    }
  }

  /** Starts queue[index] from `seconds`, cutting (with a short fade) whatever plays now. */
  async startAt(index: number, seconds: number, endReason: string = 'skip', startPaused = false): Promise<void> {
    if (this.native) { ++this.previewRevision; return this.nativeStartAt(index, seconds, endReason, startPaused); }
    const intent = ++this.previewRevision;
    const entry = this.state.queue[index];
    if (!entry) return;
    await this.ensureEngine();
    if (intent !== this.previewRevision || this.state.queue[index]?.entryId !== entry.entryId) return;
    const gen = ++this.generation;
    this.startingGeneration = gen;
    this.recovering = null;
    this.deferredLoudnessChange = false;
    this.failedIncomingToken = null;
    this.pendingEndReason = 'transition';
    this.finishPlay(endReason);
    this.invalidateNext();
    this.post({ cmd: 'pause', paused: startPaused });
    this.set({ index, status: startPaused ? 'paused' : 'loading', position: seconds, duration: this.track(entry.trackId)?.duration ?? 0, transition: null, error: null });
    this.focusAnalysis();
    const deck = this.current ? 1 - this.current.deck : 0;
    let slot: Slot;
    try {
      slot = await this.loadSlot(deck, entry, seconds, 'current', null, () => gen === this.generation);
      await this.waitFed(slot, Math.round(seconds * this.sr), 2);
    } catch (e) {
      if (gen !== this.generation) return;
      this.startingGeneration = null;
      if (unreachable(e)) {
        const paused = this.state.status === 'paused';
        this.set({ status: paused ? 'paused' : 'buffering' });
        setTimeout(() => { if (gen === this.generation && this.state.status !== 'paused') void this.startAt(index, seconds, endReason); }, 2000);
        return;
      }
      this.notify(`Не удалось воспроизвести: ${(e as Error).message}`, 'error');
      const paused = this.state.status === 'paused';
      this.set({ status: paused ? 'paused' : 'idle' });
      if (this.state.context && (this.state.context.type === 'wave' || this.state.context.type === 'yandex-wave' || this.state.queue.length > index + 1)) {
        setTimeout(() => { if (gen === this.generation && this.state.status !== 'paused') void this.advanceAfterFailure(); }, 600);
      }
      return;
    }
    if (gen !== this.generation) {
      this.releaseSlot(slot);
      return;
    }
    const prev = this.current;
    this.startingGeneration = null;
    const paused = this.state.status === 'paused';
    this.post({ cmd: 'start', deck: slot.deck, token: slot.token, frame: Math.round(seconds * this.sr) });
    if (paused) this.post({ cmd: 'pause', paused: true });
    this.current = slot;
    this.skipStreak = 0;
    if (prev && prev !== slot) this.retireSlot(prev, 120);
    this.maxPos = seconds;
    this.set({ status: paused ? 'paused' : 'playing' });
    this.beginPlay(entry);
    this.focusAnalysis();
    void this.prepareNext();
    this.scheduleSave();
  }

  private async advanceAfterFailure(): Promise<void> {
    const i = this.state.index;
    const n = this.nextIndex();
    this.removeIndexSilently(i);
    if (n === null) {
      this.finishPlay('error');
      this.releaseSlot(this.current);
      this.current = null;
      this.waveExhausted = this.isWave();
      this.set({ status: this.isWave() ? 'buffering' : 'idle', position: 0, duration: 0 });
      if (this.isWave()) void this.topUpWave();
      return;
    }
    if (this.state.queue.length > 0) await this.startAt(Math.min(i, this.state.queue.length - 1), 0, 'error');
  }

  toggle(): void {
    if (this.state.status === 'playing' || this.state.status === 'buffering') this.pause();
    else void this.resume();
  }

  pause(): void {
    this.traceAction('pause');
    this.previewRevision++;
    if (this.native) this.nativeCommand('pause');
    else this.post({ cmd: 'pause', paused: true });
    this.set({ status: 'paused' });
    this.scheduleSave(true);
  }

  async resume(): Promise<void> {
    this.traceAction('play');
    const intent = ++this.previewRevision;
    if (this.radioPlay) this.radioPlay.tick = performance.now();
    if (this.native) {
      if (this.nativeAt >= 0) { this.nativeCommand('play'); this.set({ status: 'playing' }); }
      else if (this.state.index >= 0 && this.state.queue[this.state.index]) await this.startAt(this.state.index, this.restoredPosition || 0);
      return;
    }
    if (!this.current && this.waveExhausted && (this.isWave() || this.state.context?.type === 'online-radio')) {
      const next = this.nextIndex();
      if (next !== null) { this.waveExhausted = false; await this.startAt(next, 0, 'finished'); }
      else { this.set({ status: 'buffering' }); if (this.isWave()) void this.topUpWave(); }
      return;
    }
    if (!this.current) {
      if (this.state.index >= 0 && this.state.queue[this.state.index]) await this.startAt(this.state.index, this.restoredPosition || 0);
      return;
    }
    await this.ensureEngine();
    if (intent !== this.previewRevision) return;
    this.post({ cmd: 'pause', paused: false });
    this.set({ status: 'playing' });
  }

  seek(seconds: number): void {
    this.traceAction('seekto');
    this.previewRevision++;
    this.nextRequest = null;
    this.recovering = null;
    if (this.native && this.nativeStarting) {
      const index = this.nativePendingIndex ?? this.state.index;
      const duration = this.track(this.state.queue[index]?.trackId)?.duration ?? this.state.duration;
      const s = Math.max(0, Math.min(seconds, duration));
      void this.nativeStartAt(index, s, 'skip', this.state.status === 'paused');
      return;
    }
    if (this.native && this.nativeAt >= 0) {
      const s = Math.max(0, Math.min(seconds, this.state.duration));
      this.nativeCommand('seekto', s);
      this.set({ position: s });
      return;
    }
    if (this.startingGeneration === this.generation) {
      const s = Math.max(0, Math.min(seconds, this.state.duration));
      void this.startAt(this.state.index, s, 'skip', this.state.status === 'paused');
      return;
    }
    if (!this.current) {
      this.restoredPosition = seconds;
      this.set({ position: seconds });
      return;
    }
    const s = Math.max(0, Math.min(seconds, (this.current.totalFrames - 1) / this.sr));
    this.post({ cmd: 'seek', token: this.current.token, frame: Math.round(s * this.sr) });
    this.set({ position: s });
  }

  setVolume(v: number): void {
    const vol = Math.max(0, Math.min(1, v));
    this.set({ volume: vol, muted: false });
    this.postVolume();
  }

  toggleMute(): void {
    this.set({ muted: !this.state.muted });
    this.postVolume();
  }

  /** Temporary output fade (sleep timer). Never changes the saved volume. */
  private fadeGain = 1;
  setFade(g: number): void {
    this.fadeGain = Math.max(0, Math.min(1, g));
    this.postVolume();
  }
  private postVolume(): void {
    if (this.native) void nativePlaybackControls()?.mix?.settings({ volume: this.state.muted ? 0 : this.state.volume * this.fadeGain, userVolume: this.state.volume, muted: this.state.muted }).catch(() => {});
    this.post({ cmd: 'volume', value: this.state.muted ? 0 : this.state.volume * this.fadeGain });
  }

  /** Settings: "Next" switches at once (no musical blend) when true. */
  instantNext = false;

  /** Drop future copies and cut the current recording after a saved dislike. */
  async applyDislike(trackId: string): Promise<void> {
    // Desktop hosts receive the committed reaction directly from the backend.
    if (this.autonomousRadio) return;
    const queue = this.state.queue.filter((entry, i) => i <= this.state.index || entry.trackId !== trackId);
    if (queue.length !== this.state.queue.length) { this.set({ queue }); this.onQueueChanged(); }
    if (this.currentEntry?.trackId === trackId) await this.nextTrack('dislike');
  }

  /** User pressed "next". */
  async nextTrack(reason: 'skip' | 'dislike' = 'skip'): Promise<void> {
    this.traceAction('nexttrack');
    const intent = ++this.previewRevision;
    if (this.native) {
      let n = this.nextIndex(true, this.nativePendingIndex ?? this.state.index);
      if (this.nativePendingIndex !== null) {
        if (n !== null) await this.startAt(n, 0, reason, this.state.status === 'paused');
        return;
      }
      if (n === null && this.isWave()) { await this.topUpWave(); if (intent !== this.previewRevision) return; n = this.nextIndex(true); }
      if (n === null) return;
      if (this.nativeAt >= 0 && this.nativeTracks[this.nativeAt + 1]?.entryId === this.state.queue[n].entryId) {
        this.nativeSkip = true; this.nativeCommand('nexttrack');
      } else await this.startAt(n, 0, reason, this.state.status === 'paused');
      return;
    }
    if (this.startingGeneration === this.generation) {
      const next = this.nextIndex(true);
      if (next !== null) await this.startAt(next, 0, reason, this.state.status === 'paused');
      return;
    }
    if (this.state.status === 'paused') {
      const next = this.nextIndex(true);
      if (next !== null) await this.startAt(next, 0, reason, true);
      return;
    }
    const tr = this.state.transition;
    if (tr?.active) {
      this.nextRequest = null;
      this.post({ cmd: 'finish', fade: 0.4 });
      return;
    }
    const cur = this.current;
    const pending = this.nextRequest;
    if (cur && pending?.current === cur && pending.generation === this.generation && pending.revision === this.preparationRevision) {
      // A second press also works while planning/loading is still in flight.
      pending.quick = true;
      if (this.next) {
        this.nextRequest = null;
        await this.armQuickSkip(cur, this.next);
      }
      return;
    }
    let n = this.nextIndex(true);
    if (n === null && this.isWave()) {
      const epoch = this.waveEpoch;
      await this.topUpWave();
      if (epoch !== this.waveEpoch || this.current !== cur || intent !== this.previewRevision) return;
      n = this.nextIndex(true);
    }
    if (n === null) return;
    if (!cur) {
      await this.startAt(n, 0, 'skip');
      return;
    }
    // Repeat-one may already have the current song prepared on the spare deck.
    // A manual Next advances the queue even though automatic playback repeats.
    if (this.next && this.next.entry.entryId !== this.state.queue[n]?.entryId) this.invalidateNext();
    const request = { current: cur, generation: this.generation, revision: this.preparationRevision,
      quick: this.instantNext || reason === 'dislike' || this.next?.plan.debug.requested === true || this.next?.plan.method === 'skip_fade' };
    this.nextRequest = request;
    this.skipStreak = 0;
    const isRelevant = () => this.nextRequest === request && this.current === cur && request.generation === this.generation &&
      request.revision === this.preparationRevision && !this.state.transition?.active;
    try {
      // An older automatic preparation can be cancelling here. Its finally
      // starts the replacement; await that preparation as well when necessary.
      for (let attempt = 0; attempt < 2 && !this.next; attempt++) {
        await this.prepareNext(true);
        if (!isRelevant()) return;
      }
      const nx = this.next;
      if (!nx || !isRelevant()) return;
      if (request.quick) {
        await this.armQuickSkip(cur, nx, isRelevant);
        return;
      }
      const preparedPlan = nx.plan;
      const response = await api.mixNow(cur.trackId, nx.entry.trackId, this.state.position);
      if (!isRelevant() || this.next !== nx || nx.plan !== preparedPlan) return;
      let plan = this.retimeRequested(this.afterRecovery(response.plan));
      const [buffered, vocals] = await Promise.all([
        this.bufferChangedCue(nx, preparedPlan, plan, true),
        this.bufferVocals(cur, nx.slot, plan),
      ]);
      if (!isRelevant() || this.next !== nx || nx.plan !== preparedPlan) return;
      const stagedExit = vocals.plan.aExit;
      plan = this.retimeRequested(vocals.plan);
      if (plan.vocalA && plan.aExit !== stagedExit) {
        // A's vocal chunks are keyed by source time. A delayed HTTP response
        // can move the exit to the following bar; refill that new source span.
        const replacement = await this.bufferVocals(cur, nx.slot, { ...plan, vocalB: undefined });
        if (!isRelevant() || this.next !== nx || nx.plan !== preparedPlan) return;
        vocals.A = replacement.A;
        plan = { ...replacement.plan, vocalB: plan.vocalB };
        const bufferedExit = plan.aExit;
        plan = this.retimeRequested(plan);
        if (plan.aExit !== bufferedExit) plan = { ...plan, vocalA: undefined };
      }
      this.armRequestedPlan(cur, nx, plan, buffered, vocals);
    } catch (e) {
      if (!isRelevant() || !this.next) return;
      this.notify(`Не удалось подготовить музыкальный переход: ${(e as Error).message}`, 'info');
      this.armRequestedPlan(cur, this.next, skipPlanFrom(this.next.plan, this.state.position + 0.03));
    } finally {
      if (this.nextRequest === request) this.nextRequest = null;
    }
  }

  /** A manual skip starts the next song from its beginning, not from the AutoMix entry point. */
  private async armQuickSkip(cur: Slot, nx: NextPrep, isRelevant: () => boolean = () => true): Promise<void> {
    const prepared = nx.plan, intent = this.previewRevision, generation = this.generation;
    const fromStart = (plan: TransitionPlan): TransitionPlan => ({ ...plan, bEntry: 0 });
    const buffered = await this.bufferChangedCue(nx, nx.plan, fromStart(skipPlanFrom(nx.plan, this.state.position)));
    if (!isRelevant() || this.current !== cur || this.next !== nx || nx.plan !== prepared ||
      intent !== this.previewRevision || generation !== this.generation || this.state.transition?.active) return;
    this.armRequestedPlan(cur, nx, fromStart(skipPlanFrom(nx.plan, this.state.position + 0.03)), buffered);
  }

  private armRequestedPlan(cur: Slot, nx: NextPrep, plan: TransitionPlan, buffered: BufferedChunk[] = [], vocals?: BufferedVocals): void {
    if (this.current !== cur || this.next !== nx || this.state.transition?.active) return;
    const recues = nx.plan.bEntry !== plan.bEntry;
    nx.plan = plan;
    nx.pending = [];
    this.pendingEndReason = 'skip';
    if (recues) this.post({ cmd: 'cue', deck: nx.slot.deck, frame: Math.round(plan.bEntry * this.sr) });
    this.feedChunks(nx.slot, buffered);
    if (vocals) {
      this.feedChunks(cur, vocals.A, 'vocals');
      this.feedChunks(nx.slot, vocals.B, 'vocals');
    }
    this.post({ cmd: 'gain', deck: cur.deck, gainDb: plan.gainA });
    this.post({ cmd: 'gain', deck: nx.slot.deck, gainDb: plan.gainB });
    this.post({ cmd: 'arm', transition: planToArmed(plan, this.sr, cur.token, nx.slot.token) });
    this.set({ nextPlan: plan, nextPending: [], transition: null });
  }

  private startupChunks(slot: Slot, cue: number, duration: number): number[] {
    const frame = Math.round(cue * this.sr);
    // Match the worklet's startup coverage, including WSOLA look-behind.
    // Stage PCM off the spare deck: changing its cue before this request
    // completes would evict the old cue and break a repeated fast Next.
    const first = Math.floor(Math.max(0, frame - 4096) / CHUNK_FRAMES);
    const need = Math.min(duration + 1, 3) * this.sr * 1.15 + 4096;
    const last = Math.min(Math.ceil(slot.totalFrames / CHUNK_FRAMES) - 1, Math.floor((frame + need - 1) / CHUNK_FRAMES));
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
  }

  private async bufferChangedCue(nx: NextPrep, previous: TransitionPlan, plan: TransitionPlan, force = false): Promise<BufferedChunk[]> {
    if (!force && plan.bEntry === previous.bEntry) return [];
    return this.readChunks(nx.slot, this.startupChunks(nx.slot, plan.bEntry, plan.duration));
  }

  private async bufferVocals(cur: Slot, next: Slot, plan: TransitionPlan): Promise<BufferedVocals> {
    if (desktop?.audioStart) return { plan: fallbackWithoutVocalStems(plan), A: [], B: [] };
    const needed = (points: [number, number][] | undefined) => points?.some(([, gain]) => gain < 0.999);
    try {
      const [A, B] = await Promise.all([
        needed(plan.vocalA) || plan.voiceEcho ? this.readChunks(cur, this.startupChunks(cur, plan.aExit, plan.duration), 'vocals') : [],
        needed(plan.vocalB) ? this.readChunks(next, this.startupChunks(next, plan.bEntry, plan.duration), 'vocals') : [],
      ]);
      return { plan, A, B };
    } catch (e) {
      const fallback = fallbackWithoutVocalStems(plan);
      const { stems: _staleStems, ...debug } = fallback.debug;
      return { plan: { ...fallback,
        reasons: [...plan.reasons.filter((reason) => !/вокал|голос/.test(reason)), 'разделённый вокал не загрузился: переход продолжится по оригинальному звуку'],
        debug: { ...debug, vocalFallback: (e as Error).message } }, A: [], B: [] };
    }
  }

  private retimeRequested(plan: TransitionPlan): TransitionPlan {
    // HTTP can return after the proposed start. Preserve bar alignment where
    // available; plain fades can safely start just after the current tick.
    const bpmA = plan.beatAlign?.bpmA ?? (plan.method === 'echo_out' ? this.track(plan.fromTrackId)?.analysis.bpm : null);
    const bar = bpmA && Number.isFinite(bpmA) && bpmA > 0 ? 240 / bpmA : 0;
    // Telemetry is emitted every 50 ms. Leave enough lead for its age and
    // message delivery before a bar-locked transition reaches the worklet.
    if (plan.aExit > this.state.position + (bar > 0 ? 0.1 : 0.03)) return plan;
    const exit = bar > 0 ? plan.aExit + Math.ceil((this.state.position + 0.12 - plan.aExit) / bar) * bar : this.state.position + 0.06;
    const consumedA = consumedSource(plan.tempoA ?? [[0, 1]], plan.duration);
    return exit + consumedA > (this.track(plan.fromTrackId)?.duration ?? Infinity)
      ? skipPlanFrom(plan, this.state.position + 0.03) : { ...plan, aExit: exit, loopA: undefined, tapeStopA:undefined };
  }

  /** Let the preceding bridge finish its solo tempo recovery before a new beat lock. */
  private afterRecovery(plan: TransitionPlan): TransitionPlan {
    const recovery = this.recovering;
    if (!recovery || recovery.token !== this.current?.token || recovery.endPosition <= this.state.position) return plan;
    const bpmA = plan.beatAlign?.bpmA ?? (plan.method === 'echo_out' ? this.track(plan.fromTrackId)?.analysis.bpm : null);
    if (!bpmA || !Number.isFinite(bpmA) || bpmA <= 0 || plan.aExit >= recovery.endPosition + 0.12) return plan;
    const bar = 240 / bpmA;
    const exit = plan.aExit + Math.ceil((recovery.endPosition + 0.12 - plan.aExit) / bar) * bar;
    const consumedA = consumedSource(plan.tempoA ?? [[0, 1]], plan.duration);
    if (exit + consumedA > (this.track(plan.fromTrackId)?.duration ?? Infinity)) return skipPlanFrom(plan, this.state.position + 0.03);
    return { ...plan, aExit: exit, loopA: undefined, tapeStopA:undefined, reasons: ['сначала текущий трек плавно возвращается к своему темпу', ...plan.reasons],
      debug: { ...plan.debug, recoveryDeferred: true } };
  }

  async prevTrack(): Promise<void> {
    this.traceAction('previoustrack');
    this.previewRevision++;
    if (this.nativePendingIndex !== null) {
      await this.startAt(Math.max(0, this.nativePendingIndex - 1), 0, 'skip', this.state.status === 'paused');
      return;
    }
    if (this.state.position > 3 || this.state.index <= 0) {
      this.seek(0);
      return;
    }
    if (this.native && this.nativeAt > 0 && this.nativeTracks[this.nativeAt - 1]?.entryId === this.state.queue[this.state.index - 1]?.entryId) {
      this.nativeSkip = true; this.nativeCommand('previoustrack');
      return;
    }
    await this.startAt(this.state.index - 1, 0, 'skip', this.state.status === 'paused');
  }

  // ------------------------------------------------------------------- queue

  /** Index of the entry that plays after the current one. */
  private nextIndex(manual = false, index = this.state.index): number | null {
    const { queue, repeat } = this.state;
    if (!queue.length) return null;
    if (repeat === 'one' && !manual) return index;
    if (index + 1 < queue.length) return index + 1;
    if (repeat === 'all') return 0;
    return null;
  }

  /** No usable network (lib/offline-wave.ts): «Моя волна» picks only songs that play from this device. */
  offlineOnly = false;
  setOfflineOnly(on: boolean): void {
    if (this.offlineOnly === on) return;
    this.offlineOnly = on;
    // A refill that failed for lack of network may try again at once with what the device has.
    this.waveRetryAt = 0; this.waveFailures = 0;
    if (this.isWave()) void this.topUpWave();
  }

  private isWave(): boolean {
    const t = this.state.context?.type;
    return t === 'wave' || t === 'yandex-wave';
  }

  /** Maintain a short rolling horizon without waiting for the current batch to end. */
  private resetWaveBuffer(): void {
    this.waveEpoch++;
    this.waveRequest = null;
    this.waveRetryAt = 0;
    this.waveFailures = 0;
    this.waveExhausted = false;
    this.yandexSessionReset = false;
    if (this.waveRetryTimer) clearTimeout(this.waveRetryTimer);
    this.waveRetryTimer = null;
    this.set({ waveLoading: false, waveRefillError: null, continuation: null });
  }

  /** A station is being chosen for the queue end (label), or none will come (null): the last song's end
   * then waits for it instead of stopping, or stops for real. */
  holdQueueEnd(label: string | null): void {
    this.set({ continuation: label });
    if (label || this.current || !this.waveExhausted || this.state.status !== 'buffering' || this.isWave() || this.state.context?.type === 'online-radio') return;
    this.waveExhausted = false;
    this.set({ status: 'idle', position: 0 });
  }

  /** The queue goes on as a station: the playing song is not cut, the next ones mix in as usual.
   * replaceUpcoming: the station takes over from the next song (another station, "similar to this"). */
  continueAs(context: PlayContext, trackIds: string[] = [], origin: Origin = 'context', replaceUpcoming = false): void {
    const exhausted = this.waveExhausted;
    this.resetWaveBuffer();
    this.waveExhausted = exhausted;
    const entries = trackIds.map((id) => ({ entryId: uid(), trackId: id, origin }));
    const kept = replaceUpcoming ? this.state.queue.slice(0, this.state.index + 1) : this.state.queue;
    this.set({ context, queue: [...kept, ...entries] });
    this.onQueueChanged(replaceUpcoming);
    if (!this.current && this.waveExhausted && this.state.status === 'buffering') {
      const next = this.nextIndex();
      if (next !== null) { this.waveExhausted = false; void this.startAt(next, 0, 'finished'); }
    }
  }

  /** Apply saved provider settings to future recommendations without cutting audio. */
  async refreshYandexWave(): Promise<void> {
    if (this.state.context?.type !== 'yandex-wave') return;
    const exhausted = this.waveExhausted;
    this.resetWaveBuffer();
    this.waveExhausted = exhausted;
    this.yandexSession = null;
    this.yandexSessionReset = true;
    const preparedId = this.next?.entry.entryId;
    const queue = this.state.queue.filter((entry, index) => index <= this.state.index ||
      entry.origin !== 'yandex' || entry.entryId === preparedId);
    this.set({ queue });
    this.onQueueChanged();
    await this.topUpWave();
  }

  private waveReserve(): number { return this.native && this.nativeMix.prepareQueue ? 12 : 6; }

  private waveNeedsMore(): boolean {
    // shortcut: radio selection still needs WebContent; hand off a longer known reserve until native radio selection exists.
    if (this.native && this.nativeMix.prepareQueue) return this.state.queue.length - this.state.index - 1 < this.waveReserve();
    const upcoming = this.state.queue.slice(this.state.index + 1);
    const seconds = upcoming.reduce((sum, entry) => sum + (this.track(entry.trackId)?.duration ?? 180), 0);
    return upcoming.length < 4 || (upcoming.length < 6 && seconds < 480);
  }

  private topUpWave(): Promise<void> {
    if (this.autonomousRadio) return Promise.resolve();
    if (this.waveRequest) return this.waveRequest;
    if (!this.isWave() || this.state.waveLoading || !this.waveNeedsMore()) return Promise.resolve();
    if (Date.now() < this.waveRetryAt) {
      if (!this.waveRetryTimer && this.state.status === 'buffering') {
        const context = this.state.context;
        this.waveRetryTimer = setTimeout(() => {
          this.waveRetryTimer = null;
          if (context === this.state.context) void this.topUpWave();
        }, this.waveRetryAt - Date.now());
      }
      return Promise.resolve();
    }
    const epoch = this.waveEpoch;
    const context = this.state.context;
    const relevant = () => epoch === this.waveEpoch && context === this.state.context && this.isWave();
    const request = this.refillWave(relevant);
    this.waveRequest = request;
    void request.finally(() => {
      if (this.waveRequest === request) {
        this.waveRequest = null;
        if (!relevant()) this.set({ waveLoading: false });
      }
    });
    return request;
  }

  private async refillWave(relevant: () => boolean): Promise<void> {
    this.set({ waveLoading: true, waveRefillError: null });
    let addedAny = false;
    try {
      // Bounded requests/downloads: a reserve, not an offline copy of the catalog.
      for (let attempt = 0; attempt < 3 && relevant() && this.waveNeedsMore(); attempt++) {
        const ahead = this.state.queue.length - this.state.index - 1;
        const count = Math.max(1, Math.min(4, this.waveReserve() - ahead));
        let added: QueueEntry[];
        if (this.state.context?.type === 'yandex-wave') {
          const attribution = this.yandexSession ?? this.state.queue.slice().reverse().find((e) => e.yandexSessionId);
          const session = this.yandexSessionReset ? null : attribution && ('sessionId' in attribution ? attribution.sessionId : attribution.yandexSessionId);
          const excluded = [...new Set(this.state.queue.flatMap((e) => e.yandexId ? [e.yandexId] : []))].slice(-200);
          const w = await api.yandexWave(session ?? null, { queue: excluded, count });
          if (!relevant()) return;
          await this.refreshLibrary();
          if (!relevant()) return;
          this.yandexSession = { sessionId: w.sessionId, batchId: w.batchId };
          this.yandexSessionReset = false;
          added = w.items.flatMap((item): QueueEntry[] => item.trackId ? [{ entryId: uid(), trackId: item.trackId,
            origin: 'yandex', yandexId: item.yandexId, yandexSessionId: w.sessionId, yandexBatchId: w.batchId,
            reasons: ['из «Моей волны» Яндекса'] }] : []);
        } else {
          const r = await api.waveNext({ currentId: this.currentEntry?.trackId ?? null,
            session: this.state.queue.map((e) => e.trackId), count, offline: this.offlineOnly || undefined });
          added = r.picks.map((pick) => ({ entryId: uid(), trackId: pick.id, origin: 'wave', reasons: pick.reasons }));
        }
        if (!relevant()) return;
        // Recheck the live queue after HTTP: rapid skips/edits may have changed it.
        const known = new Set(this.state.queue.map((e) => e.trackId));
        const remoteKnown = new Set(this.state.queue.flatMap((e) => e.yandexId ? [e.yandexId.split(':')[0]] : []));
        added = added.filter((entry) => {
          const remote = entry.yandexId?.split(':')[0];
          if (known.has(entry.trackId) || (remote && remoteKnown.has(remote)) || this.track(entry.trackId)?.reaction === -1) return false;
          known.add(entry.trackId); if (remote) remoteKnown.add(remote);
          return true;
        }).slice(0, Math.max(0, Math.max(8, this.waveReserve()) - (this.state.queue.length - this.state.index - 1)));
        if (!added.length) break;
        addedAny = true;
        const trim = !this.state.transition?.active ? Math.max(0, this.state.index - 120) : 0;
        if (trim && this.next) this.next.index -= trim;
        this.set({ queue: [...this.state.queue.slice(trim), ...added], index: this.state.index - trim });
        this.focusAnalysis();
        this.scheduleSave();
        if (this.nativeAt >= 0) void this.nativeSync();
        // Preparing the immediate pair must not wait for subsequent downloads.
        if (this.current && !this.next && !this.preparing) void this.prepareNext();
      }
      if (relevant()) {
        this.waveFailures = addedAny ? 0 : Math.min(5, this.waveFailures + 1);
        this.waveRetryAt = Date.now() + (addedAny ? 5000 : Math.min(60000, 5000 * 2 ** this.waveFailures));
        if (!addedAny) this.set({ waveRefillError: 'Пока нет новых доступных треков. Повторим подбор автоматически.' });
      }
    } catch (e) {
      if (relevant()) {
        this.waveFailures = Math.min(5, this.waveFailures + 1);
        this.waveRetryAt = Date.now() + Math.min(60000, 5000 * 2 ** this.waveFailures);
        this.set({ waveRefillError: 'Продолжение задерживается. Повторим загрузку автоматически.' });
        if (this.waveFailures === 1) this.notify(`Пополнение волны задерживается. Повторю автоматически: ${(e as Error).message}`, 'info');
      }
    } finally {
      if (relevant()) {
        this.set({ waveLoading: false });
        if (addedAny && this.current && !this.next && !this.preparing) void this.prepareNext();
        if (addedAny && !this.current && this.state.status === 'buffering') {
          const index = this.nextIndex();
          if (index !== null) { this.waveExhausted = false; void this.startAt(index, 0, 'finished'); }
        }
        if (this.waveRetryTimer) clearTimeout(this.waveRetryTimer);
        if (this.waveNeedsMore()) this.waveRetryTimer = setTimeout(() => {
          this.waveRetryTimer = null;
          if (relevant() && (this.state.status === 'playing' || this.state.status === 'buffering')) void this.topUpWave();
        }, Math.max(1000, this.waveRetryAt - Date.now()));
      }
    }
  }

  addToQueue(trackIds: string[], playNext = false): void {
    const entries = trackIds.map((id) => ({ entryId: uid(), trackId: id, origin: 'user' as const }));
    const q = [...this.state.queue];
    if (this.state.index < 0) {
      q.push(...entries);
      this.set({ queue: q, index: 0, context: this.state.context ?? { type: 'queue', label: 'Очередь' } });
      this.scheduleSave();
      return;
    }
    if (playNext) q.splice(this.state.index + 1, 0, ...entries);
    else q.push(...entries);
    this.set({ queue: q });
    this.onQueueChanged(false);
    if (!this.current && this.waveExhausted && this.state.context?.type === 'online-radio' && this.state.status === 'buffering') {
      const next = this.nextIndex();
      if (next !== null) { this.waveExhausted = false; void this.startAt(next, 0, 'finished'); }
    }
  }

  removeAt(i: number): void {
    if (i === this.state.index) {
      void this.nextTrack();
      return;
    }
    const before = i > this.state.index && i < this.state.queue.length ? this.state.queue : null;
    this.removeIndexSilently(i);
    this.onQueueChanged();
    if (before) this.rememberQueueEdit(before);
  }

  private removeIndexSilently(i: number): void {
    const q = [...this.state.queue];
    if (i < 0 || i >= q.length) return;
    q.splice(i, 1);
    let index = this.state.index;
    if (i < index) index--;
    if (index >= q.length) index = q.length - 1;
    this.set({ queue: q, index });
  }

  move(from: number, to: number): void {
    const q = [...this.state.queue];
    if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) return;
    const before = from > this.state.index && to > this.state.index ? this.state.queue : null;
    const [e] = q.splice(from, 1);
    q.splice(to, 0, e);
    const curId = this.currentEntry?.entryId;
    this.set({ queue: q, index: q.findIndex((x) => x.entryId === curId) });
    this.onQueueChanged();
    if (before) this.rememberQueueEdit(before);
  }

  clearUpcoming(): void {
    if (this.state.queue.length <= this.state.index + 1) return;
    const before = this.state.queue;
    this.set({ queue: this.state.queue.slice(0, this.state.index + 1) });
    this.onQueueChanged();
    this.rememberQueueEdit(before);
  }

  private queueUndo: { queue: QueueEntry[]; current: string | undefined } | null = null;

  private rememberQueueEdit(queue: QueueEntry[]): void {
    this.queueUndo = { queue, current: this.currentEntry?.entryId };
    this.set({ canUndoQueue: true });
  }

  /** One queue edit, independent of listening history; playback or another queue change expires it. */
  undoQueue(): void {
    const undo = this.queueUndo;
    if (!undo || undo.current !== this.currentEntry?.entryId) return;
    this.set({ queue: undo.queue });
    this.onQueueChanged();
  }

  jumpTo(i: number): void {
    void this.startAt(i, 0, 'skip');
  }

  toggleShuffle(): void {
    const on = !this.state.shuffle;
    const { queue, index } = this.state;
    if (on) {
      this.originalOrder = [...queue];
      const head = queue.slice(0, index + 1);
      const rest = queue.slice(index + 1);
      shuffleInPlace(rest);
      this.set({ shuffle: true, queue: [...head, ...rest] });
    } else {
      const cur = this.currentEntry;
      const orig = this.originalOrder ?? queue;
      const present = new Set(queue.map((e) => e.entryId));
      const restored = [...orig.filter((e) => present.has(e.entryId)), ...queue.filter((e) => !orig.some((o) => o.entryId === e.entryId))];
      this.originalOrder = null;
      this.set({ shuffle: false, queue: restored, index: restored.findIndex((e) => e.entryId === cur?.entryId) });
    }
    // Even if the random order kept the same next song, saved playlist intent changes eligibility.
    if (!this.native && !this.state.transition?.active) this.invalidateNext();
    this.onQueueChanged();
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    this.set({ repeat: order[(order.indexOf(this.state.repeat) + 1) % 3] });
    this.onQueueChanged();
  }

  /** After any queue edit: if the prepared next track changed, cancel it and prepare again.
   * Insert-only edits keep the native tail; only removals/reorders may replace its future. */
  private onQueueChanged(replacesFuture = true): void {
    if (replacesFuture) this.nativeQueueEditRevision++;
    this.scheduleSave();
    this.preparationRevision++;
    if (this.native) {
      if (this.nativePendingEntry && this.nativePendingIndex === null && this.state.queue[this.state.index]) {
        void this.nativeStartAt(this.state.index, this.state.position, 'skip', this.state.status === 'paused');
        return;
      }
      if (this.nativeAt >= 0) void this.nativeSync();
      this.focusAnalysis();
      if (this.isWave()) void this.topUpWave();
      return;
    }
    if (this.state.transition?.active) {
      const nx = this.next;
      if (nx) {
        let index = this.state.queue.findIndex((e) => e.entryId === nx.entry.entryId);
        if (index < 0) {
          // B is already audible. Queue edits can remove later songs, but
          // removing B here would lose now-playing/history at the swap.
          const queue = [...this.state.queue];
          index = Math.min(queue.length, Math.max(0, this.state.index + (this.current === nx.slot ? 0 : 1)));
          queue.splice(index, 0, nx.entry);
          this.set({ queue, index: queue.findIndex((e) => e.entryId === this.current?.entryId) });
        }
        nx.index = index;
      }
      return;
    }
    const n = this.nextIndex();
    const wanted = n === null ? null : this.state.queue[n];
    if (this.next && (!wanted || wanted.entryId !== this.next.entry.entryId || (n === this.state.index && this.state.repeat !== 'one'))) {
      this.invalidateNext();
    }
    if (this.current && !this.next) void this.prepareNext();
    this.focusAnalysis();
    if (this.isWave()) void this.topUpWave();
  }

  private invalidateNext(): void {
    this.nextRequest = null;
    this.preparationRevision++;
    if (!this.next) return;
    if (!this.state.transition?.active) {
      this.post({ cmd: 'disarm' });
      this.releaseSlot(this.next.slot);
    }
    this.next = null;
    this.set({ nextPlan: null, nextPending: [], transition: null });
  }

  // ------------------------------------------------------------- transitions

  private async prepareNext(manual = false): Promise<void> {
    if (this.preparing) return this.preparing;
    manual ||= this.nextRequest?.current === this.current;
    const revision = this.preparationRevision;
    this.preparing = this.doPrepare(manual).finally(() => {
      this.preparing = null;
      // Queue edits and a new playback command can arrive while HTTP is pending.
      if (revision !== this.preparationRevision && this.current && !this.next) void this.prepareNext();
    });
    return this.preparing;
  }

  /** The next track stays queued while the service is unreachable; try again shortly. */
  private retryPrepare(manual: boolean, isRelevant: () => boolean): void {
    setTimeout(() => { if (isRelevant() && !this.next) void this.prepareNext(manual); }, 3000);
  }

  /** Drops a next track that failed to load: the first skip is announced, a streak stops preparation with one error. */
  private skipNext(index: number, msg: string): void {
    this.removeIndexSilently(index);
    if (!this.keepPreparing(msg)) return;
    if (this.skipStreak === 1) this.notify(`Пропущен следующий трек: ${msg}`, 'error');
    this.preparationRevision++;
  }

  /** Counts a skipped next track; false once too many failed in a row (until a track starts or the listener presses Next). */
  private keepPreparing(msg: string): boolean {
    if (++this.skipStreak < MAX_SKIPS) return true;
    if (this.skipStreak === MAX_SKIPS) this.notify(`Подряд не загрузились ${MAX_SKIPS} следующих трека, подготовка остановлена: ${msg}`, 'error');
    return false;
  }

  private async doPrepare(manual = false): Promise<void> {
    if (!this.current || this.next || this.startingGeneration === this.generation || this.skipStreak >= MAX_SKIPS) return;
    const cur = this.current;
    const gen = this.generation;
    const revision = this.preparationRevision;
    if (this.nextIndex(manual) === null) await this.topUpWave();
    else void this.topUpWave();
    if (this.current !== cur || gen !== this.generation || revision !== this.preparationRevision) return;
    const n = this.nextIndex(manual);
    if (n === null) return;
    const entry = this.state.queue[n];
    const isRelevant = () => gen === this.generation && this.current === cur && revision === this.preparationRevision &&
      this.state.queue[this.nextIndex(manual) ?? -1]?.entryId === entry.entryId;
    let plan: TransitionPlan;
    let pending: string[] = [];
    const resourceRevision = (this.resourceRevisions.get(cur.trackId) ?? 0) + (this.resourceRevisions.get(entry.trackId) ?? 0);
    try {
      const r = await this.planPair(cur.trackId, entry.trackId, this.currentEntry, entry);
      plan = r.plan;
      pending = r.pending;
    } catch (e) {
      if (unreachable(e)) return this.retryPrepare(manual, isRelevant);
      if (isRelevant()) this.notify(`Не удалось спланировать переход: ${(e as Error).message}`, 'error');
      return;
    }
    if (!isRelevant() || this.next) return;
    const otherDeck = 1 - cur.deck;
    let slot: Slot;
    try {
      slot = await this.loadSlot(otherDeck, entry, plan.bEntry, 'next', plan.gainB, isRelevant);
    } catch (e) {
      if (!isRelevant()) return;
      if (unreachable(e)) return this.retryPrepare(manual, isRelevant);
      return this.skipNext(n, (e as Error).message);
    }
    if (!isRelevant()) {
      this.releaseSlot(slot);
      return;
    }
    plan = this.fitPlan(plan);
    let buffered: BufferedChunk[];
    let vocals: BufferedVocals;
    try {
      [buffered, vocals] = await Promise.all([
        this.readChunks(slot, this.startupChunks(slot, plan.bEntry, plan.duration)),
        this.bufferVocals(cur, slot, plan),
      ]);
    } catch (e) {
      if (!isRelevant()) return;
      this.releaseSlot(slot);
      if (unreachable(e)) return this.retryPrepare(manual, isRelevant);
      return this.skipNext(n, (e as Error).message);
    }
    if (!isRelevant() || slot.abort.signal.aborted) {
      this.releaseSlot(slot);
      return;
    }
    if (slot.failed) {
      this.releaseSlot(slot);
      return this.skipNext(n, slot.failed);
    }
    plan = this.fitPlan(vocals.plan);
    this.next = { entry, index: n, slot, plan, pending };
    this.feedChunks(slot, buffered);
    this.feedChunks(cur, vocals.A, 'vocals');
    this.feedChunks(slot, vocals.B, 'vocals');
    this.post({ cmd: 'gain', deck: cur.deck, gainDb: plan.gainA });
    this.post({ cmd: 'arm', transition: planToArmed(plan, this.sr, cur.token, slot.token) });
    this.set({ nextPlan: plan, nextPending: pending });
    // Separation can finish while HTTP or PCM buffering is still in flight.
    // That completion had no prepared pair to refresh yet; revisit it now.
    if (resourceRevision !== (this.resourceRevisions.get(cur.trackId) ?? 0) + (this.resourceRevisions.get(entry.trackId) ?? 0)) {
      this.onAnalysisDone(entry.trackId);
    } else if (renderSkipped(plan)) {
      // P10: the server planned before B's PCM was decoding; B's deck is loading it now
      this.refreshPlan(cur, this.next, 1);
    }
  }

  /** Keeps a plan usable when the listener already passed its exit point (seek). */
  private fitPlan(plan: TransitionPlan): TransitionPlan {
    if (plan.debug.processingAllowed === false) return plan;
    plan = this.afterRecovery(plan);
    // Sequential playback (AutoMix off, album order, no overlap) has nothing to
    // fit: B simply follows A's last sample, even when the listener is near the end.
    if (plan.method === 'gapless' && plan.duration <= 0) return plan;
    const pos = this.state.position;
    if (plan.aExit > pos + 1.5) return plan;
    const dur = this.track(plan.fromTrackId)?.duration ?? pos + 4;
    const D = Math.min(3, Math.max(0.5, dur - pos - 1));
    const aExit = Math.max(pos + 0.5, dur - D - 0.3);
    return {
      ...skipPlanFrom(plan, aExit),
      id: `${plan.id}_late`,
      method: 'fallback_crossfade',
      duration: D,
      swapAt: D / 2,
      automation: [
        { deck: 'A', lane: 'gain', points: Array.from({ length: 9 }, (_, i) => [(D * i) / 8, Math.cos(((i / 8) * Math.PI) / 2)] as [number, number]) },
        { deck: 'B', lane: 'gain', points: Array.from({ length: 9 }, (_, i) => [(D * i) / 8, Math.sin(((i / 8) * Math.PI) / 2)] as [number, number]) },
      ],
      reasons: ['точка перехода уже пройдена: короткий кроссфейд в конце трека'],
      fallbackReason: 'позиция после точки выхода',
    };
  }

  /** Re-plan when analysis finished for tracks involved in the prepared transition. */
  onVocalsChanged(trackId: string, revision: string): void {
    if (this.vocalRevisions.get(trackId) === revision) return;
    this.vocalRevisions.set(trackId, revision);
    if (this.vocalRevisions.size > 256) this.vocalRevisions.delete(this.vocalRevisions.keys().next().value!);
    this.dirtyVocals.add(trackId);
    void this.applyVocalChanges();
  }

  private resetVocalSource(slot: Slot): Promise<boolean> {
    const key = `${slot.deck}:${slot.token}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.vocalResetRequests.delete(key); resolve(false); }, 2500);
      this.vocalResetRequests.set(key, { resolve, timer });
      this.post({ cmd: 'resetVocals', deck: slot.deck, token: slot.token });
    });
  }

  private async applyVocalChanges(): Promise<void> {
    if (this.state.transition?.active || !this.dirtyVocals.size || this.resettingVocals) return;
    const cur = this.current;
    const affectsPair = !!cur && (this.dirtyVocals.has(cur.trackId) || !!this.next && this.dirtyVocals.has(this.next.entry.trackId)
      || this.slots.some((slot) => slot && this.dirtyVocals.has(slot.trackId)));
    if (affectsPair) {
      const target = cur && this.dirtyVocals.has(cur.trackId) ? cur : this.slots.find((slot) => slot && this.dirtyVocals.has(slot.trackId));
      if (!target) return;
      const generation = this.generation, intent = this.previewRevision;
      this.resettingVocals = true;
      const applied = await this.resetVocalSource(target);
      this.resettingVocals = false;
      // The worklet can begin a transition before its start event reaches us.
      // An ignored reset keeps the old source pinned until that transition ends.
      if (!applied || generation !== this.generation || intent !== this.previewRevision || this.state.transition?.active) return;
      this.invalidateNext();
      if (cur && this.dirtyVocals.has(cur.trackId)) {
        // A new stream object also invalidates every in-flight old response.
        cur.vocals = { pending: [], inflight: 0, fed: new Set(), fetching: new Set(), failed: null };
      }
    }
    for (const id of this.dirtyVocals) this.resourceRevisions.set(id, (this.resourceRevisions.get(id) ?? 0) + 1);
    this.dirtyVocals.clear();
    if (affectsPair) void this.prepareNext();
  }

  onRecordingChanged(trackId: string): void {
    this.queueRevision++;
    this.nativeQueueEditRevision++;
    this.nativeFiles.delete(trackId);
    this.nativeManifestKey = '';
    this.set({ queue: this.state.queue.map((entry, index) => index > this.state.index && entry.trackId === trackId ? { ...entry, entryId: uid() } : entry) });
    if (this.native) void this.nativeSync();
    else { this.invalidateNext(); void this.prepareNext(); }
  }

  onAnalysisDone(trackId: string): void {
    if (this.native) {
      if (this.nativeTracks.slice(Math.max(0, this.nativeAt)).some(t => t.trackId === trackId)) {
        this.nativeStale.add(trackId);
        // The desktop host re-plans its armed blend on any queue handoff, even an unchanged one.
        if (desktop?.nativeMix) this.nativeManifestKey = '';
        void this.nativeSync();
      }
      return;
    }
    this.resourceRevisions.set(trackId, (this.resourceRevisions.get(trackId) ?? 0) + 1);
    if (this.resourceRevisions.size > 256) this.resourceRevisions.delete(this.resourceRevisions.keys().next().value!);
    const nx = this.next;
    const cur = this.current;
    if (cur?.trackId === trackId) {
      if (this.state.transition?.active) this.deferredLoudnessChange = true;
      else {
        const track = this.track(trackId);
        this.post({ cmd: 'gain', deck: cur.deck, gainDb: track?.mixingAllowed === false ? 0 : gainFromSummary(track?.analysis, this.loudnessTarget) });
      }
    }
    if (!nx || !cur || (trackId !== cur.trackId && trackId !== nx.entry.trackId)) return;
    this.refreshPlan(cur, nx);
  }

  /** Asks the server for the pair's plan again and re-arms it while the transition is still ahead.
   * `renderAttempt` > 0: a retry of a plan whose render check waited for B's PCM (P10). */
  private refreshPlan(cur: Slot, nx: NextPrep, renderAttempt = 0): void {
    if (this.state.transition?.active || this.nextRequest || nx.plan.debug.requested === true) return;
    const preparedPlan = nx.plan;
    const generation = this.generation;
    const revision = this.preparationRevision;
    const refresh = ++this.analysisRevision;
    const startsIn = nx.plan.aExit - this.state.position;
    if (startsIn < 4) return;
    void (async () => {
      const r = await this.planPair(cur.trackId, nx.entry.trackId, this.currentEntry, nx.entry).catch(() => null);
      const isRelevant = () => this.next === nx && nx.plan === preparedPlan && this.current === cur && generation === this.generation &&
        revision === this.preparationRevision && refresh === this.analysisRevision && !this.state.transition?.active && !this.nextRequest &&
        preparedPlan.aExit - this.state.position > 0.15;
      if (!r || !isRelevant()) return;
      if (renderAttempt && renderSkipped(r.plan) && r.plan.id === preparedPlan.id) {
        // B's PCM can still be decoding (the iPhone decodes whole files): try the check a little later
        if (renderAttempt < 3) setTimeout(() => { if (isRelevant()) this.refreshPlan(cur, nx, renderAttempt + 1); }, 3000);
        return;
      }
      let plan = this.fitPlan(r.plan);
      const audio = await Promise.all([this.bufferChangedCue(nx, preparedPlan, plan), this.bufferVocals(cur, nx.slot, plan)]).catch(() => null);
      if (!audio || !isRelevant()) return;
      const [buffered, vocals] = audio;
      plan = this.fitPlan(vocals.plan);
      nx.plan = plan;
      nx.pending = r.pending;
      if (plan.bEntry !== preparedPlan.bEntry) this.post({ cmd: 'cue', deck: nx.slot.deck, frame: Math.round(plan.bEntry * this.sr) });
      this.feedChunks(nx.slot, buffered);
      this.feedChunks(cur, vocals.A, 'vocals');
      this.feedChunks(nx.slot, vocals.B, 'vocals');
      this.post({ cmd: 'gain', deck: cur.deck, gainDb: plan.gainA });
      this.post({ cmd: 'gain', deck: nx.slot.deck, gainDb: plan.gainB });
      this.post({ cmd: 'arm', transition: planToArmed(plan, this.sr, cur.token, nx.slot.token) });
      this.set({ nextPlan: plan, nextPending: r.pending });
    })();
  }

  private pendingEndReason = 'transition';

  private incomingPosition(nx: NextPrep, elapsed: number): { position: number; ratio: number } {
    const snapshot = this.deckTelemetry.get(nx.slot.token);
    if (snapshot?.playing) return { position: snapshot.position / this.sr, ratio: snapshot.ratio };
    const bTime = Math.max(0, elapsed - (nx.plan.gap > 0 ? nx.plan.duration + nx.plan.gap : 0));
    return { position: nx.plan.bEntry + consumedSource(nx.plan.tempoB, bTime), ratio: tempoAt(nx.plan.tempoB, bTime) * this.playback.speed };
  }

  /** Adopt B coherently before async preparation can inspect the new transport. */
  private adoptIncoming(nx: NextPrep, elapsed: number): void {
    const { position, ratio } = this.incomingPosition(nx, elapsed);
    const index = this.state.queue.findIndex((entry) => entry.entryId === nx.entry.entryId);
    if (index >= 0) nx.index = index;
    this.finishPlay(this.pendingEndReason, nx.plan.id);
    this.pendingEndReason = 'transition';
    this.prevSlot = this.current;
    this.current = nx.slot;
    this.skipStreak = 0;
    this.maxPos = position;
    const end = nx.plan.tempoB[nx.plan.tempoB.length - 1]?.[0] ?? 0;
    this.recovering = end > nx.plan.duration && nx.plan.tempoB.some(([, rate]) => Math.abs(rate - 1) > 0.001)
      ? { token: nx.slot.token, endPosition: nx.plan.bEntry + consumedSource(nx.plan.tempoB, end) } : null;
    this.set({ index: nx.index, duration: this.track(nx.entry.trackId)?.duration ?? nx.slot.totalFrames / this.sr, position, ratio });
    this.beginPlay(nx.entry);
    this.scheduleSave();
  }

  private applyDeferredLoudness(): void {
    if (!this.deferredLoudnessChange || !this.current) return;
    this.deferredLoudnessChange = false;
    const track = this.track(this.current.trackId);
    this.post({ cmd: 'gain', deck: this.current.deck, gainDb: track?.mixingAllowed === false ? 0 : gainFromSummary(track?.analysis, this.loudnessTarget) });
  }

  private onEngine(e: EngineEvent): void {
    if (e.type === 'diagnostic') {
      tracePlayback(e.stage, { id: e.id, seq: e.seq, command: e.command, paused: e.paused, clock: e.clock, peak: e.peak });
      return;
    }
    if (e.type === 'transitionStart' || e.type === 'swap' || e.type === 'transitionEnd' || e.type === 'transitionAborted') {
      this.confirmRunningPlan(e.planId);
    }
    switch (e.type) {
      case 'audioHealth':
        this.set({ audioHealth: { ...e, pcmUnderruns: this.state.audioHealth?.pcmUnderruns ?? 0, latencyMs: (this.ctx?.baseLatency ?? 0) * 1000 } });
        return;
      case 'vocalsReset': {
        const key = `${e.deck}:${e.token}`, request = this.vocalResetRequests.get(key);
        if (request) { clearTimeout(request.timer); this.vocalResetRequests.delete(key); request.resolve(e.applied); }
        return;
      }
      case 'tick':
        return this.onTick(e);
      case 'need':
        return this.onNeed(e.deck, e.token, e.chunks, e.part === 'vocals' ? 'vocals' : 'original');
      case 'transitionStart': {
        const nx = this.next;
        if (!nx || nx.plan.id !== e.planId) return;
        this.set({ transition: { planId: e.planId, plan: nx.plan, active: true, late: e.late, startsIn: null, progress: 0, fallback: e.late ? 'буфер не успел: упрощённый переход' : null } });
        return;
      }
      case 'swap': {
        const nx = this.next;
        if (!nx || nx.plan.id !== e.planId || nx.slot.token !== e.token) return;
        if (this.current !== nx.slot) this.adoptIncoming(nx, nx.plan.swapAt);
        return;
      }
      case 'transitionEnd': {
        const nx = this.next;
        if (!nx || nx.plan.id !== e.planId || nx.slot.token !== e.token) return;
        if (this.current !== nx.slot) {
          // swap was implied (forced finish)
          this.adoptIncoming(nx, e.forced ? (this.state.transition?.progress ?? 0) * (nx.plan.duration + nx.plan.gap) : nx.plan.duration + nx.plan.gap);
        } else {
          const transport = this.incomingPosition(nx, e.forced ? (this.state.transition?.progress ?? 0) * (nx.plan.duration + nx.plan.gap) : nx.plan.duration + nx.plan.gap);
          this.maxPos = Math.max(this.maxPos, transport.position);
          this.set(transport);
        }
        this.applyDeferredLoudness();
        const outcome = { forced: e.forced, late: this.state.transition?.late ?? false, limiterDb: this.state.limiterDb };
        const last = { plan: nx.plan, outcome, at: Date.now() };
        void api.logTransition(nx.plan, outcome).then(({ id }) => {
          if (this.state.lastTransition === last) this.set({ lastTransition: { ...last, logId: id } });
        }).catch(() => {});
        this.set({ transition: null, nextPlan: null, nextPending: [], lastTransition: last });
        const old = this.prevSlot;
        this.prevSlot = null;
        if (old && old !== this.current) this.retireSlot(old, e.forced ? 700 : 50);
        this.next = null;
        void this.applyVocalChanges();
        this.focusAnalysis();
        void this.prepareNext();
        return;
      }
      case 'transitionAborted': {
        // a seek during the blend: the sought deck stays, the other fades out
        const nx = this.next;
        if (!nx || nx.plan.id !== e.planId) return;
        this.set({ transition: null, nextPlan: null, nextPending: [] });
        if (nx && this.current !== nx.slot) {
          this.retireSlot(nx.slot, 400);
        } else if (nx) {
          const old = this.prevSlot;
          this.prevSlot = null;
          if (old) this.retireSlot(old, 400);
        }
        this.next = null;
        if (this.failedIncomingToken === nx.slot.token) {
          const index = this.state.queue.findIndex((entry) => entry.entryId === nx.entry.entryId);
          if (index >= 0) this.removeIndexSilently(index);
          this.failedIncomingToken = null;
          this.pendingEndReason = 'transition';
        }
        this.applyDeferredLoudness();
        void this.applyVocalChanges();
        void this.prepareNext();
        return;
      }
      case 'disarmed': {
        if (e.reason === 'seek' && this.next?.plan.id === e.planId && this.current) {
          const plan = this.fitPlan(this.next.plan);
          this.next.plan = plan;
          this.post({ cmd: 'arm', transition: planToArmed(plan, this.sr, this.current.token, this.next.slot.token) });
          this.set({ nextPlan: plan });
        }
        return;
      }
      case 'ended': {
        if (!this.current || e.token !== this.current.token) return;
        const nx = this.next;
        if (nx) {
          // A ran out before the transition could start: start B immediately (no gap)
          this.post({ cmd: 'start', deck: nx.slot.deck, token: nx.slot.token, frame: Math.round(nx.plan.bEntry * this.sr) });
          this.pendingEndReason = 'finished';
          this.adoptIncoming(nx, 0);
          this.recovering = null;
          const old = this.prevSlot;
          this.prevSlot = null;
          this.next = null;
          this.set({ transition: null, nextPlan: null, nextPending: [] });
          this.applyDeferredLoudness();
          this.retireSlot(old, 100);
          void this.prepareNext();
        } else {
          this.finishPlay('finished');
          const n = this.nextIndex();
          if (n !== null) void this.startAt(n, 0, 'finished');
          else {
            this.releaseSlot(this.current);
            this.current = null;
            this.waveExhausted = this.isWave() || this.state.context?.type === 'online-radio' || !!this.state.continuation;
            this.set({ status: this.waveExhausted ? 'buffering' : 'idle', position: 0 });
            if (this.isWave()) void this.topUpWave();
          }
        }
        return;
      }
      case 'underrun':
        this.set({ audioHealth: { maxRenderMs: this.state.audioHealth?.maxRenderMs ?? 0, slowBlocks: this.state.audioHealth?.slowBlocks ?? 0, latencyMs: (this.ctx?.baseLatency ?? 0) * 1000, pcmUnderruns: (this.state.audioHealth?.pcmUnderruns ?? 0) + 1 } });
        if (this.current && e.token === this.current.token && this.state.status === 'playing') this.set({ status: 'buffering' });
        return;
      case 'fallback':
        if (e.planId !== this.next?.plan.id) return;
        if (this.state.transition) this.set({ transition: { ...this.state.transition, fallback: fallbackText(e.reason) } });
        else if (this.next) this.set({ transition: { planId: e.planId, plan: this.next.plan, active: false, late: true, startsIn: 0, progress: 0, fallback: fallbackText(e.reason) } });
        return;
    }
  }

  private prevSlot: Slot | null = null;

  private confirmRunningPlan(planId: string): void {
    const nx = this.next, plan = nx?.sentPlans?.get(planId);
    // An arm sent after the audio thread started is ignored; its old events still own this pair.
    if (nx && plan && nx.plan !== plan) {
      nx.plan = plan;
      this.set({ nextPlan: plan });
    }
  }

  private onTick(e: Extract<MixerEvent, { type: 'tick' }>): void {
    if (e.transition?.active) this.confirmRunningPlan(e.transition.planId);
    this.diagnosticMixerPaused = e.paused;
    if (playbackDiagnostics() && performance.now() - this.diagnosticTickAt >= 5000) {
      this.diagnosticTickAt = performance.now();
      tracePlayback('engine.tick', { id: this.diagnosticId, paused: e.paused, clock: e.clock, status: this.state.status, context: this.ctx?.state ?? 'absent', position: this.state.position, hidden: document.hidden });
    }
    for (const deck of e.decks) if (deck.token && this.slotByToken(deck.token)) this.deckTelemetry.set(deck.token, deck);
    if (!this.current) return;
    const d = e.decks.find((x) => x.token === this.current!.token);
    if (!d) return;
    const pos = d.position / this.sr;
    if (this.radioPlay) {
      const now = performance.now();
      if (this.state.status === 'playing' && !e.paused && !d.starved) this.radioPlay.seconds += Math.max(0, Math.min(2, (now - this.radioPlay.tick) / 1000));
      this.radioPlay.tick = now;
    }
    if (this.recovering?.token === this.current.token && pos >= this.recovering.endPosition) this.recovering = null;
    this.maxPos = Math.max(this.maxPos, pos);
    let transition = this.state.transition;
    const nx = this.next;
    if (e.transition && nx && e.transition.planId === nx.plan.id) {
      const active = e.transition.active;
      const aSlot = this.prevSlot ?? this.current;
      const aDeck = e.decks.find((x) => x.token === (active ? aSlot.token : this.current!.token));
      const startsIn = active ? null : Math.max(0, nx.plan.aExit - (aDeck ? aDeck.position / this.sr : pos));
      transition = {
        planId: nx.plan.id,
        plan: nx.plan,
        active,
        late: e.transition.late,
        startsIn,
        progress: active ? Math.min(1, e.transition.t / Math.max(1, (nx.plan.duration + nx.plan.gap) * this.sr)) : 0,
        fallback: transition?.fallback ?? null,
      };
    }
    let status = this.state.status;
    if (status === 'buffering' && !d.starved) status = 'playing';
    // Ticks describe an earlier audio block, not the latest Play/Pause intent.
    // In particular a paused tick queued before Play must not relabel live audio.
    this.set({ position: pos, ratio: d.ratio, limiterDb: e.limiterDb, transition, status });
    if (status === 'playing') void this.topUpWave();
    if (performance.now() - this.lastSaved > POSITION_SAVE_MS && status === 'playing') this.scheduleSave(true);
    if (!desktop?.audioStart && 'mediaSession' in navigator && this.state.duration > 0) {
      try {
          navigator.mediaSession.setPositionState({ duration: this.state.duration, position: Math.min(pos, this.state.duration), playbackRate: this.playback.speed });
      } catch {
        /* ignore */
      }
    }
  }

  // ----------------------------------------------------------- play history

  private playStartPos = 0;

  private beginPlay(entry: QueueEntry): void {
    if (this.autonomousRadio) { this.playId = null; this.radioPlay = null; this.updateMediaSession(); return; }
    const ctx = this.state.context?.type ?? 'queue';
    this.playStartPos = this.maxPos;
    this.playId = null;
    const myEntry = entry.entryId;
    const revision = ++this.playRevision;
    void api
      .startPlay(entry.trackId, entry.origin === 'wave' ? 'wave' : ctx)
      .then((r) => {
        if (revision === this.playRevision && this.currentEntry?.entryId === myEntry) this.playId = r.id;
        else void api.endPlay(r.id, 0, 'skip').catch(() => {});
      })
      .catch(() => {});
    // Old saved queues may lack attribution: never invent a batch for them.
    const sessionId = entry.yandexSessionId;
    // Yandex hears only about its own recording: not when another chosen version actually plays.
    if (entry.origin === 'yandex' && entry.yandexId && sessionId && !this.track(entry.trackId)?.binding) {
      const batchId = entry.yandexBatchId ?? null;
      this.radioPlay = { entryId: entry.entryId, trackId: entry.yandexId, sessionId, batchId, seconds: 0, tick: performance.now() };
      void api.yandexFeedback(sessionId, batchId, { type: 'trackStarted', trackId: entry.yandexId }).catch(() => {});
    } else {
      this.radioPlay = null;
    }
    void this.topUpWave();
    this.updateMediaSession();
  }

  private finishPlay(reason: string, transitionId?: string): void {
    this.playRevision++;
    const entry = this.currentEntry;
    if (entry && (reason === 'finished' || reason === 'transition')) {
      this.heardEntries.add(entry.entryId);
      if (this.heardEntries.size > 200) this.heardEntries.delete(this.heardEntries.values().next().value!);
    }
    if (this.autonomousRadio) { this.playId = null; this.radioPlay = null; return; }
    if (this.playId !== null) {
      const ms = Math.round(Math.max(0, this.maxPos - this.playStartPos) * 1000);
      void api.endPlay(this.playId, ms, reason, transitionId).catch(() => {});
    }
    const radio = this.radioPlay;
    if (radio) void api.yandexFeedback(radio.sessionId, radio.batchId,
      { type: reason === 'finished' || reason === 'transition' ? 'trackFinished' : 'skip', trackId: radio.trackId, totalPlayedSeconds: radio.seconds }).catch(() => {});
    this.radioPlay = null;
    this.playId = null;
  }

  private focusAnalysis(): void {
    if (this.native && this.nativeMix.prepareQueue) {
      // The native producer owns MIR and downloading; do not duplicate that work in WebContent.
      void api.focus({ current: null, next: [], candidates: [] }).catch(() => {});
      return;
    }
    const cur = this.currentEntry?.trackId ?? null;
    const n = this.nextIndex();
    const next = n !== null ? [this.state.queue[n]?.trackId].filter(Boolean) as string[] : [];
    const candidates:string[]=[];
    const seen=new Set([cur,...next]);
    if(this.state.repeat!=='one')for(let offset=2;offset<this.state.queue.length&&candidates.length<2;offset++){
      const index=this.state.index+offset;
      if(index>=this.state.queue.length&&this.state.repeat!=='all')break;
      const id=this.state.queue[index%this.state.queue.length]?.trackId;
      if(id&&!seen.has(id)){seen.add(id);candidates.push(id);}
    }
    void api.focus({ current: cur, next, candidates }).catch(() => {});
  }

  // ------------------------------------------------------------- persistence

  private scheduleSave(immediate = false): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => {
        this.lastSaved = performance.now();
        const s = this.state;
        void api
          .saveQueue({ items: s.queue, index: s.index, position: s.position, context: s.context, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, originalOrder: this.originalOrder })
          .catch(() => {});
      },
      immediate ? 50 : 800,
    );
  }

  async restore(): Promise<void> {
    const intent = this.previewRevision, revision = this.nativeRevision, queueRevision = this.queueRevision;
    const stale = () => intent !== this.previewRevision || revision !== this.nativeRevision || queueRevision !== this.queueRevision ||
      !!this.current || !!this.state.queue.length || this.state.waveLoading || this.state.status === 'loading';
    try {
      const q = (await api.queue().catch(() => null)) as {
        items: QueueEntry[];
        index: number;
        position: number;
        context: PlayContext | null;
        shuffle: boolean;
        repeat: RepeatMode;
        volume?: number;
        originalOrder?: QueueEntry[] | null;
      } | null;
      const controls = nativePlaybackControls();
      await controls?.ready;
      const native = controls?.mix ? await controls.mix.state().catch(() => null) : null;
      // Initial provider/library loading can outlive the listener's first
      // Play/queue command. Restoration must never replace that newer intent.
      if (stale()) return;
      const saved = q && Array.isArray(q.items) ? q : null;
      const items = saved?.items.filter((e) => this.track(e.trackId)) ?? [];
      const active = native?.active && !native.failed && (!native.preparing || desktop?.nativeMix && native.currentTrack) ? native : null;
      const hostQueue = active?.queue;
      if (hostQueue?.some(e => !this.track(e.trackId))) await this.refreshLibrary();
      // A native queue can outlive WebContent and its last persisted position.
      // Include audible/upcoming entries even if persistence preceded their arrival.
      if (hostQueue?.length) items.splice(0, items.length, ...[...new Map(hostQueue.map(e => [e.entryId, e])).values()].map(e => ({ ...e, origin: e.origin ?? 'user' as const })));
      for (const raw of active ? [active.currentTrack, active.nextTrack] : []) {
        if (raw?.entryId && raw.trackId && this.track(raw.trackId) && !items.some(e => e.entryId === raw.entryId)) {
          items.push({ trackId: raw.trackId, entryId: raw.entryId, origin: 'user' });
        }
      }
      const curId = active?.entryId || (saved && saved.items[saved.index]?.entryId);
      const index = Math.max(0, items.findIndex((e) => e.entryId === curId));
      const audio = (await desktop?.getSettings?.().catch(() => null))?.audio;
      if (stale()) return;
      this.originalOrder = saved?.originalOrder ?? null;
      this.restoredPosition = saved?.position ?? 0;
      this.set({
        queue: items,
        index: items.length ? index : -1,
        context: active?.context ?? saved?.context ?? null,
        shuffle: !!saved?.shuffle,
        repeat: active?.repeat ?? saved?.repeat ?? 'off',
        volume: systemVolume ? 1 : audio?.volume ?? saved?.volume ?? 0.9,
        muted: !!audio?.muted,
        position: this.restoredPosition,
        duration: items[index] ? this.track(items[index].trackId)?.duration ?? 0 : 0,
        status: 'idle',
      });
      if (active && items.some(e => e.entryId === active.entryId)) {
        this.nativeAt = active.index;
        this.restoredPosition = active.position;
        this.maxPos = active.position;
        // Adoption must not replace a running native manifest or upload PCM.
        this.nativeManifestKey = JSON.stringify([this.queueRevision, items.map(e => e.entryId), this.state.repeat, this.state.shuffle, this.loudnessTarget]);
        this.onNativeState(active);
        this.nativePoll(active.sampleRate);
        // Older native checkpoints saved tracks but lost the station that must keep extending them.
        if (!active.station && desktop?.nativeMix?.setStation && (active.context || saved?.items.some(e => e.entryId === active.entryId))) {
          const context = this.state.context, type = context?.type;
          const station: NativeRadioConfig | null = type === 'online-radio' ? { kind: 'online' } : type === 'wave' ? { kind: 'own' }
            : type === 'yandex-wave' ? { kind: 'yandex', yandexSessionId: items[index]?.yandexSessionId } : null;
          if (station) await desktop.nativeMix.setStation(station, context);
        }
      }
    } catch {
      /* first run */
    }
  }

  // ------------------------------------------------------------ media keys

  private setupMediaSession(): void {
    if (desktop?.audioStart || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.resume());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('nexttrack', () => this.nextTrack());
    ms.setActionHandler('previoustrack', () => this.prevTrack());
    ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime));
    ms.setActionHandler('seekforward', () => this.seek(this.state.position + 10));
    ms.setActionHandler('seekbackward', () => this.seek(this.state.position - 10));
  }

  private updateMediaSession(): void {
    if (desktop?.audioStart || !('mediaSession' in navigator)) return;
    const t = this.currentEntry ? this.track(this.currentEntry.trackId) : null;
    if (!t) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: t.coverUrl ? [{ src: new URL(t.coverUrl, location.origin).toString(), sizes: '512x512' }] : [],
    });
  }
}

/**
 * fetch() rejects with TypeError when the local service does not answer at all
 * (restarting backend, renderer offline). That is not a fault of the track, so
 * the queue must keep it and retry instead of skipping.
 */
function unreachable(e: unknown): boolean {
  // Chromium: "Failed to fetch"; other TypeErrors are real bugs and keep the old skip path.
  return e instanceof TypeError && /fetch/i.test(e.message);
}

function shuffleInPlace<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function fallbackText(reason: string): string {
  switch (reason) {
    case 'buffer_not_ready':
      return 'следующий трек не успел загрузиться: переход упрощён';
    case 'a_ended_before_transition':
      return 'трек закончился раньше перехода';
    case 'deck_missing':
      return 'следующий трек не подготовлен';
    default:
      return reason;
  }
}
