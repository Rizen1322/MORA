import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error desktop shell modules are plain ESM JavaScript
import { AppUpdates } from '../src/app-update.mjs';

function fixture(enabled = true) {
  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  const info = { version: '0.3.15', files: [{ url: 'MORA-Setup-0.3.15.exe', size: 500_000_000 }] };
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info, cancellationToken: token })),
    downloadUpdate: vi.fn(async (_token: typeof token) => { updater.emit('update-downloaded', info); return ['verified.exe']; }),
    quitAndInstall: vi.fn(),
  });
  const changed = vi.fn();
  const updates = new AppUpdates({ updater, currentVersion: '0.3.14', enabled, onChange: changed });
  return { updates, updater, token, info, changed };
}

describe('MORA application updates', () => {
  it('checks without downloading, coalesces checks and installs only after a verified download', async () => {
    const f = fixture();
    expect(f.updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
    const [a, b] = await Promise.all([f.updates.check(), f.updates.check()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ phase: 'available', version: '0.3.15', size: 500_000_000 });
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(() => f.updates.install()).toThrow('Сначала');
    const [first, second] = await Promise.all([f.updates.download(), f.updates.download()]);
    expect(first.phase).toBe('downloaded');
    expect(second.phase).toBe('downloaded');
    expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    await f.updates.check(); // A scheduled check cannot replace a ready installer.
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    f.updates.install();
    expect(f.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(() => f.updates.install()).toThrow('Сначала');
  });

  it('keeps the installed version usable after a network or checksum failure', async () => {
    const f = fixture();
    f.updater.checkForUpdates.mockRejectedValueOnce(new Error('network offline'));
    expect((await f.updates.check()).phase).toBe('error');
    await f.updates.check();
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      const error = new Error('sha512 checksum mismatch https://private.test/?token=secret');
      f.updater.emit('error', error);
      throw error;
    });
    const state = await f.updates.download();
    expect(state).toMatchObject({ phase: 'error', currentVersion: '0.3.14' });
    expect(state.error).toContain('Проверка файла');
    expect(state.error).not.toContain('secret');
    expect(() => f.updates.install()).toThrow();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('allows cancellation, ignores late download events and checks again before retrying', async () => {
    const f = fixture();
    await f.updates.check();
    let finish!: () => void;
    f.updater.downloadUpdate.mockImplementationOnce(() => new Promise<string[]>((resolve) => {
      finish = () => { f.updater.emit('update-downloaded', f.info); resolve(['late.exe']); };
    }));
    const downloading = f.updates.download();
    f.updater.emit('download-progress', { percent: 23.8 });
    expect(f.updates.status().percent).toBe(23);
    f.updates.cancel();
    f.updater.emit('download-progress', { percent: 99 });
    expect(f.updates.status().percent).toBe(23);
    finish();
    expect((await downloading).phase).toBe('available');
    expect(() => f.updates.install()).toThrow();
    const nextToken = { cancelled: false, cancel() { this.cancelled = true; } };
    f.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: f.info, cancellationToken: nextToken });
    expect((await f.updates.download()).phase).toBe('downloaded');
    expect(f.updater.downloadUpdate).toHaveBeenLastCalledWith(nextToken);
  });

  it('does not trust download completion for a different version, and handles install errors', async () => {
    const f = fixture();
    await f.updates.check();
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit('update-downloaded', { version: '0.1.0' });
      throw new Error('unexpected file');
    });
    expect((await f.updates.download()).phase).toBe('error');
    expect(() => f.updates.install()).toThrow();
    await f.updates.check();
    await f.updates.download();
    f.updater.quitAndInstall.mockImplementationOnce(() => f.updater.emit('error', new Error('installer denied')));
    expect(f.updates.install().phase).toBe('error');
  });

  it('distinguishes no update from an available update using the library version decision', async () => {
    const f = fixture();
    f.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: f.info } as any);
    expect(await f.updates.check()).toMatchObject({ phase: 'current', version: null });
    await f.updates.download();
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('checks on a bounded schedule and stops timers on quit', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.updates.start(); f.updates.start();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
      f.updates.dispose();
      await vi.advanceTimersByTimeAsync(12 * 3600_000);
      expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
      const dev = fixture(false);
      dev.updates.start(); await dev.updates.check(); await dev.updates.download();
      expect(dev.updates.status().phase).toBe('disabled');
      expect(dev.updater.checkForUpdates).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
