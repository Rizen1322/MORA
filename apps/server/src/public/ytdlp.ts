import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * yt-dlp runner. Every call is spawn(bin, [args...], { shell: false }) with a
 * fixed option list, `--` before the only URL, a timeout, an AbortSignal, an
 * output size cap and a small priority queue (current track before next before
 * background), so a search can never start dozens of processes.
 * TLS verification stays on; secrets of this app are never passed to it.
 */

export type Priority = 0 | 1 | 2 | 3; // 0 = audible now, 1 = next track, 2 = search, 3 = background

export interface YtDlpConfig {
  bin: string | null;
  /** "node:<path>" for yt-dlp's JS challenge solver; the desktop app passes its own Electron binary. */
  jsRuntime: string | null;
  /** The runtime is Electron: run it in plain Node mode inside yt-dlp's children only. */
  runtimeIsElectron: boolean;
  ffmpegDir: string | null;
  cacheDir: string;
  concurrency: number;
  proxies?: { youtube?: string; soundcloud?: string };
}

export class ResolverError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'timeout' | 'cancelled' | 'not-installed' | 'too-large' | 'failed' | 'auth') {
    super(message);
  }
}

const ALLOWED_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'api.soundcloud.com']);

/** Only plain https URLs of the supported services reach yt-dlp. */
export function checkedMediaUrl(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new ResolverError('Некорректная ссылка', 'failed'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ResolverError('Ссылка не относится к поддерживаемому источнику', 'failed');
  }
  return u.toString();
}

/** Maps yt-dlp stderr to a short reason a listener can act on. Never echoes URLs. */
export function classifyError(stderr: string): ResolverError {
  const s = stderr.toLowerCase();
  if (/sign in to confirm (?:you(?:'|’)?re|you are) not a bot|confirm you(?:'|’)?re not a bot/.test(s)) return new ResolverError('Источник просит проверку от ботов. Попробуйте позже или выберите другой источник', 'auth');
  // "age" also matches "webpage", "message" and "package": a network
  // error must not be presented as a recording requiring an account.
  if (/sign in to confirm your age|\bage[- ]restricted\b|\bage verification\b|members-only|private video|login required|authentication required|(?:cookies|log ?in|sign ?in) (?:are |is )?required/.test(s)) return new ResolverError('Источник требует вход в аккаунт для этой записи', 'auth');
  if (/in your country|geo.?restrict|not available in (?:your|this) (?:country|region)/.test(s)) return new ResolverError('Запись недоступна в вашей стране', 'unavailable');
  if (/video unavailable|has been removed|does not exist|404|no longer available|copyright/.test(s)) return new ResolverError('Запись удалена или недоступна', 'unavailable');
  if (/max-filesize|larger than max/.test(s)) return new ResolverError('Файл слишком большой', 'too-large');
  if (/timed out|timeout|connection|network|getaddrinfo|ssl|http error (?:429|5\d\d)/.test(s)) return new ResolverError('Источник не ответил', 'timeout');
  return new ResolverError('Источник не отдал аудио', 'failed');
}

interface Job { priority: Priority; seq: number; start: () => void }

export class YtDlp {
  private queue: Job[] = [];
  private running = 0;
  private seq = 0;
  private warm = new Map<string, { at: number; info: Record<string, unknown> }>();
  private warmingCount = 0;
  constructor(readonly cfg: YtDlpConfig) {}

  get available(): boolean {
    return !!this.cfg.bin && (!path.isAbsolute(this.cfg.bin) || fs.existsSync(this.cfg.bin));
  }

  private baseArgs(target = ''): string[] {
    const a = ['--ignore-config', '--encoding', 'utf-8', '--no-warnings', '--no-playlist', '--no-progress', '--cache-dir', this.cfg.cacheDir, '--socket-timeout', '15', '--retries', '2'];
    if (this.cfg.jsRuntime) a.push('--js-runtimes', this.cfg.jsRuntime);
    if (this.cfg.ffmpegDir) a.push('--ffmpeg-location', this.cfg.ffmpegDir);
    const proxy = target.startsWith('scsearch') || target.includes('soundcloud.com/')
      ? this.cfg.proxies?.soundcloud : this.cfg.proxies?.youtube;
    if (proxy !== undefined) a.push('--proxy', proxy);
    return a;
  }

  private schedule<T>(priority: Priority, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new ResolverError('Отменено', 'cancelled'));
      const job: Job = {
        priority, seq: this.seq++,
        start: () => {
          this.running++;
          work().then(resolve, reject).finally(() => { this.running--; this.pump(); });
        },
      };
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); reject(new ResolverError('Отменено', 'cancelled')); }
      }, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < Math.max(1, this.cfg.concurrency) && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.queue.shift()!.start();
    }
  }

  /** Runs yt-dlp with fixed arguments; resolves with stdout. */
  run(args: string[], opts: { priority: Priority; timeoutMs: number; signal?: AbortSignal; maxBytes?: number; onProgress?: (fraction: number) => void; networkTarget?: string }): Promise<string> {
    if (!this.available) return Promise.reject(new ResolverError('Компонент для онлайн-источников не установлен', 'not-installed'));
    return this.schedule(opts.priority, opts.signal, () => new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
      delete env.ACCESS_TOKEN;
      delete env.AUTOMIX_SECRET_KEY;
      if (this.cfg.runtimeIsElectron) env.ELECTRON_RUN_AS_NODE = '1';
      const proc = spawn(this.cfg.bin!, [...this.baseArgs(opts.networkTarget ?? args.at(-1)), ...args], { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const max = opts.maxBytes ?? 16 << 20;
      const out: Buffer[] = [];
      const decoder = new StringDecoder('utf8');
      let progressPending = '';
      let size = 0, err = '', settled = false;
      const done = (e: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (e) { proc.kill(); reject(e); } else resolve(value!);
      };
      const onAbort = () => done(new ResolverError('Отменено', 'cancelled'));
      const timer = setTimeout(() => done(new ResolverError('Источник не ответил вовремя', 'timeout')), opts.timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      // Progress lines carry a private marker and never reach the result.
      const progress = (text: string) => {
        if (!opts.onProgress || !text.includes('MORAPROG')) return text;
        for (const m of text.matchAll(/MORAPROG\s*([\d.]+)%/g)) opts.onProgress(Math.min(1, Number(m[1]) / 100));
        return text.split(/\r?\n/).filter((l) => !l.includes('MORAPROG')).join('\n');
      };
      proc.stdout.on('data', (d: Buffer) => {
        size += d.length;
        if (size > max) { done(new ResolverError('Слишком большой ответ источника', 'too-large')); return; }
        // Decode protocol output once: pipe chunks may split UTF-8 characters,
        // JSON records or progress markers at any byte boundary.
        out.push(d);
        if (opts.onProgress) {
          progressPending += decoder.write(d);
          const lines = progressPending.split(/\r?\n/);
          progressPending = lines.pop() ?? '';
          for (const line of lines) progress(line);
        }
      });
      proc.stderr.on('data', (d: Buffer) => { const t = progress(d.toString('utf8')); if (err.length < 8000) err += t; });
      proc.on('error', (e) => done(new ResolverError(`Не удалось запустить компонент источников: ${e.message}`, 'not-installed')));
      proc.on('close', (code) => {
        if (opts.onProgress) progress(progressPending + decoder.end());
        const stdout = Buffer.concat(out).toString('utf8').replace(/^MORAPROG[^\r\n]*(?:\r?\n|$)/gm, '');
        code === 0 ? done(null, stdout) : done(classifyError(err));
      });
    }));
  }

  async version(): Promise<string | null> {
    try { return (await this.run(['--version'], { priority: 2, timeoutMs: 15000 })).trim(); } catch { return null; }
  }

  async metadata(url: string): Promise<Record<string, unknown>> {
    const raw = await this.run(['--skip-download', '-J', '--', checkedMediaUrl(url)], { priority: 2, timeoutMs: 25000 });
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /** Flat search results (no media requests): `scsearchN:` or `ytsearchN:`. */
  async search(prefix: 'scsearch' | 'ytsearch', query: string, limit: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const q = query.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    if (!q) return [];
    const raw = await this.run(['--flat-playlist', '-J', '--', `${prefix}${Math.min(25, Math.max(1, limit))}:${q}`], { priority: 2, timeoutMs: 25000, signal });
    const j = JSON.parse(raw) as { entries?: Record<string, unknown>[] };
    return (j.entries ?? []).filter(Boolean);
  }

  /** One speculative resolver at a time, only with a free slot reserved for playback. */
  async warmMetadata(url: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const target = checkedMediaUrl(url);
    if (this.warmInfo(target)) return Promise.resolve(true);
    if (this.cfg.concurrency < 2 || this.warmingCount || this.queue.length || this.running >= this.cfg.concurrency - 1) return false;
    this.warmingCount++;
      try {
        const raw = await this.run(['--skip-download', '-J', '--', target], { priority: 3, timeoutMs: 7000, signal, maxBytes: 4 << 20 });
        const info = JSON.parse(raw) as Record<string, unknown>;
        if (info._type === 'playlist' || !Array.isArray(info.formats) || !info.formats.length) return false;
        this.warm.set(target, { at: Date.now(), info });
        while (this.warm.size > 4) this.warm.delete(this.warm.keys().next().value!);
        return true;
      } finally { this.warmingCount--; }
  }

  private warmInfo(target: string): Record<string, unknown> | null {
    const entry = this.warm.get(target);
    if (!entry) return null;
    // Signed URLs may be much shorter lived than the metadata title.
    const formats = entry.info.formats as { url?: string }[];
    const expired = formats.some((f) => {
      try { const expire = Number(new URL(f.url ?? '').searchParams.get('expire')); return expire > 0 && expire * 1000 < Date.now() + 15000; }
      catch { return false; }
    });
    if (Date.now() - entry.at > 45000 || expired) { this.warm.delete(target); return null; }
    return entry.info;
  }

  /** A genuine Music songs shelf; generic ytsearch is not a substitute for this source. */
  async searchMusic(query: string, limit: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const q = query.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    if (!q) return [];
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(q)}#songs`;
    const raw = await this.run(['--flat-playlist', '--playlist-end', String(Math.min(25, Math.max(1, limit))), '-J', '--', url],
      { priority: 2, timeoutMs: 15000, signal, maxBytes: 4 << 20 });
    const json = JSON.parse(raw) as { entries?: Record<string, unknown>[] };
    return (json.entries ?? []).filter(Boolean).slice(0, limit);
  }

  /**
   * Downloads the best audio-only format as published (no re-encoding) into a
   * fresh staging folder and returns the file with yt-dlp's metadata.
   */
  async download(url: string, stagingDir: string, opts: { priority: Priority; signal?: AbortSignal; maxMb?: number; onProgress?: (fraction: number) => void; skipWarm?: boolean; preserveContainer?: boolean }): Promise<{ file: string; info: Record<string, unknown> }> {
    const target = checkedMediaUrl(url);
    await fsp.mkdir(stagingDir, { recursive: true });
    const warmed = opts.skipWarm ? null : this.warmInfo(target);
    const infoFile = path.join(stagingDir, '.source-info.json');
    if (warmed) await fsp.writeFile(infoFile, JSON.stringify(warmed));
    const fields = 'id,title,track,artist,artists,album,uploader,channel,channel_is_verified,duration,ext,acodec,abr,asr,webpage_url,thumbnail,extractor_key,availability,age_limit';
    let raw: string;
    try { raw = await this.run([
      // A growing reader cannot switch byte offsets from WebM into extracted Opus.
      '-f', 'bestaudio/best', ...(opts.preserveContainer ? ['--fixup', 'never'] : ['-x']), '--no-part', '--no-mtime', '--max-filesize', `${opts.maxMb ?? 200}M`,
      '-P', stagingDir, '-o', '%(id)s.%(ext)s', '--print', `after_move:%(.{${fields}})j`, '--print', 'after_move:filepath', '--no-simulate',
      ...(opts.onProgress ? ['--progress', '--newline', '--progress-template', 'download:MORAPROG %(progress._percent_str)s'] : []),
      ...(warmed ? ['--load-info-json', infoFile] : ['--', target]),
    ], { priority: opts.priority, timeoutMs: 180000, signal: opts.signal, maxBytes: 4 << 20, onProgress: opts.onProgress, networkTarget: target });
    } catch (error) {
      this.warm.delete(target);
      if (!warmed || opts.signal?.aborted) throw error;
      const entries = await fsp.readdir(stagingDir, { withFileTypes: true });
      // A growing decoder may already consume audio: never restart a published partial file.
      if (entries.some((e) => e.name !== '.source-info.json')) throw error;
      return this.download(url, stagingDir, { ...opts, skipWarm: true });
    } finally { if (warmed) await fsp.rm(infoFile, { force: true }); }
    const lines = raw.trim().split(/\r?\n/);
    const file = lines.pop()?.trim() ?? '';
    const info = JSON.parse(lines.join('\n') || '{}') as Record<string, unknown>;
    if (!file || path.relative(stagingDir, file).startsWith('..') || !fs.existsSync(file)) throw new ResolverError('Источник не отдал аудио', 'failed');
    return { file, info };
  }
}
