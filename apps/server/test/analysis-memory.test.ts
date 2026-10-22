import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { analyzePcm, ANALYZER_VERSION } from '@automix/core';
import { openDb, q } from '../src/db.ts';
import { AnalysisService } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { Library } from '../src/library.ts';

it('bounds full analyses in memory, retains hot entries and reloads evicted results from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-analysis-lru-'));
  const db = openDb(dir);
  const analysis = analyzePcm(new Float32Array(44100), new Float32Array(44100));
  const put = q(db, "INSERT INTO analysis(content_hash,version,status,data,updated_at) VALUES (?,?,'done',?,?)");
  for (let i = 0; i < 90; i++) put.run(`hash-${i}`, ANALYZER_VERSION, JSON.stringify(analysis), Date.now());
  const service = new AnalysisService(db, loadConfig({ dataDir: dir }), {} as Library, new EventHub());
  try {
    const hot = service.get('hash-0'), cold = service.get('hash-1');
    for (let i = 2; i < 64; i++) service.get(`hash-${i}`);
    expect(service.get('hash-0')).toBe(hot);
    for (let i = 64; i < 90; i++) service.get(`hash-${i}`);
    expect(service.get('hash-0')).toBe(hot);
    const restored = service.get('hash-1');
    expect(restored).not.toBe(cold); expect(restored).toEqual(cold);
  } finally { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
