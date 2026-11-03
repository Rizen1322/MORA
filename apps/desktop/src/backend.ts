// Backend entry for the Electron utility process. Bundled by scripts/build.mjs.
import { net } from 'electron';
import { setSoundCloudTransport } from '../../server/src/public/soundcloud.ts';
import { setYtmTransport } from '../../server/src/public/ytmusic.ts';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/src/app.ts';
import { loadConfig } from '../../server/src/config.ts';
import { configureRustNetwork, createRustNetwork, type RustNetwork } from '../../server/src/rust-network.ts';

const parent = process.parentPort;
const token = process.env.AUTOMIX_LAUNCH_TOKEN ?? '';
const desktopPlaybackToken = process.env.AUTOMIX_DESKTOP_PCM_TOKEN;
delete process.env.AUTOMIX_LAUNCH_TOKEN;
delete process.env.AUTOMIX_DESKTOP_PCM_TOKEN;
const wanted = Number(process.env.AUTOMIX_PORT || 0);

let close: (() => Promise<void>) | null = null;
let network: RustNetwork | null = null;
let closing: Promise<void> | null = null;
let analysis: { setPower(p: { idle: boolean; onBattery: boolean }): void } | null = null;
const shutdown = (code = 0) => {
  closing ??= (async () => {
    try { await close?.(); }
    finally { configureRustNetwork(null); await network?.close(); }
  })().catch((e) => console.error('shutdown', e)).finally(() => process.exit(code));
  return closing;
};
parent.on('message', (e) => {
  if (e.data?.type === 'shutdown') void shutdown();
  // idle-power.mjs: whether library-wide analysis may run now
  else if (e.data?.type === 'power') analysis?.setPower({ idle: e.data.idle === true, onBattery: e.data.onBattery === true });
});

try {
  if (token.length < 32) throw new Error('launch token missing');
  const cfg = loadConfig();
  const electronFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
  if (cfg.networkRust) {
    network = await createRustNetwork(cfg.networkRust, cfg.publicProxies, electronFetch);
    configureRustNetwork(network);
  }
  const transport = network?.fetch ?? electronFetch;
  setYtmTransport(transport);
  setSoundCloudTransport(transport);
  const created = await createApp({ host: '127.0.0.1', port: wanted, accessToken: token, desktopPlaybackToken });
  close = created.close;
  analysis = created.services.analysis;
  const syncDislikes = () => parent.postMessage({ type: 'reactions', dislikedTrackIds: created.services.lib.listDTO().filter(t => t.reaction < 0).map(t => t.id) });
  // Library events arrive per track during imports; one full scan per burst is enough.
  let reactionTimer: NodeJS.Timeout | undefined;
  const unsubscribeReactions = created.services.events.on(event => {
    if (event.type === 'library' && !reactionTimer) reactionTimer = setTimeout(() => { reactionTimer = undefined; syncDislikes(); }, 100);
  });
  created.app.addHook('onClose', async () => { unsubscribeReactions(); clearTimeout(reactionTimer); });
  syncDislikes();
  try {
    await created.app.listen({ host: '127.0.0.1', port: wanted });
  } catch (e) {
    // After a crash the previous port can be taken; any free port is fine then.
    if (!wanted || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    await created.app.listen({ host: '127.0.0.1', port: 0 });
  }
  const port = (created.app.server.address() as AddressInfo).port;
  console.log(`backend ready on ${port}, data ${created.services.cfg.dataDir}`);
  parent.postMessage({ type: 'ready', port, ffmpeg: created.services.ffmpegVersion });
} catch (e) {
  console.error('backend start failed', e);
  parent.postMessage({ type: 'error', message: (e as Error).message });
  await shutdown(1);
}
