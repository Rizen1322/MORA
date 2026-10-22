import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const versionPattern = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const releaseRoot = 'https://github.com/yt-dlp/yt-dlp/releases/download/';

/** Only official stable Windows executables; updates never overwrite bundled files. */
export class ResolverUpdater {
  constructor({ directory, bundled, fetcher = fetch, probe = async (file) => {
    const { stdout } = await exec(file, ['--version'], { timeout: 15000, windowsHide: true, maxBuffer: 4096 });
    return stdout.trim();
  } }) {
    this.directory = directory; this.bundled = bundled; this.fetcher = fetcher; this.probe = probe;
    this.busy = false; this.latest = null;
    try { const v = fs.readFileSync(path.join(path.dirname(bundled), 'VERSION.txt'), 'utf8').trim(); this.bundledVersion = versionPattern.test(v) ? v : 'bundled'; }
    catch { this.bundledVersion = 'bundled'; }
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, 'active.json'), 'utf8')); } catch { return {}; }
  }

  verified(record) {
    if (!record || !versionPattern.test(record.version) || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    const file = path.join(this.directory, record.version, 'yt-dlp.exe');
    try {
      const bytes = fs.readFileSync(file);
      return crypto.createHash('sha256').update(bytes).digest('hex') === record.sha256 ? file : null;
    } catch { return null; }
  }

  executable() { return this.verified(this.readState().active) || this.bundled; }

  status() {
    const state = this.readState();
    return { selected: this.verified(state.active) ? state.active.version : this.bundledVersion, latest: this.latest?.version ?? null,
      canRollback: !!state.active, busy: this.busy };
  }

  async bytes(url, limit, signal) {
    const response = await this.fetcher(url, { signal, headers: { 'User-Agent': 'MORA-resolver-updater', Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if (!response.ok || !response.body) throw new Error(`Сервер обновлений ответил ${response.status}`);
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Обновление слишком большое');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Обновление слишком большое');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }

  async checkRelease() {
    this.latest = null;
    const signal = AbortSignal.timeout(20000);
    const release = JSON.parse((await this.bytes('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', 2 << 20, signal)).toString('utf8'));
    if (release.draft || release.prerelease || !versionPattern.test(release.tag_name)) throw new Error('Не удалось проверить стабильную версию');
    const version = release.tag_name;
    const asset = release.assets?.find((a) => a.name === 'yt-dlp.exe');
    const sums = release.assets?.find((a) => a.name === 'SHA2-256SUMS');
    const base = `${releaseRoot}${version}/`;
    if (asset?.browser_download_url !== `${base}yt-dlp.exe` || sums?.browser_download_url !== `${base}SHA2-256SUMS`) throw new Error('Неизвестный адрес обновления');
    const text = (await this.bytes(sums.browser_download_url, 1 << 20, signal)).toString('utf8');
    const sha256 = text.split(/\r?\n/).map((s) => /^([a-f0-9]{64})\s+\*?yt-dlp\.exe$/.exec(s.trim())).find(Boolean)?.[1];
    if (!sha256) throw new Error('Нет контрольной суммы обновления');
    this.latest = { version, sha256, url: asset.browser_download_url };
    return this.status();
  }

  async check() {
    if (this.busy) throw new Error('Обновление уже выполняется');
    this.busy = true;
    try { await this.checkRelease(); return { ...this.status(), busy: false }; } finally { this.busy = false; }
  }

  writeState(state) {
    fs.mkdirSync(this.directory, { recursive: true });
    const tmp = path.join(this.directory, 'active.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, path.join(this.directory, 'active.json'));
  }

  async install() {
    if (this.busy) throw new Error('Обновление уже выполняется');
    this.busy = true; let staging;
    try {
      // Re-read metadata on installation instead of trusting stale renderer data.
      await this.checkRelease(); const release = this.latest;
      const old = this.readState();
      if (old.active?.version === release.version && this.verified(old.active)) return { ...this.status(), busy: false };
      const bytes = await this.bytes(release.url, 100 << 20, AbortSignal.timeout(120000));
      if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a || crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Проверка файла обновления не пройдена');
      fs.mkdirSync(this.directory, { recursive: true });
      staging = fs.mkdtempSync(path.join(this.directory, '.staging-'));
      const file = path.join(staging, 'yt-dlp.exe'); fs.writeFileSync(file, bytes);
      if (await this.probe(file) !== release.version) throw new Error('Новая версия не запускается; сохранена прежняя');
      const target = path.join(this.directory, release.version);
      // Version directories are immutable; a conflicting folder is not replaced.
      if (fs.existsSync(target)) {
        if (!this.verified(release)) throw new Error('Папка этой версии повреждена; сохранена прежняя');
      } else { fs.renameSync(staging, target); staging = null; }
      this.writeState({ active: { version: release.version, sha256: release.sha256 }, previous: this.verified(old.active) ? old.active : null });
      return { ...this.status(), busy: false };
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      this.busy = false;
    }
  }

  rollback() {
    if (this.busy) throw new Error('Дождитесь окончания обновления');
    const previous = this.readState().previous;
    this.writeState({ active: this.verified(previous) ? previous : null, previous: null });
    return this.status();
  }
}
