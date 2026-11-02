import fs from 'node:fs';
import path from 'node:path';

// shortcut: Oversized queues retain the previous checkpoint; raise this cap if real profiles need more.
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Keep only sound values accepted by the player; never persist native commands or paths. */
export function soundSettings(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  if (number(raw.volume, 0, 1)) result.volume = raw.volume;
  if (number(raw.userVolume, 0, 1)) result.userVolume = raw.userVolume;
  if (typeof raw.muted === 'boolean') result.muted = raw.muted;
  if (number(raw.preDb, -36, 6)) result.preDb = raw.preDb;
  const p = raw.playback;
  if (p && number(p.speed, .8, 1.2) && number(p.semitones, -6, 6)) result.playback = { speed: p.speed, semitones: p.semitones };
  const t = raw.tone;
  if (t && typeof t.enabled === 'boolean' && Array.isArray(t.gains) && t.gains.length === 10 &&
    [...t.gains].every(g => number(g, -12, 12)) && number(t.preampDb, -12, 6) &&
    typeof t.autoHeadroom === 'boolean' && number(t.balance, -1, 1) && typeof t.mono === 'boolean' &&
    (t.reverbMix === undefined || number(t.reverbMix, 0, .35))) {
    result.tone = { enabled: t.enabled, gains: [...t.gains], preampDb: t.preampDb, autoHeadroom: t.autoHeadroom,
      balance: t.balance, mono: t.mono, ...(t.reverbMix === undefined ? {} : { reverbMix: t.reverbMix }) };
  }
  return result;
}

/** The slider survives transient fades and mute; native playback still receives effective volume. */
export function audioPreferences(raw) {
  const { userVolume, ...settings } = soundSettings(raw);
  return { ...settings, ...(userVolume === undefined ? {} : { volume: userVolume }) };
}

export function audioOutputSettings(raw) {
  const settings = audioPreferences(raw);
  return { ...settings, ...(settings.volume === undefined ? {} : { userVolume: settings.volume }),
    ...(settings.muted ? { volume: 0 } : {}) };
}

function queueEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10000) return null;
  const queue = [];
  for (const entry of entries) {
    if (!entry || !text(entry.trackId) || !text(entry.entryId)) return null;
    const item = { trackId: entry.trackId, entryId: entry.entryId };
    if (['user', 'wave', 'context', 'yandex'].includes(entry.origin)) item.origin = entry.origin;
    if (text(entry.sourcePlaylistId, 4096)) item.sourcePlaylistId = entry.sourcePlaylistId;
    if (Number.isSafeInteger(entry.playlistEntryId) && entry.playlistEntryId >= 0) item.playlistEntryId = entry.playlistEntryId;
    for (const key of ['yandexId', 'yandexSessionId', 'yandexBatchId']) {
      if (text(entry[key], 4096) || (key === 'yandexBatchId' && entry[key] === null)) item[key] = entry[key];
    }
    if (text(entry.fromEntryId)) item.fromEntryId = entry.fromEntryId;
    const c = entry.transitionContext;
    if (c && text(c.playlistId) && Number.isSafeInteger(c.fromItemId) && c.fromItemId >= 0 && Number.isSafeInteger(c.toItemId) && c.toItemId >= 0)
      item.transitionContext = { playlistId: c.playlistId, fromItemId: c.fromItemId, toItemId: c.toItemId };
    queue.push(item);
  }
  return queue;
}

export function recoverySnapshot(raw) {
  if (!raw || !Array.isArray(raw.queue) || !raw.queue.length ||
    !Number.isSafeInteger(raw.index) || raw.index < 0 || raw.index >= raw.queue.length ||
    !number(raw.position, 0, 365 * 86400) || typeof raw.device !== 'string' || raw.device.length > 4096) return null;
  const queue = queueEntries(raw.queue), loop = queueEntries(raw.loop ?? []);
  if (!queue || !loop) return null;
  const result = { queue, index: raw.index, position: raw.position, settings: soundSettings(raw.settings), device: raw.device };
  if (loop.length) result.loop = loop;
  const c = raw.context;
  if (c && ['library', 'album', 'artist', 'playlist', 'liked', 'wave', 'yandex-wave', 'online-radio', 'search', 'queue', 'history'].includes(c.type) &&
    typeof c.label === 'string' && c.label.length <= 256) result.context = { type: c.type, label: c.label, ...(text(c.id) ? { id: c.id } : {}) };
  if (raw.station && ['own', 'yandex', 'online'].includes(raw.station.kind)) {
    result.station = { kind: raw.station.kind };
    if (text(raw.station.yandexSessionId, 4096)) result.station.yandexSessionId = raw.station.yandexSessionId;
    if (raw.station.seed && text(raw.station.seed.title, 1000) && typeof raw.station.seed.artist === 'string' && raw.station.seed.artist.length <= 1000)
      result.station.seed = { title: raw.station.seed.title, artist: raw.station.seed.artist };
  }
  return result;
}

/** One atomic file is both the last playback checkpoint and the unclean-exit marker. */
export class PlaybackRecovery {
  constructor(file) { this.file = file; }

  begin() {
    let previous;
    try {
      if (fs.statSync(this.file).size <= MAX_CHECKPOINT_BYTES) previous = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* First run or a damaged checkpoint. */ }
    const pending = previous?.version === 1 && previous.clean === false ? recoverySnapshot(previous.snapshot) : null;
    this.write(false, pending);
    return pending;
  }

  checkpoint(raw) {
    const snapshot = recoverySnapshot(raw);
    if (raw != null && !snapshot) throw Error('Некорректная контрольная точка воспроизведения');
    this.write(false, snapshot);
  }
  clean() { this.write(true, null); }

  write(clean, snapshot) {
    const json = JSON.stringify({ version: 1, clean, snapshot });
    if (Buffer.byteLength(json) > MAX_CHECKPOINT_BYTES) throw Error('Контрольная точка воспроизведения превышает 32 МБ');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'w');
      try {
        fs.writeFileSync(fd, json);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* Renamed, or unavailable. */ }
    }
  }
}
