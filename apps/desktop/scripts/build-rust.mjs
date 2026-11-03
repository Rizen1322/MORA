import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const local = path.join(os.homedir(), '.cargo/bin/cargo.exe');
const cargo = process.env.CARGO || (process.platform === 'win32' && fs.existsSync(local) ? local : 'cargo');
const env = { ...process.env };
// GNU Rust ships a self-contained linker, so Windows builds need no Visual Studio installation.
const version = spawnSync(cargo, ['-vV'], { encoding: 'utf8', windowsHide: true, env });
if (version.status !== 0) throw new Error('Нужен Rust: установите rustup с https://rust-lang.org/tools/install/');
if (process.platform === 'win32' && version.stdout.includes('host: x86_64-pc-windows-gnu') && !env.RUSTFLAGS) env.RUSTFLAGS = '-C linker=rust-lld -C link-self-contained=yes';
const args = process.argv.includes('--test') ? ['test'] : ['build', '--release'];
const result = spawnSync(cargo, [...args, '--locked', '--manifest-path', path.join(root, 'packages/audio-rust/Cargo.toml')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!process.argv.includes('--test')) {
  const names = process.platform === 'win32' ? ['mora-audio.exe', 'mora-smtc.exe'] : ['mora-audio'];
  const destination = path.join(root, 'apps/desktop/build/audio');
  fs.mkdirSync(destination, { recursive: true });
  const metadata = spawnSync(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', version.stdout.match(/host: (\S+)/)?.[1] ?? 'x86_64-pc-windows-msvc', '--manifest-path', path.join(root, 'packages/audio-rust/Cargo.toml')], { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (metadata.status !== 0) throw new Error('Не удалось собрать лицензии Rust-зависимостей');
  const data = JSON.parse(metadata.stdout), included = new Set(data.resolve.nodes.map(n => n.id));
  for (const name of names) fs.copyFileSync(path.join(data.target_directory, 'release', name), path.join(destination, name));
  const notices = ['MORA Rust audio engine — third-party licenses\n'];
  for (const pkg of data.packages.filter(p => p.source && included.has(p.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = path.dirname(pkg.manifest_path);
    notices.push(`\n${pkg.name} ${pkg.version} (${pkg.license ?? 'see license text'})\n${pkg.repository ?? ''}\n`);
    const files = fs.readdirSync(folder).filter(f => /^(LICENSE|COPYING)([._-]|$)/i.test(f) && fs.statSync(path.join(folder, f)).isFile());
    if (!files.length) {
      const supplied = path.join(root, 'packages/audio-rust/licenses', `${pkg.name}-${pkg.version}-MIT.txt`);
      if (!fs.existsSync(supplied)) throw new Error(`Нет текста лицензии ${pkg.name}`);
      notices.push(fs.readFileSync(supplied, 'utf8'));
    }
    for (const file of files) notices.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(folder, file), 'utf8')}`);
  }
  fs.writeFileSync(path.join(destination, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
  const rustc = process.env.RUSTC || path.join(path.dirname(cargo), process.platform === 'win32' ? 'rustc.exe' : 'rustc');
  const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { env, encoding: 'utf8', windowsHide: true });
  if (sysroot.status !== 0) throw new Error('Не удалось найти лицензии стандартной библиотеки Rust');
  const docs = path.join(sysroot.stdout.trim(), 'share/doc/rust');
  fs.copyFileSync(path.join(docs, 'COPYRIGHT-library.html'), path.join(destination, 'RUST-LIBRARY-COPYRIGHT.html'));
  const licenses = path.join(destination, 'rust-licenses');
  fs.mkdirSync(licenses, { recursive: true });
  for (const file of fs.readdirSync(path.join(docs, 'licenses'))) fs.copyFileSync(path.join(docs, 'licenses', file), path.join(licenses, file));
}
