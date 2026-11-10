import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ bridge: {} as any, toast: vi.fn() }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: state.bridge }));
vi.mock('../src/store/app.ts', () => ({ useApp: { getState: () => ({ toast: state.toast }) } }));
import { exportPlaylistBackup } from '../src/lib/playlist-export.ts';
beforeEach(() => { delete state.bridge.exportPlaylists; vi.clearAllMocks(); });
it('keeps browser and Electron downloads as ordinary links', () => {
  const event = { preventDefault: vi.fn() }; exportPlaylistBackup(event, 'id'); expect(event.preventDefault).not.toHaveBeenCalled();
});
it('uses the native dialog and treats cancellation as a normal result', async () => {
  state.bridge.exportPlaylists = vi.fn().mockResolvedValue(false);
  const event = { preventDefault: vi.fn() }; exportPlaylistBackup(event, 'id'); await Promise.resolve();
  expect(event.preventDefault).toHaveBeenCalledOnce(); expect(state.bridge.exportPlaylists).toHaveBeenCalledWith('id'); expect(state.toast).not.toHaveBeenCalled();
});
it('shows export errors instead of failing silently', async () => {
  state.bridge.exportPlaylists = vi.fn().mockRejectedValue(new Error('Disk full'));
  exportPlaylistBackup({ preventDefault() {} }); await Promise.resolve();
  expect(state.toast).toHaveBeenCalledWith('Не удалось экспортировать: Disk full', 'error');
});
