// Downloads the pinned official yt-dlp Windows build (onedir zip: no per-call
// self-extraction, so each resolve starts faster) into vendor/yt-dlp.
// Run once: node apps/desktop/scripts/fetch-ytdlp.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.08.19';
const SHA256 = '30b4c14aafab6082becff7881e41b76df46dc43ea7633479410a91e29da492bf';
const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_win.zip`;

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(desktop, 'vendor', 'yt-dlp');
const stamp = path.join(target, 'VERSION.txt');
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
  console.log(`yt-dlp ${VERSION} уже загружен`);
  process.exit(0);
}
// Staging next to the target keeps the final rename on one volume (atomic publish).
fs.mkdirSync(path.dirname(target), { recursive: true });
const tmp = fs.mkdtempSync(path.join(path.dirname(target), '.ytdlp-'));
try {
  console.log(`Загрузка ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(zip).digest('hex');
  if (got !== SHA256) throw new Error(`SHA-256 не совпал: ${got}`);
  const zipPath = path.join(tmp, 'yt-dlp.zip');
  fs.writeFileSync(zipPath, zip);
  const out = path.join(tmp, 'x');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}'`], { stdio: 'inherit' });
  const exe = fs.readdirSync(out, { recursive: true }).map(String).find((f) => /(^|[\/])yt-dlp\.exe$/i.test(f));
  if (!exe) throw new Error('yt-dlp.exe не найден в архиве');
  const root = path.join(out, path.dirname(exe));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(root, target);
  fs.writeFileSync(stamp, `${VERSION}\n`);
  fs.writeFileSync(path.join(target, 'SOURCE.txt'), `yt-dlp ${VERSION} (Unlicense; bundled components: see THIRD_PARTY_LICENSES.txt at https://github.com/yt-dlp/yt-dlp/blob/${VERSION}/THIRD_PARTY_LICENSES.txt)\nBinary: ${url}\nSHA-256: ${SHA256}\n`);
  console.log(`yt-dlp установлен в ${target}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
