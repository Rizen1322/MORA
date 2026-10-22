import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { analyzePcm, type TrackAnalysis } from '@automix/core';
import { AutoMixService } from '../src/automix.ts';
import { openDb } from '../src/db.ts';
import type { Library, TrackRow } from '../src/library.ts';
import type { AnalysisService } from '../src/analysis.ts';

describe('transition cache with upgraded vocal features', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-feature-cache-'));
  const db = openDb(dir);
  afterAll(() => {
    db.close();
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-feature-cache-')) throw new Error('unexpected cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  it('replans when activity features change with the same separation model and audio', () => {
    const analysis = analyzePcm(new Float32Array(44100), new Float32Array(44100));
    let features: TrackAnalysis['vocalActivity'] = { source: 'demucs', model: 'HDEMUCS_HIGH_MUSDB_PLUS', rate: 10, values: Array(10).fill(0) };
    const library = { get: (id: string) => ({ id, duration: 1, content_hash: id, provider: 'local', album: '', artist: '', album_artist: '', track_no: null, disc_no: null } as TrackRow), mixingPolicy: new Map([['local', true]]) } as unknown as Library;
    const service = new AutoMixService(db, library, { get: () => ({ ...analysis, vocalActivity: features }), prioritize: vi.fn() } as unknown as AnalysisService);
    expect(service.plan('a', 'b').cached).toBe(false);
    expect(service.plan('a', 'b').cached).toBe(true);
    features = { ...features, vocalRmsDb: Array(10).fill(-60) };
    expect(service.plan('a', 'b').cached).toBe(false);
    expect(service.plan('a', 'b').cached).toBe(true);
    features = { ...features, version: 'vocal-activity-2', vocalRmsDb: Array(10).fill(-90), accompanimentRmsDb: Array(10).fill(-90), phrases: [] };
    expect(service.plan('a', 'b').cached).toBe(false);
    expect(service.plan('a', 'b').cached).toBe(true);
  });
});
