// Times Yandex "Listen" (POST /api/providers/yandex/import) stage by stage, with the Rust and Node transfers.
// Read-only: track metadata, download-info, audio and cover only. Never sends reactions or likes.
// The token comes from MORA_YANDEX_TOKEN, stays in memory and is never written or printed.
// Usage (PowerShell):
//   $s = Read-Host -AsSecureString 'Yandex token'
//   $env:MORA_YANDEX_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
//   npx tsx tools/measure-yandex-listen.mts 12345678:9012345 23456789
//   Remove-Item Env:MORA_YANDEX_TOKEN
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MORA_YANDEX_TOKEN?.trim().replace(/^OAuth\s+/i, '');
delete process.env.MORA_YANDEX_TOKEN;
const ids = process.argv.slice(2);
if (!token || !/^\S{16,8192}$/.test(token)) { console.error('Set MORA_YANDEX_TOKEN first.'); process.exit(2); }
if (!ids.length || ids.some(id => !/^\d+(?::\d+)?$/.test(id))) { console.error('Pass Yandex track ids, e.g. 12345678:9012345'); process.exit(2); }

const build = path.join(repo, 'apps/desktop-tauri/build');
Object.assign(process.env, {
  AUTOMIX_DESKTOP: '1', FFMPEG_PATH: path.join(build, 'ffmpeg/ffmpeg.exe'), FFPROBE_PATH: path.join(build, 'ffmpeg/ffprobe.exe'),
  AUTOMIX_DECODER_RUST: path.join(build, 'decoder/mora-decode.exe'), YTDLP_PATH: path.join(build, 'yt-dlp/yt-dlp.exe'),
});
const load = (p: string) => import(pathToFileURL(path.join(repo, p)).href);
const { createRustNetwork, configureRustNetwork } = await load('apps/server/src/rust-network.ts');
const { createApp } = await load('apps/server/src/app.ts');
const network = await createRustNetwork(path.join(build, 'network/mora-network.exe'), {});
// Errors are reported without the token, URLs or account details.
const clean = (e: unknown) => String((e as Error)?.message ?? e).split(token).join('<token>').replace(/https?:\/\/\S+/g, '<url>');

const rows = [];
try {
  for (const transport of ['rust', 'node'] as const) {
    configureRustNetwork(transport === 'rust' ? network : null);
    // A fresh profile per transport, so neither run reuses the other's downloaded file.
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `mora-yandex-${transport}-`));
    const { app, services, close } = await createApp({ dataDir: data }, { startWorkers: false });
    const yandex = services.providers.yandex as any;
    yandex.token = () => token;
    let t0 = 0; const marks: string[] = [];
    const mark = (s: string) => marks.push(`${Math.round(performance.now() - t0)}ms ${s}`);
    const wrap = (target: any, name: string, label: (...a: any[]) => string) => {
      const original = target[name].bind(target);
      target[name] = (...a: any[]) => { const l = label(...a); mark(`${l} start`); return Promise.resolve(original(...a)).then(
        (v: unknown) => { mark(`${l} done`); return v; }, (e: unknown) => { mark(`${l} failed`); throw e; }); };
    };
    wrap(yandex, 'call', (_m: string, p: string) => p.includes('download-info') ? 'download-info' : p.split('?')[0]);
    wrap(yandex.audio, 'response', (_u: string, timeout: number) => timeout === 4000 ? 'cover' : timeout === 15000 ? 'download XML' : 'audio (Node)');
    wrap(yandex.audio.ff, 'probe', () => 'ffprobe');
    wrap(services.lib, 'saveCover', () => 'save cover');
    try {
      for (const id of ids) {
        marks.length = 0; t0 = performance.now();
        const r = await app.inject({ method: 'POST', url: '/api/providers/yandex/import', payload: { track: { externalId: id, title: '', artist: '', album: '', duration: 0, coverUrl: null, pageUrl: null, license: null, playable: true } } });
        const totalMs = Math.round(performance.now() - t0);
        const trackId = r.statusCode === 200 ? r.json().trackId : null;
        const size = trackId ? services.lib.get(trackId)?.size ?? null : null;
        rows.push({ transport, id, status: r.statusCode, totalMs, bytes: size, ...(r.statusCode === 200 ? {} : { error: clean(r.json().error) }), stages: [...marks] });
      }
    } finally { await close(); fs.rmSync(data, { recursive: true, force: true }); }
  }
} catch (e) { console.error(clean(e)); process.exitCode = 1; }
finally { await network.close(); }
console.log(JSON.stringify(rows, null, 1));
