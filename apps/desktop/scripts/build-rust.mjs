import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeRustLicenses } from '../../../tools/rust-licenses.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const local = path.join(os.homedir(), '.cargo/bin/cargo.exe');
const cargo = process.env.CARGO || (process.platform === 'win32' && fs.existsSync(local) ? local : 'cargo');
const env = { ...process.env, CARGO_BUILD_JOBS: '1' };
// GNU Rust ships a self-contained linker, so Windows builds need no Visual Studio installation.
const version = spawnSync(cargo, ['-vV'], { encoding: 'utf8', windowsHide: true, env });
if (version.status !== 0) throw new Error('Нужен Rust: установите rustup с https://rust-lang.org/tools/install/');
if (process.platform === 'win32' && version.stdout.includes('host: x86_64-pc-windows-gnu') && !env.RUSTFLAGS) env.RUSTFLAGS = '-C linker=rust-lld -C link-self-contained=yes';
const args = process.argv.includes('--test') ? ['test'] : ['build', '--release'];
for (const [crate, folder, binaries] of [
  ['audio-rust', 'audio', ['mora-audio', ...(process.platform === 'win32' ? ['mora-smtc'] : [])]],
  ['decoder-rust', 'decoder', ['mora-decode']],
  ['network-rust', 'network', ['mora-network']],
]) {
  const manifest = path.join(root, 'packages', crate, 'Cargo.toml');
  const result = spawnSync(cargo, [...args, '--locked', '--manifest-path', manifest], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!process.argv.includes('--test')) {
    const destination = path.join(root, 'apps/desktop/build', folder);
    const data = writeRustLicenses(cargo, manifest, destination, env);
    for (const name of binaries) {
      const file = name + (process.platform === 'win32' ? '.exe' : '');
      fs.copyFileSync(path.join(data.target_directory, 'release', file), path.join(destination, file));
    }
  }
}
