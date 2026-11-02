import { CHUNK_FRAMES, DEFAULT_AUTOMIX_SETTINGS, fallbackWithoutVocalStems, planToArmed, planTransition, skipPlanFrom, type MixerEvent, type TransitionPlan } from '@automix/core';
import type { NativeMixSettings, NativeMixState, NativeMixTrack, NativeQueueEntry, NativeSourceConfig } from '../../web/src/lib/native-mix.ts';

interface Audio {
  process: unknown;
  start(device?: string): Promise<{ sampleRate: number; queueFrames: number }>;
  command(value: object): Promise<void>;
  feedFile(value: object): Promise<void>;
  stop(): Promise<void>;
}
interface Source {
  sourceId: string; path: string; finalPath: string; partPath: string; format: 'f32le' | 's16h';
  totalFrames: number; availableFrames: number; complete: boolean;
  gainDb?: number;
  track: { trackId: string; title: string; artist: string; duration: number; coverUrl: string; mixingAllowed: boolean };
}
interface Item extends NativeMixTrack {
  entryId: string; trackId: string; index: number; deck: number; token: string;
  source: Source; abort: AbortController; feeds: Map<number, Promise<void>>; plan?: TransitionPlan; position: number;
  sentPlans: Map<string, TransitionPlan>;
  manualRequested?: boolean;
}
interface Options {
  backend(): { origin: string; accessToken: string; pcmToken: string };
  ready(sampleRate: number): void;
  track(value: { token: string; title: string; artist: string; coverUrl?: string }): void;
  fetch?: typeof fetch;
}

/** Main-process producer: the window sends queue edits, Rust confirms what is actually audible. */
export class DesktopPlayback {
  private generation = 0;
  private manifestRevision = 0;
  private abort = new AbortController();
  private sequence = 0;
  private sampleRate = 48000;
  private current: Item | null = null;
  private incoming: Item | null = null;
  private history: Item[] = [];
  private slots: (Item | null)[] = [null, null];
  private future: NativeQueueEntry[] = [];
  private loop: NativeQueueEntry[] = [];
  private preparing: Promise<void> | null = null;
  private tick: Extract<MixerEvent, { type: 'tick' }> | null = null;
  private paused = false;
  private failed = false;
  private ended = false;
  private starting = false;
  private waiting = false;
  private error: string | undefined;
  private failureStreak = 0;
  private values: NativeMixSettings = {};
  private device = '';
  private retireUntil = [0, 0];
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private confirmations = new Map<string, () => void>();
  private commandTail: Promise<unknown> = Promise.resolve();
  private lastTransition?: NativeMixState['lastTransition'];

  constructor(private audio: Audio, private options: Options) {}

  private async request<T>(url: string, body?: object, signal = this.abort.signal): Promise<T> {
    const backend = this.options.backend();
    const response = await (this.options.fetch ?? fetch)(new URL(url, backend.origin), {
      method: body ? 'POST' : 'GET', headers: { 'X-Access-Token': backend.accessToken,
        'X-Mora-Desktop-Token': backend.pcmToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: string };
      throw Error(value.error || `Не удалось подготовить музыку (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  private valid(entry: NativeQueueEntry): void {
    if (!entry || typeof entry.trackId !== 'string' || !entry.trackId || entry.trackId.length > 256 ||
      typeof entry.entryId !== 'string' || !entry.entryId || entry.entryId.length > 256) throw Error('Некорректный трек очереди');
  }
  private source(entry: NativeQueueEntry, role: string, start = 0, frames = CHUNK_FRAMES, signal = this.abort.signal) {
    return this.request<Source>('/internal/desktop/pcm-source', { trackId: entry.trackId, sampleRate: this.sampleRate, role, start, frames }, signal);
  }

  async startSource(entry: NativeQueueEntry, config: NativeSourceConfig): Promise<NativeMixState> {
    this.valid(entry);
    if (!config || !Number.isFinite(config.position) || config.position < 0) throw Error('Некорректная позиция');
    const generation = ++this.generation;
    this.abort.abort(); this.abort = new AbortController();
    this.manifestRevision++; clearTimeout(this.refreshTimer);
    this.future = []; this.loop = []; this.ended = false; this.failed = false; this.error = undefined; this.failureStreak = 0;
    this.starting = true; this.paused = !!config.paused;
    this.values = { volume: config.volume, tone: config.tone, preDb: config.preDb, playback: config.playback };
    try {
      if (!this.audio.process) {
        const ready = await this.audio.start(this.device);
        if (generation !== this.generation) throw Error('Запуск отменён');
        this.sampleRate = ready.sampleRate; this.options.ready(this.sampleRate);
      }
      const deck = this.current ? 1 - this.current.deck : 0;
      const item = await this.load(entry, 0, deck, generation, config.gainDb ?? 0, config.position);
      if (generation !== this.generation) throw Error('Запуск отменён');
      await this.settings(this.values);
      if (generation !== this.generation) throw Error('Запуск отменён');
      await this.audio.command({ cmd: 'pause', paused: this.paused });
      if (generation !== this.generation) throw Error('Запуск отменён');
      const confirmed = this.confirm(item.token);
      void confirmed.catch(() => {});
      await this.audio.command({ cmd: 'start', deck, token: item.token, frame: Math.min(item.totalFrames - 1, Math.round(config.position * this.sampleRate)) });
      await confirmed;
      if (generation !== this.generation) throw Error('Запуск отменён');
      this.current = item; this.incoming = null; this.history = [item];
      this.focus();
      this.retireUntil[1 - deck] = Date.now() + 150;
      await this.settings(this.values);
      return this.state();
    } catch (error) {
      if (generation === this.generation) { this.error = (error as Error).message; this.failed = !this.current; }
      throw error;
    } finally { if (generation === this.generation) this.starting = false; }
  }

  async prepareQueue(from: number, entries: NativeQueueEntry[], previousId: string, loop: NativeQueueEntry[] = [], replaceFuture = false): Promise<NativeMixState> {
    if (!Number.isSafeInteger(from) || from < 1 || !Array.isArray(entries) || entries.length > 10000 || !Array.isArray(loop) || loop.length > 10000)
      throw Error('Некорректная очередь');
    for (const entry of [...entries, ...loop]) this.valid(entry);
    const cur = this.current;
    // A handoff queued before an audible swap may not resurrect its old future.
    if (!cur || previousId !== cur.trackId || from !== cur.index + 1) return this.state();
    const prefix = entries.every((entry, i) => this.future[i]?.entryId === entry.entryId && this.future[i]?.trackId === entry.trackId);
    this.future = !replaceFuture && prefix && entries.length < this.future.length ? this.future : entries.map(e => ({ ...e }));
    this.loop = loop.map(e => ({ ...e }));
    this.manifestRevision++;
    if (this.incoming && this.future[0]?.entryId !== this.incoming.entryId && !this.tick?.transition?.active) {
      await this.audio.command({ cmd: 'disarm' }); this.incoming.abort.abort(); this.incoming = null;
    }
    void this.prepare().catch(error => this.preparationError(error));
    if (this.incoming && this.future[0]?.entryId === this.incoming.entryId)
      void this.refresh(cur, this.incoming, this.future[0], this.generation);
    this.focus();
    return this.state();
  }

  private async load(entry: NativeQueueEntry, index: number, deck: number, generation: number, gainDb = 0, position = 0): Promise<Item> {
    const source = await this.source(entry, this.current ? 'next' : 'current', Math.floor(position * this.sampleRate / CHUNK_FRAMES) * CHUNK_FRAMES);
    if (generation !== this.generation) throw Error('Подготовка отменена');
    const delay = this.retireUntil[deck] - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (generation !== this.generation) throw Error('Подготовка отменена');
    this.slots[deck]?.abort.abort();
    gainDb = source.gainDb ?? gainDb;
    const item: Item = { ...source.track, entryId: entry.entryId, trackId: entry.trackId, source,
      index, deck, token: `${entry.entryId}#host-${++this.sequence}`, totalFrames: Math.max(1, source.totalFrames), gainDb,
      abort: new AbortController(), feeds: new Map(), sentPlans: new Map(), position };
    this.slots[deck] = item;
    this.options.track(item);
    await this.audio.command({ cmd: 'load', deck, token: item.token, totalFrames: item.totalFrames, gainDb,
      cueFrame: Math.round(position * this.sampleRate) });
    const first = Math.max(0, Math.floor((position * this.sampleRate - 4096) / CHUNK_FRAMES));
    const last = Math.min(Math.ceil(item.totalFrames / CHUNK_FRAMES), first + Math.ceil(3 * this.sampleRate / CHUNK_FRAMES));
    await Promise.all(Array.from({ length: last - first }, (_, i) => this.feed(item, first + i)));
    return item;
  }

  private feed(item: Item, chunk: number): Promise<void> {
    const existing = item.feeds.get(chunk);
    if (existing) return existing;
    const work = (async () => {
      if (item.abort.signal.aborted || this.slots[item.deck] !== item) return;
      const start = chunk * CHUNK_FRAMES;
      if (start >= item.totalFrames) return;
      const source = await this.source(item, item === this.current ? 'current' : 'next', start, Math.min(CHUNK_FRAMES, item.totalFrames - start),
        AbortSignal.any([this.abort.signal, item.abort.signal]));
      if (item.abort.signal.aborted || this.slots[item.deck] !== item) return;
      if (source.complete && source.totalFrames !== item.totalFrames) {
        item.totalFrames = source.totalFrames;
        await this.audio.command({ cmd: 'length', deck: item.deck, token: item.token, totalFrames: source.totalFrames });
      }
      const frames = Math.min(CHUNK_FRAMES, item.totalFrames - start);
      if (frames <= 0) return;
      item.source = source;
      try { await this.audio.feedFile({ cmd: 'feedFile', deck: item.deck, token: item.token, chunk, frames, path: source.path, format: source.format }); }
      catch (error) {
        if (source.path === source.finalPath || item.abort.signal.aborted) throw error;
        // The decoder atomically publishes its final name between metadata and read.
        await this.audio.feedFile({ cmd: 'feedFile', deck: item.deck, token: item.token, chunk, frames, path: source.finalPath, format: source.format });
      }
    })().finally(() => item.feeds.delete(chunk));
    item.feeds.set(chunk, work);
    return work;
  }

  private prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    const generation = this.generation, revision = this.manifestRevision;
    this.preparing = this.doPrepare().catch(error => {
      if (generation === this.generation && revision === this.manifestRevision) throw error;
    }).finally(() => {
      this.preparing = null;
      if (revision !== this.manifestRevision && this.current && !this.incoming && this.future.length && !this.error && !this.starting)
        void this.prepare().catch(e => this.preparationError(e));
    });
    return this.preparing;
  }
  private async doPrepare(): Promise<void> {
    const cur = this.current;
    if (!cur || this.incoming || this.starting) return;
    if (!this.future.length && this.loop.length) this.future = this.loop.map(e => ({ ...e }));
    const entry = this.future[0];
    if (!entry) return;
    const generation = this.generation, revision = this.manifestRevision;
    const relevant = () => this.current === cur && generation === this.generation && revision === this.manifestRevision;
    const item = await this.load(entry, cur.index + 1, 1 - cur.deck, generation);
    if (!relevant()) { item.abort.abort(); return; }
    const settings = await this.request<{ automix: typeof DEFAULT_AUTOMIX_SETTINGS }>('/api/settings');
    if (!relevant()) return;
    const fallback = planTransition({ id: cur.trackId, duration: cur.totalFrames / this.sampleRate, mixingAllowed: cur.source.track.mixingAllowed, analysis: null },
      { id: item.trackId, duration: item.totalFrames / this.sampleRate, mixingAllowed: item.source.track.mixingAllowed, analysis: null }, settings.automix);
    this.incoming = item;
    await this.arm(cur, item, fallback);
    this.error = undefined; this.failureStreak = 0;
    void this.refresh(cur, item, entry, generation);
    // Only two future starts are warmed; the shared cache still enforces its disk budget.
    for (const future of this.future.slice(1, 3)) void this.source(future, 'candidate').catch(() => {});
    if (this.waiting && this.current === cur) await this.advance(false);
  }
  private async arm(cur: Item, item: Item, raw: TransitionPlan): Promise<void> {
    if (this.current !== cur || this.incoming !== item || this.tick?.transition?.active) return;
    if (item.source.gainDb !== undefined) item.gainDb = item.source.gainDb;
    // Replanning a future transition must never renormalize the audible recording.
    let plan = { ...fallbackWithoutVocalStems(raw), gainA: cur.gainDb, gainB: item.gainDb };
    const position = this.position(cur);
    if (plan.duration > 0 && plan.aExit <= position + .1) plan = skipPlanFrom(plan, position + .05);
    await this.audio.command({ cmd: 'cue', deck: item.deck, frame: Math.round(plan.bEntry * this.sampleRate) });
    const first = Math.max(0, Math.floor((plan.bEntry * this.sampleRate - 4096) / CHUNK_FRAMES));
    const last = Math.min(Math.ceil(item.totalFrames / CHUNK_FRAMES), first + Math.ceil(3 * this.sampleRate / CHUNK_FRAMES));
    await Promise.all(Array.from({ length: last - first }, (_, i) => this.feed(item, first + i)));
    if (this.current !== cur || this.incoming !== item || this.tick?.transition?.active) return;
    const armed = planToArmed(plan, this.sampleRate, cur.token, item.token);
    await this.audio.command({ cmd: 'gain', deck: item.deck, gainDb: plan.gainB });
    if (this.current !== cur || this.incoming !== item || this.tick?.transition?.active) return;
    item.plan = plan; item.gainDb = plan.gainB;
    item.transition = planToArmed(plan, 48000, cur.token, item.token);
    item.sentPlans.set(plan.id, plan);
    await this.audio.command({ cmd: 'arm', transition: armed });
  }
  private async refresh(cur: Item, item: Item, entry: NativeQueueEntry, generation: number): Promise<void> {
    const revision = this.manifestRevision;
    const params = new URLSearchParams({ from: cur.trackId, to: item.trackId });
    if (entry.transitionContext) for (const [key, value] of Object.entries(entry.transitionContext)) params.set(key, String(value));
    try {
      const result = await this.request<{ plan: TransitionPlan; pending: string[] }>(`/api/automix/plan?${params}`);
      if (this.current !== cur || this.incoming !== item || generation !== this.generation || revision !== this.manifestRevision || this.tick?.transition?.active || item.manualRequested) return;
      item.source = await this.source(item, 'next', 0, 1);
      if (this.current !== cur || this.incoming !== item || generation !== this.generation || revision !== this.manifestRevision || this.tick?.transition?.active || item.manualRequested) return;
      if (item.plan!.aExit - this.position(cur) > 4) await this.arm(cur, item, result.plan);
      if (result.pending.length) this.refreshTimer = setTimeout(() => void this.refresh(cur, item, entry, generation), 3000);
    } catch { /* The prepared full-mix fallback remains armed. */ }
  }
  private preparationError(error: unknown): void {
    if ((error as Error)?.name === 'AbortError' || this.abort.signal.aborted) return;
    this.error = (error as Error).message;
    if (++this.failureStreak < 3 && this.future.length) {
      this.future.shift(); this.error = undefined;
      queueMicrotask(() => void this.prepare().catch(e => this.preparationError(e)));
    }
  }
  private position(item = this.current): number {
    if (!item) return 0;
    const frame = this.tick?.decks.find(d => d.token === item.token)?.position;
    return frame === undefined ? item.position : frame / this.sampleRate;
  }

  onEvent(event: MixerEvent | { type: 'fatal'; error: string }): void {
    if (event.type === 'fatal') { this.failed = true; this.error = event.error; return; }
    const planId = event.type === 'tick' ? event.transition?.planId :
      'planId' in event ? event.planId : undefined;
    const incoming = this.incoming, running = planId && incoming?.sentPlans.get(planId);
    if (incoming && running && incoming.plan !== running) {
      incoming.plan = running;
      incoming.transition = planToArmed(running, 48000, this.current?.token ?? '', incoming.token);
    }
    if (event.type === 'need' && event.part !== 'vocals') {
      const item = this.slots[event.deck];
      if (item?.token === event.token) for (const chunk of event.chunks) void this.feed(item, chunk).catch(() => {
        if (!item.abort.signal.aborted) void this.audio.command({ cmd: 'nack', deck: item.deck, token: item.token, chunk }).catch(() => {});
      });
    } else if (event.type === 'tick') {
      this.tick = event;
      const item = this.slots[event.main];
      if (item && item.token === event.decks[event.main]?.token && event.decks[event.main]?.playing) {
        this.confirmations.get(item.token)?.();
        if (item === this.incoming && item !== this.current) this.adopt(item);
      }
    } else if (event.type === 'swap' && this.incoming?.token === event.token && this.slots[this.incoming.deck] === this.incoming) this.adopt(this.incoming);
    else if (event.type === 'transitionEnd' && this.incoming?.token === event.token && this.slots[this.incoming.deck] === this.incoming) {
      const item = this.incoming;
      if (item.plan) {
        this.recordTransition(item.plan, { forced: event.forced, late: this.tick?.transition?.late ?? false, limiterDb: this.tick?.limiterDb ?? 0 });
      }
      this.adopt(item); this.incoming = null;
      this.retireUntil[1 - item.deck] = Date.now() + (event.forced ? 700 : 50);
      void this.prepare().catch(e => this.preparationError(e));
    } else if (event.type === 'ended' && event.token === this.current?.token) {
      this.waiting = !!(this.future.length || this.loop.length);
      if (this.incoming) void this.advance(false).catch(e => this.preparationError(e));
      else { this.ended = !this.waiting; void this.prepare().catch(e => this.preparationError(e)); }
    }
  }
  private adopt(item: Item): void {
    if (this.current === item) return;
    this.current = item; this.waiting = false; this.ended = false;
    this.history[item.index] = item;
    if (this.future[0]?.entryId === item.entryId) this.future.shift();
    this.focus();
  }
  private recordTransition(plan: TransitionPlan, outcome: Record<string, unknown>): void {
    const last = { plan, at: Date.now(), outcome };
    this.lastTransition = last;
    void this.request<{ id: number }>('/api/automix/log', { plan, outcome }, AbortSignal.timeout(10000))
      .then(({ id }) => { if (this.lastTransition === last) this.lastTransition = { ...last, logId: id }; }).catch(() => {});
  }
  private focus(): void {
    if (!this.current) return;
    void this.request('/api/analysis/focus', { current: this.current.trackId,
      next: this.future.slice(0, 1).map(e => e.trackId), candidates: this.future.slice(1, 3).map(e => e.trackId) }).catch(() => {});
  }
  private async advance(manual: boolean): Promise<void> {
    if (!this.incoming) await this.prepare();
    const item = this.incoming;
    if (!item) return;
    const generation = this.generation, old = this.current;
    const confirmed = this.confirm(item.token);
    void confirmed.catch(() => {});
    await this.audio.command({ cmd: 'start', deck: item.deck, token: item.token, frame: manual ? 0 : Math.round((item.plan?.bEntry ?? 0) * this.sampleRate) });
    await confirmed;
    if (generation !== this.generation || this.current !== old && this.current !== item) return;
    if (manual && old && item.plan) {
      const plan: TransitionPlan = { ...skipPlanFrom(item.plan, this.position(old)), gainA: old.gainDb, gainB: item.gainDb,
        bEntry: 0, duration: .03, swapAt: 0,
        automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [.03, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 1], [.03, 1]] }],
        reasons: ['быстрое переключение вручную'] };
      this.recordTransition(plan, { forced: true, manual: true, limiterDb: this.tick?.limiterDb ?? 0 });
    }
    this.adopt(item); this.incoming = null;
    this.retireUntil[1 - item.deck] = Date.now() + 150;
    void this.prepare().catch(e => this.preparationError(e));
  }
  command(action: string, seekTime?: number): Promise<NativeMixState> {
    if (action === 'nexttrack' || action === 'previoustrack') {
      const result = this.commandTail.then(() => this.performCommand(action, seekTime));
      this.commandTail = result.catch(() => {});
      return result;
    }
    return this.performCommand(action, seekTime);
  }
  private async performCommand(action: string, seekTime?: number): Promise<NativeMixState> {
    const cur = this.current;
    if (!['play', 'pause', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward'].includes(action)) throw Error('Неизвестная команда');
    if (action === 'play' || action === 'pause') {
      this.paused = action === 'pause';
      if (this.audio.process) await this.audio.command({ cmd: 'pause', paused: this.paused });
    } else if (action === 'nexttrack') {
      if (this.tick?.transition?.active) await this.audio.command({ cmd: 'finish', fade: .15 });
      else {
        this.error = undefined; this.failureStreak = 0;
        if (!this.incoming) await this.prepare();
        const item = this.incoming;
        if (!item || !cur || this.current !== cur) return this.state();
        const settings = await this.request<{ automix: typeof DEFAULT_AUTOMIX_SETTINGS }>('/api/settings');
        if (this.current !== cur || this.incoming !== item) return this.state();
        if (this.paused || item.manualRequested || settings.automix.mixOnNext === false) await this.advance(true);
        else {
          item.manualRequested = true;
          try {
            const result = await this.request<{ plan: TransitionPlan }>('/api/automix/mix-now',
              { from: cur.trackId, to: item.trackId, position: this.position(cur) });
            if (this.current === cur && this.incoming === item) await this.arm(cur, item, result.plan);
          } catch {
            if (this.current === cur && this.incoming === item) await this.advance(true);
          }
        }
      }
    } else if (action === 'previoustrack') {
      if (cur && this.position(cur) <= 3 && cur.index > 0) {
        const previous = this.history[cur.index - 1];
        if (previous) {
          const history = this.history.slice(0, cur.index);
          const future = [cur, ...this.future].map(e => ({ trackId: e.trackId, entryId: e.entryId }));
          const loop = this.loop;
          await this.startSource(previous, { sampleRate: this.sampleRate, position: 0, paused: this.paused, ...this.values });
          if (this.current) { this.current.index = previous.index; history[previous.index] = this.current; this.history = history; }
          this.future = future; this.loop = loop; void this.prepare().catch(e => this.preparationError(e));
        }
      } else if (cur) await this.seek(0);
    } else if (cur) {
      const position = action === 'seekto' ? seekTime : this.position(cur) + (action === 'seekforward' ? 10 : -10);
      if (!Number.isFinite(position)) throw Error('Некорректная позиция');
      await this.seek(position!);
    }
    return this.state();
  }
  private confirm(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.abort.signal;
      const cleanup = () => { clearTimeout(timer); this.confirmations.delete(token); signal.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(Error('Запуск отменён')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Аудиодвижок не подтвердил трек')); }, 5000);
      signal.addEventListener('abort', cancel, { once: true });
      this.confirmations.set(token, () => { cleanup(); resolve(); });
    });
  }
  private async seek(position: number): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const frame = Math.max(0, Math.min(cur.totalFrames - 1, Math.round(position * this.sampleRate)));
    this.ended = false; this.waiting = false;
    await this.audio.command({ cmd: 'seek', token: cur.token, frame });
    cur.position = frame / this.sampleRate; this.tick = null;
    if (this.incoming) {
      const item = this.incoming; item.abort.abort(); this.incoming = null;
      this.retireUntil[item.deck] = Date.now() + 400;
      void this.prepare().catch(e => this.preparationError(e));
    }
  }
  async settings(values: NativeMixSettings): Promise<void> {
    this.values = { ...this.values, ...values };
    if (!this.audio.process) return;
    if (values.volume !== undefined) await this.audio.command({ cmd: 'volume', value: values.volume });
    if (values.playback) await this.audio.command({ cmd: 'playback', settings: values.playback });
    if (values.tone) await this.audio.command({ cmd: 'tone', settings: values.tone, preDb: values.preDb });
    if (values.gainDb !== undefined && this.current) {
      this.current.gainDb = values.gainDb;
      await this.audio.command({ cmd: 'gain', deck: this.current.deck, gainDb: values.gainDb });
    }
  }
  async setDevice(device: string): Promise<void> {
    if (typeof device !== 'string' || device.length > 4096) throw Error('Некорректное устройство');
    if (this.audio.process) await this.audio.command({ cmd: 'output', device });
    this.device = device;
  }
  state(): NativeMixState {
    const cur = this.current, position = this.position(cur), tr = this.tick?.transition;
    const starved = !!cur && !!this.tick?.decks.find(d => d.token === cur.token)?.starved;
    const track = (item: Item | null): NativeMixTrack | undefined => item ? { entryId: item.entryId, trackId: item.trackId, title: item.title,
      artist: item.artist, coverUrl: item.coverUrl, totalFrames: item.totalFrames / this.sampleRate * 48000, gainDb: item.gainDb,
      plan: item.plan, transition: item.transition } : undefined;
    return { active: !!cur && !this.failed, playing: !!cur && !this.paused && !this.ended && !this.waiting && !this.failed && !starved,
      index: cur?.index ?? 0, position, duration: cur ? cur.totalFrames / this.sampleRate : 0,
      currentTrack: track(cur), nextTrack: track(this.incoming === cur ? null : this.incoming), entryId: cur?.entryId,
      sampleRate: this.sampleRate, ended: this.ended, failed: this.failed, waitingForPreparation: this.waiting || starved,
      preparing: !!this.preparing, count: this.history.length + this.future.length, lastTransition: this.lastTransition,
      blend: tr?.active && this.incoming ? { index: this.incoming.index, progress: tr.t / Math.max(1, ((this.incoming.plan?.duration ?? 1) + (this.incoming.plan?.gap ?? 0)) * this.sampleRate) } : null,
      preparation: { state: this.error ? 'error' : this.incoming ? 'ready' : this.preparing ? 'preparing' : 'idle',
        ready: this.incoming ? 1 : 0, remaining: this.future.length, reason: this.error } };
  }
  async stop(): Promise<void> {
    this.generation++; this.manifestRevision++; this.abort.abort(); clearTimeout(this.refreshTimer);
    for (const item of this.slots) item?.abort.abort();
    this.slots = [null, null]; this.current = null; this.incoming = null; this.future = []; this.loop = []; this.history = []; this.tick = null;
    this.starting = false; this.waiting = false; this.ended = false; this.failed = false; this.error = undefined;
    await this.audio.stop();
  }
}
