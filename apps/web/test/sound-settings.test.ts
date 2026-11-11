import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, sanitizeSound } from '@automix/core';
import { api, type AppSettings } from '../src/lib/api.ts';
import { useApp, controller } from '../src/store/app.ts';

vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async (original) => ({ ...await original<typeof import('../src/lib/api.ts')>(), api: { saveSettings: vi.fn(), settings: vi.fn() } }));
const settings = (): AppSettings => ({ automix: { ...DEFAULT_AUTOMIX_SETTINGS }, wave: { mood: 'any', diversity: 'balanced' }, ui: { showDiagnostics: false }, sound: sanitizeSound(undefined) });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('sound settings persistence', () => {
  it('applies native settings changes to playback without writing them back', async () => {
    const initial = settings(); useApp.setState({ settings: initial });
    const updated = { ...initial, automix: { ...initial.automix, enabled: false, mixOnNext: false } };
    vi.mocked(api.settings).mockResolvedValueOnce(updated);
    const changed = vi.spyOn(controller, 'onSettingsChanged');
    const saves = vi.mocked(api.saveSettings).mock.calls.length;
    await useApp.getState().loadSettings();
    expect(useApp.getState().settings?.automix.enabled).toBe(false);
    expect(controller.instantNext).toBe(true);
    expect(changed).toHaveBeenCalledWith(updated.automix.loudnessTarget);
    expect(api.saveSettings).toHaveBeenCalledTimes(saves);
  });
  it('does not let a settings refresh undo a live sound edit', async () => {
    vi.useFakeTimers(); const initial = settings(); useApp.setState({ settings: initial });
    let resolve!: (value: AppSettings) => void;
    vi.mocked(api.settings).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const refresh = useApp.getState().loadSettings();
    await Promise.resolve(); await Promise.resolve();
    useApp.getState().setPlayback({ speed: 1.2, semitones: 3 });
    resolve(initial); await refresh;
    expect(useApp.getState().settings?.sound.playback).toEqual({ speed: 1.2, semitones: 3 });
  });
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
