import { backupBeforeUpgrade } from './profile-backup.mjs';
// Standalone Node backend; the shell controls it through newline-delimited stdin.
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/src/app.ts';
import { createRustNetwork, configureRustNetwork, type RustNetwork } from '../server/src/rust-network.ts';
import { setSoundCloudTransport } from '../server/src/public/soundcloud.ts';
import { setYtmTransport } from '../server/src/public/ytmusic.ts';
import { createPlaybackHost } from './playback.ts';
import { ResolverUpdater } from '../desktop/src/resolver-update.mjs';
import path from 'node:path';

const token = process.env.AUTOMIX_LAUNCH_TOKEN ?? '';
const desktopPlaybackToken = process.env.AUTOMIX_DESKTOP_PCM_TOKEN;
delete process.env.AUTOMIX_LAUNCH_TOKEN;
delete process.env.AUTOMIX_DESKTOP_PCM_TOKEN;
const wanted = Number(process.env.AUTOMIX_PORT || 0);
let close: ((preserve?: boolean) => Promise<void>) | undefined;
let network: RustNetwork | undefined;
let analysis: { setPower(p: { idle: boolean; onBattery: boolean }): void } | undefined;
let playback: { transport(command: string): void; suspend(): void; hasRecovery(): boolean; resolveRecovery(restore: boolean): Promise<void>; close(preserve?: boolean): Promise<void> } | undefined;
let closing: Promise<void> | undefined;
const send = (value: object) => process.stdout.write(`MORA_BACKEND ${JSON.stringify(value)}\n`);
const shutdown = (code = 0, preserve = false) => {
  closing ??= (async () => {
    try { await close?.(preserve); } finally { await network?.close(); }
  })().catch(e => console.error('shutdown', e)).finally(() => process.exit(code));
  return closing;
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'shutdown') void shutdown();
    else if (message.type === 'restart') void shutdown(0, true);
    else if (message.type === 'power') analysis?.setPower({ idle: message.idle === true, onBattery: message.onBattery === true });
    else if (message.type === 'transport' && typeof message.command === 'string') playback?.transport(message.command);
    else if (message.type === 'suspend') playback?.suspend();
    else if (message.type === 'recovery' && typeof message.restore === 'boolean') void playback?.resolveRecovery(message.restore).catch(e => console.error('recovery', e));
  } catch { /* malformed shell messages are ignored */ }
});
input.on('close', () => void shutdown());

try {
  if (token.length < 32 || !desktopPlaybackToken || desktopPlaybackToken.length < 32) throw new Error('launch token missing');
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) throw new Error('invalid port');
  const executable = process.env.AUTOMIX_NETWORK_RUST;
  if (!executable) throw new Error('Rust network helper missing');
  network = await createRustNetwork(executable, { youtube: process.env.AUTOMIX_YOUTUBE_PROXY, soundcloud: process.env.AUTOMIX_SOUNDCLOUD_PROXY });
  configureRustNetwork(network);
  setYtmTransport(network.fetch);
  setSoundCloudTransport(network.fetch);
  const profile = process.env.AUTOMIX_PROFILE_DIR;
  const resources = process.env.AUTOMIX_ROOT;
  if (!profile || !resources) throw new Error('desktop profile or resources missing');
  await backupBeforeUpgrade(profile, process.env.AUTOMIX_DATA_DIR || path.join(profile, 'data'), process.env.AUTOMIX_VERSION || 'unknown');
  const resolver = new ResolverUpdater({ directory: path.join(profile, 'resolver-updates'), bundled: path.join(resources, 'yt-dlp/yt-dlp.exe'), fetcher: network.fetch });
  process.env.YTDLP_PATH = resolver.executable();
  const created = await createApp({ host: '127.0.0.1', port: wanted, accessToken: token, desktopPlaybackToken });
  close = created.close;
  created.app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return payload;
  });
  analysis = created.services.analysis;
  created.app.get('/api/desktop/resolver', async () => resolver.status());
  created.app.post<{ Params: { action: string } }>('/api/desktop/resolver/:action', async (request, reply) => {
    if (request.params.action === 'check') return resolver.check();
    if (request.params.action === 'install') return resolver.install();
    if (request.params.action === 'rollback') return resolver.rollback();
    return reply.code(400).send({ error: 'Некорректная команда' });
  });
  let port = 0;
  playback = await createPlaybackHost(created.app, profile, resources, () => ({
    origin: `http://127.0.0.1:${port}`, accessToken: token, pcmToken: desktopPlaybackToken,
  }), created.services);
  close = async (preserve = false) => { await playback?.close(preserve); await created.close(); };
  try { await created.app.listen({ host: '127.0.0.1', port: wanted }); }
  catch (e) {
    if (!wanted || process.env.AUTOMIX_KEEP_PORT === '1' || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    await created.app.listen({ host: '127.0.0.1', port: 0 });
  }
  port = (created.app.server.address() as AddressInfo).port;
  send({ type: 'ready', port, ffmpeg: created.services.ffmpegVersion, recovery: playback.hasRecovery() });
} catch (e) {
  console.error('backend start failed', e);
  send({ type: 'error', message: (e as Error).message });
  await shutdown(1);
}
