import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getSettings } from '../src/automix.ts';
import { openDb, kvSet } from '../src/db.ts';

it('defaults to full only in desktop and preserves an explicit user preference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-motion-'));
  const db = openDb(dir);
  try {
    vi.stubEnv('AUTOMIX_DESKTOP', '');
    expect(getSettings(db).ui.motion).toBe('system');
    vi.stubEnv('AUTOMIX_DESKTOP', '1');
    expect(getSettings(db).ui.motion).toBe('full');
    kvSet(db, 'settings', { ui: { motion: 'reduced' } });
    expect(getSettings(db).ui.motion).toBe('reduced');
    kvSet(db, 'settings', { ui: { motion: 'system' } });
    expect(getSettings(db).ui.motion).toBe('system');
  } finally { vi.unstubAllEnvs(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
