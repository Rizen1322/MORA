import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, waitForPage } from '../desktop/scripts/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, 'probe-profile'), { recursive: true });
const profile = fs.mkdtempSync(path.join(here, 'probe-profile', 'autonomy-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = path.join(here, `src-tauri/target/${process.env.MORA_BUILD_MODE || 'debug'}/mora-desktop-native.exe`);
function tone(index) {
  const rate = 48000, frames = rate * 5, bytes = frames * 8, wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28);
  wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) { const sample = 0.1 * Math.sin(2 * Math.PI * (220 + 31 * index) * i / rate); wav.writeFloatLE(sample, 44 + i * 8); wav.writeFloatLE(sample, 48 + i * 8); }
  return wav.toString('base64');
}
async function launch() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = {
    ...process.env, AUTOMIX_TEST: '1', AUTOMIX_PROFILE_DIR: profile,
    ...(process.env.MORA_PACKAGED ? {} : { AUTOMIX_RESOURCES_DIR: path.join(here, 'build') }),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
  };
  if (process.env.MORA_PACKAGED) for (const key of ['AUTOMIX_RESOURCES_DIR', 'AUTOMIX_NODE_PATH', 'AUTOMIX_BACKEND_ENTRY', 'AUTOMIX_NETWORK_RUST']) delete env[key];
  const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', x => { log = (log + x).slice(-10000); });
  const kill = () => { if (child.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } };
  try {
    const page = await waitForPage(port, { timeoutMs: 45000 });
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.waitFor('!!window.automixDesktop?.nativeMix && !!document.querySelector("#root")?.textContent', { timeoutMs: 45000 });
    return { child, cdp, kill, log: () => log };
  } catch (e) { kill(); throw Error(`${e.message}\n${log}`); }
}
let run;
try {
  run = await launch();
  const { cdp } = run;
  for (let i = 0; i < 8; i++) {
    const result = await cdp.evaluate(`(async()=>{const b=Uint8Array.from(atob(${JSON.stringify(tone(i))}),c=>c.charCodeAt(0));const r=await fetch('/api/import/upload?name=autonomy-${i}.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:b});if(!r.ok)throw Error(await r.text());return r.json()})()`);
    assert.ok(result.trackId);
  }
  await cdp.evaluate(`(async()=>{const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({automix:{enabled:false}})});if(!r.ok)throw Error(await r.text());await window.automixDesktop.nativeMix.settings({userVolume:.35,muted:true,volume:0});location.hash='#/wave'})()`);
  await cdp.send('Page.reload');
  await cdp.waitFor("!!document.querySelector('.ws-launch:not([disabled])')");
  await cdp.evaluate("document.querySelector('.ws-source button').click();document.querySelector('.ws-launch').click()");
  const initial = await cdp.waitFor("window.automixDesktop.nativeMix.state().then(s=>s.active&&s.playing&&s.station?.kind==='own'&&s.queue?.length>1?s:null)", { timeoutMs: 60000 });
  const start = Date.now(); await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); await delay(45000);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }); const end = Date.now();
  const after = await cdp.evaluate('window.automixDesktop.nativeMix.state()');
  assert.ok(after.index > initial.queue.length + 1, 'station did not advance beyond its initial queue');
  const history = await cdp.evaluate("fetch('/api/history?limit=200').then(r=>r.json())");
  assert.ok(history.items.filter(item => item.startedAt >= start && item.startedAt <= end).length >= 8, 'history did not advance while frozen');
  const settings = await cdp.evaluate('window.automixDesktop.getSettings()');
  assert.equal(settings.audio.volume, .35); assert.equal(settings.audio.muted, true);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(profile, 'playback-recovery.json'), 'utf8'));
  assert.equal(checkpoint.clean, false); assert.equal(checkpoint.snapshot.station.kind, 'own');
  run.cdp.close(); run.kill(); await delay(1000);
  fs.writeFileSync(path.join(profile, 'playback-recovery.json'), JSON.stringify(checkpoint));
  run = await launch();
  const pending = await run.cdp.evaluate("fetch('/api/desktop/recovery').then(r=>r.json())");
  assert.equal(pending.pending, true);
  await run.cdp.evaluate("fetch('/api/desktop/recovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({restore:true})}).then(r=>{if(!r.ok)throw Error('recovery failed');return r.json()})");
  const restored = await run.cdp.waitFor("window.automixDesktop.nativeMix.state().then(s=>s.active&&s.playing&&s.station?.kind==='own'?s:null)", { timeoutMs: 60000 });
  assert.ok(restored.index >= checkpoint.snapshot.index);
  assert.deepEqual(restored.queue.slice(0, checkpoint.snapshot.queue.length).map(e => e.entryId), checkpoint.snapshot.queue.map(e => e.entryId));
  await run.cdp.evaluate("window.automixDesktop.nativeMix.command('pause')");
  await run.cdp.evaluate('window.automixDesktop.restartBackend()');
  const restarted = await run.cdp.waitFor("window.automixDesktop.nativeMix.state().then(s=>s.active&&!s.playing?s:null)", { timeoutMs: 60000 });
  assert.equal(restarted.playing, false);
  console.log(`Hidden, muted Tauri autonomy and recovery passed: ${initial.index} -> ${after.index}.`);
} catch (e) { throw Error(`${e.stack}\n${run?.log() ?? ''}`); }
finally { run?.cdp.close(); run?.kill(); }
process.exit(0);
