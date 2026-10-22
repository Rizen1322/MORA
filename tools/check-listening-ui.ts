// Isolated local fixture for visual QA; no user library, accounts or copyrighted lyrics.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const directory = path.resolve('tools/.cache/listening-ui-0.2.0');
fs.mkdirSync(directory, { recursive: true });
const cfg = loadConfig();
const a = await createApp({ dataDir: path.join(directory, 'data'), accessToken: null, host: '127.0.0.1', port: 4731, stemsPython: null }, { startWorkers: false });
for (const [index, title] of ['Пока звучит музыка, город остаётся за окном', 'Этот миг'].entries()) {
  const file = path.join(directory, `fixture-${index}.wav`);
  if (!fs.existsSync(file)) execFileSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:duration=20:sample_rate=48000`, '-ac', '2', '-metadata', `title=${title}`, '-metadata', 'artist=MORA · проверка интерфейса', file], { windowsHide: true });
  const { track } = await a.services.lib.importFile(file, path.basename(file), 'managed');
  a.services.lib.updateMeta(track.id, { title, artist: 'MORA · проверка интерфейса' });
  const audio = await a.services.lib.resolveMediaPath(track.id);
  fs.writeFileSync(audio.replace(/\.[^.]+$/, '.lrc'), '[00:00.00]Останься в этом мгновении\n[00:03.00]Пусть музыка ведёт\n[00:06.00]За окнами проснётся город\n[00:09.00]И новый день придёт\n[00:12.00]У каждого движения свой ритм\n[00:16.00]У каждой встречи — свет\n');
}
await a.app.listen({ host: '127.0.0.1', port: 4731 });
console.log('Isolated listening UI fixture: http://localhost:4731/#/library');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void a.close().then(() => process.exit(0)); });
