import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import os from 'node:os';
import { writeRustLicenses } from '../../tools/rust-licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const source = path.join(root, 'apps/desktop/build');
const output = path.join(here, 'build');
const node = spawnSync(process.execPath, [path.join(here, 'fetch-node.mjs')], { stdio: 'inherit', windowsHide: true });
if (node.status !== 0) throw Error('Unable to prepare Node runtime');
// Node 22 cannot reliably copy directory trees with non-ASCII Windows paths.
function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (entry.isDirectory()) copy(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}
for (const name of ['web', 'audio', 'decoder', 'network', 'ffmpeg', 'yt-dlp']) {
  if (!fs.existsSync(path.join(source, name))) throw Error(`Missing desktop build resource: ${name}`);
}
fs.rmSync(output, { recursive: true, force: true });
for (const name of ['web', 'audio', 'decoder', 'network', 'ffmpeg', 'yt-dlp']) copy(path.join(source, name), path.join(output, name));
fs.mkdirSync(path.join(output, 'node'), { recursive: true });
const nodeDir = path.join(here, 'toolchain/node-v22.23.4-win-x64');
for (const name of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(nodeDir, name), path.join(output, 'node', name));
fs.mkdirSync(path.join(output, 'backend'), { recursive: true });
fs.copyFileSync(path.join(source, 'backend/analysisWorker.mjs'), path.join(output, 'backend/analysisWorker.mjs'));
const banner = "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);";
await build({ entryPoints: [path.join(here, 'backend.ts')], outfile: path.join(output, 'backend/tauri-backend.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: banner }, legalComments: 'linked' });
await build({ entryPoints: { migrate: path.join(here, 'migrate-wrapper.mjs'), import: path.join(here, 'import.mjs') },
  outdir: path.join(output, 'backend'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node22',
  format: 'esm', banner: { js: banner }, legalComments: 'linked' });
const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo/bin/cargo.exe');
writeRustLicenses(cargo, path.join(here, 'src-tauri/Cargo.toml'), path.join(output, 'shell-licenses'));
fs.copyFileSync(path.join(root, 'apps/desktop/THIRD_PARTY.md'), path.join(output, 'THIRD_PARTY.md'));
console.log(`Tauri resources prepared: ${output}`);
