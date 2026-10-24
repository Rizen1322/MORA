/**
 * Renders example AutoMix transitions through the same engine the app uses.
 *
 *   npx tsx tools/render-examples.ts                 demo library -> examples/transitions
 *   npx tsx tools/render-examples.ts --dir <folder> --out <folder> [--all]
 *
 * Each example: <name>.mp3 (10 s before the transition, the transition, 10 s after)
 * and <name>.plan.json (the exact TransitionPlan).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePcm, DEFAULT_AUTOMIX_SETTINGS, planTransition, renderTransitionOffline, type TrackAnalysis } from '../packages/core/src/index.ts';
import { decode } from './eval-transitions.ts';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = path.resolve(arg('--dir') ?? 'examples/library');
const out = path.resolve(arg('--out') ?? 'examples/transitions');
const all = process.argv.includes('--all');
fs.mkdirSync(out, { recursive: true });

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(dir).filter((f) => /\.(mp3|flac|wav|ogg|m4a|opus)$/i.test(f));
const cache = new Map<string, { L: Float32Array; R: Float32Array; a: TrackAnalysis; name: string }>();
const load = (f: string) => {
  let v = cache.get(f);
  if (!v) {
    const pcm = decode(f);
    v = { ...pcm, a: analyzePcm(pcm.L, pcm.R), name: path.basename(f).replace(/\.[^.]+$/, '') };
    cache.set(f, v);
  }
  return v;
};
const find = (needle: string) => files.find((f) => path.basename(f).includes(needle));

let pairs: [string, string][];
if (all) {
  pairs = [];
  for (let i = 0; i + 1 < files.length; i++) pairs.push([files[i], files[i + 1]]);
  if (files.length > 2) pairs.push([files[files.length - 1], files[0]]);
} else {
  const want: [string, string][] = [
    ['Северный свет', 'Kinetic Garden'],
    ['Неон', 'Северный свет'],
    ['Медленный дым', 'Рассвет на 174'],
    ['Северный свет', 'Луна-парк'],
    ['Пыль и свет', 'Неон'],
    ['Деревянный дом', 'Тёплый асфальт'],
    ['Тёплый асфальт', 'Рассвет на 174'],
    ['01 Ночная Смена', '02 Ночная Смена'],
    ['Пыль и свет', 'Медленный дым'],
  ];
  pairs = want.map(([a, b]) => [find(a), find(b)]).filter((p): p is [string, string] => !!p[0] && !!p[1]);
}

const lines: string[] = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-render-'));
let n = 0;
for (const [fa, fb] of pairs) {
  const A = load(fa);
  const B = load(fb);
  const plan = planTransition(
    { id: A.name, duration: A.L.length / 44100, mixingAllowed: true, analysis: A.a },
    { id: B.name, duration: B.L.length / 44100, mixingAllowed: true, analysis: B.a },
    DEFAULT_AUTOMIX_SETTINGS,
  );
  const r = renderTransitionOffline({ L: A.L, R: A.R, sampleRate: 44100 }, { L: B.L, R: B.R, sampleRate: 44100 }, plan, 10, 10);
  const slug = `${String(++n).padStart(2, '0')}-${plan.method}`;
  const wav = path.join(tmp, `${slug}.wav`);
  const buf = Buffer.alloc(44 + r.L.length * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + r.L.length * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(r.L.length * 4, 40);
  for (let i = 0; i < r.L.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r.L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r.R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(wav, buf);
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-q:a', '2', '-metadata', `title=AutoMix: ${A.name} → ${B.name}`, path.join(out, `${slug}.mp3`)]);
  fs.writeFileSync(path.join(out, `${slug}.plan.json`), JSON.stringify(plan, null, 2));
  const start = (r.transitionStartFrame / 44100).toFixed(1);
  lines.push(`| ${slug}.mp3 | ${A.name} → ${B.name} | ${plan.method} | ${plan.duration.toFixed(1)} с, старт примера ${start} с; вход B с ${plan.bEntry.toFixed(2)} с | ${plan.reasons.slice(0, 2).join('; ')} |`);
  console.log(slug, A.name, '→', B.name, plan.method, plan.duration.toFixed(1));
}
fs.rmSync(tmp, { recursive: true, force: true });
const md = `# Примеры переходов AutoMix

Сгенерировано командой \`npx tsx tools/render-examples.ts\` тем же движком (MixerCore), что работает в приложении.
Исходники: синтетические треки из \`examples/library\`, созданные \`tools/gen-demo-tracks.ts\` (без чужой музыки).
Каждый файл: 10 с до перехода, сам переход и 10 с после. Рядом лежит точный TransitionPlan в JSON.

| Файл | Пара | Метод | Длительность | Почему |
|---|---|---|---|---|
${lines.join('\n')}
`;
fs.writeFileSync(path.join(out, 'README.md'), md);
console.log('готово:', out);
