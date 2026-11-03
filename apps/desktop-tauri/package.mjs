import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 required');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const identity = fs.statSync(path.join(root, 'package.json'), { bigint: true });
const sameRoot = drive => {
  try { const found = fs.statSync(`${drive}:/package.json`, { bigint: true }); return found.dev === identity.dev && found.ino === identity.ino; }
  catch { return false; }
};
let drive = [...'WXYZVUTSRQPONMLKJIHG'].find(sameRoot);
let owned = false;
try {
  if (!drive) {
    drive = [...'ZYXWVUTSRQPONMLKJIHG'].find(letter => !fs.existsSync(`${letter}:/`));
    if (!drive) throw Error('No free drive letter for the Windows toolchain');
    const mapped = spawnSync('subst.exe', [`${drive}:`, root], { windowsHide: true });
    if (mapped.status !== 0) throw Error('Cannot create isolated ASCII build path');
    owned = true;
    if (!sameRoot(drive)) throw Error('Cannot verify isolated ASCII build path');
  }
  const app = `${drive}:/apps/desktop-tauri`;
  const compiler = `${app}/toolchain/llvm-mingw-20260908-ucrt-x86_64/bin`;
  const toolchain = spawnSync(process.execPath, [`${app}/fetch-toolchain.mjs`], { cwd: app, stdio: 'inherit', windowsHide: true });
  if (toolchain.status !== 0 || !fs.existsSync(`${compiler}/clang.exe`)) throw Error('Unable to prepare LLVM-MinGW toolchain');
  const cargoBin = path.join(os.homedir(), '.cargo/bin');
  const env = { ...process.env, PATH: `${compiler};${cargoBin};${process.env.PATH}`, CARGO_TARGET_DIR: `${app}/src-tauri/target`,
    RUSTFLAGS: process.env.RUSTFLAGS || '-C linker=rust-lld -C link-self-contained=yes' };
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: app, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw Error(`Build failed (${result.status ?? result.error?.message})`);
  };
  run([`${app}/prepare.mjs`]);
  run([`${drive}:/node_modules/@tauri-apps/cli/tauri.js`, 'build', '--bundles', 'nsis', '--no-sign', '--', '--locked']);
} finally {
  if (owned) spawnSync('subst.exe', [`${drive}:`, '/D'], { windowsHide: true });
}
