import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = fs.mkdtempSync(path.join(root, 'tools/.cache/rust-desktop-'));
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'data-bench-results/rust-audio/48000-transition.json'), 'utf8'));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = { ...process.env, AUTOMIX_PROFILE_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const app = spawn(path.join(root, packaged ? 'apps/desktop/dist/win-unpacked/MORA.exe' : 'node_modules/electron/dist/electron.exe'), [...(packaged ? [] : [path.join(root, 'apps/desktop')]), ...(process.argv.includes('--visible') ? [] : ['--hidden']), `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { log = (log + data.toString()).slice(-16000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sequence = 0;
const pending = new Map();
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .catch(error => { throw new Error(`${error.message}: ${expression.slice(0, 180)}`); });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
try {
  let tab;
  for (let i = 0; i < 150; i++) {
    try { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch {}
    if (tab) break;
    if (app.exitCode !== null) throw new Error(`Electron exited: ${log}`);
    await delay(200);
  }
  assert.ok(tab, `Electron page did not open: ${log}`);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve;socket.onerror = reject; });
  socket.onmessage = event => {
    const result = JSON.parse(event.data), p = pending.get(result.id);
    if (!p) return;clearTimeout(p.timer);pending.delete(result.id);
    if (result.error) p.reject(new Error(JSON.stringify(result.error)));else p.resolve(result.result);
  };
  await request('Runtime.enable');
  for (let i = 0; i < 100 && !await evaluate('!!window.automixDesktop?.audioStart && !!document.querySelector("#root")?.textContent'); i++) await delay(100);
  // Import deterministic WAVs into a disposable profile. The playback queue is restored muted.
  for (let deck = 0; deck < 2; deck++) {
    const feeds = fixture.ops.filter(op => op.cmd === 'feed' && op.deck === deck);
    const l = Buffer.concat(feeds.map(op => Buffer.from(op.L, 'base64'))), r = Buffer.concat(feeds.map(op => Buffer.from(op.R, 'base64')));
    const wav = Buffer.alloc(44 + l.length * 2), dataBytes = l.length * 2;
    wav.write('RIFF');wav.writeUInt32LE(36 + dataBytes, 4);wav.write('WAVEfmt ', 8);wav.writeUInt32LE(16, 16);wav.writeUInt16LE(3, 20);wav.writeUInt16LE(2, 22);wav.writeUInt32LE(48000, 24);wav.writeUInt32LE(384000, 28);wav.writeUInt16LE(8, 32);wav.writeUInt16LE(32, 34);wav.write('data', 36);wav.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < l.length / 4; i++) { l.copy(wav, 44 + i * 8, i * 4, i * 4 + 4);r.copy(wav, 48 + i * 8, i * 4, i * 4 + 4); }
    const encoded = wav.toString('base64');
    const imported = await evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));const r=await fetch('/api/import/upload?name=rust-smoke-${deck}.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes});if(!r.ok)throw new Error(await r.text());return r.json()})()`);
    assert.ok(imported.trackId);
  }
  const queueTracks = await evaluate(`(async()=>{const {tracks}=await(await fetch('/api/library')).json();const items=Array.from({length:32},(_,i)=>({entryId:'smoke-'+i,trackId:tracks[i%tracks.length].id,origin:'user'}));const queue={items,index:0,position:0,volume:0,context:{type:'queue',label:'Rust smoke'},shuffle:false,repeat:'off'};const r=await fetch('/api/queue',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(queue)});if(!r.ok)throw new Error(await r.text());return items.map(e=>({...e,title:tracks.find(t=>t.id===e.trackId).title}))})()`);
  await request('Page.reload');
  for (let i = 0; i < 100; i++) { await delay(100);if (await evaluate('!!document.querySelector("button[aria-label=Слушать]:not([disabled])")')) break; }
  assert.equal(await evaluate(`(()=>{window.__rustEvents=[];window.automixDesktop.onAudio(e=>{if(e.type!=='waveform')window.__rustEvents.push(e)});const b=document.querySelector('button[aria-label=Слушать]:not([disabled])');if(!b)return false;b.click();return true})()`), true);
  let events = [];
  for (let i = 0; i < 150; i++) { await delay(100);events = await evaluate('window.__rustEvents');if (events.some(e => e.type === 'tick' && e.decks?.some(d => d.playing && d.position > 48000))) break; }
  assert.ok(events.some(e => e.type === 'tick' && e.decks?.some(d => d.playing && d.position > 48000)), `Controller did not play through Rust: ${JSON.stringify(events.slice(-4))}`);
  assert.ok(!events.some(e => e.type === 'fatal'), 'Native fatal event');
  await evaluate(`document.querySelector('button[aria-label=Пауза]').click()`);
  for (let i = 0; i < 25; i++) {
    await delay(100);events = await evaluate('window.__rustEvents');
    if (events.some(e => e.type === 'tick' && e.paused)) break;
  }
  assert.ok(events.some(e => e.type === 'tick' && e.paused), 'UI Pause did not reach native engine');
  const outputs = await evaluate('window.automixDesktop.audioDevices()');
  assert.ok(outputs.length > 0);
  let rejectedDevice = false;
  try { await evaluate(`window.automixDesktop.audioCommand({cmd:'output',device:${JSON.stringify(outputs[0].deviceId)}})`); }
  catch { rejectedDevice = true; }
  await evaluate(`window.automixDesktop.audioCommand({cmd:'output',device:''})`);
  await evaluate(`document.querySelector('button[aria-label=Слушать]').click()`);
  await delay(2000);
  await evaluate(`document.querySelector('button[aria-label=Следующий]').click()`);
  for (let i = 0; i < 150; i++) { await delay(100);events = await evaluate('window.__rustEvents');if (events.some(e => e.type === 'transitionEnd')) break; }
  events = await evaluate('window.__rustEvents');
  assert.ok(events.some(e => e.type === 'transitionStart'), 'UI Next did not start a native transition');
  assert.ok(events.some(e => e.type === 'transitionEnd'), 'Native transition did not finish');
  let background = null;
  if (await evaluate('!!window.automixDesktop.nativeMix')) {
    const before = await evaluate('window.automixDesktop.nativeMix.state()');
    await request('Page.setWebLifecycleState', { state: 'frozen' });
    await delay(30000);
    await request('Page.setWebLifecycleState', { state: 'active' });
    const after = await evaluate('window.automixDesktop.nativeMix.state()');
    assert.ok(after.index >= before.index + 2, `Frozen UI stopped the native queue: ${JSON.stringify({ before, after })}`);
    const log = await evaluate(`fetch('/api/automix/log').then(r=>r.json())`);
    assert.ok(log.items.length >= 2 && log.items.every(r => r.fromTrackId && r.toTrackId), 'Frozen native transitions were not recorded');
    background = { frozenMs: 30000, fromIndex: before.index, toIndex: after.index };
    await delay(700);
  }
  const rapidSkips = [];
  for (let round = 0; round < 4; round++) {
    const oldToken = await evaluate(`(()=>{const t=window.__rustEvents.findLast(e=>e.type==='tick');return t.decks[t.main].token})()`);
    const previous = round % 2 === 1;
    await evaluate(`(async()=>{for(let i=0;i<4;i++){document.querySelector('button[aria-label=Следующий]').click();await new Promise(r=>setTimeout(r,35))}${previous ? "document.querySelector('button[aria-label=Предыдущий]').click()" : ''}})()`);
    let snapshot;
    for (let i = 0; i < 150; i++) {
      await delay(100);
      snapshot = await evaluate(`(()=>{const tick=window.__rustEvents.findLast(e=>e.type==='tick');return {tick,title:document.querySelector('.pb-track-info .t-title')?.textContent}})()`);
      const tick = snapshot.tick, playing = tick?.decks.filter(d => d.playing);
      const entry = queueTracks.find(e => tick?.decks[tick.main]?.token?.startsWith(e.entryId + '#'));
      const progressed = previous || tick?.decks[tick.main]?.token !== oldToken;
      if (i >= 7 && progressed && !tick?.paused && !tick?.transition?.active && playing?.length === 1 && entry && snapshot.title?.trim() === entry.title) break;
      if (i === 149) assert.fail(`Rapid Next/Previous left stale UI or overlapping decks: ${JSON.stringify(snapshot)}`);
    }
    rapidSkips.push(snapshot);
  }
  // The transport must still accept Next after all the burst/Previous cancellations.
  const before = await evaluate(`window.automixDesktop.nativeMix ? window.automixDesktop.nativeMix.state().then(s=>s.index) : window.__rustEvents.filter(e=>e.type==='swap').length`);
  await evaluate(`document.querySelector('button[aria-label=Следующий]').click()`);
  let advanced = false;
  for (let i = 0; i < 150; i++) {
    await delay(100);
    advanced = await evaluate(`window.automixDesktop.nativeMix ? window.automixDesktop.nativeMix.state().then(s=>s.index>${before}) : window.__rustEvents.filter(e=>e.type==='swap').length>${before}`);
    if (advanced) break;
  }
  assert.ok(advanced, 'Next stopped working after rapid skips');
  const product = {};
  if (await evaluate('!!window.automixDesktop.nativeMix')) {
    await evaluate(`document.querySelector('button[aria-label=Пауза]')?.click();document.querySelector('button[aria-label=Очередь]')?.click()`);
    await delay(500);
    const count = await evaluate('document.querySelectorAll(".queue-panel .q-item").length');
    assert.ok(count > 1, 'Queue panel did not open');
    await evaluate(`document.querySelector('.queue-panel button[aria-label^="Убрать из очереди:"]').click()`);
    await delay(100);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.queue-panel button')).some(b=>b.textContent==='Отменить')`), 'Queue undo is missing');
    await evaluate(`Array.from(document.querySelectorAll('.queue-panel button')).find(b=>b.textContent==='Отменить').click()`);
    await delay(100);
    assert.equal(await evaluate('document.querySelectorAll(".queue-panel .q-item").length'), count, 'Undo did not restore the removed queue entry');
    product.undoQueue = true;
    await evaluate(`document.querySelector('button[aria-label="Закрыть очередь"]')?.click();location.hash='#/settings'`);
    for (let i = 0; i < 100; i++) { await delay(100); if (await evaluate(`!!document.querySelector('section[aria-label="Место на диске"]')`)) break; }
    assert.ok(await evaluate(`document.querySelector('section[aria-label="Место на диске"]')?.textContent.includes('Скачанные оригиналы')`), 'Disk management is missing');
    const screenshotDir = path.join(root, 'data-bench-results/desktop-0.3.27');fs.mkdirSync(screenshotDir, { recursive: true });
    await evaluate(`(()=>{document.querySelector('section[aria-label="Место на диске"]').scrollIntoView({block:'center',behavior:'instant'});return true})()`);
    await delay(200);
    fs.writeFileSync(path.join(screenshotDir, 'settings.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    product.diskManagement = true;
    const playlist = await evaluate(`(async()=>{const {tracks}=await(await fetch('/api/library')).json();const r=await fetch('/api/playlists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Подготовка — проверка',trackIds:tracks.map(t=>t.id)})});if(!r.ok)throw Error(await r.text());const p=await r.json();location.hash='#/playlist/'+p.id;return p})()`);
    for (let i = 0; i < 100; i++) { await delay(100); if (await evaluate(`!!document.querySelector('.playlist-preparation button')`)) break; }
    assert.ok(await evaluate(`!!document.querySelector('.playlist-preparation button')`), 'Playlist preparation card is missing');
    await evaluate(`document.querySelector('.playlist-preparation button').click()`);
    let prepared;
    for (let i = 0; i < 100; i++) {
      await delay(100);
      prepared = await evaluate(`fetch('/api/playlists/${playlist.id}/prepare-listening').then(r=>r.json())`);
      if (prepared?.complete) break;
    }
    assert.ok(prepared?.complete && prepared.plansReady === 1, `Playlist preparation did not finish: ${JSON.stringify(prepared)}`);
    product.playlistPreparation = prepared;
    await delay(700);
    fs.writeFileSync(path.join(screenshotDir, 'playlist.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    assert.ok(await evaluate(`!!document.querySelector('button[aria-label="Действия с плейлистом"]')`), 'Compact playlist toolbar is missing');
    await evaluate(`document.querySelector('button[aria-label="Действия с плейлистом"]').click()`);
    await delay(300);
    assert.ok(await evaluate(`document.querySelector('.menu[role=menu]')?.textContent.includes('Переименовать')`));
    const menuPlacement = await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Действия с плейлистом"]').getBoundingClientRect();const m=document.querySelector('.menu[role=menu]').getBoundingClientRect();return {left:m.left,expected:Math.max(8,Math.min(b.left,innerWidth-m.width-8)),buttons:!!document.querySelector('.menu[role=menu] button.btn')}})()`);
    assert.ok(Math.abs(menuPlacement.left - menuPlacement.expected) < 2 && !menuPlacement.buttons, `Playlist menu is offset or has toolbar buttons: ${JSON.stringify(menuPlacement)}`);
    fs.writeFileSync(path.join(screenshotDir, 'playlist-menu.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await evaluate(`document.querySelector('button[aria-label^="Действия:"]').click()`);
    await delay(100);
    assert.ok(await evaluate(`document.querySelector('.menu[role=menu]')?.textContent.includes('Ещё действия')`), 'Grouped track menu is missing');
    assert.ok(await evaluate(`!document.querySelector('.menu[role=menu]')?.textContent.includes('Анализ звука')`), 'Advanced track actions are still in the primary menu');
    fs.writeFileSync(path.join(screenshotDir, 'track-menu.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await evaluate(`document.querySelector('button[aria-label="Открыть полноэкранный плеер"]').click()`);
    await delay(300);
    assert.ok(await evaluate(`!!document.querySelector('summary[aria-label="Ещё действия с треком"]')`), 'Compact full-player actions are missing');
    assert.ok(await evaluate(`!document.querySelector('.full-player')?.textContent.includes('Музыкальный переход можно включить')`), 'Unwanted Next help is still shown');
    fs.writeFileSync(path.join(screenshotDir, 'player.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await request('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    fs.writeFileSync(path.join(screenshotDir, 'player-960.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await request('Emulation.clearDeviceMetricsOverride');
    await evaluate(`(async()=>{const s=await window.automixDesktop.nativeMix.state();const r=await fetch('/api/tracks/'+s.currentTrack.trackId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Очень длинное название песни (Prod. by Producer One, Producer Two, Producer Three)'})});if(!r.ok)throw Error(await r.text())})()`);
    for (let i=0;i<30;i++) { await delay(100); if (await evaluate(`!!document.querySelector('.fp-title[data-length]')`)) break; }
    const titleSize = await evaluate(`(()=>{const e=document.querySelector('.fp-title');return {size:parseFloat(getComputedStyle(e).fontSize),text:e.textContent}})()`);
    assert.ok(titleSize.size < 44 && titleSize.text.includes('Producer One'), `Long title did not shrink: ${JSON.stringify(titleSize)}`);
    await delay(1500);
    fs.writeFileSync(path.join(screenshotDir, 'player-long-title.png'), Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    product.longTitle = titleSize;
    await evaluate(`document.querySelector('.full-player button[aria-label="Свернуть"]').click();location.hash='#/playlist/${playlist.id}'`);
    for (let i=0;i<30;i++) { await delay(100); if (await evaluate(`!!document.querySelector('.collection-masthead .play-circle')`)) break; }
    await evaluate(`document.querySelector('.collection-masthead .play-circle').click()`);
    await delay(400);
    await evaluate(`location.hash='#/wave'`);
    for (let i=0;i<30;i++) { await delay(100); if (await evaluate(`!!document.querySelector('.ws-source')`)) break; }
    await evaluate(`Array.from(document.querySelectorAll('.ws-source button')).find(b=>b.textContent.includes('Онлайн-радио')).click()`);
    await delay(100);
    assert.ok(await evaluate(`document.querySelector('.ws-launch')?.textContent.includes('Включить радио')`), 'Playlist is incorrectly shown as an active radio station');
    product.playlistToRadio = true;
    product.compactMenus = true;
    await evaluate(`document.querySelector('button[aria-label=Слушать]')?.click()`);
    await delay(500);
  }
  events = await evaluate('window.__rustEvents');
  const health = events.filter(e => e.type === 'audioHealth');
  assert.ok(health.length > 0, 'Missing native health telemetry');
  assert.ok(!events.some(e => e.type === 'fatal'), 'Device switch failed');
  const processStats = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${app.pid}' | Where-Object Name -eq 'mora-audio.exe' | ForEach-Object { Get-Process -Id $_.ProcessId | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU } | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
  assert.ok(Number.isInteger(processStats.Id) && processStats.Id > 0);
  // Kill only the native child of this disposable Electron instance, then exercise user recovery.
  process.kill(processStats.Id);
  for (let i = 0; i < 100; i++) { await delay(100);if (await evaluate('window.__rustEvents.some(e=>e.type==="fatal") && !!document.querySelector("button[aria-label=Слушать]")')) break; }
  await evaluate(`window.__rustEvents=[];document.querySelector('button[aria-label=Слушать]').click()`);
  let recovered = false;
  for (let i = 0; i < 100; i++) { await delay(100);recovered = await evaluate('window.__rustEvents.some(e=>e.type==="tick"&&!e.paused&&e.decks.some(d=>d.playing&&d.position>0))');if (recovered) break; }
  assert.ok(recovered, 'Play did not recover after native process termination');
  const report = { date: new Date().toISOString(), profile, sampleRate: 48000, muted: true, controller: 'React → preload → Electron producer → native PCM files → Rust → WASAPI', pauseResume: true, manualTransition: true, background, rapidSkips, product, nextAfterRapidSkips: advanced, processCrashRecovery: true, deviceSwitch: true, rejectedDeviceKeptOldOutput: rejectedDevice, pcmUnderruns: events.filter(e => e.type === 'underrun').length, health, nativeProcess: processStats };
  fs.writeFileSync(path.join(root, `data-bench-results/rust-audio/desktop-smoke${packaged ? '-packaged' : ''}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate('window.automixDesktop.audioStop()').catch(() => {});
    await request('Browser.close').catch(() => {});socket.close();
  }
  for (const p of pending.values()) { clearTimeout(p.timer);p.reject(new Error('Test ended')); }
  if (app.exitCode === null) { await Promise.race([new Promise(resolve => app.once('exit', resolve)), delay(3000)]);if (app.exitCode === null) app.kill(); }
}
