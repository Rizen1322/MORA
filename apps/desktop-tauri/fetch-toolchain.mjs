import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 required');
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(here, 'toolchain');
const archive = path.join(directory, 'llvm-mingw.zip');
const expected = '1bcf74d06b724aeecaa6412ca85f5b26fb1da770e7cdcefa9263c9c5c3ad34b6';
const compiler = path.join(directory, 'llvm-mingw-20260908-ucrt-x86_64/bin/clang.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(directory, { recursive: true });
if (!fs.existsSync(archive) || hash(fs.readFileSync(archive)) !== expected) {
  const response = await fetch('https://github.com/mstorsjo/llvm-mingw/releases/download/20260908/llvm-mingw-20260908-ucrt-x86_64.zip');
  if (!response.ok) throw Error(`LLVM-MinGW download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw Error('LLVM-MinGW archive checksum mismatch');
  fs.writeFileSync(archive, bytes);
}
if (!fs.existsSync(compiler)) {
  const result = spawnSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0 || !fs.existsSync(compiler)) throw Error('LLVM-MinGW extraction failed');
}
console.log(`Verified LLVM-MinGW archive: ${archive}`);
