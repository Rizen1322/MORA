/** Small damped stereo room, bounded feedback and no allocations on the audio thread. */
class Comb {
  private readonly data: Float32Array;
  private index = 0;
  private low = 0;
  constructor(length: number) { this.data = new Float32Array(Math.max(1, Math.round(length))); }
  step(input: number) {
    const value = this.data[this.index];
    this.low += (value - this.low) * .32;
    this.data[this.index] = input + this.low * .72;
    if (++this.index === this.data.length) this.index = 0;
    return value;
  }
  reset() { this.data.fill(0); this.index = 0; this.low = 0; }
}

export class MasterReverb {
  private readonly left: Comb[];
  private readonly right: Comb[];
  private mix = 0;
  private target = 0;
  private readonly glide: number;
  private clean = true;
  constructor(sampleRate: number) {
    this.left = [.0297, .0371, .0411, .0437].map((s) => new Comb(s * sampleRate));
    this.right = [.0302, .0383, .0403, .0451].map((s) => new Comb(s * sampleRate));
    this.glide = 1 - Math.exp(-1 / (.025 * sampleRate));
  }
  setMix(value: number) { this.target = Number.isFinite(value) ? Math.max(0, Math.min(.35, value)) : 0; }
  reset() { for (const c of this.left) c.reset(); for (const c of this.right) c.reset(); this.clean = true; }
  process(L: Float32Array, R: Float32Array, n: number) {
    if (this.target === 0 && this.mix < 1e-5) { this.mix = 0; if (!this.clean) this.reset(); return; }
    this.clean = false;
    for (let i = 0; i < n; i++) {
      this.mix += (this.target - this.mix) * this.glide;
      const l = L[i], r = R[i];
      let wetL = 0, wetR = 0;
      for (let c = 0; c < 4; c++) {
        wetL += this.left[c].step(l * .85 + r * .15);
        wetR += this.right[c].step(r * .85 + l * .15);
      }
      // Four paths × .07 / (1-.72) = 1: conservative bound on the wet peak gain.
      L[i] = l * (1 - this.mix) + wetL * .07 * this.mix;
      R[i] = r * (1 - this.mix) + wetR * .07 * this.mix;
    }
  }
}
