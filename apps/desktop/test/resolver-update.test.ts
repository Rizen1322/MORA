import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-expect-error desktop shell modules are plain ESM JavaScript
import { ResolverUpdater } from '../src/resolver-update.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-')); dirs.push(directory);
  let version = '2026.10.20'; let bytes = Buffer.from('MZtest executable'); let corrupt = false; let foreign = false; let healthy = true;
  const calls: string[] = [];
  const updater = new ResolverUpdater({ directory, bundled: 'bundled.exe', probe: async () => healthy ? version : 'wrong', fetcher: async (url: string, options: RequestInit) => {
    calls.push(url);
    const root = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/`;
    if (url.endsWith('/latest')) {
      expect((options.headers as Record<string, string>).Accept).toBe('application/vnd.github+json');
      return new Response(JSON.stringify({ tag_name: version, assets: [
      { name: 'yt-dlp.exe', browser_download_url: foreign ? 'https://untrusted.test/a.exe' : root + 'yt-dlp.exe' },
      { name: 'SHA2-256SUMS', browser_download_url: root + 'SHA2-256SUMS' },
    ] })); }
    if (url.endsWith('SHA2-256SUMS')) return new Response(`${crypto.createHash('sha256').update(bytes).digest('hex')}  yt-dlp.exe\n`);
    return new Response(corrupt ? Buffer.from('MZchanged') : bytes);
  } });
  return { updater, calls, directory, change: (v: string) => { version = v; bytes = Buffer.from(`MZ${v}`); }, corrupt: () => { corrupt = true; }, foreign: () => { foreign = true; }, unhealthy: () => { healthy = false; } };
}

describe('desktop resolver updates', () => {
  it('checks without downloading an executable, installs verified versions and rolls back', async () => {
    const f = fixture();
    expect((await f.updater.check()).latest).toBe('2026.10.20');
    expect(f.calls.some((url) => url.endsWith('.exe'))).toBe(false);
    await f.updater.install();
    const first = f.updater.executable();
    expect(first).toContain('2026.10.20');
    f.change('2026.10.21'); await f.updater.install();
    expect(f.updater.executable()).toContain('2026.10.21');
    f.updater.rollback(); expect(f.updater.executable()).toBe(first);
    f.updater.rollback(); expect(f.updater.executable()).toBe('bundled.exe');
  });

  it('keeps the working version when checksum or startup checks fail', async () => {
    for (const mode of ['corrupt', 'unhealthy'] as const) {
      const f = fixture(); await f.updater.install(); const first = f.updater.executable();
      f.change('2026.10.21'); f[mode]();
      await expect(f.updater.install()).rejects.toThrow();
      expect(f.updater.executable()).toBe(first);
      expect(fs.readdirSync(f.directory).some((name) => name.startsWith('.staging-'))).toBe(false);
    }
  });

  it('rejects foreign asset URLs and falls back if the selected file is damaged', async () => {
    const f = fixture(); f.foreign();
    await expect(f.updater.install()).rejects.toThrow('адрес');
    expect(f.calls).toHaveLength(1);
    const g = fixture(); await g.updater.install();
    fs.writeFileSync(g.updater.executable(), 'broken');
    expect(g.updater.executable()).toBe('bundled.exe');
    expect(g.updater.status().selected).toBe('bundled');
  });

  it('rejects overlapping mutations', async () => {
    const f = fixture(); const pending = f.updater.install();
    await expect(f.updater.install()).rejects.toThrow('уже');
    expect(() => f.updater.rollback()).toThrow('Дождитесь');
    await pending;
  });
});
