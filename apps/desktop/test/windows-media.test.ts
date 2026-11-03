import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { WindowsMedia } from '../src/windows-media.mjs';

function fixture() {
  const values: any[] = [];
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) { values.push(JSON.parse(String(chunk))); done(); }, final(done) { queueMicrotask(() => proc.emit('exit', 0)); done(); } }),
    kill: vi.fn(() => { queueMicrotask(() => proc.emit('exit', 1)); return true; }) });
  const callbacks = { command: vi.fn(), seek: vi.fn(), available: vi.fn(), state: vi.fn(), artwork: vi.fn(async () => 'cover.png') };
  const host = new WindowsMedia('smtc.exe', callbacks, () => proc);
  host.start(48000);
  return { host, proc, callbacks, values };
}
const tick = (token: string, options = {}) => ({ type: 'tick', main: 0, paused: false,
  decks: [{ token, playing: true, starved: false, position: 48000, totalFrames: 480000, ratio: 1 }], ...options });

it('publishes only the confirmed native deck and translates hardware controls without optimistic state', async () => {
  const { host, proc, callbacks, values } = fixture();
  host.track({ token: 'a', title: 'A', artist: 'Artist', album: 'Album', coverUrl: '/api/covers/a' });
  host.track({ token: 'b', title: 'B' });
  proc.stdout.write('{"type":"ready"}\n');
  expect(values.at(-1).title).toBe('');
  host.audioEvent(tick('a'));
  await Promise.resolve();
  expect(values.at(-1)).toMatchObject({ title: 'A', artist: 'Artist', artwork: 'cover.png', status: 'playing', position: 1, duration: 10 });
  proc.stdout.write('{"type":"command","command":"pause"}\n');
  expect(callbacks.command).toHaveBeenCalledWith('pause');
  expect(values.at(-1).status).toBe('playing');
  proc.stdout.write('{"type":"seek","position":11}\n{"type":"seek","position":4}\n');
  expect(callbacks.seek.mock.calls).toEqual([[4]]);
  host.audioEvent(tick('b', { paused: true }));
  expect(values.at(-1)).toMatchObject({ title: 'B', status: 'paused', artwork: '' });
  host.audioEvent({ type: 'fatal' });
  expect(values.at(-1)).toMatchObject({ title: '', status: 'stopped' });
  await host.stop();
});

it('falls back once on helper failure and ignores stale artwork after stop', async () => {
  const { host, proc, callbacks, values } = fixture();
  let resolve: (value: string) => void = () => {};
  callbacks.artwork.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
  proc.stdout.write('{"type":"ready"}\n');
  host.track({ token: 'a', title: 'A', coverUrl: '/api/covers/a' });
  host.audioEvent(tick('a'));
  proc.emit('error', new Error('failed')); proc.emit('exit', 1);
  expect(callbacks.available.mock.calls).toEqual([[true], [false]]);
  expect(proc.kill).toHaveBeenCalledTimes(1);
  host.reset();
  resolve('late.png'); await Promise.resolve();
  expect(values.at(-1).artwork).toBe('');
  expect(host.process).toBeNull();
});

it('limits timeline updates to five seconds while sending pause and seek changes immediately', async () => {
  vi.useFakeTimers();
  try {
    const { host, proc, values } = fixture();
    proc.stdout.write('{"type":"ready"}\n');
    host.track({ token: 'a', title: 'A' });
    host.audioEvent(tick('a'));
    const count = values.length;
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(100); const event = tick('a'); event.decks[0].position += (i + 1) * 4800; host.audioEvent(event); }
    expect(values).toHaveLength(count);
    host.audioEvent(tick('a', { paused: true }));
    expect(values.at(-1).status).toBe('paused');
    expect(values).toHaveLength(count + 1);
    await host.stop();
  } finally { vi.useRealTimers(); }
});
