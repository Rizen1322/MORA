// Builds www/ for the iOS app (and the browser dev harness):
//   apps/web (Vite) + mora-bridge.js (page side) + server-worker.js (apps/server in a worker)
//   + analysis-worker.js + sql.js WASM + mobile.css.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = join(here, 'www');
const src = join(here, 'src');
const shim = (n) => join(src, 'worker', 'shims', `${n}.ts`);
// Own node_modules first: the root may hold an older hoisted copy (readable-stream 2.x from electron-builder has no Readable.from).
const mod = (n) => [join(here, 'node_modules', n), join(repo, 'node_modules', n)].find((p) => existsSync(p));
const dev = process.argv.includes('--dev');

// 1. The web app, unchanged.
if (!process.argv.includes('--no-web')) await viteBuild({
  root: join(repo, 'apps/web'),
  configFile: join(repo, 'apps/web/vite.config.ts'),
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true },
});

const common = { define: { __MORA_DEV__: String(dev) }, bundle: true, platform: 'browser', target: ['safari16.4'], legalComments: 'none', logLevel: 'warning', minify: !dev, sourcemap: dev ? 'inline' : false };

// 2. Page side.
await esbuild({ ...common, entryPoints: [join(src, 'bridge/index.ts')], outfile: join(out, 'mora-bridge.js'), format: 'iife' });
// The native producer evaluates this in JavaScriptCore, outside WebContent.
await esbuild({ ...common, platform: 'neutral', entryPoints: [join(src, 'native-mixer.ts')], outfile: join(out, 'native-mixer.js'), format: 'iife', globalName: 'MoraNativeMixer' });

// 3. The server in a worker: Node modules → shims; ffmpeg/yt-dlp classes → in-app replacements.
const nodeAlias = {
  fs: shim('fs'), 'fs/promises': shim('fs-promises'), path: mod('path-browserify'), crypto: shim('crypto'),
  stream: mod('readable-stream'), 'stream/promises': shim('stream-promises'), child_process: shim('child_process'),
  worker_threads: shim('worker_threads'), url: shim('url'), 'timers/promises': shim('timers-promises'),
  string_decoder: mod('string_decoder'), sqlite: shim('sqlite'), os: shim('os'), events: mod('events'), buffer: mod('buffer'),
};
const alias = {
  ...nodeAlias,
  ...Object.fromEntries(Object.entries(nodeAlias).map(([k, v]) => [`node:${k}`, v])),
  fastify: shim('fastify'),
  '@fastify/static': shim('fastify-static'),
  'music-metadata': shim('music-metadata'),
  'mm-core': mod('music-metadata/lib/core.js'),
  'orig-ytdlp': join(repo, 'apps/server/src/public/ytdlp.ts'),
  'orig-soundcloud': join(repo, 'apps/server/src/public/soundcloud.ts'),
  'mora-server/app': join(repo, 'apps/server/src/app.ts'),
  'mora-server/db': join(repo, 'apps/server/src/db.ts'),
};
const serverSrc = join(repo, 'apps/server/src');
// By resolved path: './ffmpeg.ts' from src/ and '../ffmpeg.ts' from src/providers/ are the same module.
const replaced = { [join(serverSrc, 'ffmpeg.ts')]: join(src, 'worker/replace/ffmpeg.ts'), [join(serverSrc, 'public/ytdlp.ts')]: join(src, 'worker/replace/ytdlp.ts') };
const swaps = {
  name: 'mora-ios-swaps',
  setup(b) {
    b.onResolve({ filter: /(ffmpeg|ytdlp)\.ts$/ }, (a) => {
      const to = a.importer.startsWith(serverSrc) && a.path.startsWith('.') ? replaced[resolve(dirname(a.importer), a.path)] : undefined;
      return to ? { path: to } : undefined;
    });
  },
};
const worker = await esbuild({
  ...common,
  entryPoints: [join(src, 'worker/main.ts')],
  outfile: join(out, 'server-worker.js'),
  format: 'iife',
  alias,
  inject: [join(src, 'worker/globals.ts')],
  define: { ...common.define, 'import.meta.url': '"file:///app/server/src/app.ts"', 'process.env.NODE_ENV': '"production"' },
  plugins: [swaps],
  metafile: true,
});
// Node's ffmpeg spawns processes, which fail on iPhone: it must never reach the worker bundle.
const leaked = Object.keys(worker.metafile.inputs).filter((f) => /apps[\/]server[\/]src[\/]ffmpeg\.ts$/.test(f));
if (leaked.length) throw new Error(`server-worker.js содержит Node-версию ffmpeg: ${leaked.join(', ')}`);
await esbuild({ ...common, entryPoints: [join(src, 'worker/analysis-worker.ts')], outfile: join(out, 'analysis-worker.js'), format: 'iife' });

// 4. Static files.
for (const f of ['sql-wasm-browser.wasm', 'sql-wasm.wasm']) copyFileSync(mod(`sql.js/dist/${f}`), join(out, f));
copyFileSync(join(src, 'mobile.css'), join(out, 'mobile.css'));

const htmlFile = join(out, 'index.html');
let html = readFileSync(htmlFile, 'utf8');
html = html
  .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">')
  .replace('</head>', '  <link rel="stylesheet" href="/mobile.css">\n  <script src="/mora-bridge.js"></script>\n</head>');
if (!readFileSync(htmlFile, 'utf8').includes('mora-bridge.js')) writeFileSync(htmlFile, html);
console.log('www/ готово');
