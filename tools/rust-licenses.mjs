import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Include target dependencies, local patches and the Rust standard library. */
export function writeRustLicenses(cargo, manifest, destination, env = process.env) {
  const version = spawnSync(cargo, ['-vV'], { encoding: 'utf8', windowsHide: true, env });
  if (version.status !== 0) throw Error('Rust toolchain unavailable');
  const target = version.stdout.match(/host: (\S+)/)?.[1];
  if (!target) throw Error('Rust host target unavailable');
  const metadata = spawnSync(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', target, '--manifest-path', manifest],
    { env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (metadata.status !== 0) throw Error('Не удалось собрать лицензии Rust-зависимостей');
  const data = JSON.parse(metadata.stdout), included = new Set(data.resolve.nodes.map(n => n.id));
  const notices = ['MORA — Rust third-party licenses\n'];
  for (const pkg of data.packages.filter(p => p.id !== data.resolve.root && included.has(p.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = path.dirname(pkg.manifest_path);
    notices.push(`\n${pkg.name} ${pkg.version} (${pkg.license ?? 'see license text'})\n${pkg.repository ?? ''}\n`);
    const files = fs.readdirSync(folder).filter(f => /^(LICENSE|COPYING)([._-]|$)/i.test(f) && fs.statSync(path.join(folder, f)).isFile());
    if (!files.length) {
      const supplied = ['.txt', '-MIT.txt'].map(suffix => path.join(path.dirname(manifest), 'licenses', `${pkg.name}-${pkg.version}${suffix}`)).find(file => fs.existsSync(file));
      if (!supplied) throw Error(`Нет текста лицензии ${pkg.name} ${pkg.version}`);
      notices.push(fs.readFileSync(supplied, 'utf8'));
    }
    for (const file of files) notices.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(folder, file), 'utf8')}`);
    if (pkg.name === 'opusic-sys') notices.push(`\n--- libopus COPYING ---\n${fs.readFileSync(path.join(folder, 'opus/COPYING'), 'utf8')}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
  const rustc = env.RUSTC || path.join(path.dirname(cargo), process.platform === 'win32' ? 'rustc.exe' : 'rustc');
  const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { env, encoding: 'utf8', windowsHide: true });
  if (sysroot.status !== 0) throw Error('Не удалось найти лицензии стандартной библиотеки Rust');
  const docs = path.join(sysroot.stdout.trim(), 'share/doc/rust');
  fs.copyFileSync(path.join(docs, 'COPYRIGHT-library.html'), path.join(destination, 'RUST-LIBRARY-COPYRIGHT.html'));
  const licenses = path.join(destination, 'rust-licenses');
  fs.mkdirSync(licenses, { recursive: true });
  for (const file of fs.readdirSync(path.join(docs, 'licenses'))) fs.copyFileSync(path.join(docs, 'licenses', file), path.join(licenses, file));
  return data;
}
