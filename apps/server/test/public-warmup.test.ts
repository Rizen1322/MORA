import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { YtDlp } from '../src/public/ytdlp.ts';

const root = path.resolve('tools/.cache/public-warmup-tests');
const dirs: string[] = [];
const url = (id = 'abcdefghijk') => `https://www.youtube.com/watch?v=${id}`;
const info = (expire = Math.floor(Date.now() / 1000) + 3600) => ({ id: 'abcdefghijk', title: 'Track', formats: [{ url: `https://r1.googlevideo.com/audio?expire=${expire}` }] });
const runner = () => new YtDlp({ bin: process.execPath, jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null, cacheDir: root, concurrency: 2 });
async function staging() { await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'case-')); dirs.push(dir); return dir; }
async function downloadResult(dir: string) { const file = path.join(dir, 'abcdefghijk.webm'); await fs.writeFile(file, 'audio'); return `${JSON.stringify({ id: 'abcdefghijk' })}\n${file}`; }
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
});

it('keeps four speculative metadata results and expires them after 45 seconds', async () => {
  vi.useFakeTimers(); const yt = runner(); const run = vi.spyOn(yt, 'run').mockResolvedValue(JSON.stringify(info()));
  for (let i = 0; i < 5; i++) await yt.warmMetadata(url(`abcdefghij${i}`));
  expect(run).toHaveBeenCalledTimes(5);
  await yt.warmMetadata(url('abcdefghij4')); expect(run).toHaveBeenCalledTimes(5);
  await yt.warmMetadata(url('abcdefghij0')); expect(run).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(45001);
  await yt.warmMetadata(url('abcdefghij4')); expect(run).toHaveBeenCalledTimes(7);
  expect(run.mock.calls.every(([, opts]) => opts.priority === 3 && opts.timeoutMs === 7000 && opts.maxBytes === 4 << 20)).toBe(true);
});

it('starts at most one speculative resolver even when calls arrive in the same tick', async () => {
  const yt = runner(); const finishes: ((v: string) => void)[] = [];
  const run = vi.spyOn(yt, 'run').mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
  const first = yt.warmMetadata(url()); const second = yt.warmMetadata(url('bcdefghijkl'));
  await Promise.resolve();
  try { expect(run).toHaveBeenCalledTimes(1); }
  finally { for (const finish of finishes) finish(JSON.stringify(info())); }
  await expect(second).resolves.toBe(false); await first;
});

it('aborts the speculative subprocess and accepts a later retry', async () => {
  const yt = runner(), ctl = new AbortController();
  const run = vi.spyOn(yt, 'run').mockImplementation((_, opts) => new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const promise = yt.warmMetadata(url(), ctl.signal); await Promise.resolve();
  const assertion = expect(promise).rejects.toThrow(); ctl.abort(); await assertion;
  await Promise.resolve(); run.mockResolvedValue(JSON.stringify(info()));
  await expect(yt.warmMetadata(url())).resolves.toBe(true);
});

it('does not spend the only playback slot or start a pre-cancelled warmup', async () => {
  const yt = runner(); yt.cfg.concurrency = 1; const run = vi.spyOn(yt, 'run');
  await expect(yt.warmMetadata(url())).resolves.toBe(false);
  const ctl = new AbortController(); ctl.abort();
  await expect(yt.warmMetadata(url(), ctl.signal)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it('reuses metadata through a temporary info-json and keeps the service network target', async () => {
  const yt = runner(), dir = await staging();
  const run = vi.spyOn(yt, 'run').mockResolvedValueOnce(JSON.stringify(info())); await yt.warmMetadata(url());
  run.mockImplementationOnce(async (args, opts) => {
    expect(args).toContain('--load-info-json'); expect(args).not.toContain(url()); expect(opts.networkTarget).toBe(url());
    expect(JSON.parse(await fs.readFile(path.join(dir, '.source-info.json'), 'utf8')).id).toBe('abcdefghijk');
    return downloadResult(dir);
  });
  expect((await yt.download(url(), dir, { priority: 0 })).info.id).toBe('abcdefghijk');
  await expect(fs.stat(path.join(dir, '.source-info.json'))).rejects.toThrow();
});

it('discards a soon-expiring URL before download', async () => {
  const yt = runner(), dir = await staging(); const run = vi.spyOn(yt, 'run').mockResolvedValueOnce(JSON.stringify(info(Math.floor(Date.now() / 1000) + 5)));
  await yt.warmMetadata(url()); run.mockImplementationOnce(async (args) => { expect(args).not.toContain('--load-info-json'); expect(args).toContain(url()); return downloadResult(dir); });
  await yt.download(url(), dir, { priority: 0 });
});

it('retries stale metadata only before any audio has been published', async () => {
  const yt = runner(), dir = await staging(); const run = vi.spyOn(yt, 'run').mockResolvedValueOnce(JSON.stringify(info()));
  await yt.warmMetadata(url()); run.mockRejectedValueOnce(new Error('expired URL'));
  run.mockImplementationOnce(async (args) => { expect(args).not.toContain('--load-info-json'); return downloadResult(dir); });
  await expect(yt.download(url(), dir, { priority: 0 })).resolves.toHaveProperty('file'); expect(run).toHaveBeenCalledTimes(3);
});

it('does not overwrite partial audio or retry after cancellation', async () => {
  for (const cancelled of [false, true]) {
    const yt = runner(), dir = await staging(), ctl = new AbortController();
    const run = vi.spyOn(yt, 'run').mockResolvedValueOnce(JSON.stringify(info())); await yt.warmMetadata(url());
    run.mockImplementationOnce(async () => { if (cancelled) ctl.abort(); else await fs.writeFile(path.join(dir, 'partial.webm'), 'keep'); throw new Error('failed'); });
    await expect(yt.download(url(), dir, { priority: 0, signal: ctl.signal })).rejects.toThrow('failed');
    expect(run).toHaveBeenCalledTimes(2);
    if (!cancelled) expect(await fs.readFile(path.join(dir, 'partial.webm'), 'utf8')).toBe('keep');
  }
});
