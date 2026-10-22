import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, sanitizeSound } from '@automix/core';
import { api, type AppSettings } from '../src/lib/api.ts';
import { useApp, controller } from '../src/store/app.ts';

vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async (original) => ({ ...await original<typeof import('../src/lib/api.ts')>(), api: { saveSettings: vi.fn() } }));
const settings = (): AppSettings => ({ automix: { ...DEFAULT_AUTOMIX_SETTINGS }, wave: { mood: 'any', diversity: 'balanced' }, ui: { showDiagnostics: false }, sound: sanitizeSound(undefined) });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('sound settings persistence', () => {
  it('does not let an earlier settings reply revert live speed and tone changes', async () => {
    vi.useFakeTimers(); const initial = settings(); useApp.setState({ settings: initial });
    const playback = vi.spyOn(controller, 'setPlayback');
    let resolve!: (value: AppSettings) => void;
    vi.mocked(api.saveSettings).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const save = useApp.getState().saveSettings({ ui: { showDiagnostics: true } });
    await Promise.resolve(); await Promise.resolve();
    useApp.getState().setPlayback({ speed: 1.2, semitones: 3 });
    useApp.getState().setTone({ ...initial.sound.tone, enabled: true, reverbMix: .2 });
    resolve({ ...initial, ui: { showDiagnostics: true } }); await save;
    expect(useApp.getState().settings?.sound.playback).toEqual({ speed: 1.2, semitones: 3 });
    expect(useApp.getState().settings?.sound.tone.reverbMix).toBe(.2);
    expect(playback).toHaveBeenLastCalledWith({ speed: 1.2, semitones: 3 });
  });
  it('serializes writes so the server finishes with the newest sound settings', async () => {
    useApp.setState({ settings: settings() });
    let resolve!: (value: AppSettings) => void;
    vi.mocked(api.saveSettings).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockImplementationOnce(async value => value as AppSettings);
    const first = useApp.getState().saveSettings({ ui: { showDiagnostics: true } });
    await Promise.resolve(); await Promise.resolve();
    const latest = { ...useApp.getState().settings!.sound, playback: { speed: .8, semitones: -3 } };
    const second = useApp.getState().saveSettings({ sound: latest });
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    resolve({ ...settings(), ui: { showDiagnostics: true } }); await first; await second;
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
    expect(useApp.getState().settings?.sound.playback).toEqual(latest.playback);
  });
});
