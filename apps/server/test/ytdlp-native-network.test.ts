import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { YtDlp } from '../src/public/ytdlp.ts';
import { configureRustNetwork, type NetworkOptions } from '../src/rust-network.ts';

let dir: string;
const download = vi.fn(async (_url: string, file: string, _options?: NetworkOptions) => { await fs.writeFile(file, 'native audio'); return { bytes: 12, status: 200 }; });
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-native-resolver-'));
  download.mockClear(); configureRustNetwork({ fetch, download, close: async () => {} });
});
afterEach(async () => { configureRustNetwork(null); await fs.rm(dir, { recursive: true, force: true }); });
const runner = () => new YtDlp({ bin: 'fixture', jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null, cacheDir: dir, concurrency: 2, proxies: { soundcloud: 'http://127.0.0.1:8888' } });

test('direct playback keeps site resolution in yt-dlp and transfers audio with native headers/proxy', async () => {
  const resolver = runner();
  const metadata = vi.spyOn(resolver, 'run').mockResolvedValue(JSON.stringify({ id: 'fixture', title: 'Трек', ext: 'webm', protocol: 'https', url: 'https://cf-media.sndcdn.com/audio?expire=123', http_headers: { cookie: 'source-cookie', 'user-agent': 'site-client' } }));
  const progress = vi.fn();
  const result = await resolver.download('https://soundcloud.com/artist/track', dir, { priority: 0, preserveContainer: true, onProgress: progress });
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(result.file, 'utf8')).toBe('native audio');
  expect(download).toHaveBeenCalledWith('https://cf-media.sndcdn.com/audio?expire=123', path.join(dir, 'fixture.webm'), expect.objectContaining({ priority: 0, proxy: 'http://127.0.0.1:8888', allowedDomains: ['sndcdn.com', 'soundcloud.com'] }));
  const options = download.mock.calls[0]![2] as unknown as { headers: Headers };
  expect(options.headers.get('cookie')).toBe('source-cookie');
  expect(progress).toHaveBeenCalledWith(1);
});

test('segmented HLS falls back to the existing yt-dlp transfer', async () => {
  const resolver = runner(), file = path.join(dir, 'fixture.aac'); await fs.writeFile(file, 'segments');
  const run = vi.spyOn(resolver, 'run').mockResolvedValueOnce(JSON.stringify({ id: 'fixture', ext: 'aac', protocol: 'm3u8_native', url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8' }))
    .mockResolvedValueOnce(`${JSON.stringify({ id: 'fixture', ext: 'aac' })}\n${file}\n`);
  const result = await resolver.download('https://soundcloud.com/artist/track', dir, { priority: 1, preserveContainer: true });
  expect(run).toHaveBeenCalledTimes(2); expect(download).not.toHaveBeenCalled(); expect(result.file).toBe(file);
});

test('a resolver cannot send native downloads to arbitrary hosts', async () => {
  const resolver = runner(); vi.spyOn(resolver, 'run').mockResolvedValue(JSON.stringify({ id: 'bad', ext: 'mp3', protocol: 'https', url: 'https://localhost/admin' }));
  await expect(resolver.download('https://soundcloud.com/artist/track', dir, { priority: 3, preserveContainer: true })).rejects.toThrow('неподдерживаемый адрес');
  expect(download).not.toHaveBeenCalled();
});

test('a failed direct transfer does not restart bytes already exposed to the growing reader', async () => {
  const resolver = runner(); const run = vi.spyOn(resolver, 'run').mockResolvedValue(JSON.stringify({ id: 'fixture', ext: 'webm', protocol: 'https', url: 'https://cf-media.sndcdn.com/audio' }));
  download.mockRejectedValueOnce(new Error('interrupted'));
  await expect(resolver.download('https://soundcloud.com/artist/track', dir, { priority: 0, preserveContainer: true })).rejects.toThrow('полный аудиофайл');
  expect(run).toHaveBeenCalledTimes(1);
});

test('YouTube preserves the site downloader even when native networking is enabled', async () => {
  const resolver = runner(), file = path.join(dir, 'youtube.webm');
  await fs.writeFile(file, 'original container');
  const run = vi.spyOn(resolver, 'run').mockResolvedValue(JSON.stringify({ id: 'fixture', ext: 'webm' }) + '\n' + file + '\n');
  const abort = new AbortController();
  const result = await resolver.download('https://www.youtube.com/watch?v=abcdefghijk', dir, { priority: 1, preserveContainer: true, signal: abort.signal });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--fixup', 'never', '--no-part']));
  expect(run.mock.calls[0]![0]).not.toContain('--skip-download');
  expect(run.mock.calls[0]![1]).toEqual(expect.objectContaining({ priority: 1, signal: abort.signal }));
  expect(download).not.toHaveBeenCalled();
  expect(result.file).toBe(file);
});
