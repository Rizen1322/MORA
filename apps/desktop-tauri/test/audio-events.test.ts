import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from '../../server/src/events.ts';
import { DesktopAnalyser, DesktopAudioContext } from '../../web/src/audio/desktop-engine.ts';
import type { DesktopBridge } from '../../web/src/lib/desktop.ts';
import { createPlaybackHost } from '../playback.ts';

const capture = vi.hoisted(() => ({ emit: (_event: unknown) => {} }));
vi.mock('../../desktop/src/rust-audio.mjs', () => ({ RustAudio: class {
  process = null;
  constructor(_file: string, emit: (e: unknown) => void) { capture.emit = emit; }
  stop = async () => {};
  command = async () => {};
} }));

it('keeps the spectrum stream alive across waveform backpressure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-audio-events-'));
  const app = Fastify();
  const host = await createPlaybackHost(app, dir, dir, () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: '' }),
    { events: new EventHub(), lib: { listDTO: () => [] } } as any);
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/audio-events`, { signal: abort.signal });
    reader = response.body!.getReader();
    await reader.read(); // connection comment
    const samples = Array.from({ length: 2048 }, (_, i) => .37 * Math.sin(2 * Math.PI * 32 * i / 2048));
    // Native stdout can deliver multiple waveform packets in one event-loop turn.
    for (let i = 0; i < 20; i++) capture.emit({ type: 'waveform', samples });
    let text = '';
    while (!text.includes('\n\n')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    const event = JSON.parse(text.split('\n\n').find(line => line.startsWith('data: '))!.slice(6));
    expect(event.type).toBe('waveform');
    const analyser = new DesktopAnalyser(new DesktopAudioContext(48000, 2048, {} as DesktopBridge));
    analyser.feed(event.samples);
    const bins = new Uint8Array(1024);
    analyser.getByteFrequencyData(bins);
    expect(bins[32]).toBeGreaterThan(100);
    await new Promise(resolve => setTimeout(resolve, 25));
    capture.emit({ type: 'test-connected' });
    while (!text.includes('test-connected')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    await host.close();
    app.server.closeAllConnections();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
