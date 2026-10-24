/** Echo of mixer.ts before the silent-ring bypass (CPU audit 2026-10-24): reference for equivalence tests. */
export class Echo {
  private readonly L: Float32Array;
  private readonly R: Float32Array;
  private pos = 0;
  delay = 1;
  feedback = 0.5;
  private hpL = 0;
  private hpR = 0;
  private hpXL = 0;
  private hpXR = 0;
  private lpL = 0;
  private lpR = 0;
  private readonly hpA: number;
  private readonly lpA: number;

  constructor(sampleRate: number) {
    const n = Math.ceil(sampleRate * 2.5);
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
    this.hpA = Math.exp((-2 * Math.PI * 250) / sampleRate);
    this.lpA = 1 - Math.exp((-2 * Math.PI * 6000) / sampleRate);
  }

  private out = 1;
  private outStep = 0;
  private deadline: number | null = null;
  private deadlineFadeFrames = 1;

  /** Absolute output-clock deadline for a voice-only echo. Feedback estimates
   * alone cannot guarantee silence: the repeated word has a finite length. */
  limitTailAt(frame: number, fadeFrames: number): void {
    this.deadline = frame;
    this.deadlineFadeFrames = Math.max(1, fadeFrames);
  }

  /** Fades the echo output to silence, then clears it (no click when cut short). */
  fadeOut(frames: number): void {
    this.outStep = 1 / Math.max(1, frames);
  }

  configure(delayFrames: number, feedback: number): void {
    this.reset();
    this.delay = Math.max(1, Math.min(this.L.length - 1, Math.round(delayFrames)));
    this.feedback = Math.max(0, Math.min(0.75, feedback));
  }

  /** Adds the echo of `inL/inR` (send signal) into outL/outR. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number, clock = 0): void {
    // Keep advancing through silent input/output blocks: a delayed attack can
    // still be waiting in the ring even when this entire block is silent.
    const N = this.L.length;
    for (let i = 0; i < n; i++) {
      const tailGain = this.deadline === null ? 1 : Math.max(0, Math.min(1, (this.deadline-clock-i)/this.deadlineFadeFrames));
      // Keep the deadline closed until configure/reset; a surviving send can
      // never repopulate the ring and bring the outgoing singer back.
      if(tailGain===0)return;
      const rp = (this.pos - this.delay + N) % N;
      const yL = this.L[rp];
      const yR = this.R[rp];
      if (this.outStep > 0) {
        this.out = Math.max(0, this.out - this.outStep);
        if (this.out === 0) {
          this.reset();
          return;
        }
      }
      outL[i] += yL * this.out * tailGain;
      outR[i] += yR * this.out * tailGain;
      // band-limit the feedback: one-pole high-pass then low-pass
      const hL = this.hpA * (this.hpL + yL - this.hpXL);
      const hR = this.hpA * (this.hpR + yR - this.hpXR);
      this.hpXL = yL;
      this.hpXR = yR;
      this.hpL = hL;
      this.hpR = hR;
      this.lpL += this.lpA * (hL - this.lpL);
      this.lpR += this.lpA * (hR - this.lpR);
      this.L[this.pos] = inL[i] + this.lpL * this.feedback;
      this.R[this.pos] = inR[i] + this.lpR * this.feedback;
      this.pos = this.pos + 1 === N ? 0 : this.pos + 1;
    }
  }

  reset(): void {
    this.L.fill(0);
    this.R.fill(0);
    this.pos = 0;
    this.hpL = this.hpR = this.hpXL = this.hpXR = this.lpL = this.lpR = 0;
    this.out = 1;
    this.outStep = 0;
    this.deadline = null;
  }
}
