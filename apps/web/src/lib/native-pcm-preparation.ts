/** A progressive response is not EOF. Only the completed decoder knows the real length. */
export async function uploadNativePcm(read: (start: number) => Promise<Response>,
  put: (byteOffset: number, bytes: ArrayBuffer) => Promise<void>, signal: AbortSignal,
  progress?: (frames: number) => void): Promise<number> {
  let frames = 0;
  for (;;) {
    signal.throwIfAborted();
    const response = await read(frames);
    if (!response.ok || response.headers.get('X-PCM-Format') !== 'f32le') throw new Error('Не удалось подготовить PCM');
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength % 8 || bytes.byteLength > 32768 * 8) throw new Error('Неверный формат PCM');
    const complete = response.headers.get('X-Complete') === '1';
    const total = Number(response.headers.get('X-Total-Frames'));
    if (bytes.byteLength) {
      if (frames * 8 + bytes.byteLength > 384 * 1024 * 1024) throw new Error('Пара слишком большая для теста');
      await put(frames * 8, bytes); frames += bytes.byteLength / 8; progress?.(frames);
    }
    if (complete) {
      if (!Number.isSafeInteger(total) || total <= 0 || frames > total) throw new Error('Изменилась длина PCM');
      if (frames === total) return frames;
    }
    if (!bytes.byteLength) throw new Error('Подготовка звука ещё не завершена');
  }
}
