import { expect, it, vi } from 'vitest';
import { nativeDownload, networkFetch, rustNetworkEnabled } from '../src/worker/replace/rust-network.ts';

it('uses the host fetch and keeps downloads on the existing mobile transport', async () => {
  const response = new Response('audio');
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  try {
    const init = { signal: new AbortController().signal };
    expect(await networkFetch('https://audio.test/song', init)).toBe(response);
    expect(fetch).toHaveBeenCalledWith('https://audio.test/song', init);
    expect(rustNetworkEnabled()).toBe(false);
    expect(nativeDownload('https://audio.test/song', '/data/song', {})).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
