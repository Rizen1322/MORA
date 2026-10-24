import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface ProbeResult {
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  hasAudio: boolean;
}

export class FfmpegTools {
  constructor(
    readonly ffmpeg: string,
    readonly ffprobe: string,
  ) {}

  version(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.ffmpeg, ['-version'], { timeout: 8000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        resolve(String(out).split('\n')[0]?.trim() ?? null);
      });
    });
  }

  probe(file: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, out, stderr) => {
          if (err) return reject(new Error(`ffprobe: ${String(stderr || err.message).slice(0, 300)}`));
          try {
            const j = JSON.parse(String(out));
            const st = j.streams?.[0];
            const duration = Number(j.format?.duration ?? st?.duration ?? 0);
            resolve({
              duration: Number.isFinite(duration) ? duration : 0,
              codec: st?.codec_name ?? null,
              sampleRate: st?.sample_rate ? Number(st.sample_rate) : null,
              channels: st?.channels ?? null,
              bitrate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
              hasAudio: !!st,
            });
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  /** Decodes to raw interleaved PCM on stdout. */
  decode(input: string | Readable, opts: { sampleRate: number; channels: number; format: 's16le' | 'f32le' }) {
    if (typeof input !== 'string') {
      const proc = spawn(this.ffmpeg, ['-v', 'error', '-nostdin', '-probesize', '65536', '-analyzeduration', '500000', '-i', 'pipe:0', '-vn', '-sn', '-dn', '-ac', String(opts.channels), '-ar', String(opts.sampleRate), '-f', opts.format, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      proc.stdin.on('error', () => {}); // Decoder cancellation can close stdin before its upstream.
      input.on('error', () => proc.kill('SIGKILL'));
      proc.once('close', () => input.destroy());
      input.pipe(proc.stdin);
      return proc;
    }
    return spawn(
      this.ffmpeg,
      ['-v', 'error', '-nostdin', '-i', input, '-vn', '-sn', '-dn', '-ac', String(opts.channels), '-ar', String(opts.sampleRate), '-f', opts.format, 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
  }
}
