const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** Render-rate-independent envelopes; RMS attacks remain visible despite FFT smoothing. */
export class MusicMotion {
  bass = 0; mid = 0; high = 0; kick = 0; level = 0;
  readonly bands = new Float32Array(16);
  private average = .08;
  private previous = 0;
  private cooldown = 0;
  private previousLowDb = -100;
  update(spectrum: Float32Array | null, waveform: Float32Array | null, sampleRate: number, fftSize: number, dt: number): void {
    dt = Math.min(.1, Math.max(.001, dt)); this.cooldown = Math.max(0, this.cooldown - dt);
    let rms = 0;
    if (waveform) { for (const x of waveform) rms += x * x; rms = Math.sqrt(rms / waveform.length); }
    const energy = clamp(rms * 4.5);
    const onset = Math.max(0, energy - this.previous);
    let lowDb = 0, lowCount = 0;
    if (spectrum) for (let i = Math.max(1, Math.ceil(35 * fftSize / sampleRate)); i <= Math.min(spectrum.length - 1, Math.floor(180 * fftSize / sampleRate)); i++) {
      lowDb += Number.isFinite(spectrum[i]) ? Math.max(-100, spectrum[i]) : -100; lowCount++;
    }
    lowDb = lowCount ? lowDb / lowCount : -100;
    const lowAttack = Math.max(0, lowDb - this.previousLowDb);
    this.previousLowDb = lowDb;
    if (energy > .035 && (onset > .02 || lowAttack > .8) && this.cooldown === 0) { this.kick = clamp(onset * 5 + Math.max(0, energy - this.average) * 1.8 + lowAttack * .1); this.cooldown = .12; }
    this.average += (energy - this.average) * (1 - Math.exp(-dt / .7)); this.previous = energy;
    const follow = (current: number, target: number) => current + (target - current) * (1 - Math.exp(-dt / (target > current ? .035 : .23)));
    const band = (low: number, high: number) => {
      if (!spectrum) return 0;
      let sum = 0, count = 0;
      for (let i = Math.max(1, Math.ceil(low * fftSize / sampleRate)); i <= Math.min(spectrum.length - 1, Math.floor(high * fftSize / sampleRate)); i++) {
        const db = spectrum[i]; sum += Number.isFinite(db) ? clamp((db + 78) / 52) : 0; count++;
      }
      return count ? clamp(sum / count) : 0;
    };
    this.bass = follow(this.bass, band(35, 180) * energy);
    this.mid = follow(this.mid, band(180, 2400) * Math.sqrt(energy));
    this.high = follow(this.high, band(2400, 14000) * Math.sqrt(energy));
    this.level = follow(this.level, energy); this.kick *= Math.exp(-dt / .18);
    for (let i = 0; i < 16; i++) this.bands[i] = follow(this.bands[i], band(40 * 2 ** (i / 2), 40 * 2 ** ((i + 1) / 2)) * Math.sqrt(energy));
  }
}
