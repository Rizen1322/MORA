import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { YtDlp } from '../src/public/ytdlp.ts';

it('preserves Unicode JSON/file paths and removes progress split across pipe chunks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-runner-'));
  const fixture = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(fixture, `const bytes=Buffer.from('MORAPROG 50.0%\\n'+JSON.stringify({title:'Верить — 世界'})+'\\nC:/Музыка/песня.opus\\n'); for(const b of bytes){process.stdout.write(Buffer.from([b]));await new Promise(r=>setTimeout(r,1));}`);
  const runner = new YtDlp({ bin: process.execPath, jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null, cacheDir: dir, concurrency: 1 });
  // A local protocol fixture replaces only the executable's CLI options.
  (runner as unknown as { baseArgs(): string[] }).baseArgs = () => [fixture];
  const progress = vi.fn();
  try {
    const result = await runner.run([], { priority: 0, timeoutMs: 10000, onProgress: progress });
    expect(result).toBe(`${JSON.stringify({ title: 'Верить — 世界' })}\nC:/Музыка/песня.opus\n`);
    expect(progress).toHaveBeenCalledWith(.5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('reserves a slot for playback and promotes queued or not-yet-queued shared work', async () => {
  const runner = new YtDlp({ bin: null, jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null, cacheDir: '', concurrency: 2 });
  const schedule = (runner as unknown as { schedule(priority: 0 | 3, signal: AbortSignal, work: () => Promise<void>): Promise<void> }).schedule.bind(runner);
  const starts: string[] = [], finish = new Map<string, () => void>();
  const task = (name: string, signal: AbortSignal, priority: 0 | 3 = 3) => schedule(priority, signal, () => {
    starts.push(name); return new Promise<void>(resolve => finish.set(name, resolve));
  });
  const a = new AbortController(), b = new AbortController(), c = new AbortController();
  const first = task('background', a.signal), second = task('shared', b.signal);
  expect(starts).toEqual(['background']);
  runner.prioritize(b.signal, 0);
  expect(starts).toEqual(['background', 'shared']);
  runner.prioritize(c.signal, 0);
  const third = task('early promotion', c.signal);
  finish.get('shared')!(); await second;
  await vi.waitFor(() => expect(starts).toEqual(['background', 'shared', 'early promotion']));
  finish.get('background')!(); finish.get('early promotion')!();
  await Promise.all([first, third]);
});

it('impersonates Chrome only for YouTube and only when the binary supports it', async () => {
  const runner = new YtDlp({ bin: process.execPath, jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null, cacheDir: '', concurrency: 1 });
  const internals = runner as unknown as { baseArgs(target: string, chrome: boolean): string[]; impersonation(): Promise<boolean> };
  const youtube = internals.baseArgs('https://music.youtube.com/watch?v=x', true);
  expect(youtube).toEqual(expect.arrayContaining(['--impersonate', 'chrome']));
  expect(youtube[youtube.indexOf('--socket-timeout') + 1]).toBe('8');
  expect(internals.baseArgs('https://soundcloud.com/a/b', true)).not.toContain('--impersonate');
  expect(internals.baseArgs('https://music.youtube.com/watch?v=x', false)).not.toContain('--impersonate');
  // A binary without curl_cffi targets (here: plain Node) keeps the previous arguments.
  expect(await internals.impersonation()).toBe(false);
});
