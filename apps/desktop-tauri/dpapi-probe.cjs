const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const profile = process.env.AUTOMIX_PROFILE_DIR;
if (!profile) throw Error('isolated profile required');
app.setPath('userData', profile);
app.whenReady().then(() => { fs.writeFileSync(path.join(profile, 'secret.bin'), safeStorage.encryptString('0123456789abcdef'.repeat(4))); app.quit(); });
