import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FfmpegTools } from '../src/ffmpeg.ts';

const decoder = process.env.AUTOMIX_DECODER_RUST ?? resolve('packages/decoder-rust/target/release/mora-decode.exe');
const ffmpeg = process.env.FFMPEG_PATH ?? resolve('apps/desktop/vendor/ffmpeg/ffmpeg.exe');
const ffprobe = process.env.FFPROBE_PATH ?? resolve('apps/desktop/vendor/ffmpeg/ffprobe.exe');
const available = [decoder, ffmpeg, ffprobe].every(existsSync);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mora-decoder-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const opts = { sampleRate: 48000, channels: 2, format: 'f32le' as const };
function fixture(name = 'audio.wav') {
  const file = join(dir, name);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.3', '-ac', '2', file], { windowsHide: true });
  return file;
}
function stop(child: ReturnType<FfmpegTools['decode']>) {
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.resume(); child.stderr.resume(); child.kill('SIGKILL');
  return closed;
}

it.skipIf(!available)('routes only a successfully probed unchanged file to native decoding', async () => {
  const old = fixture(), renamed = join(dir, 'renamed.wav');
  const tools = new FfmpegTools(ffmpeg, ffprobe, decoder);
  await tools.probe(old);
  let child = tools.decode(old, opts); expect(child.spawnfile).toBe(decoder); await stop(child);
  renameSync(old, renamed);
  child = tools.decode(renamed, opts); expect(child.spawnfile).toBe(ffmpeg); await stop(child);
  await tools.probe(renamed);
  child = tools.decode(renamed, opts); expect(child.spawnfile).toBe(decoder); await stop(child);
  writeFileSync(renamed, 'changed');
  child = tools.decode(renamed, opts); expect(child.spawnfile).toBe(ffmpeg); await stop(child);
});

it.skipIf(!available)('falls back on native startup failure and rejects corrupt inputs', async () => {
  const file = fixture(), invalid = join(dir, 'invalid.exe'); writeFileSync(invalid, 'not an executable');
  const tools = new FfmpegTools(ffmpeg, ffprobe, invalid);
  expect((await tools.probe(file)).hasAudio).toBe(true);
  const child = tools.decode(file, opts); expect(child.spawnfile).toBe(ffmpeg); await stop(child);
  const input = new PassThrough();
  const stream = tools.decode(input, opts); expect(stream.spawnfile).toBe(ffmpeg); await stop(stream);
  writeFileSync(file, 'not audio');
  await expect(tools.probe(file)).rejects.toThrow();
});

it.skipIf(!available)('cancels native probe and progressive input', async () => {
  const file = fixture();
  const tools = new FfmpegTools(ffmpeg, ffprobe, decoder), abort = new AbortController();
  abort.abort();
  await expect(tools.probe(file, abort.signal)).rejects.toThrow();
  const input = new PassThrough();
  const child = tools.decode(input, opts);
  const closed = new Promise(resolve => child.once('close', resolve));
  input.write(Buffer.from('OggS'));
  child.kill('SIGKILL');
  await closed;
  expect(input.destroyed).toBe(true);
});

it.skipIf(!available || process.platform !== 'win32')('reports a truncated WebM stream as a decoding failure', async () => {
  const file = join(dir, 'source.webm');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'libopus', file], { windowsHide: true });
  const bytes = readFileSync(file), input = Readable.from(bytes.subarray(0, Math.floor(bytes.length / 2)));
  const child = new FfmpegTools(ffmpeg, ffprobe, decoder).decode(input, opts);
  child.stdout.resume(); child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  expect(code).not.toBe(0);
});

it.skipIf(!available)('selects native decoding for a probed WebM Opus file', async () => {
  const file = join(dir, 'source.webm');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libopus', file], { windowsHide: true });
  const tools = new FfmpegTools(ffmpeg, ffprobe, decoder);
  expect((await tools.probe(file)).codec).toBe('opus');
  const child = tools.decode(file, opts);
  expect(child.spawnfile).toBe(decoder);
  await stop(child);
});

it.skipIf(!available)('preserves AAC playback timing through the compatibility decoder', async () => {
  const file = join(dir, 'source.m4a');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1:sample_rate=44100', '-ac', '2', '-c:a', 'aac', file], { windowsHide: true });
  const tools = new FfmpegTools(ffmpeg, ffprobe, decoder);
  expect((await tools.probe(file)).codec).toBe('aac');
  const child = tools.decode(file, { ...opts, sampleRate: 44100 });
  expect(child.spawnfile).toBe(ffmpeg);
  const chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  expect(code).toBe(0);
  expect(Buffer.concat(chunks)).toEqual(execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-ac', '2', '-ar', '44100', '-f', 'f32le', 'pipe:1'], { windowsHide: true }));
});
