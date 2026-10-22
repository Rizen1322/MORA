// Read-only source profile; all migration/import writes go to a separate fixture copy.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.ts';

const out = path.resolve(`tools/.cache/offline-upgrade-0.3.0-${Date.now()}`);
const data = path.join(out, 'data');
function copy(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copy(a, b); else fs.copyFileSync(a, b);
  }
}
copy(path.resolve('tools/.cache/electron-backend-0.2.0/data'), data);
const source = new DatabaseSync(path.resolve('data-dev/automix.sqlite'), { readOnly: true });
const row = source.prepare("SELECT t.*, s.external_id, s.meta AS source_meta FROM tracks t JOIN track_sources s ON s.track_id=t.id WHERE s.provider='youtube' AND s.kind='remote' AND s.meta LIKE '%audioHash%' LIMIT 1").get() as any;
source.close(); if (!row) throw new Error('No verified cached public track');
const meta = JSON.parse(row.source_meta);
const cached = path.resolve('data-dev/remote/youtube', `${meta.audioHash}${meta.ext}`);
if (!fs.existsSync(cached)) throw new Error('Verified audio missing');
const audio = path.join(data, 'remote/youtube', path.basename(cached)); fs.mkdirSync(path.dirname(audio), { recursive: true }); fs.copyFileSync(cached, audio);
const realFetch = globalThis.fetch; let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Offline release check: all HTTP disabled'); };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  app = await createApp({ dataDir: data, stemsPython: null, ytdlp: path.join(out, 'no-ytdlp.exe'), port: 0 }, { startWorkers: false });
  const settings = (await app.app.inject('/api/settings')).json();
  if (settings.sound.playback.speed !== 1 || settings.sound.playback.semitones !== 0) throw new Error('Old settings did not migrate');
  const imported = app.services.lib.addRemote({ provider: 'youtube', externalId: row.external_id, title: row.title, artist: row.artist,
    duration: row.duration, saved: true, meta, content: { hash: row.content_hash, size: row.size,
      probe: { duration: row.duration, sampleRate: row.sample_rate, channels: row.channels, codec: row.codec, bitrate: row.bitrate, hasAudio: true } } });
  const response = await app.app.inject(`/api/tracks/${imported.id}/pcm?sr=44100&start=0&frames=8192&format=f32le`);
  if (response.statusCode !== 200 || response.rawPayload.length !== 65536) throw new Error(`Offline PCM failed: ${response.statusCode}`);
  for (let i = 0; i < response.rawPayload.length; i += 4) if (!Number.isFinite(response.rawPayload.readFloatLE(i))) throw new Error('Invalid PCM');
  if (networkAttempts) throw new Error('Offline playback attempted HTTP');
  const report = { ok: true, upgradedFrom: '0.2.0 isolated backend fixture', playbackDefaults: settings.sound.playback,
    offlineTrack: row.title, pcmBytes: response.rawPayload.length, systemYtdlpAvailable: app.services.publicMusic.ytdlp.available, networkAttempts };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, directory: out }));
} finally { await app?.close(); globalThis.fetch = realFetch; }
