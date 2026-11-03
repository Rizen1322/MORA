import { expect, it } from 'vitest';
import { MixerCore } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
it.each([0, 1])('seek to inactive deck %i stops the other survivor after a missed transition end', deck => {
  const mixer = new MixerCore(48000, () => {}), pcm = new Float32Array(CHUNK_FRAMES).fill(.1);
  for (const d of [0, 1]) { mixer.load(d, 'T' + d, CHUNK_FRAMES, 0); mixer.feed(d, 'T' + d, 0, pcm, pcm.slice()); }
  const render = (blocks: number) => { for (let i = 0; i < blocks; i++) mixer.process(new Float32Array(128), new Float32Array(128), 128); };
  mixer.start(1 - deck, 'T' + (1 - deck), 0); render(32);
  expect(mixer.decks[1 - deck].playing).toBe(true);
  mixer.seek('T' + deck, 0); render(128);
  expect(mixer.decks[deck].playing).toBe(true);
  expect(mixer.decks[1 - deck].playing).toBe(false);
});
