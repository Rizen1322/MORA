import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { Readable } from 'readable-stream';
import { parseBuffer } from 'mm-core';
import { promises as fsp } from '../opfs-fs.ts';
import { decodeAudio, decodePlanes } from '../rpc.ts';

/**
 * Replaces apps/server/src/ffmpeg.ts on iOS. Probing reads tags/stream info with
 * music-metadata; decoding goes to the page (WebAudio decodeAudioData, which also
 * resamples). A decode looks like an ffmpeg child process to its callers.
 */

export interface ProbeResult {
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  hasAudio: boolean;
}

const CHUNK = 1 << 20;
/** First prefix decode of a growing download (~16 s of 128 kbit/s audio); later tries at 4× the size. */
const PREFIX_BYTES = 256 * 1024;

async function collect(input: string): Promise<ArrayBuffer> {
  const b = await fsp.readFile(input) as Uint8Array;
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer as ArrayBuffer : b.slice().buffer as ArrayBuffer;
}

class DecodeProcess extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr = new EventEmitter();
  readonly stdin = null;
  exitCode: number | null = null;
  killed = false;
  private abort = new AbortController();
  private pcm: Uint8Array | null = null;
  private at = 0;
  /** Bytes of `pcm` that may be pushed: all of it once the whole file is decoded. */
  private limit = 0;
  private final = false;

  constructor(input: string | Readable, private opts: { sampleRate: number; channels: number; format: 's16le' | 'f32le' }) {
    super();
    this.stdout = new Readable({ read: () => this.pump() });
    void this.start(input);
  }

  private decode(bytes: ArrayBuffer) {
    return decodeAudio({ bytes, sampleRate: this.opts.sampleRate, channels: this.opts.channels, format: this.opts.format }, this.abort.signal);
  }

  /**
   * A file that is still downloading (a growing stream) plays before it is complete:
   * decodeAudioData needs a whole file, but a prefix of an MP3/ADTS stream is one. The same
   * decoder gives the same samples from the start, so everything except the last second before
   * the cut is final and goes out now; the complete decode continues at the same byte.
   */
  private async collectProgressive(input: Readable): Promise<ArrayBuffer> {
    const parts: Uint8Array[] = [];
    let size = 0, nextTry = PREFIX_BYTES;
    for await (const c of input as AsyncIterable<Uint8Array>) {
      parts.push(c);
      size += c.length;
      if (size < nextTry || this.killed) continue;
      nextTry = size * 4;
      try { this.offerPrefix(new Uint8Array((await this.decode(Buffer.concat(parts).buffer as ArrayBuffer)).pcm)); }
      catch { if (this.killed) throw new Error('декодирование отменено'); /* not decodable as a prefix (container): wait for the whole file */ }
    }
    return Buffer.concat(parts).buffer as ArrayBuffer;
  }

  private offerPrefix(pcm: Uint8Array): void {
    const sample = this.opts.format === 'f32le' ? 4 : 2, frame = sample * this.opts.channels;
    // a decoder may pad a cut file to its header's full length: only audio before the last sound counts
    const view = sample === 4 ? new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 2) : new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    let last = view.length - 1;
    while (last >= 0 && view[last] === 0) last--;
    const keep = Math.floor((last + 1) / this.opts.channels) - this.opts.sampleRate;
    if (keep * frame <= this.limit) return;
    this.pcm = pcm;
    this.limit = keep * frame;
    this.pump();
  }

  private async start(input: string | Readable): Promise<void> {
    try {
      const bytes = typeof input === 'string' ? await collect(input) : await this.collectProgressive(input);
      const r = await this.decode(bytes);
      const pcm = new Uint8Array(r.pcm);
      if (pcm.byteLength < this.at) throw new Error('полный файл короче уже отданного начала');
      if (this.at && this.pcm && this.opts.format === 'f32le') {
        const n = Math.min(64, this.at >> 2), a = new Float32Array(this.pcm.buffer, this.pcm.byteOffset + this.at - n * 4, n), b = new Float32Array(pcm.buffer, pcm.byteOffset + this.at - n * 4, n);
        if (a.some((v, i) => Math.abs(v - b[i]) > 1e-4)) console.warn('[decode] prefix and whole-file decode differ at the seam');
      }
      this.pcm = pcm;
      this.limit = pcm.byteLength;
      this.final = true;
      this.pump();
    } catch (e) {
      if (this.killed) return;
      this.stderr.emit('data', Buffer.from(String((e as Error).message ?? e)));
      this.stdout.push(null);
      this.exit(1);
    }
  }

  private pump(): void {
    const pcm = this.pcm;
    if (!pcm || this.killed) return;
    while (this.at < this.limit) {
      const end = Math.min(this.limit, this.at + CHUNK);
      const more = this.stdout.push(Buffer.from(pcm.buffer as ArrayBuffer, pcm.byteOffset + this.at, end - this.at));
      this.at = end;
      if (!more) return;
    }
    if (this.final && this.exitCode === null) {
      this.stdout.push(null);
      this.pcm = null;
      this.stdout.once('end', () => this.exit(0));
      this.exitCode = -2;
    }
  }

  private exit(code: number | null): void {
    this.exitCode = code;
    queueMicrotask(() => { this.emit('exit', code); this.emit('close', code); });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.abort.abort();
    this.stdout.destroy();
    this.exit(null);
    return true;
  }
}

export class FfmpegTools {
  constructor(readonly ffmpeg: string, readonly ffprobe: string) {}

  async version(): Promise<string | null> {
    return 'WebAudio decodeAudioData (iOS)';
  }

  async probe(file: string): Promise<ProbeResult> {
    const bytes = await fsp.readFile(file) as Uint8Array;
    let meta: Awaited<ReturnType<typeof parseBuffer>> | null = null;
    try { meta = await parseBuffer(bytes, { path: file }, { duration: true, skipCovers: true }); } catch { meta = null; }
    const f = meta?.format;
    let duration = f?.duration ?? 0;
    let sampleRate = f?.sampleRate ?? null;
    let channels = f?.numberOfChannels ?? null;
    if (!duration || !Number.isFinite(duration)) {
      // container without a reliable length: decode once at a low rate to measure it
      const r = await decodePlanes({ bytes: bytes.slice().buffer as ArrayBuffer, sampleRate: 8000, channels: 1, format: 's16le' });
      duration = r.duration;
      sampleRate ??= r.sourceRate;
      channels ??= 2;
    }
    if (!duration) throw new Error('ffprobe: файл не содержит звука');
    return {
      duration,
      codec: f?.codec ? f.codec.toLowerCase().replace(/^mpeg 1 layer 3$/, 'mp3').replace(/^mpeg-4\/aac$/, 'aac') : f?.container?.toLowerCase() ?? null,
      sampleRate,
      channels,
      bitrate: f?.bitrate ? Math.round(f.bitrate) : null,
      hasAudio: true,
    };
  }

  decode(input: string | Readable, opts: { sampleRate: number; channels: number; format: 's16le' | 'f32le' }) {
    return new DecodeProcess(input, opts);
  }
}
