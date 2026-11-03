import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceTempEnv } from '../../../tools/workspace-temp.mjs';
const cwd = fileURLToPath(new URL('../', import.meta.url));
// Stable installers ship automatic transition fixes while the manual editor is auditioned.
const env = { ...workspaceTempEnv(), VITE_TRANSITION_EDITOR: '0' };
for (const args of [
  [fileURLToPath(new URL('./build.mjs', import.meta.url))],
  [fileURLToPath(new URL('../../../node_modules/electron-builder/cli.js', import.meta.url)), '--win', ...(process.argv.includes('--dir') ? ['--dir'] : []), '--config', 'electron-builder.json', '--publish', 'never'],
  ...(process.argv.includes('--dir') ? [] : [[fileURLToPath(new URL('./verify-release.mjs', import.meta.url))]]),
]) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
