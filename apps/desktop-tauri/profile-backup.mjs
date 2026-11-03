import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

/** Snapshot before schema migrations; media files remain in place and are never rewritten. */
export async function backupBeforeUpgrade(profile, dataDir, version) {
  if (!/^[0-9A-Za-z._-]+$/.test(version)) throw Error('Invalid upgrade version');
  const source = path.join(dataDir, 'automix.sqlite');
  if (!fs.existsSync(source)) return;
  const target = path.join(profile, 'upgrade-backups', version);
  const marker = path.join(target, 'complete.json');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(target, { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA quick_check').get();
    if (Object.values(result)[0] !== 'ok') throw Error('Исходная медиатека повреждена; обновление остановлено');
    await backup(db, path.join(target, 'automix.sqlite'));
  } finally { db.close(); }
  for (const name of ['desktop.json', 'secret.bin', 'tauri-secret.bin', 'Local State', 'playback-recovery.json']) {
    const file = path.join(profile, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, name));
  }
  fs.writeFileSync(marker, JSON.stringify({ version, dataDir: path.resolve(dataDir), createdAt: new Date().toISOString() }), { flag: 'wx' });
}
