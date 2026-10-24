import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PublicMusic } from '../src/public/provider.ts';

it('a cancelled decode stops the remote transfer it alone was waiting for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-stream-cancel-'));
  const src = { id: 1, track_id: 'track', provider: 'youtube', external_id: 'aaaaaaaaaaa', kind: 'remote', meta: '{}' };
  let transfer: AbortSignal | undefined;
  const lib = { get: () => ({ id: 'track', content_hash: 'remote:a' }), sources: () => [src] };
  const ytdlp = { download: (_url: string, staging: string, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    transfer = opts.signal;
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'part.wav'), Buffer.alloc(32768));
    transfer.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) };
  const music = new PublicMusic({} as never, lib as never, {} as never, { dataDir: dir } as never, ytdlp as never);
  try {
    const decode = new AbortController();
    const input = await music.playbackInput('track', decode.signal);
    expect(typeof input).not.toBe('string');
    decode.abort();
    await new Promise((r) => setImmediate(r));
    expect(transfer?.aborted).toBe(true);
  } finally { await music.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
