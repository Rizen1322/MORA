import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { FfmpegTools, ProbeResult } from '../ffmpeg.ts';
import { sha256File } from '../library.ts';

export interface YandexDownloadVariant {
  codec: string;
  bitrateInKbps: number;
  preview: boolean;
  downloadInfoUrl: string;
  direct?: boolean;
  transport?: string;
}

export interface PreparedYandexAudio {
  file: string;
  hash: string;
  size: number;
  probe: ProbeResult;
  bitrate: number;
}

/** The legacy MP3 protocol is documented by MarshalX/yandex-music-api.
 * This implementation does not use the newer encrypted-file endpoint. */
const LEGACY_MP3_SALT = 'XGRlBW9FXlekgbPrRHuSiA';
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;

export const isYandexTrackId = (id: string): boolean => /^(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?::\d+)?$/i.test(id);

/** No account headers are ever sent to the media/CDN transport. */
export function validateYandexMediaUrl(value: string, apiBase: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error('Яндекс вернул некорректный адрес аудио'); }
  const base = new URL(apiBase);
  const testOrigin = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) && u.origin === base.origin;
  const domain = ['yandex.net', 'yandex.ru', 'yandex.com', 'yandexmusic.net', 'yandexmusic.ru']
    .some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  if (u.username || u.password || (!testOrigin && (u.protocol !== 'https:' || !domain || (u.port && u.port !== '443')))) {
    throw new Error('Яндекс вернул неподдерживаемый адрес аудио');
  }
  return u;
}

/** Parses a tiny fixed XML schema, rejecting DTD/entities instead of evaluating XML. */
export function parseYandexDownloadXml(xml: string, apiBase: string): string {
  if (xml.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Некорректное описание аудио Яндекса');
  const field = (name: string) => {
    const matches = [...xml.matchAll(new RegExp(`<${name}>\\s*([^<>]*)\\s*</${name}>`, 'g'))];
    if (matches.length !== 1) throw new Error('Неполное описание аудио Яндекса');
    return matches[0][1].trim().replace(/&amp;/g, '&');
  };
  const host = field('host'), sourcePath = field('path'), ts = field('ts'), salt = field('s');
  if (!/^[a-z\d.:[\]-]+$/i.test(host) || !/^[a-f\d]{1,64}$/i.test(ts) || !/^\/[\w./%+=,@~-]+$/.test(sourcePath)
    || sourcePath.includes('..') || !/^[\w+-]+$/.test(salt)) throw new Error('Некорректное описание аудио Яндекса');
  const sign = crypto.createHash('md5').update(LEGACY_MP3_SALT + sourcePath.slice(1) + salt).digest('hex');
  const base = new URL(apiBase);
  const scheme = host === base.host && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) ? base.protocol : 'https:';
  return validateYandexMediaUrl(`${scheme}//${host}/get-mp3/${sign}/${ts}${sourcePath}`, apiBase).href;
}

export class YandexAudio {
  private pending = new Map<string, Promise<PreparedYandexAudio>>();

  constructor(private cfg: AppConfig, private ff: FfmpegTools, private apiBase: string,
    private variants: (id: string) => Promise<YandexDownloadVariant[]>) {}

  private async response(url: string, timeout = 120000): Promise<Response> {
    let current = validateYandexMediaUrl(url, this.apiBase);
    for (let redirects = 0; redirects <= 3; redirects++) {
      let r: Response;
      try { r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeout) }); }
      catch { throw new Error('Не удалось загрузить аудио Яндекса: проверьте подключение'); }
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        const location = r.headers.get('location');
        if (!location) break;
        current = validateYandexMediaUrl(new URL(location, current).href, this.apiBase);
        continue;
      }
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw new Error(`Аудио Яндекса недоступно (HTTP ${r.status})`);
      }
      return r;
    }
    throw new Error('Слишком много перенаправлений аудио Яндекса');
  }

  prepare(id: string, duration: number, expectedHash?: string): Promise<PreparedYandexAudio> {
    if (!isYandexTrackId(id)) return Promise.reject(new Error('Некорректный ID трека Яндекса'));
    if (expectedHash && !/^[a-f\d]{64}$/.test(expectedHash)) return Promise.reject(new Error('Некорректный хеш аудио'));
    const key = `${id}:${expectedHash ?? ''}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = this.run(id, duration, expectedHash).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  async cover(url: string): Promise<{ data: Buffer; type: string } | null> {
    try {
      const r = await this.response(url, 4000);
      const type = r.headers.get('content-type')?.split(';')[0] ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) { await r.body?.cancel(); return null; }
      const reader = r.body!.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 2 * 1024 * 1024) return null;
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return { data: Buffer.concat(parts), type };
    } catch { return null; }
  }

  private async run(id: string, duration: number, expectedHash?: string): Promise<PreparedYandexAudio> {
    const dir = path.join(this.cfg.dataDir, 'remote', 'yandex');
    await fsp.mkdir(dir, { recursive: true });
    const cached = expectedHash ? path.join(dir, `${expectedHash}.mp3`) : null;
    if (cached && fs.existsSync(cached)) {
      const content = await sha256File(cached);
      if (content.hash === expectedHash) {
        const probe = await this.ff.probe(cached);
        this.validateAudio(probe, duration);
        return { file: cached, ...content, probe, bitrate: Math.round((probe.bitrate ?? 0) / 1000) };
      }
      await fsp.rm(cached, { force: true });
    }
    const all = await this.variants(id);
    const choices = all.filter((v) => v.codec === 'mp3' && v.preview === false && (!v.transport || v.transport === 'raw') && !!v.downloadInfoUrl)
      .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0));
    if (!choices.length) throw new Error(all.some((v) => v.preview)
      ? 'Яндекс отдаёт только превью. Для AutoMix нужен полный трек, доступный вашему аккаунту.'
      : 'Полный MP3-поток этого трека недоступен. Зашифрованные форматы в этом адаптере не поддерживаются.');
    // Re-resolve expiring URLs on every attempt; never persist a signed URL.
    const choice = choices[0];
    let directUrl = choice.downloadInfoUrl;
    if (!choice.direct) {
      const r = await this.response(choice.downloadInfoUrl, 15000);
      const reader = r.body!.getReader();
      const parts: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 65536) throw new Error('Описание аудио Яндекса слишком большое');
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      directUrl = parseYandexDownloadXml(Buffer.concat(parts).toString('utf8'), this.apiBase);
    }
    const temp = path.join(dir, `incoming-${crypto.randomUUID()}.mp3`);
    try {
      const r = await this.response(directUrl);
      const reader = r.body!.getReader();
      const out = await fsp.open(temp, 'wx'); let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > MAX_AUDIO_BYTES) throw new Error('Аудиофайл Яндекса слишком большой');
          await out.writeFile(value);
        }
      } finally { await out.close(); await reader.cancel().catch(() => {}); }
      const probe = await this.ff.probe(temp).catch(() => { throw new Error('Яндекс вернул файл, который не удалось декодировать'); });
      this.validateAudio(probe, duration);
      const content = await sha256File(temp);
      if (expectedHash && content.hash !== expectedHash) throw new Error('Версия аудио Яндекса изменилась. Добавьте трек заново, чтобы пересчитать точки сведения.');
      const file = path.join(dir, `${content.hash}.mp3`);
      if (!fs.existsSync(file)) {
        try { await fsp.rename(temp, file); }
        catch (error) {
          // Two distinct catalog IDs may resolve to identical audio. On Windows
          // the second atomic rename can fail because the first published it.
          // Accept only the verified same content, never an arbitrary file.
          const existing = await sha256File(file).catch(() => null);
          if (existing?.hash !== content.hash) throw error;
        }
      }
      return { file, ...content, probe, bitrate: choice.bitrateInKbps };
    } finally { await fsp.rm(temp, { force: true }); }
  }

  private validateAudio(probe: ProbeResult, expectedDuration: number): void {
    if (!probe.hasAudio || probe.codec !== 'mp3' || !(probe.duration > 0.2)) throw new Error('Яндекс не предоставил полный декодируемый MP3');
    if (expectedDuration > 0 && Math.abs(probe.duration - expectedDuration) > Math.max(1, expectedDuration * 0.02)) {
      throw new Error('Длительность аудио не совпадает с треком: возможно, Яндекс вернул превью или другую версию');
    }
  }
}
