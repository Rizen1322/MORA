import { expect, it } from 'vitest';
import fs from 'node:fs';
import { unifiedConfig } from '../unified-installer.mjs';
it('preserves the released Electron NSIS identity and update contract for the native payload', () => {
  const legacy = JSON.parse(fs.readFileSync(new URL('../../desktop/electron-builder.json', import.meta.url), 'utf8'));
  const config = unifiedConfig(legacy, '0.4.2', '/output', '/icons');
  expect(config.appId).toBe('ru.mora.desktop');
  expect(config.productName).toBe('MORA');
  expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, shortcutName: 'MORA', artifactName: 'MORA-Setup-${version}.exe' });
  expect(config.win.executableName).toBe('MORA');
  expect(config.extraResources).toEqual([]);
  expect(config.extraMetadata.version).toBe('0.4.2');
});
