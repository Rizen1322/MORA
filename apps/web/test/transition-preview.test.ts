import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  state: { status: 'playing' }, pause: vi.fn(), toggle: vi.fn(), subscribe: vi.fn(), toast: vi.fn(),
}));
vi.mock('../src/store/app.ts', () => ({ controller: transport, useApp: { getState: () => ({ toast: transport.toast }) } }));
import { previewPhraseDraft, stopPreview } from '../src/lib/transition-preview.ts';

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class PreviewAudio {
  static instances: PreviewAudio[] = [];
  static nextPlay: Promise<void> | undefined;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => PreviewAudio.nextPlay ?? Promise.resolve());
  constructor(public src: string) { PreviewAudio.instances.push(this); }
}
beforeEach(() => {
  vi.clearAllMocks(); PreviewAudio.instances = []; PreviewAudio.nextPlay = undefined;
  transport.state.status = 'playing';
  transport.pause.mockImplementation(() => { transport.state.status = 'paused'; });
  transport.toggle.mockImplementation(() => { transport.state.status = 'playing'; });
  vi.stubGlobal('Audio', PreviewAudio);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['wav']))));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${PreviewAudio.instances.length}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { stopPreview(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not let a late play rejection stop the replacement preview', async () => {
  const oldPlay = pending<void>(); PreviewAudio.nextPlay = oldPlay.promise;
  const old = previewPhraseDraft('a', 'b');
  await vi.waitFor(() => expect(PreviewAudio.instances).toHaveLength(1));
  PreviewAudio.nextPlay = undefined;
  await previewPhraseDraft('b', 'c');
  const replacement = PreviewAudio.instances[1];
  oldPlay.reject(new Error('old Audio was stopped')); await old;
  expect(replacement.pause).not.toHaveBeenCalled();
  expect(transport.toast).not.toHaveBeenCalled();
  expect(transport.state.status).toBe('paused');
});

it('releases a failed preview and restores the previously playing transport once', async () => {
  await previewPhraseDraft('a', 'b');
  const audio = PreviewAudio.instances[0];
  audio.onerror!(); audio.onerror!();
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(transport.toggle).toHaveBeenCalledTimes(1);
  expect(transport.toast).toHaveBeenCalledTimes(1);
});

it('ignores a cancelled render even when the fetch implementation resolves late', async () => {
  const response = pending<Response>(); vi.mocked(fetch).mockReturnValue(response.promise);
  const loading = previewPhraseDraft('a', 'b'); stopPreview();
  response.resolve(new Response(new Blob(['late wav']))); await loading;
  expect(PreviewAudio.instances).toHaveLength(0);
  expect(transport.pause).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});
