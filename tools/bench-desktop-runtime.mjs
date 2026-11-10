// Hidden, disposable profiles only; never attaches to the user's player.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const executable = option('exe'), kind = option('kind'), rounds = Number(option('rounds') ?? 5);
assert.ok(executable && fs.existsSync(executable), '--exe must identify a built app');
assert.ok(['electron', 'tauri'].includes(kind), '--kind=electron|tauri');
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cache = path.join(root, 'tools/.cache');
fs.mkdirSync(cache, { recursive: true });
const results = [];
const resources = process.env.AUTOMIX_RESOURCES_DIR ?? path.join(path.dirname(executable), 'resources');
const hashes = {};
for (const file of [executable, ...['app.asar', 'backend/backend.mjs', 'backend/tauri-backend.mjs', 'backend/analysisWorker.mjs', 'audio/mora-audio.exe', 'decoder/mora-decode.exe', 'network/mora-network.exe', 'web/index.html'].map(p => path.join(resources, p))]) {
  if (!fs.existsSync(file)) continue;
  const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  hashes[file === executable ? 'executable' : path.relative(resources, file)] = hash.digest('hex');
}
const wave = Buffer.alloc(44 + 48000 * 2 * 4 * 60);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(3, 20); wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(384000, 28); wave.writeUInt16LE(8, 32); wave.writeUInt16LE(32, 34);
wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);

for (let round = 0; round < rounds; round++) {
  const profile = fs.mkdtempSync(path.join(cache, `runtime-${kind}-`));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, AUTOMIX_PROFILE_DIR: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
  delete env.ELECTRON_RUN_AS_NODE;
  if (kind === 'tauri') env.AUTOMIX_TEST = '1';
  const started = performance.now();
  const app = spawn(executable, ['--hidden', ...(kind === 'electron' ? [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] : [])],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', socket, seq = 0;
  const pending = new Map();
  for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { log = (log + data.toString()).slice(-12000); });
  const waitFor = async (description, fn, timeout = 45000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (app.exitCode !== null) throw Error(`${kind} exited (${app.exitCode}) during ${description}: ${log}`);
      const value = await fn(); if (value) return value;
      await delay(100);
    }
    throw Error(`Timeout: ${description}: ${log}`);
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const snapshot = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/bench/runtime-processes.ps1'), '-RootProcessId', String(app.pid), '-Profile', profile], { encoding: 'utf8', windowsHide: true }));
  const measure = async () => {
    const before = snapshot(), at = performance.now();
    await delay(8000);
    const after = snapshot(), seconds = (performance.now() - at) / 1000;
    const old = new Map(before.map(p => [p.pid, p.cpuSeconds]));
    return { seconds, cpuOneCorePercent: after.reduce((s, p) => s + (old.has(p.pid) ? Math.max(0, p.cpuSeconds - old.get(p.pid)) : 0), 0) / seconds * 100,
      privateWorkingSetMiB: after.reduce((s, p) => s + p.privateWorkingSetBytes, 0) / 2 ** 20,
      privateCommitMiB: after.reduce((s, p) => s + p.privateBytes, 0) / 2 ** 20,
      summedWorkingSetMiB: after.reduce((s, p) => s + p.workingSetBytes, 0) / 2 ** 20, processes: after };
  };
  try {
    const tab = await waitFor('application page', async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); }
      catch { return null; }
    });
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = e => {
      const message = JSON.parse(e.data), p = pending.get(message.id);
      if (!p) return; clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(Error(JSON.stringify(message.error))); else p.resolve(message.result);
    };
    await waitFor('React and native bridge', () => evaluate('!!window.automixDesktop?.nativeMix && !!document.querySelector("#root")?.textContent'));
    const startupMs = performance.now() - started;
    await delay(2000);
    const idle = await measure();
    // Import the same silent float WAV, then mute before starting the actual WASAPI host.
    // Keep the test driver's large buffers out of the measured renderer heap.
    const fixture = path.join(profile, 'fixture');
    fs.mkdirSync(fixture); fs.writeFileSync(path.join(fixture, 'runtime-benchmark.wav'), wave);
    await evaluate(`(async()=>{const r=await fetch('/api/import/folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:${JSON.stringify(fixture)}})});if(!r.ok)throw Error('Folder import failed: '+r.status);return r.json()})()`);
    const trackId = await waitFor('imported fixture', () => evaluate(`fetch('/api/library').then(r=>r.json()).then(r=>r.tracks?.find(t=>t.title==='runtime-benchmark')?.id)`));
    assert.equal(typeof trackId, 'string');
    await evaluate(`window.automixDesktop.nativeMix.settings({userVolume:0,volume:0,muted:true})`);
    const playStart = performance.now();
    await evaluate(`window.automixDesktop.nativeMix.startSource({entryId:'runtime-benchmark',trackId:${JSON.stringify(trackId)}},{sampleRate:48000,position:0,volume:0,userVolume:0,muted:true})`);
    await waitFor('confirmed native playback', () => evaluate('window.automixDesktop.nativeMix.state().then(s=>s.active&&s.playing&&s.currentTrack?s:null)'));
    const commandToConfirmedStateMs = performance.now() - playStart;
    await delay(2000);
    const playing = await measure();
    const state = await evaluate('window.automixDesktop.nativeMix.state()');
    assert.ok(state.active && state.playing && state.position >= 5, 'Native playback did not advance during measurement');
    const row = { kind, round, profile, startupMs, commandToConfirmedStateMs, idle, playing, playingPositionSeconds: state.position };
    results.push(row); console.log(JSON.stringify(row));
    await evaluate('window.automixDesktop.nativeMix.stop()');
  } finally {
    socket?.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Benchmark stopped')); }
    if (app.pid && app.exitCode === null) {
      try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/bench/runtime-processes.ps1'), '-RootProcessId', String(app.pid), '-Profile', profile, '-StopOwned'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Already exited. */ }
    }
  }
}
const out = option('out') ?? path.join(root, 'data-bench-results/native-stack', `${kind}-runtime.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ executable, resources, hashes, kind, methodology: 'Hidden fresh profile; warm OS cache; silent 60s float WAV; CPU is % of one logical core for surviving processes, not whole-machine %; private working set includes WebView/decoder/network/audio children. Summed working sets double-count shared pages. Command latency ends at native state confirmation, not measured DAC output. No physical audio latency claim.', results }, null, 2));
