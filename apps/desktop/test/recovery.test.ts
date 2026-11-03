import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PlaybackRecovery, recoverySnapshot, soundSettings, audioPreferences, audioOutputSettings } from '../src/recovery.mjs';

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function profile() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-recovery-')); folders.push(folder);
  return path.join(folder, 'playback-recovery.json');
}
const snapshot = () => ({ queue: [{ trackId: 'a', entryId: 'first' }, { trackId: 'b', entryId: 'second' }],
  index: 1, position: 42.5, settings: { volume: .6, playback: { speed: 1.1, semitones: -2 } }, device: 'Speakers',
  loop: [{ trackId: 'a', entryId: 'first' }], context: { type: 'playlist', id: 'saved', label: 'Моя музыка' },
  station: { kind: 'yandex', yandexSessionId: 'session', seed: { title: 'Song', artist: '' } } });

it('offers the last complete queue, native position, loop and station after an unclean exit', () => {
  const file = profile(), recovery = new PlaybackRecovery(file);
  expect(recovery.begin()).toBeNull();
  recovery.checkpoint(snapshot());
  expect(new PlaybackRecovery(file).begin()).toEqual(snapshot());
  // Dismissing the offer must not repeat it if this launch later crashes while idle.
  recovery.checkpoint(null);
  expect(new PlaybackRecovery(file).begin()).toBeNull();
});

it('does not offer playback after a graceful shutdown', () => {
  const file = profile(), recovery = new PlaybackRecovery(file);
  recovery.begin(); recovery.checkpoint(snapshot()); recovery.clean();
  expect(new PlaybackRecovery(file).begin()).toBeNull();
});

it('leaves the previous atomic checkpoint intact when publication fails', () => {
  const file = profile(), recovery = new PlaybackRecovery(file);
  recovery.begin(); recovery.checkpoint(snapshot());
  const before = fs.readFileSync(file, 'utf8');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('disk failure'); });
  expect(() => recovery.checkpoint({ ...snapshot(), position: 50 })).toThrow('disk failure');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.readdirSync(path.dirname(file))).toEqual(['playback-recovery.json']);
  expect(new PlaybackRecovery(file).begin()?.position).toBe(42.5);
});

it('ignores damaged files and validates positions, queue bounds and sound settings', () => {
  const file = profile(); fs.writeFileSync(file, '{');
  expect(new PlaybackRecovery(file).begin()).toBeNull();
  for (const bad of [{ index: -1 }, { position: NaN }, { queue: [{ trackId: '../file' }] }, { loop: new Array(10001).fill(snapshot().queue[0]) }])
    expect(recoverySnapshot({ ...snapshot(), ...bad })).toBeNull();
  expect(soundSettings({ volume: Infinity, preDb: -100, playback: { speed: 2, semitones: 0 }, tone: { gains: [] }, path: 'private.pcm' })).toEqual({});
  expect(recoverySnapshot({ ...snapshot(), accessToken: 'secret', queue: [{ ...snapshot().queue[0], path: 'private.pcm' }], index: 0 }))
    .toEqual({ ...snapshot(), queue: [snapshot().queue[0]], index: 0 });
});

it('retains the complete validated sound panel without native-only fields', () => {
  const tone = { enabled: true, gains: [1, 2, 3, 4, 5, 6, -1, -2, -3, 0], preampDb: -2, autoHeadroom: true, balance: -.3, mono: true, reverbMix: .2 };
  const values = { tone, preDb: -8, volume: .7, playback: { speed: .9, semitones: 3 } };
  expect(soundSettings({ ...values, gainDb: 12, sampleRate: 48000, position: 15 })).toEqual(values);
});

it('preserves playlist and Yandex attribution on both queue and repeated entries', () => {
  const entry = { trackId: 'a', entryId: 'first', origin: 'yandex', sourcePlaylistId: 'playlist', playlistEntryId: 12,
    yandexId: 'recording', yandexSessionId: 'session', yandexBatchId: null,
    transitionContext: { playlistId: 'playlist', fromItemId: 11, toItemId: 12 }, fromEntryId: 'previous' };
  const raw = { ...snapshot(), queue: [entry], index: 0, loop: [entry] };
  expect(recoverySnapshot(raw)).toEqual(raw);
  const bad = { ...entry, origin: 'other', sourcePlaylistId: '../file'.repeat(1000), playlistEntryId: -1,
    yandexId: {}, yandexSessionId: 'x'.repeat(4097), yandexBatchId: 42 };
  expect(recoverySnapshot({ ...raw, queue: [bad] })?.queue[0]).toEqual({ trackId: entry.trackId, entryId: entry.entryId,
    transitionContext: entry.transitionContext, fromEntryId: entry.fromEntryId });
});

it('keeps the previous readable checkpoint when unusually large attribution exceeds the file bound', () => {
  const file = profile(), recovery = new PlaybackRecovery(file);
  recovery.begin(); recovery.checkpoint(snapshot());
  const queue = Array.from({ length: 9000 }, (_, i) => ({ trackId: `t${i}`, entryId: `e${i}`, yandexSessionId: 'я'.repeat(4096) }));
  expect(() => recovery.checkpoint({ ...snapshot(), queue, index: 0 })).toThrow('32 МБ');
  expect(() => recovery.checkpoint({ ...snapshot(), position: NaN })).toThrow('Некорректная');
  expect(new PlaybackRecovery(file).begin()).toEqual(snapshot());
});

it('persists the listener slider separately from mute and transient fade volume', () => {
  const preferences = audioPreferences({ volume: .14, userVolume: .7, muted: false });
  expect(preferences).toEqual({ volume: .7, muted: false });
  expect(audioOutputSettings(preferences)).toEqual({ volume: .7, userVolume: .7, muted: false });
  const muted = audioPreferences({ volume: 0, userVolume: .7, muted: true });
  expect(muted).toEqual({ volume: .7, muted: true });
  expect(audioOutputSettings(muted)).toEqual({ volume: 0, userVolume: .7, muted: true });
  expect(soundSettings({ volume: .14, userVolume: .7, muted: false })).toEqual({ volume: .14, userVolume: .7, muted: false });
  expect(audioPreferences({ volume: .4, userVolume: NaN, muted: 'true' })).toEqual({ volume: .4 });
});
