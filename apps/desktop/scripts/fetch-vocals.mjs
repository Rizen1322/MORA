// Build-time only: isolated embeddable Python + CPU wheels + the official model.
// No system packages are installed, no pip/download is needed on the user's PC.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vendor = path.join(root, 'apps/desktop/vendor');
const destination = path.join(vendor, 'vocal');
const staging = path.join(vendor, 'vocal-staging');
const python = process.argv[process.argv.indexOf('--python') + 1];
if (!process.argv.includes('--python') || !python) throw new Error('Pass --python <build Python 3.12 executable>');
const run = (exe, args, env = process.env) => {
  const result = spawnSync(exe, args, { cwd: root, windowsHide: true, stdio: 'inherit', env });
  if (result.status !== 0) throw result.error || new Error(`Build tool exited ${result.status}`);
};
run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3,12), "Build with Python 3.12"']);
const digest = async (file, algorithm = 'sha256') => {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
if (fs.existsSync(path.join(destination, 'pack.json'))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'pack.json'), 'utf8'));
  if (manifest.version !== 'mora-vocal-cpu-1') throw new Error('Unknown existing pack');
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (await digest(path.join(destination, file)) !== expected) throw new Error(`Pack integrity mismatch: ${file}`);
  }
  console.log('Vocal pack already verified'); process.exit(0);
}
if (path.dirname(staging) !== vendor || path.basename(staging) !== 'vocal-staging') throw new Error('Unsafe staging path');
fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
const cache = path.join(root, 'tools/.cache'); fs.mkdirSync(cache, { recursive: true });
async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
  const temporary = `${file}.part`;
  try { await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary)); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
const archive = path.join(cache, 'python-3.12.10-embed-amd64.zip');
if (!fs.existsSync(archive)) await download('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', archive);
// Published on the official release page; SHA-256 is additionally recorded below.
if (await digest(archive) !== '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
  || await digest(archive, 'md5') !== 'fe8ef205f2e9c3ba44d0cf9954e1abd3') throw new Error('Python archive mismatch');
run(python, ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, staging]);
fs.writeFileSync(path.join(staging, 'python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
const site = path.join(staging, 'Lib/site-packages');
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--target', site,
  '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.7.1+cpu', 'torchaudio==2.7.1+cpu', 'numpy==2.2.6',
  'filelock==3.32.3', 'typing-extensions==4.16.0', 'sympy==1.14.0', 'networkx==3.6.1', 'jinja2==3.1.6',
  'fsspec==2026.7.0', 'setuptools==78.1.0', 'mpmath==1.3.0', 'MarkupSafe==3.0.3']);
const modelRelative = 'models/hub/torchaudio/models/hdemucs_high_trained.pt';
const model = path.join(staging, modelRelative); fs.mkdirSync(path.dirname(model), { recursive: true });
// Always fetch the release model from its official origin, not an arbitrary user checkpoint.
await download('https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt', model);
if (await digest(model) !== 'a004b2790d73ffeaa535db458a1a79b539dfdbafbccc31f275d07e632ebd7816') throw new Error('Model checksum mismatch');
const cleanEnv = { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  TORCH_HOME: path.join(staging, 'models'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
delete cleanEnv.PYTHONPATH; delete cleanEnv.PYTHONHOME;
run(path.join(staging, 'python.exe'), ['-c',
  'import torch,torchaudio,numpy,json; assert not torch.cuda.is_available(); m=torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model(); print(json.dumps({"torch":torch.__version__,"audio":torchaudio.__version__,"sources":m.sources}))'], cleanEnv);
const manifest = { version: 'mora-vocal-cpu-1', python: '3.12.10', torch: '2.7.1+cpu', torchaudio: '2.7.1+cpu',
  model: 'HDEMUCS_HIGH_MUSDB_PLUS', archiveSha256: await digest(archive), files: {} };
for (const file of ['python.exe', 'python312.dll', modelRelative]) manifest.files[file] = await digest(path.join(staging, file));
fs.writeFileSync(path.join(staging, 'pack.json'), JSON.stringify(manifest, null, 2));
// Wheel metadata contains license texts; keep it with the runtime.
fs.renameSync(staging, destination);
console.log(`Vocal pack ready: ${destination}`);
