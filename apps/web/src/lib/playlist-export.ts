import { desktop } from './desktop.ts';
import { useApp } from '../store/app.ts';

export function exportPlaylistBackup(event: { preventDefault(): void }, playlist?: string): void {
  if (!desktop?.exportPlaylists) return;
  event.preventDefault();
  void desktop.exportPlaylists(playlist).catch(error => useApp.getState().toast(`Не удалось экспортировать: ${error instanceof Error ? error.message : String(error)}`, 'error'));
}
