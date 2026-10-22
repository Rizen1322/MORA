import { expect, it } from 'vitest';
import { proxyFromPac } from '../src/public-network.mjs';
import { YtDlp } from '../../server/src/public/ytdlp.ts';

it('keeps the first system proxy route and validates its address', () => {
  expect(proxyFromPac('PROXY 127.0.0.1:8080; DIRECT')).toBe('http://127.0.0.1:8080');
  expect(proxyFromPac('SOCKS5 [::1]:1080')).toBe('socks5://[::1]:1080');
  expect(proxyFromPac('DIRECT; PROXY other:8080')).toBe('');
  expect(proxyFromPac('PROXY user:password@host:80')).toBeUndefined();
  expect(proxyFromPac('PROXY localhost:99999')).toBeUndefined();
});

it('passes only the corresponding provider proxy to yt-dlp', () => {
  const runner = new YtDlp({ bin: 'yt-dlp', jsRuntime: null, runtimeIsElectron: false, ffmpegDir: null,
    cacheDir: '.', concurrency: 2, proxies: { youtube: 'http://localhost:8080', soundcloud: '' } });
  const args = (target: string): string[] => (runner as any).baseArgs(target);
  expect(args('ytsearch5:test').slice(-2)).toEqual(['--proxy', 'http://localhost:8080']);
  expect(args('https://soundcloud.com/artist/song').slice(-2)).toEqual(['--proxy', '']);
});
