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
