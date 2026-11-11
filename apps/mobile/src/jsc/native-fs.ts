import path from 'path-browserify';
import { Buffer } from 'buffer';
import { Readable, Writable } from 'readable-stream';
import { host } from './host.ts';

/**
 * Node's fs for the server in JavaScriptCore, on the app's real files through moraHost.fs.
 * Same surface as ../worker/opfs-fs.ts (the build swaps one for the other); every call is
 * synchronous underneath, so there is no tree cache and no write queue.
 */

const fsh = host.fs;
const norm = (p: string | URL): string => {
  const s = typeof p === 'string' ? p : p.pathname;
  return path.posix.resolve('/', s.replace(/\\/g, '/'));
};

export async function initFs(): Promise<void> { /* the host's root exists before the server starts */ }
/** Writes reach the file system as they happen. */
export function settled(): Promise<void> { return Promise.resolve(); }

class Stats {
  constructor(private n: { dir: boolean; size: number; mtimeMs: number }) {}
  get size() { return this.n.dir ? 4096 : this.n.size; }
  get mtimeMs() { return this.n.mtimeMs; }
  get ctimeMs() { return this.n.mtimeMs; }
  get birthtimeMs() { return this.n.mtimeMs; }
  get atimeMs() { return this.n.mtimeMs; }
  get mtime() { return new Date(this.n.mtimeMs); }
  get ctime() { return new Date(this.n.mtimeMs); }
  get birthtime() { return new Date(this.n.mtimeMs); }
  get atime() { return new Date(this.n.mtimeMs); }
  get mode() { return this.n.dir ? 0o40755 : 0o100644; }
  isFile() { return !this.n.dir; }
  isDirectory() { return this.n.dir; }
  isSymbolicLink() { return false; }
}

class Dirent {
  constructor(readonly name: string, private dir: boolean, readonly parentPath: string) {}
  get path() { return this.parentPath; }
  isFile() { return !this.dir; }
  isDirectory() { return this.dir; }
  isSymbolicLink() { return false; }
}

function err(code: string, syscall: string, p: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: p, errno: -1 });
}
function statImpl(p0: string | URL): Stats {
  const p = norm(p0);
  const n = fsh.stat(p);
  if (!n) throw err('ENOENT', 'stat', p);
  return new Stats(n);
}
function readdirImpl(p0: string | URL, o?: { withFileTypes?: boolean } | BufferEncoding): (string | Dirent)[] {
  const p = norm(p0);
  const list = fsh.readdir(p).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return typeof o === 'object' && o?.withFileTypes ? list.map((e) => new Dirent(e.name, e.dir, p)) : list.map((e) => e.name);
}

class FileHandle {
  private pos = 0;
  private closed = false;
  constructor(readonly p: string, readonly fd: number, private append: boolean) {}
  private readAt(length: number, at: number): Uint8Array { return fsh.read(this.fd, length, at); }
  async read(buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | null = null): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    const at = position ?? this.pos;
    const got = this.readAt(length, at);
    buffer.set(got, offset);
    if (position == null) this.pos += got.byteLength;
    return { bytesRead: got.byteLength, buffer };
  }
  async write(data: Uint8Array | string, offset = 0, length?: number, position: number | null = null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data.subarray(offset, offset + (length ?? data.byteLength - offset));
    const at = this.append ? fsh.size(this.fd) : position ?? this.pos;
    const n = fsh.write(this.fd, bytes, at);
    if (position == null) this.pos = at + n;
    return { bytesWritten: n, buffer: data };
  }
  async writeFile(data: Uint8Array | string): Promise<void> { await this.write(data); }
  async readFile(enc?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string> {
    const got = this.readAt(fsh.size(this.fd), 0);
    const buf = Buffer.from(got.buffer as ArrayBuffer, got.byteOffset, got.byteLength);
    const e = typeof enc === 'string' ? enc : enc?.encoding;
    return e ? buf.toString(e) : buf;
  }
  async truncate(len = 0): Promise<void> { fsh.truncate(this.fd, len); }
  async stat(): Promise<Stats> { return statImpl(this.p); }
  async sync(): Promise<void> { fsh.sync(this.fd); }
  async datasync(): Promise<void> { fsh.sync(this.fd); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    fsh.close(this.fd);
  }
}

function openSync(p0: string | URL, flags = 'r'): FileHandle {
  const p = norm(p0);
  return new FileHandle(p, fsh.open(p, flags), flags.startsWith('a'));
}
async function openFile(p0: string | URL, flags = 'r'): Promise<FileHandle> { return openSync(p0, flags); }

function createReadStream(p0: string | URL, opts: { start?: number; end?: number; highWaterMark?: number } | string = {}): Readable {
  const p = norm(p0);
  const o = typeof opts === 'string' ? {} : opts;
  let pos = o.start ?? 0;
  const CHUNK = o.highWaterMark ?? 256 * 1024;
  let fd = -1;
  const stream = new Readable({
    highWaterMark: CHUNK,
    read() {
      try {
        if (fd < 0) fd = fsh.open(p, 'r');
        const size = fsh.size(fd);
        const end = Math.min(size, o.end !== undefined ? o.end + 1 : size);
        if (pos >= end) { this.push(null); return; }
        const got = fsh.read(fd, Math.min(CHUNK, end - pos), pos);
        pos += got.byteLength;
        this.push(got.byteLength ? Buffer.from(got.buffer as ArrayBuffer, got.byteOffset, got.byteLength) : null);
      } catch (e) { this.destroy(e as Error); }
    },
    destroy(e: Error | null, cb: (e: Error | null) => void) {
      if (fd >= 0) { try { fsh.close(fd); } catch { /* closed */ } fd = -1; }
      cb(e);
    },
  });
  (stream as Readable & { path: string }).path = p;
  return stream;
}

function createWriteStream(p0: string | URL, opts: { flags?: string } | string = {}): Writable {
  const p = norm(p0);
  const flags = (typeof opts === 'string' ? undefined : opts.flags) ?? 'w';
  let fh: FileHandle | null = null;
  const stream = new Writable({
    write(chunk: Uint8Array | string, _enc: string, cb: (e?: Error) => void) {
      fh!.write(chunk).then(() => cb(), (e) => cb(e as Error));
    },
    final(cb: (e?: Error) => void) {
      fh!.sync().then(() => cb(), (e) => cb(e as Error));
    },
    destroy(e: Error | null, cb: (e: Error | null) => void) {
      const done = () => cb(e);
      if (fh) void fh.close().then(done, done); else done();
    },
  });
  // Node opens eagerly; errors such as a missing folder surface early.
  try { fh = openSync(p, flags); } catch (e) { queueMicrotask(() => stream.destroy(e as Error)); }
  (stream as Writable & { path: string }).path = p;
  return stream;
}

const toBytes = (data: string | Uint8Array | ArrayBuffer, enc?: BufferEncoding): Uint8Array =>
  typeof data === 'string' ? Buffer.from(data, enc ?? 'utf8') : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
const encOf = (o?: BufferEncoding | { encoding?: BufferEncoding | null } | null) => (typeof o === 'string' ? o : o?.encoding ?? undefined);

function readFileSync(p0: string | URL, o?: BufferEncoding | { encoding?: BufferEncoding | null }): Buffer | string {
  const p = norm(p0);
  const fd = fsh.open(p, 'r');
  try {
    const got = fsh.read(fd, fsh.size(fd), 0);
    const buf = Buffer.from(got.buffer as ArrayBuffer, got.byteOffset, got.byteLength);
    const e = encOf(o);
    return e ? buf.toString(e) : buf;
  } finally { fsh.close(fd); }
}
function writeFileSync(p0: string | URL, data: string | Uint8Array | ArrayBuffer, o?: BufferEncoding | { encoding?: BufferEncoding; flag?: string }): void {
  const p = norm(p0);
  const flag = typeof o === 'object' && o?.flag ? o.flag : 'w';
  const fd = fsh.open(p, flag);
  try {
    const bytes = toBytes(data, encOf(o));
    fsh.write(fd, bytes, flag.startsWith('a') ? fsh.size(fd) : 0);
    fsh.sync(fd);
  } finally { fsh.close(fd); }
}

const rmImpl = (p0: string | URL, o?: { recursive?: boolean; force?: boolean }) => fsh.rm(norm(p0), !!o?.recursive, !!o?.force);
const mkdirImpl = (p: string | URL, o?: { recursive?: boolean } | number) => fsh.mkdir(norm(p), typeof o === 'object' && !!o?.recursive);
const utimesImpl = (p: string | URL, _a: unknown, m: number | Date) => fsh.utimes(norm(p), typeof m === 'number' ? m * 1000 : m.getTime());

export const promises = {
  async readFile(p: string | URL, o?: BufferEncoding | { encoding?: BufferEncoding | null }) { return readFileSync(p, o); },
  async writeFile(p: string | URL, data: string | Uint8Array | ArrayBuffer, o?: BufferEncoding | { encoding?: BufferEncoding; flag?: string }) { writeFileSync(p, data, o); },
  async appendFile(p: string, data: string | Uint8Array) { writeFileSync(p, data, { flag: 'a' }); },
  async mkdir(p: string | URL, o?: { recursive?: boolean }) { return mkdirImpl(p, o); },
  async readdir(p: string | URL, o?: { withFileTypes?: boolean }) { return readdirImpl(p, o); },
  async stat(p: string | URL) { return statImpl(p); },
  async lstat(p: string | URL) { return statImpl(p); },
  async access(p: string | URL) { statImpl(p); },
  async rm(p: string | URL, o?: { recursive?: boolean; force?: boolean }) { rmImpl(p, o); },
  async unlink(p: string | URL) { rmImpl(p); },
  async rmdir(p: string | URL, o?: { recursive?: boolean }) { rmImpl(p, o); },
  async rename(a: string | URL, b: string | URL) { fsh.rename(norm(a), norm(b)); },
  async copyFile(a: string | URL, b: string | URL) { fsh.copy(norm(a), norm(b)); },
  async statfs(): Promise<never> { throw err('ENOSYS', 'statfs', '/'); },
  async utimes(p: string | URL, a: unknown, m: number | Date) { utimesImpl(p, a, m); },
  async realpath(p: string | URL) { statImpl(p); return norm(p); },
  open: openFile,
};

type Cb<T = void> = (e: Error | null, v?: T) => void;
const cbify = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => (...args: [...A, Cb<T>] | A) => {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() as Cb<T> : null;
  fn(...(args as A)).then((v) => cb?.(null, v), (e) => cb?.(e as Error));
};

const fs = {
  promises,
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  existsSync(p: string | URL) { try { return !!fsh.stat(norm(p)); } catch { return false; } },
  statSync(p: string | URL, o?: { throwIfNoEntry?: boolean }) {
    try { return statImpl(p); } catch (e) { if (o?.throwIfNoEntry === false) return undefined; throw e; }
  },
  lstatSync(p: string | URL) { return statImpl(p); },
  readdirSync: readdirImpl,
  mkdirSync: mkdirImpl,
  rmSync: rmImpl,
  unlinkSync(p: string | URL) { rmImpl(p); },
  renameSync(a: string | URL, b: string | URL) { fsh.rename(norm(a), norm(b)); },
  realpathSync(p: string | URL) { statImpl(p); return norm(p); },
  accessSync(p: string | URL) { statImpl(p); },
  readFileSync,
  writeFileSync,
  createReadStream,
  createWriteStream,
  stat: cbify(promises.stat),
  lstat: cbify(promises.lstat),
  readdir: cbify(promises.readdir),
  readFile: cbify(promises.readFile),
  writeFile: cbify(promises.writeFile),
  mkdir: cbify(promises.mkdir),
  rm: cbify(promises.rm),
  unlink: cbify(promises.unlink),
  rename: cbify(promises.rename),
  utimes: cbify(promises.utimes),
  access: cbify(promises.access),
  open: cbify(openFile),
  Stats,
  Dirent,
};

export default fs;
