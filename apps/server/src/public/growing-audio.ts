import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export interface GrowingAudio {
  staging: string;
  done: boolean;
  error: Error | null;
  result: Promise<string>;
}
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
const STREAMABLE = /\.(webm|mp3|opus|ogg|flac|wav)$/i;

/** Reads the writer's existing bytes once, waits for new bytes and ends only after verification. */
export async function growingAudioInput(state: GrowingAudio): Promise<string | Readable> {
  while (!state.done) {
    const files = await fs.readdir(state.staging).catch(() => []);
    for (const name of files) {
      if (!STREAMABLE.test(name)) continue; // MP4/M4A may need a moov atom at the end: use the complete file.
      const file = path.join(state.staging, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size < 16384 || !stat.isFile()) continue;
      const handle = await fs.open(file, 'r').catch(() => null);
      if (!handle) continue;
      let stream!: Readable;
      stream = Readable.from((async function* () {
        let position = 0;
        try {
          while (!stream.destroyed) {
            if (state.error) throw state.error;
            const buffer = Buffer.allocUnsafe(64 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead) { position += bytesRead; yield buffer.subarray(0, bytesRead); continue; }
            if (state.done) { await state.result; break; }
            await wait();
          }
        } finally { await handle.close().catch(() => {}); }
      })());
      stream.once('close', () => { void handle.close().catch(() => {}); });
      return stream;
    }
    await wait();
  }
  return state.result;
}
