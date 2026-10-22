import path from 'node:path';

// Windows refuses to rename a folder while an indexer or antivirus holds a file in it; such locks are brief.
async function rename(fs, from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Swaps a finished import into place, keeping the previous library as a backup.
 * If the swap fails the previous library is put back; staging is never removed here,
 * so a failed restore still leaves the import for recoverDataDir to publish on next start.
 */
export async function publishLibrary(fs, dataDir, staging, stamp) {
  const backup = fs.existsSync(dataDir) ? `${dataDir}.backup-${stamp}` : null;
  if (backup) await rename(fs, dataDir, backup);
  try {
    await rename(fs, staging, dataDir);
  } catch (e) {
    if (backup) await rename(fs, backup, dataDir);
    throw e;
  }
  fs.rmSync(path.join(dataDir, '.import-complete'), { force: true });
}
