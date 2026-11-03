import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DesktopPlayback } from '../desktop/src/desktop-playback.ts';
import { RustAudio } from '../desktop/src/rust-audio.mjs';
import { WindowsMedia } from '../desktop/src/windows-media.mjs';
import { PlaybackRecovery, audioPreferences, audioOutputSettings } from '../desktop/src/recovery.mjs';

/** The renderer can invoke only these playback operations; PCM credentials stay here. */
export async function createPlaybackHost(app: FastifyInstance, profile: string, resources: string,
  backend: () => { origin: string; accessToken: string; pcmToken: string }) {
  const clients = new Set<import('node:http').ServerResponse>();
  const emit = (event: object) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) if (!client.write(line)) { client.destroy(); clients.delete(client); }
  };
  const file = path.join(profile, 'desktop.json');
  let settings: any;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  settings.audio = { ...audioPreferences(settings.audio), outputDevice: typeof settings.audio?.outputDevice === 'string' && settings.audio.outputDevice.length <= 4096 ? settings.audio.outputDevice : '' };
  const saveAudio = (values: object, device?: string) => {
    settings.audio = { ...settings.audio, ...audioPreferences(values), ...(device === undefined ? {} : { outputDevice: device }) };
    fs.mkdirSync(profile, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2));
    fs.renameSync(temp, file);
  };
  const recovery = new PlaybackRecovery(path.join(profile, 'playback-recovery.json'));
  let pending = recovery.begin();
  const restartFile = path.join(profile, 'playback-restart.json');
  let restartPaused: boolean | undefined = fs.existsSync(restartFile) ? true : undefined;
  try { const value = JSON.parse(fs.readFileSync(restartFile, 'utf8')); if (typeof value.paused === 'boolean') restartPaused = value.paused; } catch { /* no intentional restart */ }
  if (!pending) { restartPaused = undefined; try { fs.unlinkSync(restartFile); } catch { /* absent */ } }
  const checkpoint = () => { if (!pending) recovery.checkpoint(playback.recoverySnapshot()); };
  const artworkFiles = new Set<string>();
  let artworkAbort: AbortController | undefined;
  const artwork = async (coverUrl: string) => {
    artworkAbort?.abort();
    if (!/^\/api\/(?:covers\/[a-zA-Z0-9_.-]+|tracks\/[a-zA-Z0-9_-]+\/cover|providers\/subsonic\/cover\/[^/?#]+)$/.test(coverUrl)) return '';
    const abort = new AbortController(); artworkAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const service = backend();
      const response = await fetch(`${service.origin}${coverUrl}`, { headers: { 'X-Access-Token': service.accessToken }, signal: abort.signal, redirect: 'error' });
      const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
      if (!response.ok || !['image/jpeg', 'image/png'].includes(type ?? '') || Number(response.headers.get('content-length')) > 4 * 1024 * 1024 || !response.body) return '';
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { abort.abort(); return ''; }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const file = path.join(profile, `smtc-${process.pid}-${createHash('sha256').update(bytes).digest('hex')}.${type === 'image/png' ? 'png' : 'jpg'}`);
      await fs.promises.writeFile(file, bytes);
      artworkFiles.delete(file); artworkFiles.add(file);
      while (artworkFiles.size > 8) {
        const old = artworkFiles.values().next().value!; artworkFiles.delete(old);
        void fs.promises.unlink(old).catch(() => {});
      }
      return file;
    } catch { return ''; } finally { clearTimeout(timeout); }
  };
  const media = new WindowsMedia(path.join(resources, 'audio', 'mora-smtc.exe'), {
    command: (cmd: string) => {
      const action: Record<string, string> = { play: 'play', pause: 'pause', next: 'nexttrack', prev: 'previoustrack' };
      if (action[cmd]) void playback.command(action[cmd]).catch(console.error);
    },
    seek: (position: number) => void playback.command('seekto', position).catch(console.error),
    available: () => {}, artwork,
  });
  const audio = new RustAudio(path.join(resources, 'audio', 'mora-audio.exe'), (event: any) => {
    playback.onEvent(event); media.audioEvent(event); emit(event);
  });
  const playback = new DesktopPlayback(audio, { backend,
    ready: rate => { media.reset(); media.start(rate); }, track: track => media.track(track) });
  await playback.setDevice(settings.audio.outputDevice);
  await playback.settings(audioOutputSettings(settings.audio));
  const timer = setInterval(() => { try { checkpoint(); } catch (e) { console.error('playback checkpoint', e); } }, 2000);
  timer.unref();

  app.get('/api/desktop/audio-events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    clients.add(reply.raw);
    request.raw.on('close', () => clients.delete(reply.raw));
  });
  app.get('/api/desktop/audio-devices', async () => audio.devices());
  app.post<{ Body: { device?: unknown } }>('/api/desktop/audio-start', async request => {
    if (playback.state().active) throw Error('Аудиопоток уже управляется нативным плеером');
    const device = request.body?.device ?? '';
    if (typeof device !== 'string' || device.length > 4096) throw Error('Некорректное устройство');
    media.reset(); const ready = await audio.start(device); media.start(ready.sampleRate); saveAudio({}, device); return ready;
  });
  app.post<{ Body: { cmd?: unknown; device?: unknown; L?: unknown; R?: unknown } }>('/api/desktop/audio-command', { bodyLimit: 1024 * 1024 }, async request => {
    const command = request.body;
    if (!command || typeof command.cmd !== 'string') throw Error('Некорректная аудиокоманда');
    if (command.cmd === 'output') {
      if (typeof command.device !== 'string' || command.device.length > 4096) throw Error('Некорректное устройство');
      await playback.setDevice(command.device); saveAudio({}, command.device); return null;
    }
    if (playback.state().active) throw Error('Используйте управление нативным плеером');
    if (!['load','length','unload','feed','feedVocal','disableVocals','resetVocals','nack','start','seek','pause','volume','tone','playback','gain','cue','arm','disarm','finish','tickRate','stop','suspend','resume'].includes(command.cmd)) throw Error('Недопустимая аудиокоманда');
    if (command.cmd === 'feed' || command.cmd === 'feedVocal') {
      if (!Array.isArray(command.L) || !Array.isArray(command.R) || command.L.length > 32768 || command.R.length > 32768) throw Error('Некорректный PCM');
      command.L = Float32Array.from(command.L); command.R = Float32Array.from(command.R);
    }
    await audio.command(command); return null;
  });
  app.post('/api/desktop/audio-stop', async () => { media.reset(); await playback.stop(); return null; });
  app.post<{ Body: unknown }>('/api/desktop/media-track', async request => { media.track(request.body); return null; });
  app.get('/api/desktop/settings', async () => ({ closeToTray: settings.closeToTray !== false,
    dataDir: process.env.AUTOMIX_DATA_DIR, version: process.env.AUTOMIX_VERSION ?? '0.3.31-preview.1', backend: 'ready',
    compact: false, compactOnTop: settings.compactOnTop !== false, audio: settings.audio }));
  const operations: Record<string, (...args: any[]) => Promise<unknown> | unknown> = {
    startStation: (station, config) => playback.startStation(station, config),
    setStation: (station, context) => playback.setStation(station, context),
    startSource: (entry, config) => playback.startSource(entry, config),
    prepareQueue: (from, entries, previousId, loop, replaceFuture, manifest) => playback.prepareQueue(from, entries, previousId, loop, replaceFuture, manifest),
    settings: values => playback.settings(values), stop: () => playback.stop(), state: () => playback.state(),
    command: (action, position) => playback.command(action, position),
  };
  app.post<{ Params: { operation: string }; Body: unknown }>('/api/desktop/native-mix/:operation', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const operation = request.params.operation;
    if (!Object.hasOwn(operations, operation) || !Array.isArray(request.body) || request.body.length > 6) return reply.code(400).send({ error: 'Некорректная команда' });
    const args = request.body;
    const result = await operations[operation](...args);
    if (operation === 'startSource' || operation === 'startStation') saveAudio(args[1]);
    if (operation === 'settings') saveAudio(args[0]);
    if (operation !== 'state' && operation !== 'settings') checkpoint();
    if (operation === 'stop') media.reset();
    return result ?? null;
  });
  const resolveRecovery = async (restore: boolean) => {
    if (pending && restore) {
      const restoredSettings = Object.assign({}, pending.settings, audioOutputSettings(settings.audio), restartPaused === undefined ? {} : { paused: restartPaused });
      await playback.restoreRecovery({ ...pending, device: settings.audio.outputDevice, settings: restoredSettings });
    }
    pending = null;
    checkpoint();
    restartPaused = undefined;
    try { fs.unlinkSync(restartFile); } catch { /* absent on normal recovery */ }
  };
  app.get('/api/desktop/recovery', async () => ({ pending: !!pending }));
  app.post<{ Body: { restore?: unknown } }>('/api/desktop/recovery', async (request, reply) => {
    if (typeof request.body?.restore !== 'boolean') return reply.code(400).send({ error: 'Некорректный ответ' });
    await resolveRecovery(request.body.restore);
    return { pending: false };
  });
  return {
    hasRecovery: () => !!pending,
    resolveRecovery,
    transport: (command: string) => {
      const actions: Record<string, string> = { toggle: playback.state().playing ? 'pause' : 'play', play: 'play', pause: 'pause', next: 'nexttrack', prev: 'previoustrack' };
      if (Object.hasOwn(actions, command)) void playback.command(actions[command]).catch(console.error);
    },
    suspend: () => {
      if (playback.state().active) void playback.command('pause').catch(console.error);
      else if (audio.process) void audio.command({ cmd: 'pause', paused: true }).catch(console.error);
    },
    close: async (preserve = false) => {
      clearInterval(timer);
      artworkAbort?.abort();
      for (const client of clients) client.end();
      if (preserve) {
        checkpoint();
        if (playback.recoverySnapshot()) {
          fs.writeFileSync(`${restartFile}.tmp`, JSON.stringify({ paused: !playback.state().playing }));
          fs.renameSync(`${restartFile}.tmp`, restartFile);
        }
      }
      await Promise.allSettled([playback.stop(), media.stop()]);
      if (!preserve) { recovery.clean(); try { fs.unlinkSync(restartFile); } catch { /* no pending restart */ } }
      for (const file of artworkFiles) { try { fs.unlinkSync(file); } catch { /* optional artwork */ } }
    },
  };
}
