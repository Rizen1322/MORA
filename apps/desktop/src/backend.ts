// Backend entry for the Electron utility process. Bundled by scripts/build.mjs.
import { net } from 'electron';
import { setSoundCloudTransport } from '../../server/src/public/soundcloud.ts';
import { setYtmTransport } from '../../server/src/public/ytmusic.ts';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/src/app.ts';

const parent = process.parentPort;
const token = process.env.AUTOMIX_LAUNCH_TOKEN ?? '';
delete process.env.AUTOMIX_LAUNCH_TOKEN;
const wanted = Number(process.env.AUTOMIX_PORT || 0);

let close: (() => Promise<void>) | null = null;
let closing: Promise<void> | null = null;
const shutdown = (code = 0) => {
  closing ??= (close ? close() : Promise.resolve()).catch((e) => console.error('shutdown', e)).finally(() => process.exit(code));
  return closing;
};
parent.on('message', (e) => { if (e.data?.type === 'shutdown') void shutdown(); });

try {
  if (token.length < 32) throw new Error('launch token missing');
  setYtmTransport((input, init) => net.fetch(input instanceof URL ? input.href : input, init));
  setSoundCloudTransport((input, init) => net.fetch(input instanceof URL ? input.href : input, init));
  const created = await createApp({ host: '127.0.0.1', port: wanted, accessToken: token });
  close = created.close;
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
