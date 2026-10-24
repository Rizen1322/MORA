import path from 'path-browserify';
import { Buffer } from 'buffer';
import { Readable, Writable } from 'readable-stream';

/**
 * Node's fs on the Origin Private File System, for the server running in a worker.
 * The tree (names, sizes, times) lives in memory so the sync calls the server makes
 * (existsSync, statSync, readdirSync, mkdirSync, rmSync) answer at once; changes reach
 * OPFS through one ordered queue. File bytes go through FileSystemSyncAccessHandle,
 * shared per file because WebKit allows only one open handle at a time.
 */

type FileNode = { kind: 'file'; size: number; mtime: number };
type DirNode = { kind: 'dir'; mtime: number; children: Map<string, Node> };
type Node = FileNode | DirNode;

interface SyncHandle {
  read(buf: ArrayBufferView, opts?: { at?: number }): number;
  write(buf: ArrayBufferView, opts?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

const tree: DirNode = { kind: 'dir', mtime: Date.now(), children: new Map() };
let opfsRoot: FileSystemDirectoryHandle;

function err(code: string, syscall: string, p: string): Error {
  const msg = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', ENOSYS: 'function not implemented', EBUSY: 'resource busy' }[code] ?? code;
  return Object.assign(new Error(`${code}: ${msg}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -1 });
}

const norm = (p: string | URL): string => {
  const s = typeof p === 'string' ? p : p.pathname;
  return path.posix.resolve('/', s.replace(/\\/g, '/'));
};
const parts = (p: string): string[] => p.split('/').filter(Boolean);

function lookup(p: string): Node | null {
  let n: Node = tree;
  for (const seg of parts(p)) {
    if (n.kind !== 'dir') return null;
    const c = n.children.get(seg);
    if (!c) return null;
    n = c;
  }
  return n;
}

function parentOf(p: string, syscall: string): DirNode {
  const d = lookup(path.posix.dirname(p));
  if (!d) throw err('ENOENT', syscall, p);
  if (d.kind !== 'dir') throw err('ENOTDIR', syscall, p);
  return d;
}

// ---------- the ordered OPFS queue ----------

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch((e) => console.warn('[fs]', (e as Error).message));
  return p;
}
/** Resolves once every queued change has reached OPFS. */
export function settled(): Promise<void> {
  return chain.then(() => {});
}

const dirHandles = new Map<string, FileSystemDirectoryHandle>();
async function dirHandle(p: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  if (p === '/') return opfsRoot;
  const hit = dirHandles.get(p);
  if (hit) return hit;
  const parent = await dirHandle(path.posix.dirname(p), create);
  const h = await parent.getDirectoryHandle(path.posix.basename(p), { create });
  dirHandles.set(p, h);
  return h;
}
async function fileHandle(p: string, create: boolean): Promise<FileSystemFileHandle> {
  const d = await dirHandle(path.posix.dirname(p), create);
  return d.getFileHandle(path.posix.basename(p), { create });
}

// ---------- shared access handles ----------

/** dirty: written since the last flush. A read-only use (every PCM chunk while playing) needs no flush. */
interface Open { h: SyncHandle; refs: number; used: number; dirty: boolean }
const open = new Map<string, Open>();
const opening = new Map<string, Promise<Open>>();
const MAX_IDLE_OPEN = 24;

async function acquire(p: string): Promise<Open> {
  const hit = open.get(p);
  if (hit) { hit.refs++; hit.used = Date.now(); return hit; }
  let o = opening.get(p);
  if (!o) {
    o = enqueue(async () => {
      const fh = await fileHandle(p, true);
      const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      const entry: Open = { h, refs: 0, used: Date.now(), dirty: false };
      open.set(p, entry);
      return entry;
    }).finally(() => opening.delete(p));
    opening.set(p, o);
  }
  const entry = await o;
  entry.refs++;
  entry.used = Date.now();
  return entry;
}

function release(p: string, o: Open): void {
  o.refs = Math.max(0, o.refs - 1);
  if (o.refs) return;
  if (o.dirty) { try { o.h.flush(); o.dirty = false; } catch { /* closed meanwhile */ } }
  const idle = [...open.entries()].filter(([, e]) => !e.refs);
  if (idle.length > MAX_IDLE_OPEN) {
    idle.sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of idle.slice(0, idle.length - MAX_IDLE_OPEN)) closeHandle(k, e);
  }
}

function closeHandle(p: string, e: Open): void {
  try { e.h.close(); } catch { /* already closed */ }
  if (open.get(p) === e) open.delete(p);
}

/**
 * Takes handles under `p` out of the shared map at once, so a file recreated at
 * the same path never writes into a handle that is about to be closed.
 */
function detachUnder(p: string): Open[] {
  const prefix = `${p}/`;
  const out: Open[] = [];
  for (const [k, e] of [...open]) if (k === p || k.startsWith(prefix)) { open.delete(k); out.push(e); }
  return out;
}

/** Closes detached handles, waiting a while for their readers to finish. */
async function closeDetached(list: Open[]): Promise<void> {
  for (let i = 0; i < 100 && list.some((e) => e.refs); i++) await new Promise((r) => setTimeout(r, 50));
  for (const e of list) { try { e.h.close(); } catch { /* already closed */ } }
}

// ---------- boot ----------

export async function initFs(rootName = 'mora'): Promise<void> {
  const top = await navigator.storage.getDirectory();
  opfsRoot = await top.getDirectoryHandle(rootName, { create: true });
  dirHandles.clear();
  tree.children.clear();
  const walk = async (h: FileSystemDirectoryHandle, node: DirNode, p: string) => {
    for await (const [name, child] of (h as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      const cp = path.posix.join(p, name);
      if (child.kind === 'directory') {
        const d: DirNode = { kind: 'dir', mtime: Date.now(), children: new Map() };
        node.children.set(name, d);
        dirHandles.set(cp, child as FileSystemDirectoryHandle);
        await walk(child as FileSystemDirectoryHandle, d, cp);
      } else {
        try {
          const f = await (child as FileSystemFileHandle).getFile();
          node.children.set(name, { kind: 'file', size: f.size, mtime: f.lastModified });
        } catch { node.children.set(name, { kind: 'file', size: 0, mtime: Date.now() }); }
      }
    }
  };
  await walk(opfsRoot, tree, '/');
}

// ---------- tree operations ----------

class Stats {
  constructor(private n: Node) {}
  get size() { return this.n.kind === 'file' ? this.n.size : 4096; }
  get mtimeMs() { return this.n.mtime; }
  get ctimeMs() { return this.n.mtime; }
  get birthtimeMs() { return this.n.mtime; }
  get atimeMs() { return this.n.mtime; }
  get mtime() { return new Date(this.n.mtime); }
  get ctime() { return new Date(this.n.mtime); }
  get birthtime() { return new Date(this.n.mtime); }
  get atime() { return new Date(this.n.mtime); }
  get mode() { return this.n.kind === 'dir' ? 0o40755 : 0o100644; }
  isFile() { return this.n.kind === 'file'; }
  isDirectory() { return this.n.kind === 'dir'; }
  isSymbolicLink() { return false; }
}

class Dirent {
  constructor(readonly name: string, private n: Node, readonly parentPath: string) {}
  get path() { return this.parentPath; }
  isFile() { return this.n.kind === 'file'; }
  isDirectory() { return this.n.kind === 'dir'; }
  isSymbolicLink() { return false; }
}

function mkdirTree(p: string, recursive: boolean): string | undefined {
  const segs = parts(p);
  let n: DirNode = tree, cur = '/', first: string | undefined;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    cur = path.posix.join(cur, seg);
    const c = n.children.get(seg);
    if (c) {
      if (c.kind !== 'dir') throw err('ENOTDIR', 'mkdir', p);
      if (i === segs.length - 1 && !recursive) throw err('EEXIST', 'mkdir', p);
      n = c;
      continue;
    }
    if (!recursive && i < segs.length - 1) throw err('ENOENT', 'mkdir', p);
    const d: DirNode = { kind: 'dir', mtime: Date.now(), children: new Map() };
    n.children.set(seg, d);
    first ??= cur;
    n = d;
  }
  if (first) enqueue(() => dirHandle(p, true));
  return first;
}

function touchFile(p: string, truncate: boolean, exclusive = false): FileNode {
  const parent = parentOf(p, 'open');
  const name = path.posix.basename(p);
  const c = parent.children.get(name);
  if (c?.kind === 'dir') throw err('EISDIR', 'open', p);
  if (c && exclusive) throw err('EEXIST', 'open', p);
  if (c) { if (truncate) { c.size = 0; c.mtime = Date.now(); } return c; }
  const f: FileNode = { kind: 'file', size: 0, mtime: Date.now() };
  parent.children.set(name, f);
  return f;
}

function rmTree(p: string, opts: { recursive?: boolean; force?: boolean } = {}): boolean {
  const n = lookup(p);
  if (!n) { if (opts.force) return false; throw err('ENOENT', 'rm', p); }
  if (n.kind === 'dir' && n.children.size && !opts.recursive) throw err('ENOTEMPTY', 'rm', p);
  if (p === '/') throw err('EBUSY', 'rm', p);
  parentOf(p, 'rm').children.delete(path.posix.basename(p));
  const prefix = `${p}/`;
  for (const k of [...dirHandles.keys()]) if (k === p || k.startsWith(prefix)) dirHandles.delete(k);
  return true;
}

function persistRm(p: string): Promise<void> {
  const detached = detachUnder(p);
  return enqueue(async () => {
    // also handles whose open was queued before this removal
    await closeDetached([...detached, ...detachUnder(p)]);
    try {
      const d = await dirHandle(path.posix.dirname(p), false);
      await d.removeEntry(path.posix.basename(p), { recursive: true });
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  });
}

async function copyBytes(from: string, to: string): Promise<void> {
  const src = await (await fileHandle(from, false)).getFile();
  const dst = await (await fileHandle(to, true) as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  try {
    dst.truncate(0);
    const CHUNK = 4 << 20;
    for (let at = 0; at < src.size; at += CHUNK) dst.write(new Uint8Array(await src.slice(at, at + CHUNK).arrayBuffer()), { at });
    dst.flush();
  } finally { dst.close(); }
}

async function moveEntry(from: string, to: string, isDir: boolean): Promise<void> {
  if (isDir) {
    const src = await dirHandle(from, false);
    await dirHandle(to, true);
    for await (const [name, child] of (src as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      await moveEntry(path.posix.join(from, name), path.posix.join(to, name), child.kind === 'directory');
    }
  } else {
    const fh = await fileHandle(from, false) as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
    let moved = false;
    if (typeof fh.move === 'function') {
      try {
        const dest = await dirHandle(path.posix.dirname(to), true);
        try { await dest.removeEntry(path.posix.basename(to)); } catch { /* absent */ }
        await fh.move(dest, path.posix.basename(to));
        moved = true;
      } catch { /* fall back to copying */ }
    }
    if (!moved) await copyBytes(from, to);
  }
  if (!isDir) {
    try { await (await dirHandle(path.posix.dirname(from), false)).removeEntry(path.posix.basename(from)); } catch { /* moved */ }
  } else {
    try { await (await dirHandle(path.posix.dirname(from), false)).removeEntry(path.posix.basename(from), { recursive: true }); } catch { /* gone */ }
    for (const k of [...dirHandles.keys()]) if (k === from || k.startsWith(`${from}/`)) dirHandles.delete(k);
  }
}

function renameSyncImpl(a: string, b: string): Promise<void> {
  const n = lookup(a);
  if (!n) throw err('ENOENT', 'rename', a);
  const dest = parentOf(b, 'rename');
  const existing = dest.children.get(path.posix.basename(b));
  if (existing?.kind === 'dir' && n.kind === 'file') throw err('EISDIR', 'rename', b);
  parentOf(a, 'rename').children.delete(path.posix.basename(a));
  dest.children.set(path.posix.basename(b), n);
  n.mtime = Date.now();
  const detached = [...detachUnder(a), ...detachUnder(b)];
  return enqueue(async () => {
    await closeDetached([...detached, ...detachUnder(a), ...detachUnder(b)]);
    await moveEntry(a, b, n.kind === 'dir');
  });
}

// ---------- FileHandle (fs/promises.open) ----------

class FileHandle {
  private pos = 0;
  private closed = false;
  constructor(readonly p: string, private node: FileNode, private o: Open, private append: boolean) {
    if (append) this.pos = node.size;
  }
  async read(buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | null = null): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    const at = position ?? this.pos;
    const n = this.o.h.read(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length), { at });
    if (position == null) this.pos += n;
    return { bytesRead: n, buffer };
  }
  async write(data: Uint8Array | string, offset = 0, length?: number, position: number | null = null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    const view = typeof data === 'string' ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length ?? bytes.byteLength - offset);
    const at = this.append ? this.node.size : position ?? this.pos;
    const n = this.o.h.write(view, { at });
    this.o.dirty = true;
    if (position == null) this.pos = at + n;
    this.node.size = Math.max(this.node.size, at + n);
    this.node.mtime = Date.now();
    return { bytesWritten: n, buffer: data };
  }
  async writeFile(data: Uint8Array | string): Promise<void> { await this.write(data); }
  async readFile(enc?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string> {
    const size = this.o.h.getSize();
    const buf = Buffer.alloc(size);
    this.o.h.read(buf, { at: 0 });
    const e = typeof enc === 'string' ? enc : enc?.encoding;
    return e ? buf.toString(e) : buf;
  }
  async truncate(len = 0): Promise<void> { this.o.h.truncate(len); this.o.dirty = true; this.node.size = len; }
  async stat(): Promise<Stats> { return new Stats(this.node); }
  async sync(): Promise<void> { this.o.h.flush(); this.o.dirty = false; }
  async datasync(): Promise<void> { await this.sync(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    release(this.p, this.o);
  }
}

async function openFile(p0: string | URL, flags: string = 'r'): Promise<FileHandle> {
  const p = norm(p0);
  const existing = lookup(p);
  let node: FileNode;
  if (flags.startsWith('r')) {
    if (!existing) throw err('ENOENT', 'open', p);
    if (existing.kind === 'dir') throw err('EISDIR', 'open', p);
    node = existing;
  } else node = touchFile(p, flags.startsWith('w'), flags.includes('x'));
  const o = await acquire(p);
  if (flags.startsWith('w')) { o.h.truncate(0); o.dirty = true; }
  return new FileHandle(p, node, o, flags.startsWith('a'));
}

// ---------- streams ----------

function createReadStream(p0: string | URL, opts: { start?: number; end?: number; highWaterMark?: number } | string = {}): Readable {
  const p = norm(p0);
  const o = typeof opts === 'string' ? {} : opts;
  let pos = o.start ?? 0;
  const CHUNK = o.highWaterMark ?? 256 * 1024;
  let handle: Open | null = null;
  const stream = new Readable({
    highWaterMark: CHUNK,
    async read() {
      try {
        if (!handle) {
          const n = lookup(p);
          if (!n || n.kind !== 'file') throw err('ENOENT', 'open', p);
          handle = await acquire(p);
        }
        const size = handle.h.getSize();
        const end = Math.min(size, o.end !== undefined ? o.end + 1 : size);
        if (pos >= end) { this.push(null); return; }
        const buf = Buffer.alloc(Math.min(CHUNK, end - pos));
        const n = handle.h.read(buf, { at: pos });
        pos += n;
        this.push(n ? buf.subarray(0, n) : null);
      } catch (e) { this.destroy(e as Error); }
    },
    destroy(e: Error | null, cb: (e: Error | null) => void) {
      if (handle) { release(p, handle); handle = null; }
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
  let opened: Promise<FileHandle> | null = null;
  const ensure = () => (opened ??= openFile(p, flags).then((h) => (fh = h)));
  const stream = new Writable({
    async write(chunk: Uint8Array | string, _enc: string, cb: (e?: Error) => void) {
      try { await (await ensure()).write(chunk); cb(); } catch (e) { cb(e as Error); }
    },
    async final(cb: (e?: Error) => void) {
      try { const h = await ensure(); await h.sync(); cb(); } catch (e) { cb(e as Error); }
    },
    destroy(e: Error | null, cb: (e: Error | null) => void) {
      const done = () => cb(e);
      if (fh) void fh.close().then(done, done);
      else if (opened) void opened.then((h) => h.close()).then(done, done);
      else done();
    },
  });
  // Node opens eagerly; errors such as a missing folder surface early.
  void ensure().catch((e) => stream.destroy(e));
  (stream as Writable & { path: string }).path = p;
  return stream;
}

// ---------- public API ----------

const toBytes = (data: string | Uint8Array | ArrayBuffer, enc?: BufferEncoding): Uint8Array =>
  typeof data === 'string' ? Buffer.from(data, enc ?? 'utf8') : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
const encOf = (o?: BufferEncoding | { encoding?: BufferEncoding | null } | null) => (typeof o === 'string' ? o : o?.encoding ?? undefined);

async function readFile(p0: string | URL, o?: BufferEncoding | { encoding?: BufferEncoding | null }): Promise<Buffer | string> {
  const fh = await openFile(p0, 'r');
  try { return await fh.readFile(encOf(o) ?? undefined); } finally { await fh.close(); }
}

async function writeFile(p0: string | URL, data: string | Uint8Array | ArrayBuffer, o?: BufferEncoding | { encoding?: BufferEncoding; flag?: string }): Promise<void> {
  const flag = typeof o === 'object' && o?.flag ? o.flag : 'w';
  const fh = await openFile(p0, flag);
  try { await fh.write(toBytes(data, encOf(o))); await fh.sync(); } finally { await fh.close(); }
}

function readdirImpl(p0: string | URL, o?: { withFileTypes?: boolean } | BufferEncoding): (string | Dirent)[] {
  const p = norm(p0);
  const n = lookup(p);
  if (!n) throw err('ENOENT', 'scandir', p);
  if (n.kind !== 'dir') throw err('ENOTDIR', 'scandir', p);
  const names = [...n.children.keys()].sort();
  return typeof o === 'object' && o?.withFileTypes ? names.map((name) => new Dirent(name, n.children.get(name)!, p)) : names;
}

function statImpl(p0: string | URL): Stats {
  const p = norm(p0);
  const n = lookup(p);
  if (!n) throw err('ENOENT', 'stat', p);
  return new Stats(n);
}

export const promises = {
  readFile,
  writeFile,
  async appendFile(p: string, data: string | Uint8Array) { await writeFile(p, data, { flag: 'a' }); },
  async mkdir(p: string | URL, o?: { recursive?: boolean }) { return mkdirTree(norm(p), !!o?.recursive); },
  async readdir(p: string | URL, o?: { withFileTypes?: boolean }) { return readdirImpl(p, o); },
  async stat(p: string | URL) { return statImpl(p); },
  async lstat(p: string | URL) { return statImpl(p); },
  async access(p: string | URL) { statImpl(p); },
  async rm(p0: string | URL, o?: { recursive?: boolean; force?: boolean }) {
    const p = norm(p0);
    if (rmTree(p, o)) await persistRm(p);
  },
  async unlink(p0: string | URL) { const p = norm(p0); if (rmTree(p)) await persistRm(p); },
  async rmdir(p0: string | URL, o?: { recursive?: boolean }) { const p = norm(p0); if (rmTree(p, o)) await persistRm(p); },
  async rename(a: string | URL, b: string | URL) { await renameSyncImpl(norm(a), norm(b)); },
  async copyFile(a0: string | URL, b0: string | URL) {
    const a = norm(a0), b = norm(b0);
    const n = lookup(a);
    if (!n || n.kind !== 'file') throw err('ENOENT', 'copyfile', a);
    const f = touchFile(b, true);
    f.size = n.size;
    const detached = [...detachUnder(a), ...detachUnder(b)];
    await enqueue(async () => { await closeDetached(detached); await copyBytes(a, b); });
  },
  async statfs(): Promise<never> { throw err('ENOSYS', 'statfs', '/'); },
  async utimes(p: string | URL, _a: unknown, m: number | Date) {
    const n = lookup(norm(p));
    if (n) n.mtime = typeof m === 'number' ? m * 1000 : m.getTime();
  },
  async realpath(p: string | URL) { return norm(p); },
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
  existsSync(p: string | URL) { try { return !!lookup(norm(p)); } catch { return false; } },
  statSync(p: string | URL, o?: { throwIfNoEntry?: boolean }) {
    try { return statImpl(p); } catch (e) { if (o?.throwIfNoEntry === false) return undefined; throw e; }
  },
  lstatSync(p: string | URL) { return statImpl(p); },
  readdirSync: readdirImpl,
  mkdirSync(p: string | URL, o?: { recursive?: boolean } | number) { return mkdirTree(norm(p), typeof o === 'object' && !!o?.recursive); },
  rmSync(p0: string | URL, o?: { recursive?: boolean; force?: boolean }) { const p = norm(p0); if (rmTree(p, o)) void persistRm(p); },
  unlinkSync(p0: string | URL) { const p = norm(p0); if (rmTree(p)) void persistRm(p); },
  renameSync(a: string | URL, b: string | URL) { void renameSyncImpl(norm(a), norm(b)); },
  realpathSync(p: string | URL) { if (!lookup(norm(p))) throw err('ENOENT', 'realpath', norm(p)); return norm(p); },
  accessSync(p: string | URL) { statImpl(p); },
  readFileSync(p0: string | URL, o?: BufferEncoding | { encoding?: BufferEncoding | null }) {
    // Only files with an open shared handle can be read synchronously.
    const p = norm(p0);
    const n = lookup(p);
    if (!n) throw err('ENOENT', 'open', p);
    const h = open.get(p);
    if (!h) throw err('ENOSYS', 'open', p);
    const buf = Buffer.alloc(h.h.getSize());
    h.h.read(buf, { at: 0 });
    const e = encOf(o);
    return e ? buf.toString(e) : buf;
  },
  writeFileSync(p0: string | URL, data: string | Uint8Array, o?: BufferEncoding | { encoding?: BufferEncoding }) {
    const p = norm(p0);
    const bytes = toBytes(data, encOf(o)).slice();
    const f = touchFile(p, true);
    f.size = bytes.byteLength;
    void writeFile(p, bytes);
  },
  createReadStream,
  createWriteStream,
  stat: cbify(async (p: string | URL) => statImpl(p)),
  lstat: cbify(async (p: string | URL) => statImpl(p)),
  readdir: cbify(async (p: string | URL, o?: { withFileTypes?: boolean }) => readdirImpl(p, o)),
  readFile: cbify(readFile),
  writeFile: cbify(writeFile),
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
