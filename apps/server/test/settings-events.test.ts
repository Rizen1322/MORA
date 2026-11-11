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

it('merges partial native EQ edits without resetting other tone or playback settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-native-eq-'));
  const app = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false });
  const put = (payload: Record<string, unknown>) => app.app.inject({ method: 'PUT', url: '/api/settings', payload });
  try {
    const initial = (await app.app.inject('/api/settings')).json();
    const sound = { ...initial.sound, tone: { ...initial.sound.tone, enabled: true, balance: .25, mono: true, reverbMix: .2 },
      playback: { speed: .9, semitones: 2 }, presets: [{ name: 'Saved', gains: Array(10).fill(1) }] };
    expect((await put({ sound })).statusCode).toBe(200);
    const off = await put({ sound: { tone: { enabled: false } } });
    expect(off.statusCode).toBe(200);
    expect(off.json().sound).toMatchObject({ ...sound, tone: { ...sound.tone, enabled: false } });
    const gains = Array(10).fill(0); gains[2] = 3.5;
    const eq = await put({ sound: { tone: { gains } } });
    expect(eq.statusCode).toBe(200);
    expect(eq.json().sound).toMatchObject({ ...sound, tone: { ...sound.tone, enabled: false, gains } });
    expect((await app.app.inject('/api/settings')).json().sound.tone.gains).toEqual(gains);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
