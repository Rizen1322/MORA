// Prepares everything the Electron shell needs in apps/desktop/build:
//   web/      production React build (served by the backend on 127.0.0.1)
//   backend/  bundled Fastify backend + analysis worker (run in a utility process)
//   ffmpeg/   pinned LGPL FFmpeg (scripts/fetch-ffmpeg.mjs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const out = path.join(desktop, 'build');
const skipWeb = process.argv.includes('--skip-web');

// fs.cpSync crashes on Cyrillic Windows paths in Node 22, so copy by hand.
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
};
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

fs.mkdirSync(out, { recursive: true });
if (!skipWeb) {
  // Own outDir: apps/web/dist may be served by a running browser-mode server.
  run([path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/web/vite.config.ts', '--outDir', path.join(out, 'web'), '--logLevel', 'warn', 'apps/web']);
}

// CommonJS dependencies (fastify) still call require(); give the ESM bundle one.
const banner = "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);";
fs.rmSync(path.join(out, 'backend'), { recursive: true, force: true });
await build({
  entryPoints: { backend: path.join(desktop, 'src/backend.ts'), analysisWorker: path.join(root, 'apps/server/src/analysisWorker.ts') },
  outdir: path.join(out, 'backend'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  external: ['electron'],
  format: 'esm',
  target: 'node24',
  banner: { js: banner },
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
});

// No vocal separation in the app any more: old tools/ and vocal/ outputs must not reach the installer.
for (const old of ['tools', 'vocal']) fs.rmSync(path.join(out, old), { recursive: true, force: true });

const ffSrc = process.env.AUTOMIX_FFMPEG_DIR || path.join(desktop, 'vendor/ffmpeg');
if (!fs.existsSync(path.join(ffSrc, 'ffmpeg.exe'))) {
  console.error('Нет FFmpeg: выполните node apps/desktop/scripts/fetch-ffmpeg.mjs');
  process.exit(1);
}
fs.rmSync(path.join(out, 'ffmpeg'), { recursive: true, force: true });
copyDir(ffSrc, path.join(out, 'ffmpeg'));
const ytSrc = process.env.AUTOMIX_YTDLP_DIR || path.join(desktop, 'vendor/yt-dlp');
if (!fs.existsSync(path.join(ytSrc, 'yt-dlp.exe'))) {
  console.error('Нет yt-dlp: выполните node apps/desktop/scripts/fetch-ytdlp.mjs');
  process.exit(1);
}
fs.rmSync(path.join(out, 'yt-dlp'), { recursive: true, force: true });
copyDir(ytSrc, path.join(out, 'yt-dlp'));
console.log(`Сборка desktop готова: ${out}`);
