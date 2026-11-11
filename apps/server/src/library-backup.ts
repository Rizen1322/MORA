import { DEFAULT_AUTOMIX_SETTINGS, sanitizeSound } from '@automix/core';
import { DEFAULT_SETTINGS, type AppSettings } from './automix.ts';
import { validateSmartRules, type SmartRules } from './smart-playlists.ts';

/** Explicit settings fields only; arbitrary kv/provider configuration never enters a backup. */
export function backupSettings(raw: AppSettings): AppSettings {
  const primitives = <T extends object>(defaults: T, value: T): T => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const v = (value as Record<string, unknown>)?.[key];
    return [key, typeof v === typeof fallback && (typeof v !== 'number' || Number.isFinite(v)) ? v : fallback];
  })) as T;
  return {
    automix: primitives(DEFAULT_AUTOMIX_SETTINGS, raw.automix), sound: sanitizeSound(raw.sound),
    wave: { ...primitives(DEFAULT_SETTINGS.wave, raw.wave), ...(Array.isArray(raw.wave.yandexSeeds) ? { yandexSeeds: raw.wave.yandexSeeds.filter(seed => typeof seed === 'string' && seed.length <= 120).slice(0, 12) } : {}) },
    ui: { showDiagnostics: !!raw.ui.showDiagnostics,
      motion: ['system', 'full', 'reduced'].includes(raw.ui.motion ?? '') ? raw.ui.motion : 'system',
      graphics: raw.ui.graphics === 'canvas' ? 'canvas' : 'auto' },
    yandex: primitives(DEFAULT_SETTINGS.yandex, raw.yandex),
    downloads: { autoLiked: !!raw.downloads.autoLiked, wifiOnly: !!raw.downloads.wifiOnly,
      keepWave: [5, 10, 20, 50].includes(raw.downloads.keepWave ?? 0) ? raw.downloads.keepWave : 0 },
    analysis: { onlyWhenIdle: !!raw.analysis.onlyWhenIdle },
  };
}

export interface LibraryBackupData {
  smartPlaylists?: { id: string; name: string; rules: SmartRules; createdAt: number }[];
  settings: AppSettings;
  reactions: { trackId: string; value: number; updatedAt: number }[];
  history: { key: number; trackId: string; startedAt: number; endedAt: number | null; playedMs: number; durationMs: number | null; endReason: string | null }[];
}
export function validateLibraryBackup(value: LibraryBackupData, ids: Set<string>): void {
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!value || !value.settings || ['automix', 'sound', 'wave', 'ui', 'yandex', 'downloads', 'analysis'].some(key => {
    const group = (value.settings as unknown as Record<string, unknown>)[key]; return !group || typeof group !== 'object' || Array.isArray(group);
  })
    || !Array.isArray(value.reactions) || value.reactions.length > 10000 || !Array.isArray(value.history) || value.history.length > 50000
    || value.reactions.some(row => !row || !ids.has(row.trackId) || ![-1, 0, 1].includes(row.value) || !integer(row.updatedAt))
    || value.history.some(row => !row || !ids.has(row.trackId) || !integer(row.key) || !integer(row.startedAt) || !integer(row.playedMs)
      || (row.endedAt !== null && !integer(row.endedAt)) || (row.durationMs !== null && !integer(row.durationMs))
      || (row.endReason !== null && !['finished', 'transition', 'skip', 'stop', 'error'].includes(row.endReason)))) throw Error('Повреждена копия медиатеки');
  backupSettings(value.settings);
  if (value.smartPlaylists !== undefined) {
    if (!Array.isArray(value.smartPlaylists) || value.smartPlaylists.length > 1000 || value.smartPlaylists.some(p => !p || typeof p.id !== 'string' || p.id.length > 100 || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || !integer(p.createdAt))) throw Error('Повреждены умные плейлисты');
    for (const playlist of value.smartPlaylists) validateSmartRules(playlist.rules);
  }
}
