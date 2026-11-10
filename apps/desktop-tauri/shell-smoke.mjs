import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPage, connect } from '../desktop/scripts/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, 'probe-profile'), { recursive: true });
const profile = fs.mkdtempSync(path.join(here, 'probe-profile', 'shell-'));
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = {
  ...process.env, AUTOMIX_TEST: '1', AUTOMIX_PROFILE_DIR: profile,
  ...(process.env.MORA_PACKAGED ? {} : { AUTOMIX_RESOURCES_DIR: path.join(here, 'build') }),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
};
if (process.env.MORA_PACKAGED) for (const key of ['AUTOMIX_RESOURCES_DIR', 'AUTOMIX_NODE_PATH', 'AUTOMIX_BACKEND_ENTRY', 'AUTOMIX_NETWORK_RUST']) delete env[key];
const child = spawn(path.join(here, `src-tauri/target/${process.env.MORA_BUILD_MODE || 'debug'}/mora-desktop-native.exe`), [], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '';
let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { errors += chunk.toString(); });
try {
  const page = await waitForPage(port, { timeoutMs: 45000 });
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await cdp.waitFor('!!window.automixDesktop && document.documentElement.classList.contains("desktop")', { timeoutMs: 45000 });
    assert.equal(await cdp.evaluate('document.hidden'), true);
    assert.equal(await cdp.evaluate('typeof window.automixDesktop.exportPlaylists'), 'function');
    assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('a[href=\"#/library\"]')).webkitUserDrag"), 'none');
    assert.equal(await cdp.evaluate("fetch('/api/health').then(r=>r.json()).then(h=>h.decoder)"), 'Symphonia');
    assert.equal(await cdp.evaluate("fetch('/api/backup/playlists').then(r=>r.json()).then(b=>b.format)"), 'mora-playlists');
    assert.match(await cdp.evaluate("window.__TAURI_INTERNALS__.invoke('desktop_action',{action:'save-export',value:{contents:'{',name:'MORA-playlists.json'}}).then(()=>'',e=>String(e))"), /JSON/);
    assert.equal(await cdp.evaluate('window.automixDesktop.getSettings().then(x => x.decorated)'), false);
    assert.equal(await cdp.evaluate('document.querySelectorAll(".titlebar .window-controls button").length'), 3);
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".titlebar")).height'), '40px');
    await cdp.evaluate(`window.__windowCommands=[];window.__originalWindowCommand=window.automixDesktop.windowCommand;window.automixDesktop.windowCommand=async action=>{window.__windowCommands.push(action)};document.querySelectorAll('.titlebar .window-controls button').forEach(b=>b.click())`);
    assert.deepEqual(await cdp.evaluate('window.__windowCommands'), ['minimize', 'maximize', 'close']);
    await cdp.evaluate('window.automixDesktop.windowCommand=window.__originalWindowCommand;delete window.__originalWindowCommand');
    assert.equal(await cdp.evaluate('typeof window.automixDesktop.nativeMix.state'), 'function');
    assert.equal(await cdp.evaluate('window.automixDesktop.nativeMix.state().then(x => x.active)'), false);
    await cdp.evaluate("window.automixDesktop.audioCommand({cmd:'output',device:''})");
    assert.equal(await cdp.evaluate('window.automixDesktop.getSettings().then(x => x.audio.outputDevice)'), '');
    assert.equal(await cdp.evaluate('window.automixDesktop.setCompact(true).then(x => x.on).catch(e => String(e))'), true);
    await cdp.waitFor('document.documentElement.classList.contains("compact")');
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".window-controls")).display'), 'flex');
    assert.equal(await cdp.evaluate('window.automixDesktop.setCompact(false).then(x => x.on)'), false);
    await cdp.evaluate('window.automixDesktop.restartBackend()');
    assert.equal(await cdp.evaluate('window.automixDesktop.nativeMix.state().then(x => x.active)'), false);
    const second = spawn(child.spawnfile, [], { windowsHide: true, env, stdio: 'ignore' });
    const secondExit = await Promise.race([new Promise(resolve => second.once('exit', resolve)), new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
    if (secondExit === null) second.kill();
    assert.notEqual(secondExit, null, 'second instance did not exit');
    console.log('Hidden Tauri window: React desktop bridge and inactive playback state passed.');
  } finally { cdp.close(); }
} catch (error) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.text()).catch(() => 'DevTools unavailable');
  throw new Error(`${error.message}\nexit=${child.exitCode} signal=${child.signalCode}\n${output}\n${errors}\n${targets}`);
}
finally { child.kill(); }
process.exit(0);
