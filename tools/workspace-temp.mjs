import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Keep disposable test/packager output on the workspace drive, not the OS drive. */
export function workspaceTempEnv() {
  const temp = fileURLToPath(new URL('./.cache/tmp/', import.meta.url));
  fs.mkdirSync(temp, { recursive: true });
  return { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
}
