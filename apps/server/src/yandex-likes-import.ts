import crypto from 'node:crypto';
import { getSettings } from './automix.ts';
import { kvGet, kvSet, q, tx, type Db } from './db.ts';
import type { Library } from './library.ts';
import type { EventHub } from './events.ts';
import type { YandexProvider } from './providers/yandex.ts';

interface Job { id: string; account: string; state: 'listing' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'; startedAt: number; total: number; message: string }
type Item = { position: number; external_id: string; state: string; track_id: string | null };
const KEY = 'yandex.likes-import';

/** Durable two-worker import. Only local reactions are written: these tracks are already liked remotely. */
export class YandexLikesImport {
  private job: Job | null;
  private task: Promise<void> | null = null;
  private stopped = false;
  constructor(private db: Db, private lib: Library, private provider: Pick<YandexProvider, 'reactionSession' | 'likeIds' | 'importTrack'>, private events: EventHub) {
    db.exec(`CREATE TABLE IF NOT EXISTS yandex_likes_import_items (
      job_id TEXT NOT NULL, position INTEGER NOT NULL, external_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', track_id TEXT,
      PRIMARY KEY(job_id, position));`);
    this.job = kvGet<Job | null>(db, KEY, null);
    if (this.job && ['running', 'listing'].includes(this.job.state)) {
      this.job.state = 'paused'; this.job.message = 'Импорт приостановлен после перезапуска. Можно продолжить.';
      q(db, "UPDATE yandex_likes_import_items SET state='pending' WHERE job_id=? AND state='preparing'").run(this.job.id);
      this.save();
    }
  }
  private save() { kvSet(this.db, KEY, this.job); }
  status() {
    if (!this.job) return null;
    const rows = q(this.db, 'SELECT state, COUNT(*) AS n FROM yandex_likes_import_items WHERE job_id=? GROUP BY state').all(this.job.id) as { state: string; n: number }[];
    const counts = new Map(rows.map((r) => [r.state, r.n]));
    return { id: this.job.id, state: this.job.state, busy: !!this.task, total: this.job.total, done: counts.get('done') ?? 0, failed: counts.get('failed') ?? 0,
      skipped: counts.get('skipped') ?? 0, preparing: counts.get('preparing') ?? 0, message: this.job.message };
  }
  start() {
    if (this.task || (this.job && ['paused', 'running', 'listing'].includes(this.job.state))) throw new Error('Продолжите или завершите текущий импорт');
    if (!getSettings(this.db).yandex.importLikes) throw new Error('Импорт лайков из Яндекса выключен в настройках источников');
    const session = this.provider.reactionSession();
    if (!session) throw new Error('Подключите Яндекс Музыку');
    this.stopped = false;
    this.job = { id: crypto.randomUUID(), account: session.key, state: 'listing', total: 0, startedAt: Date.now(), message: '' };
    this.save(); this.launch(); return this.status();
  }
  pause() {
    if (this.job && ['listing', 'running'].includes(this.job.state)) { this.job.state = 'paused'; this.job.message = 'Подготовка текущих треков завершится. Остальные ждут продолжения.'; this.save(); }
    return this.status();
  }
  cancel() {
    if (this.job && this.job.state !== 'done') { this.job.state = 'cancelled'; this.job.message = 'Импорт завершён. Добавленные треки остаются в Любимом.'; this.save(); }
    return this.status();
  }
  resume(retryFailed = false) {
    if (!this.job || this.task) throw new Error('Дождитесь завершения текущей операции');
    if (this.job.state === 'cancelled') throw new Error('Этот импорт завершён. Начните новый.');
    if (!getSettings(this.db).yandex.importLikes) throw new Error('Импорт лайков из Яндекса выключен в настройках источников');
    if (this.provider.reactionSession()?.key !== this.job.account) throw new Error('Подключите тот аккаунт Яндекса, с которого начат импорт');
    if (retryFailed) q(this.db, "UPDATE yandex_likes_import_items SET state='pending' WHERE job_id=? AND state='failed'").run(this.job.id);
    this.stopped = false; this.job.state = this.job.total ? 'running' : 'listing'; this.job.message = ''; this.save(); this.launch(); return this.status();
  }
  async stop() { this.stopped = true; this.pause(); await this.task; }
  async settled() { await this.task; }
  private launch() {
    const job = this.job!;
    this.task = this.run(job).catch(() => {
      if (['listing', 'running'].includes(job.state)) { job.state = 'error'; job.message = 'Не удалось продолжить импорт. Проверьте подключение и повторите.'; }
      this.save();
    }).finally(() => { this.task = null; this.events.emit({ type: 'library', reason: 'yandex-likes-import' }); });
  }
  private async run(job: Job) {
    const current = () => !this.stopped && ['running', 'listing'].includes(job.state) && this.provider.reactionSession()?.key === job.account;
    if (!job.total) {
      const snapshot = await this.provider.likeIds();
      if (!current() || snapshot.key !== job.account) { if (job.state !== 'cancelled') job.state = 'paused'; this.save(); return; }
      tx(this.db, () => {
        q(this.db, 'DELETE FROM yandex_likes_import_items').run();
        snapshot.ids.forEach((id, i) => q(this.db, 'INSERT INTO yandex_likes_import_items(job_id, position, external_id) VALUES (?, ?, ?)').run(job.id, i, id));
        job.total = snapshot.ids.length; job.state = 'running'; this.save();
      });
    }
    let consecutiveFailures = 0;
    const worker = async () => {
      while (current()) {
        const item = q(this.db, "SELECT * FROM yandex_likes_import_items WHERE job_id=? AND state='pending' ORDER BY position LIMIT 1").get(job.id) as Item | undefined;
        if (!item) return;
        q(this.db, "UPDATE yandex_likes_import_items SET state='preparing' WHERE job_id=? AND position=?").run(job.id, item.position);
        try {
          const id = await this.provider.importTrack({ externalId: item.external_id, title: '', artist: '', album: '', duration: 0, coverUrl: null, pageUrl: null, license: null, playable: true });
          if (this.provider.reactionSession()?.key !== job.account) {
            q(this.db, "UPDATE yandex_likes_import_items SET state='pending' WHERE job_id=? AND position=?").run(job.id, item.position);
            job.state = 'paused'; job.message = 'Подключение Яндекса изменилось.'; this.save(); return;
          }
          // Do not undo a user's dislike/unlike made while this job was downloading.
          const local = q(this.db, 'SELECT value, updated_at FROM reactions WHERE track_id=?').get(id) as { value: number; updated_at: number } | undefined;
          const sync = q(this.db, 'SELECT value, updated_at FROM yandex_reaction_sync WHERE external_id=?').get(item.external_id) as { value: number; updated_at: number } | undefined;
          const newer = [local, sync].some((r) => r && r.updated_at > job.startedAt && r.value !== 1);
          tx(this.db, () => {
            if (!newer) {
              // Original position wins over download completion time. Recent local likes stay recent.
              const timestamp = local?.value === 1 && local.updated_at > job.startedAt ? local.updated_at : job.startedAt - item.position;
              q(this.db, 'INSERT INTO reactions(track_id, value, updated_at) VALUES (?, 1, ?) ON CONFLICT(track_id) DO UPDATE SET value=1, updated_at=excluded.updated_at').run(id, timestamp);
              this.lib.setSaved(id, true);
            }
            q(this.db, 'UPDATE yandex_likes_import_items SET state=?, track_id=? WHERE job_id=? AND position=?').run(newer ? 'skipped' : 'done', id, job.id, item.position);
          });
          consecutiveFailures = 0;
          this.events.emit({ type: 'library', reason: 'yandex-likes-import', trackId: id });
        } catch {
          q(this.db, "UPDATE yandex_likes_import_items SET state='failed' WHERE job_id=? AND position=?").run(job.id, item.position);
          if (++consecutiveFailures >= 3 && current()) { job.state = 'paused'; job.message = 'Несколько треков подряд не загрузились. Проверьте сеть и продолжите; ошибки можно повторить.'; this.save(); }
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (current()) { job.state = 'done'; job.message = ''; }
    else if (job.state === 'running') { job.state = 'paused'; job.message = 'Подключение Яндекса изменилось.'; }
    this.save();
  }
}
