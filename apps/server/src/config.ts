import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The desktop shell points ROOT at its resources folder (bundled tools/*.py).
export const ROOT = process.env.AUTOMIX_ROOT || path.resolve(here, '../../..');

/** Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
if (!process.env.AUTOMIX_DESKTOP) loadDotEnv(path.join(ROOT, '.env'));

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  /** Required when listening on a non-loopback interface. */
  accessToken: string | null;
  pcmCacheBytes: number;
  /** How decoded playback PCM is stored. 's16le' (phone) halves the flash writes; reads are float either way. */
  pcmCacheFormat?: 'f32le' | 's16le';
  stemsCacheBytes?: number;
  analysisWorkers: number;
  /** false: analyze only what is about to play (phone: whole-library analysis heats it up). */
  backgroundAnalysis?: boolean;
  webDist: string;
  jamendoClientId: string | null;
  audiusApiKey: string | null;
  ffmpeg: string;
  ffprobe: string;
  /** Optional Python with CUDA/CPU torch + torchaudio. No audio is uploaded. */
  stemsPython: string | null;
  /** Read-only pretrained model directory shipped with the CPU runtime. */
  stemsModels?: string | null;
  /** yt-dlp for public YouTube/SoundCloud recordings; null disables those sources. */
  ytdlp: string | null;
  /** "node:<path>" JS runtime for yt-dlp challenge solving. */
  ytdlpJsRuntime: string | null;
  ytdlpRuntimeIsElectron: boolean;
  publicProxies?: { youtube?: string; soundcloud?: string };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const dataDir = path.resolve(ROOT, env.AUTOMIX_DATA_DIR ?? 'data');
  const bundled = bundledVocals(ROOT);
  return {
    dataDir,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4730),
    accessToken: env.ACCESS_TOKEN || null,
    pcmCacheBytes: Number(env.PCM_CACHE_MB ?? 512) * 1024 * 1024,
    stemsCacheBytes: Number(env.STEMS_CACHE_MB ?? 2048) * 1024 * 1024,
    analysisWorkers: Number(env.ANALYSIS_WORKERS ?? 2),
    webDist: env.AUTOMIX_WEB_DIST || path.join(ROOT, 'apps/web/dist'),
    jamendoClientId: env.JAMENDO_CLIENT_ID || null,
    audiusApiKey: env.AUDIUS_API_KEY || null,
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    stemsPython: env.STEMS_PYTHON || bundled?.python || null,
    stemsModels: env.STEMS_PYTHON ? null : bundled?.models || null,
    publicProxies: { youtube: env.AUTOMIX_YOUTUBE_PROXY, soundcloud: env.AUTOMIX_SOUNDCLOUD_PROXY },
    ytdlp: env.YTDLP_PATH ?? defaultYtDlp(),
    // This process's own runtime solves yt-dlp's JS challenges: Node in the browser
    // version, the app's Electron binary (in Node mode) on the desktop.
    ytdlpJsRuntime: env.YTDLP_JS_RUNTIME ?? `node:${process.execPath}`,
    ytdlpRuntimeIsElectron: env.YTDLP_JS_RUNTIME ? env.YTDLP_RUNTIME_ELECTRON === '1' : !!process.versions.electron,
    ...overrides,
  };
}

/** Missing/incomplete optional resources must never claim a working vocal model. */
export function bundledVocals(root: string): { python: string; models: string } | null {
  const pack = path.join(root, 'vocal');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'pack.json'), 'utf8'));
    const python = path.join(pack, 'python.exe'), models = path.join(pack, 'models');
    if (manifest.version !== 'mora-vocal-cpu-1' || !fs.statSync(python).isFile()
      || fs.statSync(path.join(models, 'hub/torchaudio/models/hdemucs_high_trained.pt')).size !== 334697255) return null;
    return { python, models };
  } catch { return null; }
}

function defaultYtDlp(): string {
  const vendored = path.join(ROOT, 'apps', 'desktop', 'vendor', 'yt-dlp', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return fs.existsSync(vendored) ? vendored : 'yt-dlp';
}

export function ensureDirs(cfg: AppConfig): void {
  for (const d of ['library', 'covers', 'cache/pcm', 'incoming', 'remote', 'session-cache']) {
    fs.mkdirSync(path.join(cfg.dataDir, d), { recursive: true });
  }
}
