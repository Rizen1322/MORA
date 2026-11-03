import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, 'probe-profile'), { recursive: true });
const root = path.resolve(here, '../..');
const profile = fs.mkdtempSync(path.join(here, 'probe-profile', 'backend-'));
fs.writeFileSync(path.join(profile, 'playback-recovery.json'), JSON.stringify({ version: 1, clean: false,
  snapshot: { queue: [{ trackId: 'test-track', entryId: 'test-entry' }], index: 0, position: 1, settings: {}, device: '' } }));
const resources = path.join(root, 'apps/desktop/build');
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [path.join(here, 'probe-backend.mjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: {
  ...process.env, AUTOMIX_PROFILE_DIR: profile, AUTOMIX_DATA_DIR: path.join(profile, 'data'), AUTOMIX_DESKTOP: '1',
  AUTOMIX_ROOT: resources, AUTOMIX_WEB_DIST: path.join(resources, 'web'), AUTOMIX_ANALYSIS_WORKER: path.join(resources, 'backend/analysisWorker.mjs'),
  AUTOMIX_RUST_CORE: path.join(resources, 'audio/mora-audio.exe'), AUTOMIX_NETWORK_RUST: path.join(root, 'packages/network-rust/target/release/mora-network.exe'),
  AUTOMIX_DECODER_RUST: path.join(resources, 'decoder/mora-decode.exe'),
  FFMPEG_PATH: path.join(resources, 'ffmpeg/ffmpeg.exe'), FFPROBE_PATH: path.join(resources, 'ffmpeg/ffprobe.exe'),
  YTDLP_PATH: path.join(resources, 'yt-dlp/yt-dlp.exe'), STEMS_PYTHON: '', AUTOMIX_LAUNCH_TOKEN: token,
  AUTOMIX_DESKTOP_PCM_TOKEN: randomBytes(32).toString('hex'),
} });
const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 90000);
try {
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`backend exited ${code}`)));
    lines.on('line', line => {
      if (!line.startsWith('MORA_BACKEND ')) return;
      const message = JSON.parse(line.slice('MORA_BACKEND '.length));
      if (message.type === 'error') reject(new Error(message.message));
      if (message.type === 'ready') resolve(message.port);
    });
  });
  const url = `http://127.0.0.1:${port}/api/health`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { 'X-Access-Token': token } })).status, 200);
  const pcm = await fetch(`http://127.0.0.1:${port}/internal/desktop/pcm-source`, {
    method: 'POST', headers: { 'X-Access-Token': token, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(pcm.status, 403);
  const invoke = (operation, args) => fetch(`http://127.0.0.1:${port}/api/desktop/native-mix/${operation}`, {
    method: 'POST', headers: { 'X-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  assert.equal((await invoke('state', [])).status, 200);
  assert.equal((await invoke('feedFile', [])).status, 400);
  const output = await fetch(`http://127.0.0.1:${port}/api/desktop/audio-command`, { method: 'POST',
    headers: { 'X-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'output', device: '' }) });
  assert.equal(output.status, 200);
  const forbidden = await fetch(`http://127.0.0.1:${port}/api/desktop/audio-command`, { method: 'POST',
    headers: { 'X-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'feedFile', path: 'private' }) });
  assert.notEqual(forbidden.status, 200);
  const recoveryUrl = `http://127.0.0.1:${port}/api/desktop/recovery`;
  const headers = { 'X-Access-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(recoveryUrl, { headers })).json()).pending, true);
  assert.equal((await (await fetch(recoveryUrl, { method: 'POST', headers, body: '{"restore":false}' })).json()).pending, false);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.write('{"type":"shutdown"}\n');
  assert.equal(await exited, 0);
  console.log('Standalone backend: authenticated health and clean shutdown passed.');
} finally { clearTimeout(timeout); child.kill(); }
