import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export interface ProbeResult {
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  hasAudio: boolean;
}

const nativeCodecs = new Set(['mp3', 'flac', 'opus', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);

export class FfmpegTools {
  private readonly nativeFiles = new Map<string, { size: number; mtimeMs: number }>();
  constructor(
    readonly ffmpeg: string,
    readonly ffprobe: string,
    readonly decoder?: string,
  ) {}

  version(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.ffmpeg, ['-version'], { timeout: 8000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        resolve(String(out).split('\n')[0]?.trim() ?? null);
      });
    });
  }

  probe(file: string, signal?: AbortSignal): Promise<ProbeResult> {
    if (!this.decoder || !existsSync(this.decoder) || !['.wav', '.flac', '.mp3', '.ogg', '.opus', '.webm'].includes(extname(file).toLowerCase())) return this.probeFfmpeg(file, signal);
    return new Promise((resolve, reject) => {
      try { execFile(this.decoder!, ['probe', file], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (err, out) => {
        try {
          if (err) throw err;
          const { container, ...result }: ProbeResult & { container?: string } = JSON.parse(String(out));
          if (!result.hasAudio || !Number.isFinite(result.duration) || result.duration <= 0 || !result.codec || !result.sampleRate || !result.channels || result.channels > 2 ||
              (result.codec === 'opus' && container !== 'ogg' && container !== 'matroska') ||
              !nativeCodecs.has(result.codec)) throw new Error('unsupported native probe');
          this.rememberNative(file, result);
          resolve(result);
        } catch (error) { if (signal?.aborted) reject(error); else resolve(this.probeFfmpeg(file, signal)); }
      }); } catch (error) { if (signal?.aborted) reject(error); else resolve(this.probeFfmpeg(file, signal)); }
    });
  }

  private rememberNative(file: string, result: ProbeResult) {
    this.nativeFiles.delete(file);
    // shortcut: native routing covers validated mono/stereo formats, expand after compatibility tests.
    if (this.decoder && ['.wav', '.flac', '.mp3', '.ogg', '.opus', '.webm'].includes(extname(file).toLowerCase()) &&
        result.codec && nativeCodecs.has(result.codec) &&
        result.sampleRate && result.sampleRate >= 8000 && result.sampleRate <= 192000 && result.channels && result.channels <= 2) {
      try { const { size, mtimeMs } = statSync(file); this.nativeFiles.set(file, { size, mtimeMs }); } catch {}
    }
  }

  private probeFfmpeg(file: string, signal?: AbortSignal): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
        (err, out, stderr) => {
          if (err) return reject(new Error(`ffprobe: ${String(stderr || err.message).slice(0, 300)}`));
          try {
            const j = JSON.parse(String(out));
            const st = j.streams?.[0];
            const duration = Number(j.format?.duration ?? st?.duration ?? 0);
            const result: ProbeResult = {
              duration: Number.isFinite(duration) ? duration : 0,
              codec: st?.codec_name ?? null,
              sampleRate: st?.sample_rate ? Number(st.sample_rate) : null,
              channels: st?.channels ?? null,
              bitrate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
              hasAudio: !!st,
            };
            this.nativeFiles.delete(file);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  /** Decodes to raw interleaved PCM on stdout. */
  decode(input: string | Readable, opts: { sampleRate: number; channels: number; format: 's16le' | 'f32le' }) {
    if (typeof input === 'string' && this.decoder && existsSync(this.decoder) && opts.channels > 0 && opts.channels <= 2 && opts.sampleRate >= 8000 && opts.sampleRate <= 192000) {
      const cached = this.nativeFiles.get(input);
      try {
        const stat = statSync(input);
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          return spawn(this.decoder, [input, String(opts.sampleRate), String(opts.channels), opts.format],
            { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        }
      } catch {}
    }
    if (typeof input !== 'string') {
      const native = process.platform === 'win32' && this.decoder && existsSync(this.decoder) && opts.channels > 0 && opts.channels <= 2 && opts.sampleRate >= 8000 && opts.sampleRate <= 192000;
      const ffmpeg = () => spawn(this.ffmpeg, ['-v', 'error', '-nostdin', '-probesize', '65536', '-analyzeduration', '500000', '-i', 'pipe:0', '-vn', '-sn', '-dn', '-ac', String(opts.channels), '-ar', String(opts.sampleRate), '-f', opts.format, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let proc: ReturnType<typeof ffmpeg>;
      try { proc = native ? spawn(this.decoder!, ['stream', this.ffmpeg, String(opts.sampleRate), String(opts.channels), opts.format], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) : ffmpeg(); }
      catch { proc = ffmpeg(); }
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
