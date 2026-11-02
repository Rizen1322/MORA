import type { NativeQueueEntry } from '../../web/src/lib/native-mix.ts';

type ListeningEntry = NativeQueueEntry & { origin?: string; yandexId?: string; yandexSessionId?: string; yandexBatchId?: string | null; binding?: boolean };
type EndReason = 'finished' | 'skip' | 'transition' | 'stop' | 'error';
type Request = (method: 'POST' | 'PATCH', path: string, body: object) => Promise<any>;

/** Records the entry confirmed by the mixer, independently of the renderer. */
export class NativeListening {
  private current: { entry: ListeningEntry; position: number; seconds: number; id?: number } | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private request: Request) {}

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch(() => {});
  }

  start(entry: ListeningEntry, positionSeconds = 0, reason: 'skip' | 'transition' = 'skip'): void {
    if (this.current?.entry.entryId === entry.entryId) return;
    this.finish(reason);
    const play = { entry, position: Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0, seconds: 0 } as NonNullable<NativeListening['current']>;
    this.current = play;
    this.enqueue(async () => {
      const result = await this.request('POST', '/api/plays', { trackId: entry.trackId, context: entry.origin ?? 'queue' });
      if (Number.isSafeInteger(result?.id) && result.id > 0) play.id = result.id;
    });
    if (entry.origin === 'yandex' && entry.yandexId && entry.yandexSessionId && entry.binding === false) {
      this.enqueue(async () => { await this.request('POST', '/api/providers/yandex/feedback', { sessionId: entry.yandexSessionId, batchId: entry.yandexBatchId ?? null,
        event: { type: 'trackStarted', trackId: entry.yandexId } }); });
    }
  }

  tick(positionSeconds: number, playing: boolean): void {
    const play = this.current;
    if (!play || !Number.isFinite(positionSeconds) || positionSeconds < 0) return;
    if (playing) play.seconds += Math.min(2, Math.max(0, positionSeconds - play.position));
    play.position = positionSeconds;
  }

  finish(reason: EndReason = 'finished'): void {
    const play = this.current;
    if (!play) return;
    this.current = null;
    const { entry, seconds } = play;
    this.enqueue(async () => {
      if (play.id) await this.request('PATCH', `/api/plays/${play.id}`, { playedMs: Math.round(seconds * 1000), endReason: reason });
    });
    if (entry.origin === 'yandex' && entry.yandexId && entry.yandexSessionId && entry.binding === false) {
      this.enqueue(async () => { await this.request('POST', '/api/providers/yandex/feedback', { sessionId: entry.yandexSessionId, batchId: entry.yandexBatchId ?? null,
        event: { type: reason === 'finished' || reason === 'transition' ? 'trackFinished' : 'skip', trackId: entry.yandexId, totalPlayedSeconds: seconds } }); });
    }
  }
}
