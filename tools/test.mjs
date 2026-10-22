import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceTempEnv } from './workspace-temp.mjs';
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), env: workspaceTempEnv(), stdio: 'inherit', windowsHide: true,
});
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
