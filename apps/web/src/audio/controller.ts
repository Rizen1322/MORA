import { CHUNK_FRAMES, fallbackWithoutVocalStems, planToArmed, preampFor, skipPlanFrom, type MixerEvent, type ToneSettings, type TransitionPlan, type TransitionRating, type TransitionRatingReason } from '@automix/core';
import { DEFAULT_PLAYBACK, sanitizePlayback, type PlaybackSettings } from '@automix/core';
import workletUrl from './engine.worklet.ts?worker&url';
import type { EngineCommand, EngineEvent } from './engine.worklet.ts';
import { playbackDiagnostics, tracePlayback } from '../lib/playback-trace.ts';
import { api, ApiError, type AnalysisSummary, type Track } from '../lib/api.ts';

export type RepeatMode = 'off' | 'all' | 'one';
export type Origin = 'user' | 'wave' | 'context' | 'yandex';

export interface QueueEntry {
  entryId: string;
  trackId: string;
  origin: Origin;
  reasons?: string[];
  yandexId?: string;
  /** Attribution belongs to this recommendation, never to the latest fetched batch. */
  yandexSessionId?: string;
  yandexBatchId?: string | null;
}

export interface PlayContext {
  type: 'library' | 'album' | 'artist' | 'playlist' | 'liked' | 'wave' | 'yandex-wave' | 'online-radio' | 'search' | 'queue' | 'history';
  id?: string;
  label: string;
}

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
  audioHealth?: { maxRenderMs: number; slowBlocks: number; pcmUnderruns: number; latencyMs: number };
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
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
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
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setLoudnessTarget(t: number | null): void {
    this.loudnessTarget = t;
  }

  /** A saved mix setting must affect the already prepared pair as well. */
  onSettingsChanged(target: number | null): void {
    this.previewRevision++;
    this.loudnessTarget = target;
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
    // The system, not the listener, stopped the context: playing stays playing, so pick up again
    // (WebKit settles a resume() from 'interrupted' once the interruption ends).
    const keepRunning = (event: Event) => {
      tracePlayback('context.event', { reason: event.type, context: ctx.state, status: this.state.status, hidden: document.hidden });
      if (ctx.state !== 'running' && ctx.state !== 'closed' && (this.state.status === 'playing' || this.state.status === 'buffering')) {
        if (playbackDiagnostics()?.allowAutoResume === false) { tracePlayback('context.autoResume.suppressed', { context: ctx.state }); return; }
        tracePlayback('context.autoResume.request', { context: ctx.state });
        void ctx.resume().then(() => tracePlayback('context.autoResume.resolved', { context: ctx.state }), () => tracePlayback('context.autoResume.rejected', { context: ctx.state }));
      }
    };
    ctx.onstatechange = keepRunning;
    document.addEventListener('visibilitychange', keepRunning);
    this.ctx = ctx;
    this.node = node;
    this.analyser = analyser;
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
      if (ctx?.setSinkId) await ctx.setSinkId(id);
      this.outputDevice = id;
    } catch {
      this.notify('Не удалось переключить устройство вывода. Звук идёт на устройство Windows по умолчанию.', 'error');
    }
  }

  private tone: ToneSettings | null = null;
  private playback = { ...DEFAULT_PLAYBACK };
  setPlayback(settings: PlaybackSettings): void {
    this.playback = sanitizePlayback(settings);
    this.post({ cmd: 'playback', settings: this.playback });
  }
  /** Listener EQ on the final mix. The curve's measured peak is computed here, off the audio thread. */
  setTone(tone: ToneSettings): void {
    this.tone = tone;
    this.post({ cmd: 'tone', settings: tone, preDb: preampFor(tone, this.sr) });
  }

  private diagnosticId?: string;
  private diagnosticSeq = 0;
  private diagnosticTickAt = -Infinity;
  private traceAction(action: string): void {
    const d = playbackDiagnostics();
    if (!d) return;
    this.diagnosticId = d.currentId ?? d.nextId();
    tracePlayback('controller.action', { id: this.diagnosticId, action, context: this.ctx?.state ?? 'absent', status: this.state.status, position: this.state.position });
  }

  private post(cmd: EngineCommand, transfer: Transferable[] = []): void {
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

  async playTracks(trackIds: string[], startIndex: number, context: PlayContext): Promise<void> {
    this.queueRevision++;
    this.previewRevision++;
    this.resetWaveBuffer();
    const queue: QueueEntry[] = trackIds.map((id) => ({ entryId: uid(), trackId: id, origin: 'context' }));
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
    const revision = ++this.previewRevision;
    this.resetWaveBuffer();
    const epoch = this.waveEpoch;
    await this.ensureEngine();
    if (revision !== this.previewRevision) return;
    this.set({ waveLoading: true, waveRefillError: null, error: null });
    try {
      let entries: QueueEntry[] = [];
      if (kind === 'yandex') {
        const w = await api.yandexWave(null);
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
        const r = await api.waveNext({ currentId: null, session: [], count: 3 });
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
    this.post({ cmd: 'pause', paused: true });
    this.set({ status: 'paused' });
    this.scheduleSave(true);
  }

  async resume(): Promise<void> {
    this.traceAction('play');
    const intent = ++this.previewRevision;
    if (this.radioPlay) this.radioPlay.tick = performance.now();
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
    this.post({ cmd: 'volume', value: this.state.muted ? 0 : this.state.volume * this.fadeGain });
  }

  /** Settings: "Next" switches at once (no musical blend) when true. */
  instantNext = false;

  /** User pressed "next". */
  async nextTrack(reason: 'skip' | 'dislike' = 'skip'): Promise<void> {
    this.traceAction('nexttrack');
    const intent = ++this.previewRevision;
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
    const fromStart = (plan: TransitionPlan): TransitionPlan => ({ ...plan, bEntry: 0 });
    const buffered = await this.bufferChangedCue(nx, nx.plan, fromStart(skipPlanFrom(nx.plan, this.state.position)));
    if (!isRelevant() || this.current !== cur || this.next !== nx) return;
    this.armRequestedPlan(cur, nx, fromStart(skipPlanFrom(nx.plan, this.state.position + 0.03)), buffered);
  }

  private armRequestedPlan(cur: Slot, nx: NextPrep, plan: TransitionPlan, buffered: BufferedChunk[] = [], vocals?: BufferedVocals): void {
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
    if (this.state.position > 3 || this.state.index <= 0) {
      this.seek(0);
      return;
    }
    await this.startAt(this.state.index - 1, 0, 'skip', this.state.status === 'paused');
  }

  // ------------------------------------------------------------------- queue

  /** Index of the entry that plays after the current one. */
  private nextIndex(manual = false): number | null {
    const { queue, index, repeat } = this.state;
    if (!queue.length) return null;
    if (repeat === 'one' && !manual) return index;
    if (index + 1 < queue.length) return index + 1;
    if (repeat === 'all') return 0;
    return null;
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
    this.onQueueChanged();
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

  private waveNeedsMore(): boolean {
    const upcoming = this.state.queue.slice(this.state.index + 1);
    const seconds = upcoming.reduce((sum, entry) => sum + (this.track(entry.trackId)?.duration ?? 180), 0);
    return upcoming.length < 4 || (upcoming.length < 6 && seconds < 480);
  }

  private topUpWave(): Promise<void> {
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
        const count = Math.max(1, Math.min(4, 6 - ahead));
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
            session: this.state.queue.map((e) => e.trackId), count });
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
        }).slice(0, Math.max(0, 8 - (this.state.queue.length - this.state.index - 1)));
        if (!added.length) break;
        addedAny = true;
        const trim = !this.state.transition?.active ? Math.max(0, this.state.index - 120) : 0;
        if (trim && this.next) this.next.index -= trim;
        this.set({ queue: [...this.state.queue.slice(trim), ...added], index: this.state.index - trim });
        this.focusAnalysis();
        this.scheduleSave();
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
    this.onQueueChanged();
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
    this.removeIndexSilently(i);
    this.onQueueChanged();
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
    const [e] = q.splice(from, 1);
    q.splice(to, 0, e);
    const curId = this.currentEntry?.entryId;
    this.set({ queue: q, index: q.findIndex((x) => x.entryId === curId) });
    this.onQueueChanged();
  }

  clearUpcoming(): void {
    this.set({ queue: this.state.queue.slice(0, this.state.index + 1) });
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
    this.onQueueChanged();
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    this.set({ repeat: order[(order.indexOf(this.state.repeat) + 1) % 3] });
    this.onQueueChanged();
  }

  /** After any queue edit: if the prepared next track changed, cancel it and prepare again. */
  private onQueueChanged(): void {
    this.scheduleSave();
    this.preparationRevision++;
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
      const r = await api.plan(cur.trackId, entry.trackId);
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

  onAnalysisDone(trackId: string): void {
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
      const r = await api.plan(cur.trackId, nx.entry.trackId).catch(() => null);
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

  private onTick(e: Extract<MixerEvent, { type: 'tick' }>): void {
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
    if ('mediaSession' in navigator && this.state.duration > 0) {
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
    try {
      const q = (await api.queue()) as {
        items: QueueEntry[];
        index: number;
        position: number;
        context: PlayContext | null;
        shuffle: boolean;
        repeat: RepeatMode;
        volume?: number;
        originalOrder?: QueueEntry[] | null;
      } | null;
      if (!q || !Array.isArray(q.items)) return;
      // Initial provider/library loading can outlive the listener's first
      // Play/queue command. Restoration must never replace that newer intent.
      if (this.current || this.state.queue.length || this.state.waveLoading || this.state.status === 'loading') return;
      const items = q.items.filter((e) => this.track(e.trackId));
      const curId = q.items[q.index]?.entryId;
      const index = Math.max(0, items.findIndex((e) => e.entryId === curId));
      this.originalOrder = q.originalOrder ?? null;
      this.restoredPosition = q.position ?? 0;
      this.set({
        queue: items,
        index: items.length ? index : -1,
        context: q.context,
        shuffle: !!q.shuffle,
        repeat: q.repeat ?? 'off',
        volume: systemVolume ? 1 : q.volume ?? 0.9,
        position: this.restoredPosition,
        duration: items[index] ? this.track(items[index].trackId)?.duration ?? 0 : 0,
        status: 'idle',
      });
    } catch {
      /* first run */
    }
  }

  // ------------------------------------------------------------ media keys

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
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
    if (!('mediaSession' in navigator)) return;
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
