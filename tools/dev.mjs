import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Launch the JS entry points directly so npm dev works with Cyrillic paths on Windows.
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'apps/server/src/index.ts'], { cwd: root, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['--env-file-if-exists=.env', 'node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web'], { cwd: root, stdio: 'inherit', windowsHide: true }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
};
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
