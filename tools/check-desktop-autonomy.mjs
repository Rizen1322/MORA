import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sessionFile = path.join(root, 'data-bench-results/desktop-0.3.28/autonomy-session.json');
const cache = path.join(root, 'tools/.cache');
const station = process.argv.includes('--station'), recovery = process.argv.includes('--recovery'), silent = !process.argv.includes('--visible');
assert.notEqual(station, recovery, 'Specify exactly one of --station or --recovery');
fs.mkdirSync(cache, { recursive: true });
const saved = recovery ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null;
const profile = station ? fs.mkdtempSync(path.join(cache, 'autonomy-')) : saved.profile;
assert.ok(typeof profile === 'string' && path.dirname(path.resolve(profile)) === path.resolve(cache) && path.basename(profile).startsWith('autonomy-'), 'Refusing a profile outside the disposable test directory');
if (recovery && silent) {
  assert.ok(saved.checkpoint?.clean === false && saved.checkpoint.snapshot?.queue?.length, 'Missing saved unclean checkpoint');
  fs.writeFileSync(path.join(profile, 'playback-recovery.json'), JSON.stringify(saved.checkpoint));
}
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
let inspectorPort;
if (recovery && silent) {
  const inspectorServer = createServer();
  await new Promise(resolve => inspectorServer.listen(0, '127.0.0.1', resolve));
  inspectorPort = inspectorServer.address().port;
  await new Promise(resolve => inspectorServer.close(resolve));
}
const env = { ...process.env, AUTOMIX_PROFILE_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const app = spawn(path.join(root, packaged ? 'apps/desktop/dist/win-unpacked/MORA.exe' : 'node_modules/electron/dist/electron.exe'),
  [...(packaged ? [] : [path.join(root, 'apps/desktop')]), ...(silent ? ['--hidden'] : []),
    ...(inspectorPort ? [`--inspect-brk=127.0.0.1:${inspectorPort}`] : []), `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  { cwd: root, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', socket, inspector, sequence = 0, finished = false;
for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { log = (log + data.toString()).slice(-16000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const killOwned = () => {
  if (app.pid && app.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Already exited. */ }
  }
};
const waitFor = async (description, fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (app.exitCode !== null) throw Error(`Electron exited while waiting for ${description}: ${log}`);
    const value = await fn(); if (value) return value;
    await delay(200);
  }
  throw Error(`Timed out waiting for ${description}: ${log}`);
};
function tone(index) {
  const rate = 48000, frames = rate * 5, bytes = frames * 8, wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28);
  wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) {
    const sample = 0.1 * Math.sin(2 * Math.PI * (220 + 31 * index) * i / rate);
    wav.writeFloatLE(sample, 44 + i * 8); wav.writeFloatLE(sample, 48 + i * 8);
  }
  return wav.toString('base64');
}

try {
  let inspect;
  if (recovery && silent) {
    const target = await waitFor('main-process inspector', async () => {
      try { return (await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json()).find(t => t.webSocketDebuggerUrl); } catch { return null; }
    });
    inspector = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { inspector.onopen = resolve; inspector.onerror = reject; });
    let id = 0, pausedResolve;
    const replies = new Map(), paused = new Promise(resolve => { pausedResolve = resolve; });
    inspect = (method, params = {}) => new Promise((resolve, reject) => {
      const call = ++id, timer = setTimeout(() => { replies.delete(call); reject(Error(`Inspector timeout: ${method}`)); }, 20000);
      replies.set(call, { resolve, reject, timer }); inspector.send(JSON.stringify({ id: call, method, params }));
    });
    inspector.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Debugger.paused') pausedResolve();
      const reply = replies.get(message.id);
      if (!reply) return; clearTimeout(reply.timer); replies.delete(message.id);
      if (message.error) reply.reject(Error(JSON.stringify(message.error))); else reply.resolve(message.result);
    };
    await inspect('Runtime.enable');
    await inspect('Debugger.enable');
    await inspect('Runtime.runIfWaitingForDebugger');
    await Promise.race([paused, delay(20000).then(() => { throw Error('Main process did not pause before startup'); })]);
    const injected = await inspect('Runtime.evaluate', { expression: `(()=>{const electron=process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'apps/desktop/src/main.mjs'))})('electron');globalThis.__autonomyRecoveryPrompts=[];electron.dialog.showMessageBox=async (...args)=>{const options=args.at(-1);globalThis.__autonomyRecoveryPrompts.push(options);if(options?.title==='Восстановление MORA'&&options.type==='question')return {response:0,checkboxChecked:false};throw Error('Unexpected dialog: '+JSON.stringify(options))};return true})()`, returnByValue: true });
    assert.equal(injected.result?.value, true, `Cannot install test dialog handler: ${JSON.stringify(injected.exceptionDetails)}`);
    await inspect('Debugger.resume');
  } else if (recovery) console.log(`Recovery dialog expected for disposable profile ${profile}. Choose Continue in the app within 120 seconds.`);
  const tab = await waitFor('application page' + (recovery ? ' after recovery dialog' : ''), async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); }
    catch { return null; }
  }, recovery ? 120000 : 30000);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const result = JSON.parse(event.data), p = pending.get(result.id);
    if (!p) return; clearTimeout(p.timer); pending.delete(result.id);
    if (result.error) p.reject(Error(JSON.stringify(result.error))); else p.resolve(result.result);
  };
  await request('Runtime.enable');
  await waitFor('desktop bridge', () => evaluate('!!window.automixDesktop?.nativeMix && !!document.querySelector("#root")?.textContent'));
  if (station) {
    for (let i = 0; i < 8; i++) {
      const encoded = tone(i);
      const result = await evaluate(`(async()=>{const data=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));const r=await fetch('/api/import/upload?name=autonomy-${i}.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:data});if(!r.ok)throw Error(await r.text());return r.json()})()`);
      assert.ok(result.trackId, `Import ${i} failed`);
    }
    await evaluate(`(async()=>{const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({automix:{enabled:false}})});if(!r.ok)throw Error(await r.text());await window.automixDesktop.nativeMix.settings({userVolume:.35,muted:true,volume:0});location.hash='#/wave'})()`);
    await request('Page.reload');
    await waitFor('own wave launch', () => evaluate(`!!document.querySelector('.ws-launch:not([disabled])')`));
    await evaluate(`document.querySelector('.ws-source button').click();document.querySelector('.ws-launch').click()`);
    const initial = await waitFor('native station and initial queue', () => evaluate(`window.automixDesktop.nativeMix.state().then(s=>s.active&&s.playing&&s.station?.kind==='own'&&s.queue?.length>1&&s.queue.length<=6?s:null)`), 60000);
    const frozenAt = Date.now();
    await request('Page.setWebLifecycleState', { state: 'frozen' });
    await delay(45000);
    await request('Page.setWebLifecycleState', { state: 'active' });
    const thawedAt = Date.now();
    const after = await evaluate('window.automixDesktop.nativeMix.state()');
    assert.ok(after.index > initial.queue.length + 1, `Native station did not advance past the initial queue: ${JSON.stringify({ initial, after })}`);
    const history = await evaluate(`fetch('/api/history?limit=200').then(r=>r.json())`);
    const frozenHistory = history.items.filter(item => item.startedAt >= frozenAt && item.startedAt <= thawedAt);
    assert.ok(frozenHistory.length >= 8, `Expected eight history entries during freeze, got ${frozenHistory.length}`);
    await waitFor('UI title and queue to adopt native state', () => evaluate(`(async()=>{const s=await window.automixDesktop.nativeMix.state();const title=document.querySelector('.ws-track-copy h3')?.textContent?.trim();const items=[...document.querySelectorAll('.ws-queue-copy strong')].map(e=>e.textContent.trim());const tracks=(await(await fetch('/api/library')).json()).tracks;const expected=s.queue.slice(s.index+1,s.index+6).map(e=>tracks.find(t=>t.id===e.trackId)?.title);return s.currentTrack?.title===title&&expected.length>0&&JSON.stringify(items)===JSON.stringify(expected)})()`));
    const checkpointFile = path.join(profile, 'playback-recovery.json');
    const checkpoint = await waitFor('unclean playback checkpoint', async () => {
      try {
        const value = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
        const current = await evaluate('window.automixDesktop.nativeMix.state()');
        return value.clean === false && value.snapshot?.station?.kind === 'own' && value.snapshot.queue[value.snapshot.index]?.entryId === current.entryId ? value : null;
      } catch { return null; }
    });
    const state = await evaluate('window.automixDesktop.nativeMix.state()');
    const settings = await evaluate('window.automixDesktop.getSettings()');
    assert.equal(settings.audio?.volume, .35); assert.equal(settings.audio?.muted, true);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ profile, checkpoint, state, settings, frozenAt, thawedAt, frozenHistory }, null, 2));
    killOwned(); finished = true;
    console.log(JSON.stringify({ phase: 'station', profile, initialIndex: initial.index, finalIndex: after.index, frozenHistory: frozenHistory.length, sessionFile }));
  } else {
    const snapshot = saved.checkpoint.snapshot;
    const restored = await waitFor('restored playback', () => evaluate(`window.automixDesktop.nativeMix.state().then(s=>s.active&&s.playing&&s.station?.kind==='own'?s:null)`), 30000);
    assert.ok(restored.index >= snapshot.index, `Restored index precedes checkpoint: ${JSON.stringify({ snapshot, restored })}`);
    assert.deepEqual(restored.queue.slice(0, snapshot.queue.length).map(e => e.entryId), snapshot.queue.map(e => e.entryId), 'Checkpoint queue was not restored');
    if (restored.entryId === snapshot.queue[snapshot.index].entryId) assert.ok(restored.position >= snapshot.position - 0.5, 'Playback restarted before saved position');
    const settings = await evaluate('window.automixDesktop.getSettings()');
    assert.deepEqual(settings.audio, saved.settings.audio, 'Audio settings or output device changed after recovery');
    assert.equal(settings.audio.volume, .35); assert.equal(settings.audio.muted, true);
    if (silent) {
      const prompts = await inspect('Runtime.evaluate', { expression: 'globalThis.__autonomyRecoveryPrompts', returnByValue: true });
      assert.equal(prompts.result?.value?.length, 1, `Expected exactly one recovery prompt: ${JSON.stringify(prompts)}`);
      assert.equal(prompts.result.value[0].type, 'question');
      inspector.close(); inspector = undefined;
    }
    await evaluate('window.automixDesktop.setCloseToTray(false)');
    await request('Browser.close').catch(() => {});
    if (app.exitCode === null) await Promise.race([new Promise(resolve => app.once('exit', resolve)), delay(15000)]);
    finished = app.exitCode !== null;
    console.log(JSON.stringify({ phase: 'recovery', restored, settings: settings.audio, cleanExit: finished }));
    assert.ok(finished, 'Electron did not exit normally');
  }
} finally {
  socket?.close();
  inspector?.close();
  if (!finished) killOwned();
}
