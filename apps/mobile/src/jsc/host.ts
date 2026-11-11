/**
 * The app-process host the server runs on in JavaScriptCore (ios/App/App/NativeServer.swift).
 * Every call is synchronous unless it takes a callback; failures throw an Error with a Node-style `code`.
 * Paths are the server's virtual absolute paths ("/data/automix.sqlite"); the host maps them under its own root.
 */

export type SqlValue = number | string | Uint8Array | null;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

export interface MoraHost {
  log(level: 'debug' | 'info' | 'warn' | 'error', text: string): void;
  /** Server → page/native router: the same FromWorker messages a Web Worker would post. */
  post(message: unknown): void;
  /** Calls globalThis.__moraTimer(id) after `ms`, again every `ms` when `repeat`. */
  timer(id: number, ms: number, repeat: boolean): void;
  clearTimer(id: number): void;
  now(): number;
  random(length: number): Uint8Array;

  fs: {
    stat(path: string): { dir: boolean; size: number; mtimeMs: number } | null;
    readdir(path: string): { name: string; dir: boolean }[];
    /** Returns the first directory it created, like Node's recursive mkdir. */
    mkdir(path: string, recursive: boolean): string | undefined;
    /** Node flags: r, r+, w, w+, wx, a, a+. */
    open(path: string, flags: string): number;
    read(fd: number, length: number, position: number): Uint8Array;
    write(fd: number, data: Uint8Array, position: number): number;
    size(fd: number): number;
    truncate(fd: number, length: number): void;
    sync(fd: number): void;
    close(fd: number): void;
    rm(path: string, recursive: boolean, force: boolean): void;
    rename(from: string, to: string): void;
    copy(from: string, to: string): void;
    utimes(path: string, mtimeMs: number): void;
  };

  /** A real SQLite file. Statements are cached by SQL text in the host, so nothing here needs finalizing. */
  db: {
    open(path: string): number;
    exec(db: number, sql: string): void;
    run(db: number, sql: string, params: SqlParams): { changes: number; lastInsertRowid: number };
    get(db: number, sql: string, params: SqlParams): Record<string, SqlValue> | null;
    all(db: number, sql: string, params: SqlParams): Record<string, SqlValue>[];
    inTransaction(db: number): boolean;
    close(db: number): void;
  };

  /** Decodes an audio file under the server root and analyses it with the app's compiled analyzer (TrackAnalysis).
   *  Fails unless that analyzer is `version`, so results never land under another analyzer's version. */
  analyze(path: string, duration: number, version: string, done: (error: string | null, analysis: unknown) => void, progress: (value: number) => void): number;
  cancelAnalysis(job: number): void;
}

export const host = (globalThis as unknown as { moraHost: MoraHost }).moraHost;
