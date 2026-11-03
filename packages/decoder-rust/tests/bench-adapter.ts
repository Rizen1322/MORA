import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FfmpegTools } from '../../../apps/server/src/ffmpeg.ts';
const [decoderArg, ffmpegArg, ffprobeArg, codec = 'flac', durationArg = '120'] = process.argv.slice(2);
if (!decoderArg || !ffmpegArg || !ffprobeArg) throw Error('usage: tsx tests/bench-adapter.ts DECODER FFMPEG FFPROBE');
const decoder = resolve(decoderArg), ffmpeg = resolve(ffmpegArg), ffprobe = resolve(ffprobeArg);
const dir = mkdtempSync(join(tmpdir(), 'mora-adapter-bench-'));
try {
  const encoder = { flac: 'flac', mp3: 'libmp3lame', wav: 'pcm_s16le', webm: 'libopus' }[codec];
  const duration = Number(durationArg);
  if (!encoder || !Number.isFinite(duration) || duration <= 0) throw Error('invalid codec or duration');
  const file = join(dir, `sample.${codec}`);
  const gen = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=997:duration=${duration}:sample_rate=44100`, '-ac', '2', '-c:a', encoder, file], { windowsHide: true });
  if (gen.status !== 0) throw Error(String(gen.stderr));
  for (const useNative of [true, false]) {
    const tools = new FfmpegTools(ffmpeg, ffprobe, useNative ? decoder : undefined);
    await tools.probe(file);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const cpu0 = process.cpuUsage(), t0 = performance.now();
      const child = tools.decode(file, { sampleRate: 48000, channels: 2, format: 'f32le' });
      if (child.spawnfile !== (useNative ? decoder : ffmpeg)) { child.kill('SIGKILL'); throw Error('unexpected decoder route'); }
      let first = 0, bytes = 0, peak = process.memoryUsage.rss();
      child.stdout.on('data', chunk => { if (!first) first = performance.now() - t0; bytes += chunk.length; peak = Math.max(peak, process.memoryUsage.rss()); });
      child.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      if (code !== 0) throw Error(`decoder exited ${code}`);
      const elapsed = performance.now() - t0, cpu = process.cpuUsage(cpu0);
      runs.push({ first_ms: +first.toFixed(1), wall_s: +(elapsed / 1000).toFixed(3), adapter_cpu_s: +((cpu.user + cpu.system) / 1e6).toFixed(3), adapter_peak_mib: +(peak / 1048576).toFixed(1), bytes, speed: +(duration * 1000 / elapsed).toFixed(1) });
    }
    console.log(JSON.stringify({ codec, duration, decoder: useNative ? 'native' : 'ffmpeg', runs }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
