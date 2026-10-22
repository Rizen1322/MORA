import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/**
 * Optional NVIDIA runtime for the bundled vocal model: CUDA torch/torchaudio wheels downloaded
 * only after the user confirms, placed next to (not into) the read-only bundled CPU pack.
 * Measured in docs/cuda-runtime-2026-10-22.md: same vocals as CPU with shifts=1, 2.8-3.9x faster.
 */
const VERSION = 'mora-vocal-cuda118-1';
const WHEELS = [
  { file: 'torch-2.7.1+cu118-cp312-cp312-win_amd64.whl', bytes: 2817174610, sha256: '80855ec840b7b06372ff43535d01393a8ec101842618d1f9ed629572b52aed71' },
  { file: 'torchaudio-2.7.1+cu118-cp312-cp312-win_amd64.whl', bytes: 4089965, sha256: 'e214b04cd40be5e733f5915879f8cbe2de889661ca179fd86998bbadf3740f44' },
];
export const CUDA_DOWNLOAD_BYTES = WHEELS.reduce((sum, w) => sum + w.bytes, 0);
/** Extracted torch+torchaudio cu118 plus the copied embeddable Python. */
export const CUDA_DISK_BYTES = 5_500_000_000;

export type GpuInfo = { name: string; vramMiB: number; driver: string };
export type CudaStatus = {
  gpu: GpuInfo | null | undefined; status: 'absent' | 'downloading' | 'installing' | 'ready' | 'error';
  progress?: number; error?: string; fallback?: string; downloadBytes: number; diskBytes: number;
};

export class VocalCuda {
  private gpu: GpuInfo | null | undefined;
  private state: Pick<CudaStatus, 'status' | 'progress' | 'error'> = { status: 'absent' };
  /** Set when the runtime cannot start; the bundled CPU Python serves the rest of the session. */
  private broken: string | null = null;

  constructor(private dir: string, private bundledPython: string, private models: string) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')).version === VERSION
        && fs.existsSync(path.join(dir, 'python.exe'))) {
        this.writePth(); // the bundled pack moves when MORA is reinstalled elsewhere
        this.state = { status: 'ready' };
      }
    } catch { /* not installed */ }
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        const [name, vram, driver] = error ? [] : String(stdout).split(/\r?\n/)[0].split(',').map(s => s.trim());
        this.gpu = name && Number(vram) > 0 ? { name, vramMiB: Number(vram), driver } : null;
      });
  }

  /** Python to run separation with, or null for the bundled CPU runtime. */
  python(): string | null {
    return this.state.status === 'ready' && !this.broken ? path.join(this.dir, 'python.exe') : null;
  }

  markBroken(reason: string): void { this.broken = reason.slice(0, 300); }

  status(): CudaStatus {
    return { gpu: this.gpu, ...this.state, ...(this.broken ? { fallback: this.broken } : {}),
      downloadBytes: CUDA_DOWNLOAD_BYTES, diskBytes: CUDA_DISK_BYTES };
  }

  /** Download, verify and self-test. Resolves when finished; failures are kept in status(). */
  async install(): Promise<void> {
    if (this.state.status === 'downloading' || this.state.status === 'installing' || this.state.status === 'ready') return;
    try {
      this.state = { status: 'downloading', progress: 0 };
      await fsp.rm(this.dir, { recursive: true, force: true });
      const download = path.join(this.dir, 'download');
      await fsp.mkdir(download, { recursive: true });
      let done = 0;
      for (const wheel of WHEELS) {
        const file = path.join(download, wheel.file);
        const response = await fetch(`https://download.pytorch.org/whl/cu118/${encodeURIComponent(wheel.file)}`);
        if (!response.ok || !response.body) throw new Error(`Загрузка ${wheel.file}: HTTP ${response.status}`);
        const hash = crypto.createHash('sha256');
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({
          transform: (chunk: Buffer, _enc, next) => {
            hash.update(chunk); done += chunk.length;
            this.state = { status: 'downloading', progress: Math.min(1, done / CUDA_DOWNLOAD_BYTES) };
            next(null, chunk);
          },
        }), fs.createWriteStream(file));
        if (hash.digest('hex') !== wheel.sha256) throw new Error(`Контрольная сумма ${wheel.file} не совпала`);
      }
      this.state = { status: 'installing' };
      const site = path.join(this.dir, 'site');
      for (const wheel of WHEELS) {
        await run(this.bundledPython, ['-I', '-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
          path.join(download, wheel.file), site]);
      }
      await fsp.rm(download, { recursive: true, force: true });
      // Interpreter files only: numpy and other pure dependencies stay in the bundled pack.
      const pack = path.dirname(this.bundledPython);
      for (const entry of await fsp.readdir(pack, { withFileTypes: true })) {
        if (entry.isFile() && !/\._pth$|^pack\.json$/i.test(entry.name)) await fsp.copyFile(path.join(pack, entry.name), path.join(this.dir, entry.name));
      }
      this.writePth();
      await run(path.join(this.dir, 'python.exe'), ['-c', [
        'import torch, torchaudio',
        'assert torch.version.cuda, "CPU torch was imported"',
        'assert torch.cuda.is_available(), "CUDA недоступна: обновите драйвер NVIDIA"',
        'm = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model().cuda().eval()',
        'with torch.inference_mode(): m(torch.zeros(1, 2, 44100, device="cuda"))',
      ].join('\n')], { TORCH_HOME: this.models });
      await fsp.writeFile(path.join(this.dir, 'ready.json'), JSON.stringify({ version: VERSION }));
      this.broken = null;
      this.state = { status: 'ready' };
    } catch (e) {
      // Never leave gigabytes of an unusable runtime behind.
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.state = { status: 'error', error: (e as Error).message.slice(-500) };
    }
  }

  async remove(): Promise<void> {
    if (this.state.status === 'downloading' || this.state.status === 'installing') throw new Error('Пакет сейчас устанавливается');
    // A running separation locks python.exe: whatever was deleted, never start this runtime again.
    try { await fsp.rm(this.dir, { recursive: true, force: true }); } catch (e) { this.broken = 'Пакет удалён не полностью'; throw e; }
    this.state = { status: 'absent' };
    this.broken = null;
  }

  private writePth(): void {
    // CUDA torch first; the bundled site-packages still provides numpy and torch's pure dependencies.
    fs.writeFileSync(path.join(this.dir, 'python312._pth'),
      ['python312.zip', '.', 'site', path.join(path.dirname(this.bundledPython), 'Lib', 'site-packages'), 'import site', ''].join('\n'));
  }
}

function run(exe: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', ...env } });
    let stderr = '';
    proc.stderr!.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    proc.once('error', reject);
    proc.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim().split(/\r?\n/).pop() || `код ${code}`)));
  });
}
