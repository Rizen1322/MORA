import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { RustAudio } from '../src/rust-audio.mjs';

function process() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as unknown as Writable, kill: vi.fn() });
  const commands: any[] = [];
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('exit', 1)); return true; });
  child.stdin = new Writable({ write(data, _encoding, done) {
    const command = JSON.parse(data.toString()); commands.push(command);
    queueMicrotask(() => {
      if (command.cmd === 'quit') child.emit('exit', 0);
      else child.stdout.write(JSON.stringify({ type: 'ack', request: command.request }) + '\n');
    });
    done();
  } });
  return { child, commands };
}

it('waits for native readiness, sends bounded PCM, acknowledges commands and shuts down', async () => {
  const { child, commands } = process(), events = vi.fn(), launch = vi.fn(() => child), host = new RustAudio('audio.exe', events, launch);
  const start = host.start();
  await Promise.resolve();
  child.stdout.write('{"type":"ready","sampleRate":48000,"queueFrames":2048}\n');
  expect(await start).toMatchObject({ sampleRate: 48000 });
  const l = Float32Array.of(.1, .2), r = Float32Array.of(.3, .4);
  await host.command({ cmd: 'feed', deck: 0, token: 'a', chunk: 0, L: l, R: r });
  expect(Buffer.from(commands[0].L, 'base64').readFloatLE(0)).toBe(l[0]);
  expect(commands[0].request).toBeGreaterThan(0);
  await expect(host.command({ cmd: 'feed', L: Float32Array.of(NaN), R: r })).rejects.toThrow('PCM');
  await expect(host.command({ cmd: 'quit' })).rejects.toThrow();
  child.stdout.write('{"type":"tick","clock":128}\n');
  expect(events).toHaveBeenCalledWith({ type: 'tick', clock: 128 });
  await host.stop();
  expect(commands.at(-1).cmd).toBe('quit');
  expect(host.pending.size).toBe(0);
  expect(events.mock.calls.some(([e]) => e.type === 'fatal')).toBe(false);
});

it('rejects failed startup and reports a native crash once', async () => {
  const { child } = process(), events = vi.fn(), host = new RustAudio('audio.exe', events, () => child);
  const start = host.start(); await Promise.resolve();
  child.emit('error', new Error('ENOENT'));
  await expect(start).rejects.toThrow('Rust');
  expect(host.process).toBeNull();
  expect(events).not.toHaveBeenCalled();
  const next = process(), second = new RustAudio('audio.exe', events, () => next.child);
  const ready = second.start(); await Promise.resolve();
  next.child.stdout.write('{"type":"ready","sampleRate":44100}\n'); await ready;
  next.child.emit('exit', 1);next.child.emit('error', new Error('duplicate'));
  expect(events).toHaveBeenCalledTimes(1);
  expect(events.mock.calls[0][0].type).toBe('fatal');
});

it('supersedes concurrent starts and cancels startup on stop', async () => {
  const first = process(), second = process();
  const launch = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
  const host = new RustAudio('audio.exe', vi.fn(), launch);
  const old = host.start();
  const rejected = expect(old).rejects.toThrow('отменён');
  const current = host.start();
  await Promise.resolve();
  first.child.stdout.write('{"type":"ready","sampleRate":48000}\n');
  await current; await rejected;
  expect(launch).toHaveBeenCalledTimes(1);
  await host.stop();
  const cancelled = host.start();
  const stopped = expect(cancelled).rejects.toThrow('отменён');
  await Promise.resolve();
  await host.stop();
  await stopped;
  expect(host.process).toBeNull();
});
