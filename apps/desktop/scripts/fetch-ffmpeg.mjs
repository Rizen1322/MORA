// Downloads the pinned LGPL (shared, no GPL parts) FFmpeg build into vendor/ffmpeg.
// Run once: node apps/desktop/scripts/fetch-ffmpeg.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'autobuild-2026-10-20-13-08';
const NAME = 'ffmpeg-n9.0.2-29-g6dfaba896f-win64-lgpl-shared-9.0';
const SHA256 = 'c39750c8dfe849e4389843e5f4af51e8062a6d6a3e8b74c1fd7e469594ef68e2';
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${NAME}.zip`;

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(desktop, 'vendor', 'ffmpeg');
if (fs.existsSync(path.join(target, 'ffmpeg.exe')) && fs.readFileSync(path.join(target, 'VERSION.txt'), 'utf8').trim() === NAME) {
  console.log(`FFmpeg ${NAME} уже загружен`);
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-ffmpeg-'));
try {
  console.log(`Загрузка ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(zip).digest('hex');
  if (got !== SHA256) throw new Error(`SHA-256 не совпал: ${got}`);
  const zipPath = path.join(tmp, 'ffmpeg.zip');
  fs.writeFileSync(zipPath, zip);
  const out = path.join(tmp, 'x');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}'`], { stdio: 'inherit' });
  const bin = path.join(out, NAME, 'bin');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(bin)) if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(f)) fs.copyFileSync(path.join(bin, f), path.join(target, f));
  fs.copyFileSync(path.join(out, NAME, 'LICENSE.txt'), path.join(target, 'LICENSE.txt'));
  fs.writeFileSync(path.join(target, 'VERSION.txt'), `${NAME}\n`);
  fs.writeFileSync(path.join(target, 'SOURCE.txt'), `FFmpeg (LGPL v3: build uses --enable-version3, no GPL components), build ${NAME}\nBinary: ${url}\nSHA-256: ${SHA256}\nSource: https://github.com/FFmpeg/FFmpeg (build scripts: https://github.com/BtbN/FFmpeg-Builds)\n`);
  console.log(`FFmpeg установлен в ${target}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
