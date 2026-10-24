import type { SourceRow } from '../library.ts';

export interface Capabilities {
  search: boolean;
  library: boolean;
  playlists: boolean;
  recommendations: boolean;
  playback: boolean;
  seek: boolean;
  /** Raw PCM is available to our engine. */
  pcm: boolean;
  /** Audio analysis supported by this adapter; unofficial integrations are labelled separately. */
  analysis: boolean;
  /** Adapter supports PCM processing. Does not assert a licence from the service. */
  mixing: boolean;
  caching: 'persistent' | 'session' | 'none';
}

export type ProviderStatus = 'connected' | 'needs_credentials' | 'unavailable' | 'not_supported' | 'error' | 'disabled';

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'local' | 'self-hosted' | 'catalog' | 'unofficial' | 'restricted';
  official: boolean;
  capabilities: Capabilities;
  status: ProviderStatus;
  statusText: string;
  notes: string[];
  docs: string[];
  configFields: ConfigField[];
  config: Record<string, string>;
  hasSecret: boolean;
  account?: string | null;
  checkedAt: number;
}

export interface ExternalTrack {
  externalId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string | null;
  pageUrl: string | null;
  license: string | null;
  playable: boolean;
  /** Already in the library as this track id. */
  libraryTrackId?: string | null;
}

export interface Provider {
  nativeSource?(src: SourceRow): Promise<import('@automix/core/native-preparation.ts').NativeMediaSource>;
  readonly id: string;
  info(force?: boolean): Promise<ProviderInfo>;
  capabilities(): Capabilities;
  connect?(config: Record<string, string>, secret: Record<string, string>): Promise<void>;
  disconnect?(): Promise<void>;
  search?(query: string): Promise<ExternalTrack[]>;
  featured?(): Promise<ExternalTrack[]>;
  importTrack?(t: ExternalTrack): Promise<string>;
  fetchAudio?(src: SourceRow, signal?: AbortSignal): Promise<string>;
}

export const NO_CAPS: Capabilities = {
  search: false,
  library: false,
  playlists: false,
  recommendations: false,
  playback: false,
  seek: false,
  pcm: false,
  analysis: false,
  mixing: false,
  caching: 'none',
};

export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: T | null; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 12000) });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const downloads = new Map<string, Promise<void>>();

/** Downloads a URL to a file, never logging the URL (it may contain credentials). Concurrent calls for one file share a transfer. */
export function downloadTo(url: string, file: string, maxBytes = 1024 * 1024 * 1024): Promise<void> {
  let running = downloads.get(file);
  if (!running) {
    running = download(url, file, maxBytes).finally(() => downloads.delete(file));
    downloads.set(file, running);
  }
  return running;
}

async function download(url: string, file: string, maxBytes: number): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { mkdir, rm, rename } = await import('node:fs/promises');
  const { pipeline } = await import('node:stream/promises');
  const { randomUUID } = await import('node:crypto');
  const path = await import('node:path');
  await mkdir(path.dirname(file), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok || !res.body) throw new Error(`сервер источника ответил ${res.status}`);
  const part = `${file}.${randomUUID()}.part`;
  try {
    let n = 0;
    await pipeline(res.body, async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        n += chunk.length;
        if (n > maxBytes) throw new Error('файл слишком большой');
        yield chunk;
      }
    }, createWriteStream(part));
    await rename(part, file);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}

/** Normalizes artist/title for fuzzy matching across catalogs. */
export function normKey(artist: string, title: string): string {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/\b(feat|ft|featuring)\b.*$/g, ' ')
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return `${n(artist.split(/,|&| и | x /)[0] ?? artist)}|${n(title)}`;
}
