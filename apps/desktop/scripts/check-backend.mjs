// Backend integration check inside Electron, without browser automation or a second player.
// Run with Electron: electron apps/desktop/scripts/check-backend.mjs <resources> <isolated-output-dir>
import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const resources = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'shell-profile'));
const token = crypto.randomBytes(32).toString('hex');
const report = { runtime: process.versions.electron, systemToolsOnPath: false, startedAt: new Date().toISOString() };
const timeout = setTimeout(() => { console.error('Integration check timed out'); app.exit(1); }, 180000);
let backend;
async function run() {
try {
  await app.whenReady();
  const env = { ...process.env, PATH: [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'),
    AUTOMIX_DESKTOP: '1', AUTOMIX_ROOT: resources, AUTOMIX_WEB_DIST: path.join(resources, 'web'),
    AUTOMIX_ANALYSIS_WORKER: path.join(resources, 'backend', 'analysisWorker.mjs'), AUTOMIX_DATA_DIR: path.join(output, 'data'),
    AUTOMIX_LAUNCH_TOKEN: token, AUTOMIX_PORT: '0', FFMPEG_PATH: path.join(resources, 'ffmpeg', 'ffmpeg.exe'),
    FFPROBE_PATH: path.join(resources, 'ffmpeg', 'ffprobe.exe'), YTDLP_PATH: path.join(resources, 'yt-dlp', 'yt-dlp.exe'), STEMS_PYTHON: '' };
  for (const name of ['HOST', 'PORT', 'ACCESS_TOKEN', 'NODE_OPTIONS', 'PYTHONPATH', 'ELECTRON_RUN_AS_NODE', 'YTDLP_JS_RUNTIME', 'YTDLP_RUNTIME_ELECTRON']) delete env[name];
  backend = utilityProcess.fork(path.join(resources, 'backend', 'backend.mjs'), [], { serviceName: 'MORA Integration Check', stdio: 'pipe', env });
  const log = fs.createWriteStream(path.join(output, 'backend.log'));
  backend.stdout?.pipe(log, { end: false }); backend.stderr?.pipe(log, { end: false });
  const ready = await new Promise((resolve, reject) => {
    backend.on('message', (m) => { if (m?.type === 'ready') resolve(m); else if (m?.type === 'error') reject(new Error(m.message)); });
    backend.once('exit', (code) => reject(new Error(`Backend exited: ${code}`)));
  });
  const root = `http://127.0.0.1:${ready.port}`;
  const request = async (url, body) => {
    const response = await fetch(root + url, { headers: { 'x-access-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  report.ffmpeg = !!ready.ffmpeg;
  const health = await (await request('/api/health')).json();
  report.vocalRuntime = health.stems?.runtime;
  if (report.vocalRuntime !== 'bundled-cpu') throw new Error('Bundled vocal model unavailable');
  const saved = await (await request('/api/settings')).json();
  if (!saved.sound?.playback || saved.sound.playback.speed !== 1) throw new Error('Playback settings migration failed');
  report.playbackDefaults = saved.sound.playback;
  report.motionDefault = saved.ui.motion;
  if (saved.ui.motion !== 'full') throw new Error('Desktop animation default is not full');
  const searchStart = performance.now();
  const search = await (await request('/api/search/ytmusic?q=Yanix%20%D0%92%D0%B5%D1%80%D0%B8%D1%82%D1%8C')).json();
  report.searchMs = Math.round(performance.now() - searchStart);
  if (!search.items?.length) throw new Error('No public results');
  const track = search.items[0];
  const scStart = performance.now();
  const sc = await (await request('/api/search/soundcloud?q=Yanix%20%D0%92%D0%B5%D1%80%D0%B8%D1%82%D1%8C')).json();
  report.soundcloud = { ms: Math.round(performance.now() - scStart), count: sc.items?.length, withCover: sc.items?.filter(t => t.coverUrl).length };
  if (!sc.items?.length) throw new Error('No SoundCloud results');
  const scArtist=sc.items.find(t=>t.artistId);
  if(!scArtist)throw new Error('SoundCloud artist identity missing');
  const scPage=await(await request(`/api/catalog/soundcloud/artists/${scArtist.artistId}`)).json();
  report.soundcloudArtist={id:scPage.id,title:scPage.title,tracks:scPage.tracks?.length};
  if(scPage.id!==scArtist.artistId||!scPage.title||!scPage.tracks?.length||scPage.tracks.some(t=>t.source!=='soundcloud'))throw new Error('Invalid SoundCloud artist shelf');
  const libraryBefore = (await (await request('/api/library')).json()).tracks.length;
  const warmStart = performance.now();
  report.warmup = { ...await (await request('/api/public/warmup', { provider: track.audioProvider, externalId: track.externalId })).json(), ms: Math.round(performance.now() - warmStart) };
  if (!report.warmup.ready) throw new Error('Metadata warmup was not completed');
  const libraryAfter = (await (await request('/api/library')).json()).tracks.length;
  if (libraryBefore !== libraryAfter) throw new Error('Warmup polluted the library');
  report.warmupLibraryUnchanged = true;
  if (track.artistId) {
    const artist = await (await request(`/api/catalog/public/artists/${track.artistId}`)).json();
    report.catalogArtist = { title: artist.title, tracks: artist.tracks?.length, albums: artist.albums?.length };
    if (!artist.title || !artist.tracks?.length) throw new Error('Public artist missing tracks');
  }
  if (track.albumId) {
    const album = await (await request(`/api/catalog/public/albums/${track.albumId}`)).json();
    report.catalogAlbum = { title: album.title, tracks: album.tracks?.length };
    if (!album.title || !album.tracks?.length) throw new Error('Public album missing tracks');
  }
  const start = performance.now();
  const prepared = await (await request('/api/public/prepare', { provider: track.audioProvider, externalId: track.externalId, progressive: true })).json();
  report.prepareMs = Math.round(performance.now() - start);
  const pcm = await request(`/api/tracks/${prepared.trackId}/pcm?sr=48000&start=0&frames=8192&format=f32le`);
  report.firstPcmMs = Math.round(performance.now() - start);
  report.pcmBytes = (await pcm.arrayBuffer()).byteLength;
  if (report.pcmBytes !== 8192 * 8) throw new Error('Incomplete PCM block');
  const cover = await request(`/api/tracks/${prepared.trackId}/cover`);
  report.coverBytes = (await cover.arrayBuffer()).byteLength;
  report.coverType = cover.headers.get('content-type');
  report.fullLikesRoute = (await request('/api/providers/yandex/likes/import')).status;
  report.ok = true;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { backend.kill(); reject(new Error('Shutdown timed out')); }, 20000);
    backend.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Shutdown code ${code}`)); });
    backend.postMessage({ type: 'shutdown' });
  });
  backend = null;
  console.log(JSON.stringify(report));
} catch (error) {
  report.ok = false; report.error = error.message; console.error(error.message);
} finally {
  clearTimeout(timeout); backend?.kill();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}
}
void run();
