import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { FfmpegTools } from './ffmpeg.ts';
import type { Readable } from 'node:stream';

/** Float frames as read() returns them: f32le stereo preserves decoder/resampler overs before normalization. */
const FLOAT_FRAME = 8;
/** The 16-bit store keeps 6 dB above full scale for those overs: it holds value / S16_HEADROOM. */
const S16_HEADROOM = 2;

/** f32le → headroom s16le. Decoder chunks may split a sample: the remainder waits for the next chunk. */
function floatToS16(): (chunk: Buffer) => Buffer {
  let carry: Buffer | null = null;
  return (chunk) => {
    const bytes = carry ? Buffer.concat([carry, chunk]) : chunk;
    const n = bytes.length >> 2;
    carry = bytes.length > n * 4 ? Buffer.from(bytes.subarray(n * 4)) : null;
    const f = bytes.byteOffset % 4 === 0 ? new Float32Array(bytes.buffer, bytes.byteOffset, n) : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
    const out = new Int16Array(n), k = 32768 / S16_HEADROOM;
    for (let i = 0; i < n; i++) { const v = Math.round(f[i] * k); out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
    return Buffer.from(out.buffer);
  };
}

function s16ToFloat(raw: Buffer): Buffer {
  const n = raw.length >> 1;
  const s = raw.byteOffset % 2 === 0 ? new Int16Array(raw.buffer, raw.byteOffset, n) : new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 2));
  const out = new Float32Array(n), k = S16_HEADROOM / 32768;
  for (let i = 0; i < n; i++) out[i] = s[i] * k;
  return Buffer.from(out.buffer);
}

interface Entry {
  key: string;
  file: string;
  part: string;
  sampleRate: number;
  bytes: number;
  done: boolean;
  error: string | null;
  proc: ReturnType<FfmpegTools['decode']> | null;
  waiters: Set<() => void>;
  lastUse: number;
  estimatedFrames: number;
  session: boolean;
  readers: number;
  cancelled: boolean;
  /** Tells the input (a remote transfer) that this decode no longer wants it. */
  abort: AbortController;
}

/**
 * Decoded PCM (f32le stereo at the playback sample rate) on disk, written
 * progressively by ffmpeg so playback can start before decoding finishes.
 * Bounded by size (LRU); decodes nobody reads any more are cancelled.
 */
export class PcmCache {
  private entries = new Map<string, Entry>();
  private legacy = new Map<string, { file: string; bytes: number }>();
  private readonly dir: string;
  private readonly sessionDir: string;
  private pins = new Map<string, number>();
  private focused = new Set<string>();
  private eviction: Promise<void> | null = null;
  private stopped = false;
  private readonly s16: boolean;
  /** Stored bytes per stereo frame: 8 (f32le) or 4 (headroom s16le). */
  private readonly width: number;
  private readonly ext: string;

  constructor(
    private readonly cfg: AppConfig,
    private readonly ff: FfmpegTools,
  ) {
    this.s16 = cfg.pcmCacheFormat === 's16le';
    this.width = this.s16 ? 4 : FLOAT_FRAME;
    this.ext = this.s16 ? 's16h' : 'f32';
    this.dir = path.join(cfg.dataDir, 'cache', 'pcm');
    this.sessionDir = path.join(cfg.dataDir, 'session-cache', 'pcm');
    fs.mkdirSync(this.dir, { recursive: true });
    // session-only cache (providers that forbid persistent caching) never survives a restart
    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    fs.mkdirSync(this.sessionDir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      if (f.endsWith('.part')) {
        fs.rmSync(full, { force: true });
        continue;
      }
      // Legacy integer caches have already clipped hot decoded masters. Never
      // promote them to float; decode the original again. Retain the files until
      // their replacement is complete so an older reader can finish safely.
      // Files of the other store format are decoded again too and only counted until evicted.
      const m = /^(.+)_(\d+)\.(f32|s16h)$/.exec(f);
      if (!m || m[3] !== this.ext) {
        const old = m ?? /^(.+)_(\d+)\.s16$/.exec(f);
        if (old) this.legacy.set(`${old[1]}_${old[2]}`, { file: full, bytes: fs.statSync(full).size });
        continue;
      }
      const st = fs.statSync(full);
      this.entries.set(`${m[1]}_${m[2]}`, {
        key: `${m[1]}_${m[2]}`,
        file: full,
        part: `${full}.unused.part`,
        sampleRate: Number(m[2]),
        bytes: st.size,
        done: true,
        error: null,
        proc: null,
        waiters: new Set(),
        lastUse: st.mtimeMs,
        estimatedFrames: st.size / this.width,
        session: false,
        readers: 0, cancelled: false, abort: new AbortController(),
      });
    }
  }

  /** Marks a key as in use (current/next track) for `ms`. Pinned entries are not evicted or cancelled. */
  pin(hash: string, sampleRate: number, ms = 10 * 60_000): void {
    const key = `${hash}_${sampleRate}`;
    this.pins.set(key, Math.max(this.pins.get(key) ?? 0, Date.now() + ms));
  }

  /** A changed queue must not retain ten minutes of obsolete prepared tracks.
   * Keep a short grace period for requests already in flight. */
  focus(hashes: Set<string>): void {
    const grace = Date.now() + 30_000;
    const active = new Set([...hashes].slice(0, 2));
    for (const e of this.entries.values()) {
      const hash = e.key.slice(0, e.key.lastIndexOf('_'));
      if (this.focused.has(hash) && !active.has(hash)) this.pins.set(e.key, grace);
    }
    this.focused = active;
    for (const [key, until] of this.pins) {
      const hash = key.slice(0, key.lastIndexOf('_'));
      if (!active.has(hash)) this.pins.set(key, Math.min(until, grace));
    }
  }

  private isPinned(key: string): boolean {
    const hash = key.slice(0, key.lastIndexOf('_'));
    if (this.focused.has(hash)) return true;
    const until = this.pins.get(key);
    return !!until && until > Date.now();
  }

  /** Opens (and if needed starts decoding) the PCM for a content hash. */
  open(hash: string, sampleRate: number, input: (signal: AbortSignal) => Promise<string | Readable>, durationHint: number, session = false): Entry {
    const key = `${hash}_${sampleRate}`;
    let e = this.entries.get(key);
    if (e && !e.error && !e.cancelled) {
      e.lastUse = Date.now();
      return e;
    }
    const dir = session ? this.sessionDir : this.dir;
    e = {
      key,
      file: path.join(dir, `${key}.${this.ext}`),
      part: path.join(dir, `${key}.${randomUUID()}.part`),
      sampleRate,
      bytes: 0,
      done: false,
      error: null,
      proc: null,
      waiters: new Set(),
      lastUse: Date.now(),
      estimatedFrames: Math.round(durationHint * sampleRate),
      session,
      readers: 0, cancelled: false, abort: new AbortController(),
    };
    this.entries.set(key, e);
    if (this.stopped) this.fail(e, 'кэш остановлен');
    else void this.startDecode(e, input).catch(error => this.fail(e, (error as Error).message));
    return e;
  }

  private async startDecode(e: Entry, input: (signal: AbortSignal) => Promise<string | Readable>): Promise<void> {
    const part = e.part;
    let src: string | Readable;
    try {
      src = await input(e.abort.signal);
    } catch (err) {
      this.fail(e, (err as Error).message);
      return;
    }
    if (e.cancelled || this.stopped) { if (typeof src !== 'string') src.destroy(); return; }
    await this.evict();
    if (e.cancelled || this.stopped) { if (typeof src !== 'string') src.destroy(); return; }
    const out = fs.createWriteStream(part);
    const proc = this.ff.decode(src, { sampleRate: e.sampleRate, channels: 2, format: 'f32le' });
    e.proc = proc;
    out.on('error', (error) => { proc.kill('SIGKILL'); this.fail(e, `Не удалось сохранить звук: ${error.message}`); });
    out.on('drain', () => proc.stdout.resume());
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const store = this.s16 ? floatToS16() : (chunk: Buffer) => chunk;
    proc.stdout.on('data', (chunk: Buffer) => {
      const data = store(chunk);
      if (!data.length) return;
      // count bytes only once they are flushed, so readers never see unwritten regions
      const writable = out.write(data, () => {
        e.bytes += data.length;
        this.wake(e);
      });
      if (!writable) proc.stdout.pause();
    });
    proc.on('error', (err) => this.fail(e, `ffmpeg: ${err.message}`));
    proc.on('close', (code) => {
      out.end(() => {
        e.proc = null;
        if (code === 0 && e.bytes > 0 && !e.cancelled) {
          fs.rename(part, e.file, (err) => {
            if (err) return this.fail(e, err.message);
            e.done = true;
            e.estimatedFrames = e.bytes / this.width;
            this.wake(e);
            void this.evict().catch(() => {});
          });
        } else {
          fs.rm(part, { force: true }, () => {});
          this.fail(e, code === null ? 'декодирование отменено' : `не удалось декодировать файл: ${stderr.split('\n').filter(Boolean).pop() ?? 'код ' + code}`);
        }
      });
    });
  }

  private fail(e: Entry, msg: string): void {
    e.error = msg;
    e.done = true;
    this.wake(e);
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
  }

  private wake(e: Entry): void {
    for (const w of e.waiters) w();
    e.waiters.clear();
  }

  /** Reads frames [start, start+frames). Waits for the decoder when needed. */
  async read(e: Entry, startFrame: number, frames: number, timeoutMs = 30000): Promise<{ data: Buffer; totalFrames: number; complete: boolean }> {
    if (this.pins.has(e.key)) this.pins.set(e.key, Math.max(this.pins.get(e.key)!, Date.now() + 30_000));
    e.readers++;
    try { return await this.readEntry(e, startFrame, frames, timeoutMs); }
    finally { e.readers--; }
  }

  private async readEntry(e: Entry, startFrame: number, frames: number, timeoutMs: number): Promise<{ data: Buffer; totalFrames: number; complete: boolean }> {
    e.lastUse = Date.now();
    const want = (startFrame + frames) * this.width;
    const t0 = Date.now();
    while (!e.done && e.bytes < want) {
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); e.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 500);
        e.waiters.add(wake);
      });
    }
    if (e.error) throw new Error(e.error);
    const readFrom = e.done ? e.file : e.part;
    const available = Math.max(0, Math.min(want, e.bytes) - startFrame * this.width);
    const buf = Buffer.alloc(available);
    if (available > 0) {
      const fh = await fsp.open(readFrom, 'r').catch(error => {
        // The progressive file can be atomically renamed between choosing its
        // name and opening it. Retry the published name, not the decode itself.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && readFrom !== e.file) return fsp.open(e.file, 'r');
        throw error;
      });
      try {
        await fh.read(buf, 0, available, startFrame * this.width);
      } finally {
        await fh.close();
      }
    }
    return { data: this.s16 ? s16ToFloat(buf) : buf, totalFrames: e.done ? e.bytes / this.width : e.estimatedFrames, complete: e.done };
  }

  status(hash: string, sampleRate: number): { bytes: number; done: boolean; error: string | null } | null {
    const e = this.entries.get(`${hash}_${sampleRate}`);
    return e ? { bytes: e.bytes, done: e.done, error: e.error } : null;
  }

  /** Cancels decodes nobody has read for a while (stale queue entries). */
  reapStale(idleMs = 90_000): number {
    let n = 0;
    for (const [key, until] of this.pins) if (until <= Date.now()) this.pins.delete(key);
    for (const e of this.entries.values()) {
      if (!e.done && !e.readers && !this.isPinned(e.key) && Date.now() - e.lastUse > idleMs) {
        this.cancelEntry(e);
        n++;
      }
    }
    return n;
  }

  cancel(hash: string, sampleRate: number): void {
    const e = this.entries.get(`${hash}_${sampleRate}`);
    if (e && !e.done) this.cancelEntry(e);
  }

  private cancelEntry(e: Entry): void {
    e.cancelled = true;
    e.abort.abort();
    e.proc?.kill('SIGKILL');
    this.fail(e, 'декодирование отменено');
  }

  totalBytes(): number {
    let s = 0;
    for (const e of this.entries.values()) s += e.bytes;
    for (const e of this.legacy.values()) s += e.bytes;
    return s;
  }

  protectedBytes():number {
    let bytes=0;
    for(const e of this.entries.values())if(this.isPinned(e.key)||e.readers||!e.done)bytes+=e.bytes;
    return bytes;
  }

  evict(): Promise<void> {
    if (!this.eviction) this.eviction = this.evictEntries().finally(() => { this.eviction = null; });
    return this.eviction;
  }

  private async evictEntries(): Promise<void> {
    let total = this.totalBytes();
    if (total <= this.cfg.pcmCacheBytes) return;
    // Count the old format in the same disk budget while it is phased out.
    for (const [key, e] of this.legacy) {
      if (total <= this.cfg.pcmCacheBytes * 0.85) break;
      if (this.isPinned(key)) continue;
      await fsp.rm(e.file, { force: true });
      this.legacy.delete(key);
      total -= e.bytes;
    }
    const done = [...this.entries.values()].filter((e) => e.done && !e.proc && !this.isPinned(e.key)).sort((a, b) => a.lastUse - b.lastUse);
    for (const e of done) {
      if (total <= this.cfg.pcmCacheBytes * 0.85) break;
      if (this.isPinned(e.key) || e.proc || e.readers || this.entries.get(e.key) !== e) continue;
      // Commit the small directory mutation in this turn: no new reader can
      // acquire this entry between the reader check and unlink.
      fs.rmSync(e.file, { force: true });
      this.entries.delete(e.key);
      total -= e.bytes;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async clear(): Promise<void> {
    await this.eviction;
    for (const e of [...this.entries.values()]) {
      if (e.readers || this.isPinned(e.key)) continue;
      if (!e.done) this.cancelEntry(e);
      fs.rmSync(e.file, { force: true });
      if (this.entries.get(e.key) === e) this.entries.delete(e.key);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    for (const e of this.legacy.values()) await fsp.rm(e.file, { force: true });
    this.legacy.clear();
  }

  shutdown(): void {
    this.stopped = true;
    for (const e of [...this.entries.values()]) if (!e.done) this.cancelEntry(e);
  }
}
