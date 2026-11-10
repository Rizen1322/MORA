import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { publishLibrary } from '../desktop/src/publish.mjs';
import { openSecret, sealSecret } from '../server/src/providers/base.ts';

const [source, dataDir] = process.argv.slice(2);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const staging = `${dataDir}.importing`;
let claimed = false;
function resolved(value) {
  let current = path.resolve(value); const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw Error('Не удалось определить папку медиатеки');
    tail.unshift(path.basename(current)); current = parent;
  }
  const result = path.join(fs.realpathSync.native(current), ...tail);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function overlaps(a, b) {
  const relative = path.relative(a, b);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
try {
  let keys;
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.length > 1024) throw Error('Некорректный ключ медиатеки');
    try { keys = JSON.parse(line); } catch { throw Error('Некорректный ключ медиатеки'); }
    break;
  }
  if (!keys || !/^[0-9a-f]{64}$/i.test(keys.destination ?? '') || (keys.source != null && !/^[0-9a-f]{64}$/i.test(keys.source))) throw Error('Не удалось получить ключ медиатеки');
  if (!source || !dataDir) throw Error('Папка медиатеки не указана');
  if (!fs.existsSync(path.join(source, 'automix.sqlite'))) throw Error('В папке нет automix.sqlite');
  const from = resolved(source), to = resolved(dataDir), temp = resolved(staging);
  if (overlaps(from, to) || overlaps(to, from) || overlaps(from, temp) || overlaps(temp, from)) throw Error('Папки исходной и текущей медиатеки пересекаются');
  if (fs.existsSync(staging)) throw Error('Найдена незавершённая копия медиатеки; она сохранена для восстановления');
  fs.mkdirSync(staging); claimed = true;
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./migrate.mjs', import.meta.url)), source, staging, dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let failure = '';
  worker.stderr.on('data', data => { failure = (failure + data.toString()).slice(-4096); });
  createInterface({ input: worker.stdout }).on('line', line => {
    try { const value = JSON.parse(line); if (value.type === 'progress') send(value); else if (value.type === 'error') failure = value.message; } catch {}
  });
  const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  if (code !== 0) throw Error(failure || `Импорт прерван (код ${code})`);
  const db = new DatabaseSync(path.join(staging, 'automix.sqlite'));
  try {
    const hasProviders = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='providers'").get();
    if (hasProviders) {
      const rows = db.prepare("SELECT id, secret FROM providers WHERE secret LIKE 'enc1:%'").all();
      if (rows.length && !keys.source) throw Error('Ключ исходной медиатеки недоступен; данные входа не перенесены');
      const sourceKey = keys.source ? Buffer.from(keys.source, 'hex') : null;
      const destinationKey = Buffer.from(keys.destination, 'hex');
      const update = db.prepare('UPDATE providers SET secret = ? WHERE id = ?');
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          const plain = openSecret(row.secret, sourceKey);
          if (plain === null) throw Error('Не удалось расшифровать данные входа исходной медиатеки');
          update.run(sealSecret(plain, destinationKey), row.id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } finally { db.close(); }
  await publishLibrary(fs, dataDir, staging, new Date().toISOString().replace(/[:.]/g, '-'));
  send({ type: 'done' });
} catch (error) {
  // A missing destination means staging may be the only surviving copy.
  if (claimed && fs.existsSync(dataDir)) fs.rmSync(staging, { recursive: true, force: true });
  send({ type: 'error', message: error.message });
  process.exitCode = 1;
}
