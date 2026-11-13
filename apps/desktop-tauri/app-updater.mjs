import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
    this.ready = null;
    const response = await this.fetcher(`${this.feed}${file}`, { signal: token.signal, headers: { 'User-Agent': 'MORA-updater', Accept: 'application/octet-stream' } }, LIMIT);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`Сервер обновлений ответил ${response.status}`); }
    const hash = crypto.createHash('sha512');
    let received = 0;
    let staging;
    try {
      fs.mkdirSync(path.dirname(this.directory), { recursive: true });
      staging = fs.mkdtempSync(`${this.directory}.download-`);
      const progress = new Transform({ transform: (chunk, _encoding, done) => {
        received += chunk.length;
        if (received > size) return done(Error('Размер обновления не совпадает'));
        hash.update(chunk);
        this.emit('download-progress', { percent: received / size * 100 });
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(path.join(staging, file), { flags: 'wx' }), { signal: token.signal });
      token.signal.throwIfAborted();
      if (received !== size || hash.digest('base64') !== sha512) throw Error('sha512 checksum mismatch');
      fs.rmSync(this.directory, { recursive: true, force: true });
      fs.renameSync(staging, this.directory);
      this.ready = { version, file };
      this.emit('update-downloaded', { version });
    } finally {
      await response.body.cancel().catch(() => {});
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** The shell launches the installer named here; it only accepts a file inside this directory. */
  quitAndInstall() {
    if (!this.ready) throw Error('Обновление не скачано');
    fs.writeFileSync(path.join(this.directory, 'pending.json'), JSON.stringify(this.ready));
  }
}
