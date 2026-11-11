import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

it('notifies other clients only after settings are accepted and saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-settings-events-'));
  const app = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false });
  const saved: boolean[] = [];
  const off = app.services.events.on(event => {
    if (event.type === 'settings') {
      const row = app.services.db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string };
      saved.push(JSON.parse(row.value).automix.enabled);
    }
  });
  try {
    expect((await app.app.inject({ method: 'PUT', url: '/api/settings', payload: { automix: { enabled: false } } })).statusCode).toBe(200);
    expect(saved).toEqual([false]);
    expect((await app.app.inject({ method: 'PUT', url: '/api/settings', payload: { wave: { yandexSeeds: ['unsupported'] } } })).statusCode).not.toBe(200);
    expect(saved).toEqual([false]);
  } finally { off(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
