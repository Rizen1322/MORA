import { Readable } from 'readable-stream';
import { expect, it, vi } from 'vitest';

vi.mock('mm-core', () => ({ parseBuffer: vi.fn() })); // a build alias (music-metadata core)
// A stand-in decoder: every input byte becomes one stereo frame, so a prefix decodes to a prefix.
vi.mock('../src/worker/rpc.ts', () => ({
  decodePlanes: vi.fn(),
  decodeAudio: vi.fn(async ({ bytes, sampleRate }: { bytes: ArrayBuffer; sampleRate: number }) => {
    const b = new Uint8Array(bytes), out = new Float32Array(b.length * 2);
    for (let i = 0; i < b.length; i++) out[2 * i] = out[2 * i + 1] = (b[i] + 1) / 256;
    return { pcm: out.buffer, sourceRate: sampleRate, duration: b.length / sampleRate };
  }),
}));

const { FfmpegTools } = await import('../src/worker/replace/ffmpeg.ts');

it('a growing download plays from its decodable start and continues exactly at the seam', async () => {
  const data = new Uint8Array(1_200_000).map((_, i) => (i * 7) % 251);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const input = Readable.from((async function* () {
    for (let i = 0; i < data.length; i += 100_000) {
      if (i === 600_000) await gate; // the rest of the file is still downloading
      yield Buffer.from(data.subarray(i, i + 100_000));
    }
  })());
  const proc = new FfmpegTools('ffmpeg', 'ffprobe').decode(input as never, { sampleRate: 1000, channels: 2, format: 'f32le' });
  const chunks: Buffer[] = [];
  proc.stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
  const early = chunks.reduce((n, c) => n + c.length, 0);
  // everything before the last second of the prefix, nothing beyond what was downloaded
  expect(early).toBeGreaterThan(0);
  expect(early).toBeLessThanOrEqual((600_000 - 1000) * 8);
  release();
  await new Promise<void>((r) => proc.on('exit', () => r()));
  const all = new Float32Array(Buffer.concat(chunks).buffer.slice(0));
  expect(all.length).toBe(data.length * 2);
  for (let i = 0; i < data.length; i += 997) expect(all[2 * i]).toBe((data[i] + 1) / 256);
});
