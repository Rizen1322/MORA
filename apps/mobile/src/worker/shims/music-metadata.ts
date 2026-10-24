/** music-metadata: the browser build reads bytes; the server calls parseFile(path). */
import { parseBuffer } from 'mm-core';
import type { IOptions } from 'mm-core';
import { promises as fsp } from '../opfs-fs.ts';

export async function parseFile(file: string, options?: IOptions) {
  const bytes = await fsp.readFile(file) as Uint8Array;
  return parseBuffer(bytes, { path: file }, options);
}
export * from 'mm-core';
