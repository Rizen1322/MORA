import type { ReactionSync, ReactionValue } from '@automix/core';
import { q, type Db } from './db.ts';
import type { EventHub } from './events.ts';
import type { Library } from './library.ts';
import { isYandexTrackId } from './providers/yandex-audio.ts';

export interface YandexReactionSession {
  key: string;
  current(): boolean;
  account(): Promise<string>;
  write(uid: string, kind: 'likes' | 'dislikes', action: 'add-multiple' | 'remove', externalId: string): Promise<void>;
}

interface ReactionProvider {
  reactionSession(): YandexReactionSession | null;
  cachedReactionFor(externalId: string): ReactionValue | undefined;
}

interface SyncRow {
  track_id: string | null; external_id: string; value: ReactionValue; revision: number;
  status: 'pending' | 'synced' | 'error'; attempts: number; next_attempt_at: number;
  account_key: string | null; account_uid: string | null; error: string | null; updated_at: number;
}

const RETRY_ERROR = 'Оценка сохранена здесь. Не удалось обновить Яндекс Музыку; повторим позже.';
const ACCOUNT_ERROR = 'Оценка сохранена здесь. Для отправки подключите исходный аккаунт Яндекс Музыки.';

/** A durable, serial, last-write-wins outbox. Only an explicit local reaction queues writes. */
export class YandexReactionSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly maxAttempts = 6;

  constructor(private db: Db, private lib: Library, private provider: ReactionProvider, private events: EventHub) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.flush(); }, 1000);
    this.timer.unref();
    void this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  connectionChanged(): void {
    q(this.db, "UPDATE yandex_reaction_sync SET attempts=0, next_attempt_at=0, status='pending', error=NULL WHERE status!='synced'").run();
    void this.flush();
  }

  private externalId(trackId: string): string | null {
    const track = this.lib.get(trackId);
    if (track?.provider !== 'yandex' || !/^[a-f\d]{64}$/.test(track.content_hash)) return null;
    return this.lib.sources(trackId).find((source) => source.provider === 'yandex' && source.kind === 'remote' && source.external_id && isYandexTrackId(source.external_id))?.external_id ?? null;
  }

  private row(trackId: string): SyncRow | undefined {
    const externalId = this.externalId(trackId);
    return externalId ? this.rowExternal(externalId) : undefined;
  }

  private rowExternal(externalId: string): SyncRow | undefined {
    return q(this.db, 'SELECT * FROM yandex_reaction_sync WHERE external_id=?').get(externalId) as unknown as SyncRow | undefined;
  }

  /** Called in the same transaction as the local reaction; no remote call happens here. */
  enqueue(trackId: string, value: ReactionValue): ReactionSync {
    const externalId = this.externalId(trackId);
    if (!externalId) return { status: 'local' };
    return this.enqueueExternal(externalId, value, trackId);
  }

  /** The catalog route verifies this ID through /tracks before calling this method. */
  enqueueExternal(externalId: string, value: ReactionValue, trackId?: string): ReactionSync {
    if (!isYandexTrackId(externalId)) throw new Error('Некорректный ID трека Яндекса');
    const previous = this.rowExternal(externalId), session = this.provider.reactionSession();
    const matchedTrackId = trackId ?? this.lib.all().find((track) => this.externalId(track.id) === externalId)?.id ?? null;
    const key = session?.key ?? previous?.account_key ?? null;
    const uid = previous?.account_key === key ? previous?.account_uid ?? null : null;
    q(this.db, `INSERT INTO yandex_reaction_sync(track_id,external_id,value,revision,status,attempts,next_attempt_at,account_key,account_uid,error,updated_at)
      VALUES (?,?,?,1,'pending',0,0,?,?,NULL,?) ON CONFLICT(external_id) DO UPDATE SET
      track_id=excluded.track_id,value=excluded.value,revision=yandex_reaction_sync.revision+1,
      status='pending',attempts=0,next_attempt_at=0,account_key=excluded.account_key,account_uid=excluded.account_uid,error=NULL,updated_at=excluded.updated_at`)
      .run(matchedTrackId, externalId, value, key, uid, Date.now());
    if (matchedTrackId) this.writeLocal(matchedTrackId, value);
    return { status: 'pending' };
  }

  status(trackId: string): ReactionSync {
    const row = this.row(trackId);
    return row ? { status: row.status, ...(row.error ? { error: row.error } : {}) } : { status: 'local' };
  }

  statusExternal(externalId: string): ReactionSync {
    const row = this.rowExternal(externalId);
    return row ? { status: row.status, ...(row.error ? { error: row.error } : {}) } : { status: 'local' };
  }

  private writeLocal(trackId: string, value: ReactionValue): void {
    if (value === 0) q(this.db, 'DELETE FROM reactions WHERE track_id=?').run(trackId);
    else q(this.db, `INSERT INTO reactions(track_id,value,updated_at) VALUES (?,?,?) ON CONFLICT(track_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(trackId, value, Date.now());
  }

  attachTrack(trackId: string): void {
    const externalId = this.externalId(trackId);
    if (!externalId) return;
    const row = this.rowExternal(externalId);
    if (row) q(this.db, 'UPDATE yandex_reaction_sync SET track_id=? WHERE external_id=?').run(trackId, externalId);
    const value = this.valueForExternal(externalId) ?? this.provider.cachedReactionFor(externalId);
    if (value !== undefined) this.writeLocal(trackId, value);
  }

  valueForExternal(externalId: string): ReactionValue | undefined {
    // "<track>" or "<track>:<album>": an exact match or a primary-key range over the "<track>:" prefix (';' follows ':').
    const base = externalId.split(':')[0];
    const row = q(this.db, `SELECT * FROM yandex_reaction_sync WHERE
      external_id=? OR (external_id>=? AND external_id<?) ORDER BY updated_at DESC,revision DESC LIMIT 1`)
      .get(base, `${base}:`, `${base};`) as unknown as SyncRow | undefined;
    const key = this.provider.reactionSession()?.key;
    return row && (!row.account_key || row.account_key === key) ? row.value : undefined;
  }

  displayReaction(trackId: string, local: number): number {
    const externalId = this.externalId(trackId);
    if (!externalId) return local;
    return this.valueForExternal(externalId) ?? (local || this.provider.cachedReactionFor(externalId) || 0);
  }

  stats(): { pending: number; error: number; synced: number; items: { trackId: string | null; externalId: string; value: ReactionValue; sync: ReactionSync }[] } {
    const totals = { pending: 0, error: 0, synced: 0 };
    for (const row of q(this.db, 'SELECT status,COUNT(*) AS n FROM yandex_reaction_sync GROUP BY status').all() as { status: keyof typeof totals; n: number }[]) totals[row.status] = row.n;
    const rows = q(this.db, 'SELECT * FROM yandex_reaction_sync ORDER BY updated_at DESC LIMIT 100').all() as unknown as SyncRow[];
    return { ...totals, items: rows.map((row) => ({ trackId: row.track_id, externalId: row.external_id, value: row.value, sync: { status: row.status, ...(row.error ? { error: row.error } : {}) } })) };
  }

  async settle(trackId: string, timeoutMs = 750): Promise<ReactionSync> {
    const externalId = this.externalId(trackId);
    return externalId ? this.settleExternal(externalId, timeoutMs) : { status: 'local' };
  }

  async settleExternal(externalId: string, timeoutMs = 750): Promise<ReactionSync> {
    const work = this.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
    return this.statusExternal(externalId);
  }

  flush(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return force ? this.running.then(() => this.flush(true)) : this.running;
    const work = this.drain(force).catch(() => { /* Durable rows remain for the next tick. Never log remote exceptions. */ });
    this.running = work;
    void work.finally(() => { if (this.running === work) this.running = null; });
    return work;
  }

  private current(row: SyncRow): boolean {
    return !this.stopped && this.rowExternal(row.external_id)?.revision === row.revision;
  }

  private update(row: SyncRow, status: SyncRow['status'], attempts: number, next: number, error: string | null): void {
    q(this.db, 'UPDATE yandex_reaction_sync SET status=?,attempts=?,next_attempt_at=?,error=? WHERE external_id=? AND revision=?')
      .run(status, attempts, next, error, row.external_id, row.revision);
    this.events.emit({ type: 'library', reason: 'reaction-sync', ...(row.track_id ? { trackId: row.track_id } : {}) });
  }

  private async drain(force: boolean): Promise<void> {
    const seen = new Set<string>();
    for (let turn = 0; turn < 32 && !this.stopped; turn++) {
      const rows = q(this.db, `SELECT * FROM yandex_reaction_sync WHERE status!='synced' AND attempts<? AND (? OR next_attempt_at<=?) ORDER BY updated_at LIMIT 64`)
        .all(this.maxAttempts, force ? 1 : 0, Date.now()) as unknown as SyncRow[];
      const row = rows.find((item) => !seen.has(`${item.external_id}:${item.revision}`));
      if (!row) return;
      seen.add(`${row.external_id}:${row.revision}`);
      if (!isYandexTrackId(row.external_id) || (row.track_id && this.externalId(row.track_id) !== row.external_id)) { this.update(row, 'error', this.maxAttempts, 0, 'Оценка сохранена здесь. Источник трека не подтверждён'); continue; }
      const session = this.provider.reactionSession();
      if (!session) { this.update(row, 'pending', row.attempts, Date.now() + 60000, 'Подключите аккаунт Яндекс Музыки, чтобы отправить оценку'); continue; }
      try {
        const uid = await session.account();
        if (!this.current(row) || !session.current()) continue;
        // A new token may belong to the same account. An unknown old owner is never guessed.
        if ((row.account_uid && row.account_uid !== uid) || (!row.account_uid && row.account_key && row.account_key !== session.key)) {
          this.update(row, 'error', this.maxAttempts, 0, ACCOUNT_ERROR); continue;
        }
        q(this.db, 'UPDATE yandex_reaction_sync SET account_key=?,account_uid=? WHERE external_id=? AND revision=?').run(session.key, uid, row.external_id, row.revision);
        const steps: ['likes' | 'dislikes', 'add-multiple' | 'remove'][] = row.value === 1
          ? [['dislikes', 'remove'], ['likes', 'add-multiple']]
          : row.value === -1 ? [['likes', 'remove'], ['dislikes', 'add-multiple']] : [['likes', 'remove'], ['dislikes', 'remove']];
        for (const [kind, action] of steps) {
          if (!this.current(row) || !session.current()) break;
          await session.write(uid, kind, action, row.external_id);
        }
        if (this.current(row) && session.current()) this.update(row, 'synced', 0, 0, null);
      } catch {
        if (!this.current(row)) continue;
        if (!session.current()) { this.update(row, 'pending', row.attempts, 0, null); continue; }
        const attempts = row.attempts + 1;
        this.update(row, 'error', attempts, Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1)), RETRY_ERROR);
      }
    }
  }
}
