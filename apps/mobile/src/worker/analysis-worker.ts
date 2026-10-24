import { AnalysisAccumulator } from '@automix/core';

/**
 * Same analyzer as apps/server/src/analysisWorker.ts, fed with PCM the page already
 * decoded (44.1 kHz stereo float, one plane per channel) instead of an ffmpeg pipe.
 */

const CHUNK = 44100 * 4;

self.onmessage = (e: MessageEvent<{ type: 'job'; jobId: number; L: ArrayBuffer; R: ArrayBuffer; duration: number }>) => {
  const job = e.data;
  const post = (m: object) => (self as unknown as Worker).postMessage({ jobId: job.jobId, ...m });
  try {
    const L = new Float32Array(job.L), R = new Float32Array(job.R);
    const total = Math.min(L.length, R.length);
    if (total < 4410) throw new Error('файл не содержит звука');
    const acc = new AnalysisAccumulator(Math.max(30, job.duration + 5, total / 44100 + 5));
    let last = 0;
    // the accumulator regroups input into its own fixed windows: views need no copy
    for (let start = 0; start < total; start += CHUNK) {
      const n = Math.min(CHUNK, total - start);
      acc.push(L.subarray(start, start + n), R.subarray(start, start + n), n);
      const p = Math.min(0.5, (acc.frames / total) * 0.5);
      if (p - last > 0.05) { last = p; post({ type: 'progress', progress: p }); }
    }
    const analysis = acc.finish({ onProgress: (p: number) => post({ type: 'progress', progress: 0.5 + p * 0.5 }), checkCancel: () => {} });
    post({ type: 'done', analysis });
  } catch (err) {
    post({ type: 'error', error: (err as Error).message });
  }
};
