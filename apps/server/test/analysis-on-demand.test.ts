import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { AnalysisService, PRIORITY } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { Library, TrackRow } from '../src/library.ts';

it('without background analysis queues only tracks that are about to play', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-analysis-demand-'));
  const db = openDb(dir);
  const lib = { all: () => [], mixingPolicy: new Map([['yandex', true]]) } as unknown as Library;
  const service = new AnalysisService(db, loadConfig({ dataDir: dir, backgroundAnalysis: false }), lib, new EventHub());
  const track = (id: string) => ({ id, provider: 'yandex', status: 'ok', content_hash: id.repeat(64) }) as unknown as TrackRow;
  const queued = () => (db.prepare('SELECT content_hash FROM analysis').all() as { content_hash: string }[]).map((r) => r.content_hash[0]);
  try {
    service.ensure(track('a'), PRIORITY.imported);
    service.ensure(track('b'), PRIORITY.background);
    expect(queued()).toEqual([]);
    service.ensure(track('c'), PRIORITY.next);
    expect(queued()).toEqual(['c']);
  } finally { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
