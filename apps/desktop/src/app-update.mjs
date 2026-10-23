/** App updates use the packaged GitHub feed; renderer messages never supply URLs or paths. */
export class AppUpdates {
  constructor({ updater, currentVersion, enabled, onChange = () => {} }) {
    this.updater = updater;
    this.onChange = onChange;
    this.state = { phase: enabled ? 'idle' : 'disabled', currentVersion, version: null, size: null, percent: 0, error: null };
    this.pending = null;
    this.token = null;
    this.timers = [];
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.autoRunAppAfterInstall = true;
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('download-progress', (progress) => {
      if (this.state.phase !== 'downloading' || this.token?.cancelled) return;
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent || 0)));
      if (percent !== this.state.percent) this.set({ percent });
    });
    updater.on('update-downloaded', (info) => {
      if (this.state.phase === 'downloading' && !this.token?.cancelled && info.version === this.state.version) {
        this.set({ phase: 'downloaded', percent: 100, error: null });
      }
    });
    // The library emits errors as well as rejecting promises, including install failures.
    updater.on('error', (error) => {
      if (!this.token?.cancelled) this.fail(error);
    });
  }

  status() { return { ...this.state }; }
  set(patch) { Object.assign(this.state, patch); this.onChange(this.status()); }
  fail(error) {
    const integrity = /checksum|sha512|signature|integrity/i.test(String(error?.code ?? '') + String(error?.message ?? ''));
    this.set({ phase: 'error', error: integrity
      ? 'Проверка файла обновления не прошла. Установка отменена; скачайте обновление заново.'
      : 'Не удалось обновить MORA. Проверьте подключение и повторите проверку; текущая версия продолжит работать.' });
  }

  check() {
    if (['disabled', 'downloading', 'downloaded', 'installing'].includes(this.state.phase)) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.set({ phase: 'checking', error: null });
    this.pending = (async () => {
      try {
        const result = await this.updater.checkForUpdates();
        this.token = result?.isUpdateAvailable ? result.cancellationToken : null;
        const info = result?.isUpdateAvailable ? result.updateInfo : null;
        const file = info?.files?.find((f) => /\.exe$/i.test(f.url));
        this.set({ phase: info ? 'available' : 'current', version: info?.version ?? null,
          size: Number.isFinite(file?.size) && file.size > 0 ? file.size : null, percent: 0, error: null });
      } catch (error) { this.fail(error); }
      finally { this.pending = null; }
      return this.status();
    })();
    return this.pending;
  }

  async download() {
    if (this.pending) { await this.pending; return this.download(); }
    if (this.state.phase !== 'available') return this.status();
    if (!this.token || this.token.cancelled) {
      await this.check();
      if (this.state.phase !== 'available' || !this.token) return this.status();
    }
    const token = this.token;
    this.set({ phase: 'downloading', percent: 0, error: null });
    this.pending = (async () => {
      try { await this.updater.downloadUpdate(token); }
      catch (error) { if (!token.cancelled) this.fail(error); }
      finally {
        if (token.cancelled) this.set({ phase: 'available', percent: 0, error: null });
        this.pending = null;
      }
      return this.status();
    })();
    return this.pending;
  }

  cancel() {
    if (this.state.phase === 'downloading') this.token?.cancel();
    return this.status();
  }

  install() {
    if (this.state.phase !== 'downloaded') throw new Error('Сначала скачайте и проверьте обновление');
    this.set({ phase: 'installing', error: null });
    try { this.updater.quitAndInstall(true, true); }
    catch (error) { this.fail(error); }
    return this.status();
  }

  start() {
    if (this.state.phase === 'disabled' || this.timers.length) return;
    const check = () => { void this.check(); };
    this.timers.push(setTimeout(check, 15_000), setInterval(check, 6 * 3600_000));
    for (const timer of this.timers) timer.unref?.();
  }

  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.cancel();
  }
}
