/**
 * Generates a small license-free demo library: procedurally synthesized tracks
 * with known tempo/key/structure, real ID3/FLAC tags and generated cover art.
 * Output: examples/library/*.mp3|flac plus deliberately broken files in examples/broken/.
 *
 *   npm run demo:tracks
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, type SynthSpec } from '../packages/core/src/synth/synth.ts';
import { encodePng } from './png.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'examples', 'library');
const BROKEN = path.join(ROOT, 'examples', 'broken');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

interface Demo {
  file: string;
  title: string;
  artist: string;
  album: string;
  trackNo: number;
  year: number;
  genre: string;
  spec: SynthSpec;
  palette: [number, number, number][];
  format: 'mp3' | 'flac';
}

const P = {
  dusk: [[18, 22, 64], [233, 96, 70], [255, 196, 120]] as [number, number, number][],
  sea: [[8, 40, 60], [32, 150, 160], [210, 240, 230]] as [number, number, number][],
  forest: [[16, 40, 24], [90, 140, 70], [230, 220, 160]] as [number, number, number][],
  neon: [[20, 8, 40], [230, 40, 140], [60, 220, 255]] as [number, number, number][],
  rust: [[40, 18, 10], [190, 80, 40], [240, 200, 150]] as [number, number, number][],
  ice: [[230, 236, 245], [120, 150, 200], [30, 40, 80]] as [number, number, number][],
  sand: [[60, 46, 30], [200, 160, 100], [250, 240, 220]] as [number, number, number][],
};

const DEMOS: Demo[] = [
  { file: '01 Ночная Смена - Северный свет', title: 'Северный свет', artist: 'Ночная Смена', album: 'Огни трассы', trackNo: 1, year: 2026, genre: 'House', format: 'mp3', palette: P.dusk, spec: { style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 80, seed: 101 } },
  { file: '02 Ночная Смена - Тёплый асфальт', title: 'Тёплый асфальт', artist: 'Ночная Смена', album: 'Огни трассы', trackNo: 2, year: 2026, genre: 'House', format: 'mp3', palette: P.dusk, spec: { style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 80, seed: 102 } },
  { file: 'Mono Pine - Kinetic Garden', title: 'Kinetic Garden', artist: 'Mono Pine', album: 'Kinetic', trackNo: 1, year: 2025, genre: 'Techno', format: 'flac', palette: P.sea, spec: { style: 'techno', bpm: 127, tonic: 4, mode: 'minor', bars: 88, seed: 103 } },
  { file: 'Mono Pine - Ветер в проводах', title: 'Ветер в проводах', artist: 'Mono Pine', album: 'Kinetic', trackNo: 4, year: 2025, genre: 'Techno', format: 'mp3', palette: P.ice, spec: { style: 'techno', bpm: 130, tonic: 0, mode: 'minor', bars: 88, seed: 104 } },
  { file: 'Ойра - Медленный дым', title: 'Медленный дым', artist: 'Ойра', album: 'Дым', trackNo: 1, year: 2024, genre: 'Hip-Hop', format: 'mp3', palette: P.rust, spec: { style: 'hiphop', bpm: 88, tonic: 2, mode: 'minor', bars: 56, seed: 105 } },
  { file: 'Grey Harbor - Рассвет на 174', title: 'Рассвет на 174', artist: 'Grey Harbor', album: 'Harbor Lights', trackNo: 3, year: 2026, genre: 'Drum & Bass', format: 'mp3', palette: P.sea, spec: { style: 'dnb', bpm: 174, tonic: 5, mode: 'minor', bars: 112, seed: 106 } },
  { file: 'Ойра - Пыль и свет', title: 'Пыль и свет', artist: 'Ойра', album: 'Дым', trackNo: 5, year: 2024, genre: 'Ambient', format: 'flac', palette: P.sand, spec: { style: 'ambient', bpm: 70, tonic: 7, mode: 'major', bars: 40, seed: 107, fadeOut: true } },
  { file: 'Лиса Лес - Деревянный дом', title: 'Деревянный дом', artist: 'Лиса Лес', album: 'Деревянный дом', trackNo: 1, year: 2023, genre: 'Acoustic', format: 'mp3', palette: P.forest, spec: { style: 'acoustic', bpm: 96, tonic: 5, mode: 'major', bars: 48, seed: 108, fadeOut: true } },
  { file: 'Kollektiv Ost - Неон', title: 'Неон', artist: 'Kollektiv Ost', album: 'Неон', trackNo: 1, year: 2026, genre: 'Pop', format: 'mp3', palette: P.neon, spec: { style: 'pop', bpm: 118, tonic: 2, mode: 'major', bars: 72, seed: 109, leadSilence: 2, tailSilence: 3 } },
  { file: 'Kollektiv Ost - Луна-парк', title: 'Луна-парк', artist: 'Kollektiv Ost', album: 'Неон', trackNo: 6, year: 2026, genre: 'Pop', format: 'mp3', palette: P.neon, spec: { style: 'pop', bpm: 140, tonic: 9, mode: 'major', bars: 80, seed: 110 } },
  { file: 'Ночная Смена - Заставка', title: 'Заставка', artist: 'Ночная Смена', album: '', trackNo: 0, year: 2026, genre: 'House', format: 'mp3', palette: P.dusk, spec: { style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 6, seed: 111, introBars: 0, outroBars: 0 } },
];

function cover(palette: [number, number, number][], seed: number): Buffer {
  const W = 512;
  const rgb = new Uint8Array(W * W * 3);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cx = 0.3 + rnd() * 0.4;
  const cy = 0.3 + rnd() * 0.4;
  const rings = 3 + Math.floor(rnd() * 5);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / W;
      const d = Math.hypot(u - cx, v - cy);
      const band = (Math.sin(d * rings * Math.PI * 2 + u * 3) + 1) / 2;
      const t = Math.min(1, v * 0.7 + band * 0.45);
      const a = palette[0];
      const b = palette[1];
      const c = palette[2];
      const mix = (p: number, q: number, k: number) => p + (q - p) * k;
      const k1 = Math.min(1, t * 1.6);
      const k2 = Math.max(0, t * 1.6 - 0.6);
      const glow = Math.max(0, 1 - d * 2.4) ** 3;
      for (let ch = 0; ch < 3; ch++) {
        let val = mix(mix(a[ch], b[ch], k1), c[ch], k2) + glow * 60;
        val += (rnd() - 0.5) * 6;
        rgb[(y * W + x) * 3 + ch] = Math.max(0, Math.min(255, val));
      }
    }
  }
  return encodePng(W, W, rgb);
}

function wav16(L: Float32Array, R: Float32Array, sr: number): Buffer {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  return buf;
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(BROKEN, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-demo-'));
for (const d of DEMOS) {
  const target = path.join(OUT, `${d.file}.${d.format}`);
  if (fs.existsSync(target) && !process.argv.includes('--force')) {
    console.log('есть', path.basename(target));
    continue;
  }
  const r = synthesize({ ...d.spec, level: 0.55 });
  const wav = path.join(tmp, 'a.wav');
  const png = path.join(tmp, 'c.png');
  fs.writeFileSync(wav, wav16(r.L, r.R, r.sampleRate));
  fs.writeFileSync(png, cover(d.palette, d.spec.seed));
  const meta = ['title', d.title, 'artist', d.artist, 'album', d.album, 'album_artist', d.album ? d.artist : '', 'date', String(d.year), 'genre', d.genre, 'track', d.trackNo ? String(d.trackNo) : '', 'comment', 'Синтезировано AutoMix для демонстрации (без чужой музыки)'];
  const metaArgs: string[] = [];
  for (let i = 0; i < meta.length; i += 2) if (meta[i + 1]) metaArgs.push('-metadata', `${meta[i]}=${meta[i + 1]}`);
  const codec = d.format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '3', '-id3v2_version', '3'] : ['-c:a', 'flac'];
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', wav, '-i', png, '-map', '0:a', '-map', '1:v', ...codec, '-c:v', 'png', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)', ...metaArgs, target]);
  console.log('создан', path.basename(target), `${(r.L.length / r.sampleRate).toFixed(0)} с`);
}
// deliberately problematic files for error handling
fs.writeFileSync(path.join(BROKEN, 'повреждённый.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 7)]));
fs.writeFileSync(path.join(BROKEN, 'тишина.wav'), wav16(new Float32Array(44100 * 20), new Float32Array(44100 * 20), 44100));
fs.writeFileSync(path.join(BROKEN, 'пустой.flac'), Buffer.alloc(0));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('готово:', OUT);
