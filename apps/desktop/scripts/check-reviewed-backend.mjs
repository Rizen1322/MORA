// Check exact local approvals in the packaged Electron backend, with fixture data only.
// electron check-reviewed-backend.mjs RESOURCES ISOLATED_OUTPUT
import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const resources = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const catalog = JSON.parse(fs.readFileSync(path.join(output, 'data/reviewed-transitions.json'), 'utf8'));
app.setPath('userData', path.join(output, 'shell-profile'));
const token = crypto.randomBytes(32).toString('hex'), report = { runtime: process.versions.electron, ok: false, plans: [] };
let backend;
const timeout = setTimeout(() => { backend?.kill(); app.exit(1); }, 60000);
const geometry = p => JSON.stringify(Object.fromEntries(['method','aExit','bEntry','duration','gap','swapAt','tempoA','tempoB','gainA','gainB','bDelay','automation','loopA','vocalA','vocalB','echo','voiceEcho','tapeStopA'].map(key => [key, p[key] ?? null])));
async function run() {
try {
  await app.whenReady();
  const env = { ...process.env, PATH: [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'),
    AUTOMIX_DESKTOP: '1', AUTOMIX_ROOT: resources, AUTOMIX_WEB_DIST: path.join(resources, 'web'),
    AUTOMIX_ANALYSIS_WORKER: path.join(resources, 'backend/analysisWorker.mjs'), AUTOMIX_DATA_DIR: path.join(output, 'data'),
    AUTOMIX_LAUNCH_TOKEN: token, AUTOMIX_PORT: '0', FFMPEG_PATH: path.join(resources, 'ffmpeg/ffmpeg.exe'),
    FFPROBE_PATH: path.join(resources, 'ffmpeg/ffprobe.exe'), YTDLP_PATH: path.join(resources, 'yt-dlp/yt-dlp.exe'), STEMS_PYTHON: '' };
  for (const key of ['HOST','PORT','ACCESS_TOKEN','NODE_OPTIONS','PYTHONPATH','ELECTRON_RUN_AS_NODE','YTDLP_JS_RUNTIME','YTDLP_RUNTIME_ELECTRON']) delete env[key];
  backend = utilityProcess.fork(path.join(resources, 'backend/backend.mjs'), [], { serviceName: 'MORA Reviewed Plans Check', stdio: 'pipe', env });
  const log = fs.createWriteStream(path.join(output, 'backend.log')); backend.stdout?.pipe(log); backend.stderr?.pipe(log);
  const ready = await new Promise((resolve, reject) => { backend.on('message', m => { if (m?.type === 'ready') resolve(m); else if (m?.type === 'error') reject(Error(m.message)); }); backend.once('exit', code => reject(Error(`Backend exited ${code}`))); });
  for (const entry of catalog.entries) {
    const query = new URLSearchParams({ from: entry.plan.fromTrackId, to: entry.plan.toTrackId });
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/automix/plan?${query}`, { headers: { 'x-access-token': token } });
    const body = await response.text(); assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    assert.equal(result.plan.debug.reviewedTransition.id, entry.id);
    assert.equal(geometry(result.plan), geometry(entry.plan));
    assert.deepEqual(result.pending, []);
    report.plans.push({ id: entry.id, exactGeometry: true, loop: !!result.plan.loopA });
  }
  await new Promise((resolve, reject) => { backend.once('exit', code => code === 0 ? resolve() : reject(Error(`Shutdown ${code}`))); backend.postMessage({ type: 'shutdown' }); });
  backend = null; report.ok = true;
} catch (error) { report.error = String(error); }
finally { clearTimeout(timeout); backend?.kill(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1); }
}
void run();
