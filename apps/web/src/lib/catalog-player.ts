import type { CatalogTrack } from '@automix/core';
import type { PlayContext } from '../audio/controller.ts';

interface Transport {
  readonly intentVersion: number;
  readonly queueVersion?: number;
  state: { queue: { trackId: string }[]; index: number };
  unlockAudio(): Promise<void>;
  playTracks(ids: string[], index: number, context: PlayContext): Promise<void>;
  addToQueue(ids: string[], next?: boolean): void;
  subscribe(fn: () => void): () => void;
}
export interface CatalogPlaybackState {
  phase: 'idle' | 'starting' | 'next';
  externalId: string | null;
  title: string;
  error: string | null;
  pending: string[];
}
interface Session {
  request: number;
  items: CatalogTrack[];
  next: number;
  queued: string[];
  version: number;
  queueVersion?: number;
}

const KEEP_PLAYED = 100;
/** An evicted id is simply prepared again; the server returns the recording it already stored. */
const KEEP_PREPARED = 500;

/** Imports only what playback needs: the selected track and two ahead.
 * A later user command always wins over an earlier slow download. */
export class CatalogPlayer {
  state: CatalogPlaybackState = { phase: 'idle', externalId: null, title: '', error: null, pending: [] };
  private listeners = new Set<(state: CatalogPlaybackState) => void>();
  private inflight = new Map<string, Promise<string>>();
  private prepared = new Map<string, string>();
  private request = 0;
  private session: Session | null = null;
  private pumping = false;

  constructor(private deps: {
    transport: Transport;
    known(track: CatalogTrack): string | null;
    exists(id: string): boolean;
    prepare(track: CatalogTrack): Promise<string>;
    key?(track: CatalogTrack): string;
    notify(message: string): void;
    allow?(track: CatalogTrack): boolean;
  }) { deps.transport.subscribe(() => { void this.pump(); }); }

  subscribe(fn: (state: CatalogPlaybackState) => void): () => void {
    this.listeners.add(fn); return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<CatalogPlaybackState>): void {
    // pump() runs on every transport tick; an unchanged snapshot must not re-render subscribers.
    const same = (k: keyof CatalogPlaybackState) => k === 'pending'
      ? patch.pending!.length === this.state.pending.length && patch.pending!.every((v, i) => v === this.state.pending[i])
      : patch[k] === this.state[k];
    if ((Object.keys(patch) as (keyof CatalogPlaybackState)[]).every(same)) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
  private key(track: CatalogTrack): string { return this.deps.key?.(track) ?? track.externalId; }
  known(track: CatalogTrack): string | null {
    const id = this.deps.known(track) ?? this.prepared.get(this.key(track));
    return id && this.deps.exists(id) ? id : null;
  }
  ensure(track: CatalogTrack): Promise<string> {
    const id = this.known(track); if (id) return Promise.resolve(id);
    if (!track.playable) return Promise.reject(new Error('Эта запись недоступна в источнике'));
    const key = this.key(track);
    const previous = this.inflight.get(key); if (previous) return previous;
    const job = this.deps.prepare(track).then((id) => {
      this.prepared.delete(key); this.prepared.set(key, id);
      if (this.prepared.size > KEEP_PREPARED) this.prepared.delete(this.prepared.keys().next().value!);
      return id;
    })
      .finally(() => { this.inflight.delete(key); this.set({ pending: [...this.inflight.keys()] }); });
    this.inflight.set(key, job); this.set({ pending: [...this.inflight.keys()] }); return job;
  }
  cancel(): void {
    this.request++; this.session = null;
    this.set({ phase: 'idle', externalId: null, title: '', error: null });
  }
  dismissError(): void { this.set({ error: null }); }
  async save(track: CatalogTrack): Promise<void> {
    try { await this.ensure(track); this.deps.notify(`«${track.title}» в медиатеке`); }
    catch (e) { this.set({ error: (e as Error).message }); }
  }
  async enqueue(track: CatalogTrack, next = false): Promise<void> {
    this.cancel();
    const request = this.request, version = this.deps.transport.intentVersion;
    try {
      const id = await this.ensure(track);
      if (request !== this.request || version !== this.deps.transport.intentVersion) return;
      this.deps.transport.addToQueue([id], next);
      this.deps.notify(next ? 'Трек сыграет следующим' : 'Трек добавлен в очередь');
    } catch (e) {
      if (request === this.request && version === this.deps.transport.intentVersion) this.set({ error: (e as Error).message });
    }
  }
  async play(items: CatalogTrack[], index: number, context: PlayContext): Promise<void> {
    const selected = items[index]; if (!selected) return;
    const request = ++this.request; this.session = null;
    const transport = this.deps.transport, version = transport.intentVersion;
    this.set({ phase: 'starting', externalId: selected.externalId, title: selected.title, error: null });
    try {
      // Called inside the click gesture, before any network request finishes.
      await transport.unlockAudio();
      if (request !== this.request || version !== transport.intentVersion) return;
      const sequence = items.slice(index).filter((t, i) => i === 0 || t.playable || this.known(t));
      // Warm one future track concurrently, without delaying the chosen song.
      if (sequence[1]) void this.ensure(sequence[1]).catch(() => {});
      const first = await this.ensure(selected);
      if (request !== this.request || version !== transport.intentVersion) return;
      await transport.playTracks([first], 0, context);
      if (request !== this.request) return;
      this.session = { request, items: sequence, next: 1, queued: [first], version: transport.intentVersion, queueVersion: transport.queueVersion };
      this.set({ phase: 'idle', externalId: null });
      void this.pump();
    } catch (e) {
      if (request === this.request) this.set({ phase: 'idle', externalId: null, error: (e as Error).message });
    } finally {
      if (request === this.request && !this.session) this.set({ phase: 'idle', externalId: null });
    }
  }
  /** Items of the running session not queued yet (radio refills before this runs dry). */
  get remaining(): number { return this.session && this.matches(this.session) ? this.session.items.length - this.session.next : -1; }
  get sessionItems(): CatalogTrack[] { return this.session?.items ?? []; }
  get sessionVersion(): number | null { return this.session && this.matches(this.session) ? this.session.request : null; }
  /** Appends to the running session; false when the listener moved on to something else. */
  extend(items: CatalogTrack[], expectedVersion?: number): boolean {
    const s = this.session;
    if (!s || !this.matches(s) || (expectedVersion !== undefined && s.request !== expectedVersion)) return false;
    const have = new Set(s.items.map((t) => this.key(t)));
    s.items.push(...items.filter((t) => { const key = this.key(t); if (have.has(key)) return false; have.add(key); return true; }));
    // An endless station keeps only recent history; the cursor moves with the dropped head.
    const drop = s.next - KEEP_PLAYED;
    if (drop > 0) { s.items.splice(0, drop); s.next -= drop; }
    void this.pump();
    return true;
  }
  private matches(s: Session): boolean {
    const t = this.deps.transport;
    if (s !== this.session || s.request !== this.request) return false;
    if (s.queueVersion !== undefined) {
      if (s.queueVersion !== t.queueVersion || !t.state.queue.length) return false;
      // Deleting/reordering upcoming songs edits this station, not its ownership.
      // Keep the candidate cursor: removed recommendations must not be added again.
      s.queued = t.state.queue.map(entry => entry.trackId);
      return true;
    }
    return s.queued.length === t.state.queue.length && s.queued.every((id, i) => id === t.state.queue[i].trackId);
  }
  private async pump(): Promise<void> {
    const s = this.session;
    if (!s || this.pumping) return;
    if (!this.matches(s)) { this.cancel(); return; }
    this.pumping = true;
    try {
      while (this.matches(s) && s.next < s.items.length && s.queued.length - this.deps.transport.state.index - 1 < 2) {
        const track = s.items[s.next++];
        this.set({ phase: 'next', externalId: track.externalId, title: track.title });
        try {
          if (this.deps.allow && !this.deps.allow(track)) continue;
          const id = await this.ensure(track);
          if (!this.matches(s)) break;
          if (this.deps.allow && !this.deps.allow(track)) continue;
          // Update the expected queue before synchronous transport subscribers run.
          s.queued.push(id); this.deps.transport.addToQueue([id]); s.version = this.deps.transport.intentVersion;
        } catch (e) {
          if (this.matches(s)) this.deps.notify(`Пропускаю «${track.title}»: ${(e as Error).message}`);
        }
      }
    } finally {
      this.pumping = false;
      if (this.session === s) this.set({ phase: 'idle', externalId: null });
      else if (this.session) void this.pump();
    }
  }
}
