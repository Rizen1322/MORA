import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { YandexLikesImport } from '../src/yandex-likes-import.ts';
import { kvGet, kvSet, q } from '../src/db.ts';
import type { ExternalTrack } from '../src/providers/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(count = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-all-likes-'));
  const a = await createApp({ dataDir: dir, accessToken: null, stemsPython: null }, { startWorkers: false });
  cleanup.push(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = Array.from({ length: count }, (_, i) => `${1000 + i}:10`);
  const known = new Map<string, string>(); const calls: string[] = [];
  let key = 'account-one', active = 0, peak = 0, failures = false, gate: Promise<void> | null = null;
  const provider = {
    reactionSession: () => { const captured = key; return { key, current: () => key === captured, account: async () => '42', write: async () => { throw new Error('must never mutate remote likes'); } }; },
    likeIds: async () => ({ key, ids }),
    importTrack: async (track: ExternalTrack) => {
      calls.push(track.externalId); active++; peak = Math.max(peak, active);
      try {
        await (gate ?? new Promise<void>((r) => setImmediate(r)));
        if (failures) throw new Error('offline');
        if (!known.has(track.externalId)) known.set(track.externalId, a.services.lib.addRemote({ provider: 'yandex', externalId: track.externalId, title: track.externalId, artist: 'Fixture', duration: 180, meta: {} }).id);
        return known.get(track.externalId)!;
      } finally { active--; }
    },
  };
  const make = () => new YandexLikesImport(a.services.db, a.services.lib, provider, a.services.events);
  const job = make(); cleanup.push(() => job.stop());
  return { a, ids, known, calls, job, make, peak: () => peak, account: (next: string) => { key = next; }, failures: (on: boolean) => { failures = on; }, gate: (next: Promise<void> | null) => { gate = next; } };
}

describe('durable complete Yandex likes import', () => {
  it('imports beyond both old caps with two workers and newest-first favorite order', async () => {
    const f = await fixture(401); f.job.start(); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'done', done: 401, total: 401, failed: 0 });
    expect(f.peak()).toBe(2);
    const liked = f.a.services.lib.listDTO().sort((a, b) => b.likedAt! - a.likedAt!);
    expect(liked.map((t) => t.title)).toEqual(f.ids);
    expect(q(f.a.services.db, 'SELECT COUNT(*) AS n FROM yandex_reaction_sync').get()).toMatchObject({ n: 0 });
  });

  it('finishes active tracks on pause, resumes after a restart and recovers claimed positions', async () => {
    const f = await fixture(); let release!: () => void;
    f.gate(new Promise<void>((r) => { release = r; })); f.job.start();
    await new Promise<void>((r) => setImmediate(r)); f.job.pause(); release(); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'paused', done: 2 });
    const saved = kvGet<any>(f.a.services.db, 'yandex.likes-import', null);
    saved.state = 'running'; kvSet(f.a.services.db, 'yandex.likes-import', saved);
    q(f.a.services.db, "UPDATE yandex_likes_import_items SET state='preparing' WHERE position=2").run();
    const recovered = f.make(); f.gate(null);
    expect(recovered.status()).toMatchObject({ state: 'paused', preparing: 0, done: 2 });
    recovered.resume(); await recovered.settled();
    expect(recovered.status()).toMatchObject({ state: 'done', done: 6 });
    expect(f.calls.filter((id) => id === f.ids[0])).toHaveLength(1);
  });

  it('pauses on repeated failures, then retries only failed and pending positions', async () => {
    const f = await fixture(8); f.failures(true); f.job.start(); await f.job.settled();
    expect(f.job.status()?.state).toBe('paused');
    expect(f.calls.length).toBeLessThan(8);
    f.failures(false); f.job.resume(true); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'done', done: 8, failed: 0 });
  });

  it('does not publish favorites into another account and preserves reactions changed during import', async () => {
    const f = await fixture(2); let release!: () => void;
    f.gate(new Promise<void>((r) => { release = r; })); f.job.start();
    await new Promise<void>((r) => setImmediate(r)); f.account('another'); release(); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'paused', done: 0 });
    expect(() => f.job.resume()).toThrow('аккаунт');
    f.account('account-one'); f.gate(null);
    const id = f.known.get(f.ids[0])!;
    q(f.a.services.db, 'INSERT INTO reactions(track_id,value,updated_at) VALUES (?,-1,?)').run(id, Date.now() + 100);
    f.job.resume(); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'done', done: 1, skipped: 1 });
    expect(f.a.services.lib.listDTO().find((t) => t.id === id)?.reaction).toBe(-1);
  });

  it('allows ending an old account job and starting a fresh snapshot without deleting songs', async () => {
    const f = await fixture(2); let release!: () => void;
    f.gate(new Promise<void>((r) => { release = r; })); f.job.start();
    await new Promise<void>((r) => setImmediate(r)); f.job.pause(); release(); await f.job.settled();
    const first = f.job.status()!.id;
    f.job.cancel(); expect(f.job.status()?.state).toBe('cancelled');
    f.gate(null);
    f.account('another'); f.job.start(); await f.job.settled();
    expect(f.job.status()).toMatchObject({ state: 'done', done: 2 });
    expect(f.job.status()!.id).not.toBe(first);
    expect(f.a.services.lib.all()).toHaveLength(2);
  });
});
