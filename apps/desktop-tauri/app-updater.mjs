import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FEED = 'https://github.com/Rizen1322/MORA/releases/latest/download/';
const LIMIT = 400 * 1048576;
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** electron-updater-shaped adapter over the same latest.yml feed, so AppUpdates drives it unchanged. */
export class GithubNsisUpdater {
  constructor({ directory, currentVersion, fetcher = fetch, feed = FEED }) {
    Object.assign(this, { directory, currentVersion, fetcher, feed, listeners: new Map(), info: null });
  }
  on(event, callback) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
  emit(event, value) { for (const callback of this.listeners.get(event) ?? []) callback(value); }

  async checkForUpdates() {
    const response = await this.fetcher(`${this.feed}latest.yml`, { headers: { 'User-Agent': 'MORA-updater' } }, 65536);
    if (!response.ok) throw Error(`Сервер обновлений ответил ${response.status}`);
    const text = await response.text();
    const field = name => new RegExp(`^${name}: *'?([^'\\r\\n]+)`, 'm').exec(text)?.[1];
    const version = field('version'), file = field('path'), sha512 = field('sha512'), size = Number(/^ +size: *(\d+)/m.exec(text)?.[1]);
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^MORA-Setup-\d+\.\d+\.\d+\.exe$/.test(file ?? '') ||
        !/^[A-Za-z0-9+/]{86}==$/.test(sha512 ?? '') || !(size > 0 && size <= LIMIT)) throw Error('Некорректное описание обновления');
    if (!newer(version, this.currentVersion)) return { isUpdateAvailable: false, updateInfo: { version } };
    this.info = { version, file, sha512, size };
    const controller = new AbortController();
    const cancellationToken = { cancelled: false, signal: controller.signal, cancel() { this.cancelled = true; controller.abort(); } };
    return { isUpdateAvailable: true, cancellationToken, updateInfo: { version, files: [{ url: file, size }] } };
  }

  async downloadUpdate(token) {
    const { version, file, sha512, size } = this.info;
    const response = await this.fetcher(`${this.feed}${file}`, { signal: token.signal, headers: { 'User-Agent': 'MORA-updater', Accept: 'application/octet-stream' } }, LIMIT);
    if (!response.ok || !response.body) throw Error(`Сервер обновлений ответил ${response.status}`);
    const hash = crypto.createHash('sha512'), chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        received += value.byteLength;
        if (received > size) throw Error('Размер обновления не совпадает');
        hash.update(value); chunks.push(Buffer.from(value));
        this.emit('download-progress', { percent: received / size * 100 });
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (received !== size || hash.digest('base64') !== sha512) throw Error('sha512 checksum mismatch');
    fs.rmSync(this.directory, { recursive: true, force: true });
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(path.join(this.directory, file), Buffer.concat(chunks));
    this.ready = { version, file };
    this.emit('update-downloaded', { version });
  }

  /** The shell launches the installer named here; it only accepts a file inside this directory. */
  quitAndInstall() {
    if (!this.ready) throw Error('Обновление не скачано');
    fs.writeFileSync(path.join(this.directory, 'pending.json'), JSON.stringify(this.ready));
  }
}
