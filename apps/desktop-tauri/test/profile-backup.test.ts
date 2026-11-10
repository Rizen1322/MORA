import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { backupBeforeUpgrade } from '../profile-backup.mjs';
it('backs up WAL rows, provider ciphertext, custom paths and settings before migration without touching originals', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mora-upgrade-')), profile=path.join(root,'profile'), data=path.join(root,'custom');
  fs.mkdirSync(profile);fs.mkdirSync(data);
  const original=new DatabaseSync(path.join(data,'automix.sqlite'));
  try {
    original.exec("PRAGMA journal_mode=WAL;CREATE TABLE playlists(id TEXT);INSERT INTO playlists VALUES('mine');CREATE TABLE providers(secret TEXT);INSERT INTO providers VALUES('enc1:test')");
    fs.writeFileSync(path.join(profile,'desktop.json'),JSON.stringify({dataDir:data,audio:{volume:.42}}));
    fs.writeFileSync(path.join(profile,'secret.bin'),'encrypted-source-key');
    await backupBeforeUpgrade(profile,data,'0.4.2');
    const saved=new DatabaseSync(path.join(profile,'upgrade-backups/0.4.2/automix.sqlite'),{readOnly:true});
    try {expect(saved.prepare('SELECT id FROM playlists').get().id).toBe('mine');expect(saved.prepare('SELECT secret FROM providers').get().secret).toBe('enc1:test');}finally{saved.close()}
    expect(fs.readFileSync(path.join(profile,'upgrade-backups/0.4.2/secret.bin'),'utf8')).toBe('encrypted-source-key');
    original.exec("INSERT INTO playlists VALUES('later')");
    await backupBeforeUpgrade(profile,data,'0.4.2');
    expect(original.prepare('SELECT count(*) n FROM playlists').get().n).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(profile,'upgrade-backups/0.4.2/complete.json'),'utf8')).dataDir).toBe(data);
  } finally {original.close();fs.rmSync(root,{recursive:true,force:true})}
});
it('fails closed on a damaged database before writing the completion marker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mora-upgrade-bad-'));
  try {fs.writeFileSync(path.join(root,'automix.sqlite'),'broken');await expect(backupBeforeUpgrade(root,root,'0.4.2')).rejects.toThrow();expect(fs.existsSync(path.join(root,'upgrade-backups/0.4.2/complete.json'))).toBe(false)}finally{fs.rmSync(root,{recursive:true,force:true})}
});
