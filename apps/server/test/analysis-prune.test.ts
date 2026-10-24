import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ANALYZER_VERSION } from '@automix/core';
import { openDb } from '../src/db.ts';
import { AnalysisService } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { Library } from '../src/library.ts';

it('keeps the current and the newest other finished analysis per track, and drops older versions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-analysis-prune-'));
  const db = openDb(dir);
  const put = db.prepare("INSERT INTO analysis(content_hash, version, status, data, updated_at) VALUES (?, ?, ?, ?, ?)");
  const big = 'x'.repeat(200_000);
  for (const [hash, version, status, at] of [
    ['h1', 'old-a', 'done', 1], ['h1', 'old-b', 'done', 2], ['h1', 'old-c', 'error', 3], ['h1', ANALYZER_VERSION, 'done', 4],
    ['h2', 'old-a', 'done', 1], ['h2', 'old-b', 'done', 2],
  ] as const) put.run(hash, version, status, big, at);
  const lib = { all: () => [], mixingPolicy: new Map() } as unknown as Library;
  const service = new AnalysisService(db, loadConfig({ dataDir: dir }), lib, new EventHub());
  try {
    service.start();
    const rows = db.prepare('SELECT content_hash, version FROM analysis ORDER BY content_hash, version').all() as { content_hash: string; version: string }[];
    expect(rows.map(r => `${r.content_hash}:${r.version}`)).toEqual(['h1:' + ANALYZER_VERSION, 'h1:old-b', 'h2:old-b'].sort());
    // the one-time cleanup returned the space
    expect((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBe(0);
  } finally { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
