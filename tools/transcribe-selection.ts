/** Word timing for the tracks of an audit selection with the server's own script; never re-separates.
 * Writes only lyrics.json next to existing voices. Usage: npx tsx tools/transcribe-selection.ts REPORT.json */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../apps/server/src/config.ts';

const cfg = loadConfig();
if (!cfg.stemsPython) throw new Error('STEMS_PYTHON не задан');
const tracks = (JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8')).tracks as { title: string; contentHash: string }[]);
for (const t of tracks) {
  const dir = path.join(cfg.dataDir, 'cache', 'stems', t.contentHash, 'hdemucs-v1'), out = path.join(dir, 'lyrics.json');
  if (!fs.existsSync(path.join(dir, 'metadata.json')) || fs.existsSync(out)) continue;
  try {
    const log = execFileSync(cfg.stemsPython, [path.join(ROOT, 'tools', 'transcribe-vocals.py'), '--stem-dir', dir, '--output', out], { windowsHide: true, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const done = log.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.type === 'done');
    console.log(`${t.title}: ${done ? `${done.language}, ${done.words} слов, ${done.seconds} с` : 'нет результата'}`);
  } catch (e) { console.log(`${t.title}: ошибка ${(e as Error).message.slice(0, 160)}`); }
}
