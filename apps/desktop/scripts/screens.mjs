// Window screenshots at several sizes and display scales (Chromium's
// --force-device-scale-factor emulates 125/150/200 % DPI for this window).
//   node apps/desktop/scripts/screens.mjs --profile <test profile> --out <dir> [--exe MORA.exe]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep, waitForPage } from './cdp.mjs';
import { captureWindow, closeMainWindow, pinWindow, placeWindow } from './proctree.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const exe = arg('--exe', path.join(desktop, 'dist/win-unpacked/MORA.exe'));
const profile = arg('--profile');
const out = path.resolve(arg('--out', 'screens'));
if (!profile) throw new Error('--profile is required (use a test profile, never the real one)');
fs.mkdirSync(out, { recursive: true });
const results = [];

for (const scale of [1, 1.25, 1.5, 2]) {
  const proc = spawn(exe, ['--remote-debugging-port=9333', `--force-device-scale-factor=${scale}`], { env: { ...process.env, AUTOMIX_PROFILE_DIR: profile }, stdio: 'ignore' });
  const c = await connect((await waitForPage(9333)).webSocketDebuggerUrl);
  await c.waitFor("!!document.querySelector('.sidebar')");
  pinWindow(proc.pid, true);
  const sizes = scale === 1 ? [['min', 960, 680], ['normal', 1280, 820], ['max']] : [['normal', 1280, 820]];
  for (const [name, w, h] of sizes) {
    placeWindow(proc.pid, name === 'max' ? { maximized: true } : { width: Math.round(w * scale), height: Math.round(h * scale) });
    for (const route of scale === 1 && name === 'normal' ? ['', 'library', 'liked', 'settings', 'wave'] : ['']) {
      await c.evaluate(`location.hash = '/${route}'; document.querySelector('#main')?.scrollTo(0, 0); true`);
      await sleep(1400);
      const file = path.join(out, `${route || 'home'}-${name}-${Math.round(scale * 100)}.png`);
      captureWindow(proc.pid, file);
      const m = await c.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, overflowX: document.documentElement.scrollWidth > innerWidth, sidebarOverflow: (() => { const s = document.querySelector(".sidebar"); return s.scrollHeight > s.clientHeight + 1; })() })');
      results.push({ file: path.basename(file), ...m });
      console.log(path.basename(file), JSON.stringify(m));
    }
  }
  pinWindow(proc.pid, false);
  await c.evaluate('window.automixDesktop.setCloseToTray(false).then(() => true)');
  closeMainWindow(proc.pid);
  await new Promise((r) => proc.once('exit', r));
  // Restore the preference so the next scale starts like a normal launch.
  const s = JSON.parse(fs.readFileSync(path.join(profile, 'desktop.json'), 'utf8'));
  fs.writeFileSync(path.join(profile, 'desktop.json'), JSON.stringify({ ...s, closeToTray: true }, null, 2));
}
fs.writeFileSync(path.join(out, 'screens.json'), JSON.stringify(results, null, 2));
process.exit(0);
