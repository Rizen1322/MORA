/** Declarations for modules without bundled types, and the build-time aliases in build.mjs. */

declare const __MORA_DEV__: boolean;

declare module 'path-browserify' {
  interface Path {
    join(...p: string[]): string;
    resolve(...p: string[]): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    extname(p: string): string;
    relative(from: string, to: string): string;
    isAbsolute(p: string): boolean;
    normalize(p: string): string;
    sep: string;
    posix: Path;
  }
  const path: Path;
  export default path;
}

declare module 'readable-stream' {
  // Same API as node:stream; the app only needs it loosely typed.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export class Readable {
    constructor(opts?: any);
    [k: string]: any;
    static from(it: any, opts?: any): Readable;
  }
  export class Writable {
    constructor(opts?: any);
    [k: string]: any;
  }
  export function pipeline(...args: any[]): any;
  export function finished(...args: any[]): any;
}

declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export interface Statement {
    run(values?: SqlValue[] | Record<string, SqlValue>): void;
    bind(values?: SqlValue[] | Record<string, SqlValue>): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    reset(): void;
    free(): boolean;
  }
  export interface Database {
    exec(sql: string): { columns: string[]; values: SqlValue[][] }[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}

type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'ucs2' | 'utf16le';

declare module 'events' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export class EventEmitter {
    on(ev: string, fn: (...a: any[]) => void): this;
    once(ev: string, fn: (...a: any[]) => void): this;
    off(ev: string, fn: (...a: any[]) => void): this;
    removeListener(ev: string, fn: (...a: any[]) => void): this;
    emit(ev: string, ...a: any[]): boolean;
  }
  export default EventEmitter;
}

declare module 'orig-ytdlp' {
  export type Priority = 0 | 1 | 2 | 3;
  export interface YtDlpConfig { bin: string | null; jsRuntime: string | null; runtimeIsElectron: boolean; ffmpegDir: string | null; cacheDir: string; concurrency: number; proxies?: { youtube?: string; soundcloud?: string } }
  export class ResolverError extends Error {
    constructor(message: string, kind: 'unavailable' | 'timeout' | 'cancelled' | 'not-installed' | 'too-large' | 'failed' | 'auth');
    readonly kind: 'unavailable' | 'timeout' | 'cancelled' | 'not-installed' | 'too-large' | 'failed' | 'auth';
  }
  export function classifyError(stderr: string): ResolverError;
  export function checkedMediaUrl(value: string): string;
}

declare module 'orig-soundcloud' {
  export function parseSoundCloudSearch(value: unknown, limit: number): Record<string, unknown>[];
}

/** apps/server, resolved by the bundler; typechecked in its own project. */
declare module 'mora-server/app' {
  export function createApp(overrides: Record<string, unknown>, opts?: { logger?: boolean; startWorkers?: boolean }): Promise<{ app: unknown; services: { db: unknown }; close: () => Promise<void> }>;
}
declare module 'mora-server/db' {
  export function kvGet<T>(db: unknown, key: string, fallback: T): T;
  export function kvSet(db: unknown, key: string, value: unknown): void;
}
declare module 'mora-server/native-sources' {
  export function registerNativeSources(app: unknown, services: unknown): void;
}
