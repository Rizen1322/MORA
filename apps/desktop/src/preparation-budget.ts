import { freemem } from 'node:os';

/** Bounds future PCM warmups using recent playback preparation time and available system memory. */
export class PreparationBudget {
  private elapsed = 0;

  constructor(private freeMemory: () => number = freemem) {}

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.elapsed = this.elapsed ? this.elapsed * 0.75 + ms * 0.25 : ms;
  }

  candidates(): number {
    const free = this.freeMemory();
    if (free < 512 * 1024 ** 2) return 0;
    if (free < 1024 ** 3) return 1;
    return this.elapsed >= 30_000 ? 4 : this.elapsed >= 10_000 ? 3 : 2;
  }
}
