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
// ADTS .aac (HLS packed audio) is a plain frame stream like MP3.
const STREAMABLE = /\.(webm|mp3|opus|ogg|flac|wav|aac)$/i;

/** Reads the writer's existing bytes once, waits for new bytes and ends only after verification. */
export async function growingAudioInput(state: GrowingAudio, signal?: AbortSignal): Promise<string | Readable> {
  while (!state.done) {
    signal?.throwIfAborted();
    const files = await fs.readdir(state.staging).catch(() => []);
    for (const name of files) {
      if (!STREAMABLE.test(name)) continue; // MP4/M4A may need a moov atom at the end: use the complete file.
      const staged = path.join(state.staging, name);
      const stat = await fs.stat(staged).catch(() => null);
      if (!stat || stat.size < 16384 || !stat.isFile()) continue;
      let stream!: Readable;
      stream = Readable.from((async function* () {
        // The file is opened per read, never held: the finished download is moved into the cache
        // (the iPhone's file layer waits for open handles before a move). Once moved, the rest comes
        // from the published file at the same position.
        let position = 0, file = staged, published = false;
        while (!stream.destroyed) {
          if (state.error) throw state.error;
          const handle = await fs.open(file, 'r').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
          if (!handle) {
            if (file !== staged) throw new Error('файл записи пропал');
            while (!state.done) { if (state.error) throw state.error; await wait(); }
            file = await state.result;
            published = true;
            continue;
          }
          let bytesRead = 0;
          const buffer = Buffer.allocUnsafe(256 * 1024);
          try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position)); } finally { await handle.close().catch(() => {}); }
          if (bytesRead) { position += bytesRead; yield buffer.subarray(0, bytesRead); continue; }
          if (state.done) {
            const final = await state.result;
            // Completion can race the EOF read above. Drain the verified file
            // at the same offset before declaring EOF, even if its name stayed.
            if (!published) { file = final; published = true; continue; }
            break;
          }
          await wait();
        }
      })());
      return stream;
    }
    await wait();
  }
  return state.result;
}
