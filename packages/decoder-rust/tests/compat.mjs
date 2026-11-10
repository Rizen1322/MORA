import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [decoderArg, ffmpegArg] = process.argv.slice(2);
if (!decoderArg || !ffmpegArg) throw Error('usage: node tests/compat.mjs DECODER FFMPEG');
const decoder = resolve(decoderArg), ffmpeg = resolve(ffmpegArg);
const dir = mkdtempSync(join(tmpdir(), 'mora-decoder-'));
function run(command, args, input) {
  const result = spawnSync(command, args, { input, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
try {
  for (const [ext, codec] of [['wav', 'pcm_s16le'], ['flac', 'flac'], ['mp3', 'libmp3lame']]) {
    for (const sourceRate of [44100, 48000]) for (const sourceChannels of [1, 2]) {
      const file = join(dir, `sample.${ext}`);
      run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=997:duration=1.23:sample_rate=${sourceRate}`, '-ac', String(sourceChannels), '-c:a', codec, file]);
      for (const targetRate of [44100, 48000]) {
        const actual = run(decoder, [file, String(targetRate), '2', 'f32le']);
        const expected = run(ffmpeg, ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(targetRate), '-f', 'f32le', 'pipe:1']);
        assert.equal(actual.length, expected.length, `${ext} frame count`);
        let squared = 0;
        for (let i = 0; i < actual.length; i += 4) squared += (actual.readFloatLE(i) - expected.readFloatLE(i)) ** 2;
        assert.ok(Math.sqrt(squared / (actual.length / 4)) < 0.0001, `${ext} signal mismatch`);
      }
      for (const outputFormat of ['f32le', 's16le']) {
        const actual = run(decoder, [file, String(sourceRate), '1', outputFormat]);
        const expected = run(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sourceRate), '-f', outputFormat, 'pipe:1']);
        assert.equal(actual.length, expected.length, `${ext} mono frame count`);
        let squared = 0;
        const width = outputFormat === 'f32le' ? 4 : 2;
        for (let i = 0; i < actual.length; i += width) {
          const a = width === 4 ? actual.readFloatLE(i) : actual.readInt16LE(i) / 32768;
          const b = width === 4 ? expected.readFloatLE(i) : expected.readInt16LE(i) / 32768;
          squared += (a - b) ** 2;
        }
        assert.ok(Math.sqrt(squared / (actual.length / width)) < 0.0001, `${ext} ${sourceRate} ${sourceChannels} ${outputFormat} mono mismatch rms=${Math.sqrt(squared / (actual.length / width))}`);
      }
      const stream = run(decoder, ['-', String(sourceRate), String(sourceChannels), 'f32le'], readFileSync(file));
      const local = run(decoder, [file, String(sourceRate), String(sourceChannels), 'f32le']);
      assert.deepEqual(stream, local, `${ext} stdin mismatch`);
      if (process.platform === 'win32') {
        const auto = run(decoder, ['stream', ffmpeg, String(sourceRate), String(sourceChannels), 'f32le'], readFileSync(file));
        if (ext === 'mp3') assert.deepEqual(auto, local, 'MP3 stream routing mismatch');
        else assert.deepEqual(auto, run(ffmpeg, ['-v', 'error', '-nostdin', '-probesize', '65536', '-analyzeduration', '500000', '-i', 'pipe:0', '-vn', '-sn', '-dn', '-ac', String(sourceChannels), '-ar', String(sourceRate), '-f', 'f32le', 'pipe:1'], readFileSync(file)), `${ext} fallback mismatch`);
      }
    }
  }
  for (const ext of ['ogg', 'webm']) for (const channels of [1, 2]) for (const duration of ['0.503', '1.23', '4.333']) {
    const file = join(dir, 'sample.' + ext);
    run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=997:duration=${duration}:sample_rate=48000`, '-ac', String(channels), '-c:a', 'libopus', file]);
    const actual = run(decoder, [file, '48000', String(channels), 'f32le']);
    const expected = run(ffmpeg, ['-v', 'error', '-i', file, '-ac', String(channels), '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    assert.equal(actual.length, expected.length, 'Ogg/Opus frame count');
    let squared = 0;
    for (let i = 0; i < actual.length; i += 4) squared += (actual.readFloatLE(i) - expected.readFloatLE(i)) ** 2;
    assert.ok(Math.sqrt(squared / (actual.length / 4)) < 0.0001, 'Ogg/Opus signal mismatch');
    assert.deepEqual(run(decoder, ['-', '48000', String(channels), 'f32le'], readFileSync(file)), actual, 'Ogg/Opus stdin mismatch');
    if (process.platform === 'win32') assert.deepEqual(run(decoder, ['stream', ffmpeg, '48000', String(channels), 'f32le'], readFileSync(file)), actual, `${ext} stream routing mismatch`);
  }
  const fractional = join(dir, 'fractional.wav');
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=44100', '-af', 'atrim=end_sample=100', '-ac', '2', fractional]);
  assert.equal(run(decoder, [fractional, '48000', '2', 'f32le']).length,
    run(ffmpeg, ['-v', 'error', '-i', fractional, '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1']).length);
  const file = join(dir, 'long.flac');
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:duration=30:sample_rate=48000', '-ac', '2', '-c:a', 'flac', file]);
  const compressed = readFileSync(file);
  const child = spawn(decoder, ['-', '48000', '2', 'f32le'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => {});
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= compressed.length) { clearInterval(timer); child.stdin.end(); return; }
    child.stdin.write(compressed.subarray(offset, offset += 1024));
  }, 5);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('progressive output timed out')), 10000);
    child.stdout.once('data', () => {
      try { assert.ok(offset < compressed.length, 'output arrived only after all input'); child.kill('SIGKILL'); clearTimeout(timeout); resolve(); }
      catch (error) { clearTimeout(timeout); reject(error); }
    });
    child.once('error', reject);
  });
  clearInterval(timer);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('cancellation timed out')), 3000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
  });
  if (process.platform === 'win32') {
    const aac = join(dir, 'fallback.aac');
    run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', aac]);
    const wrapper = spawn(decoder, ['stream', ffmpeg, '48000', '2', 'f32le'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    wrapper.stdin.on('error', () => {}); wrapper.stdout.resume(); wrapper.stderr.resume();
    wrapper.stdin.write(readFileSync(aac));
    await new Promise(resolve => setTimeout(resolve, 300));
    const query = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${wrapper.pid} AND Name = 'ffmpeg.exe'").ProcessId`], { encoding: 'utf8', windowsHide: true });
    const childPids = query.stdout.trim().split(/\s+/).map(Number).filter(n => n > 0);
    assert.ok(childPids.length, `FFmpeg fallback did not start: ${query.stderr}`);
    const closed = new Promise(resolve => wrapper.once('close', resolve));
    wrapper.kill('SIGKILL');
    await closed;
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const pid of childPids) assert.throws(() => process.kill(pid, 0), 'FFmpeg fallback survived cancellation');
  }
  console.log('Decoder compatibility and progressive cancellation passed');
} finally { rmSync(dir, { recursive: true, force: true }); }
