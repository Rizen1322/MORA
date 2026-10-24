import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisService, PRIORITY } from '../src/analysis.ts';
import { getSettings } from '../src/automix.ts';
import { openDb } from '../src/db.ts';
import { EventHub } from '../src/events.ts';
import type { Library } from '../src/library.ts';

/** Real AnalysisService and SQLite; only the workers and the media fetch are stand-ins (as in analysis-lifecycle). */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-analysis-idle-'));
  const db = openDb(dir);
  const tracks = new Map(['lib1', 'lib2', 'imported', 'next'].map((id) => [id, { id, content_hash: `h-${id}`, provider: 'local', status: 'ok', duration: 10 }]));
  const resolving = new Set<string>();
  const lib = {
    get: (id: string) => tracks.get(id), mixingPolicy: new Map([['local', true]]),
    resolveMediaPath: (id: string) => { resolving.add(id); return new Promise<string>(() => {}); },
  } as unknown as Library;
  const service = new AnalysisService(db, {} as never, lib, new EventHub());
  const workers = [0, 1, 2, 3].map(() => ({ w: { postMessage: vi.fn(), terminate: vi.fn(async () => 0) }, busy: false, cancel: new Int32Array(1) }));
  (service as unknown as { pool: typeof workers }).pool = workers;
  const ensure = (id: string, priority: number) => service.ensure(tracks.get(id) as never, priority);
  return { db, service, resolving, ensure, clean: async () => { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

afterEach(() => { vi.unstubAllEnvs(); });

it('pauses library-wide analysis while the computer is in use or on battery, never the next track', async () => {
  const f = fixture();
  try {
    f.service.setPower({ onlyWhenIdle: true });
    // no power signal yet: the computer counts as in use
    f.ensure('lib1', PRIORITY.background);
    f.ensure('imported', PRIORITY.imported);
    expect(f.resolving.size).toBe(0);
    f.ensure('next', PRIORITY.next);
    expect([...f.resolving]).toEqual(['next']);
    // idle, but on battery: still paused
    f.service.setPower({ idle: true, onBattery: true });
    expect(f.service.backgroundAllowed()).toBe(false);
    expect([...f.resolving]).toEqual(['next']);
    // idle on mains power: the queued work resumes, imported tracks first
    f.service.setPower({ onBattery: false });
    expect([...f.resolving]).toEqual(['next', 'imported', 'lib1']);
    // the user is back: further library work waits again (the running job finishes)
    f.service.setPower({ idle: false });
    f.ensure('lib2', PRIORITY.background);
    expect([...f.resolving]).toEqual(['next', 'imported', 'lib1']);
  } finally { await f.clean(); }
});

it('runs as before when the setting is off, whatever the power state', async () => {
  const f = fixture();
  try {
    f.service.setPower({ onlyWhenIdle: false, idle: false, onBattery: true });
    f.ensure('lib1', PRIORITY.background);
    expect([...f.resolving]).toEqual(['lib1']);
  } finally { await f.clean(); }
});

it('enables the idle-only mode by default only in the desktop app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-analysis-idle-'));
  const db = openDb(dir);
  try {
    vi.stubEnv('AUTOMIX_DESKTOP', '');
    expect(getSettings(db).analysis.onlyWhenIdle).toBe(false);
    vi.stubEnv('AUTOMIX_DESKTOP', '1');
    expect(getSettings(db).analysis.onlyWhenIdle).toBe(true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
