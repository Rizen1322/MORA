import type { PcmSource } from '../dsp/wsola.ts';

export interface SourceLoop {
  start: number;
  end: number;
  until: number;
  fade: number;
  roll?: { at: number; length: number }[];
}
export interface SourceTapeStop { start: number; end: number; fade: number }

/** Finite source loop, before WSOLA. Keeps the beat period exact and consumes
 * existing PCM chunks, not a second decoded file or an unbounded recording.
 * The seam blends into the preroll immediately preceding the loop start; the
 * first transient of the next bar is neither skipped nor played twice. */
export class LoopPcmSource implements PcmSource {
  private loop: SourceLoop | null = null;
  private tape: SourceTapeStop | null = null;
  private readonly scratchL: Float32Array;
  private readonly scratchR: Float32Array;
  constructor(private readonly source: PcmSource, private readonly sampleRate: number) {
    this.scratchL = new Float32Array(Math.ceil(sampleRate * .02));
    this.scratchR = new Float32Array(this.scratchL.length);
  }
  get totalFrames(): number { return Math.max(this.source.totalFrames, this.loop?.until ?? 0); }
  setLoop(loop: SourceLoop | null): boolean {
    this.loop = null;
    this.tape = null;
    if (!loop) return true;
    const { start, end, until, fade } = loop, length = end - start;
    if (![start, end, until, fade].every(Number.isSafeInteger) || fade < 1 || fade > this.scratchL.length
      || start < fade || end > this.source.totalFrames || length < this.sampleRate * .25 || length > this.sampleRate * 8
      || fade > length / 8 || until <= end || until - start > length * 4) return false;
    let at = start, previousLength = length;
    if (loop.roll && (loop.roll.length > 3 || loop.roll.some(step => {
      const cycles=(step.at-at)/previousLength;
      const valid = Number.isSafeInteger(step.at) && Number.isSafeInteger(step.length) && step.at >= at + previousLength-1
        && step.at < until && step.length >= this.sampleRate * .1 && Math.abs(step.length-previousLength/2)<=1
        && step.length >= fade * 8 && Math.abs(cycles-Math.round(cycles))*previousLength<=1;
      at = step.at; previousLength = step.length; return !valid;
    }))) return false;
    this.loop = { ...loop, roll: loop.roll?.map(x => ({ ...x })) };
    return true;
  }
  getLoop(): Readonly<SourceLoop> | null { return this.loop; }
  setTapeStop(tape:SourceTapeStop|null):boolean {
    this.tape=null;
    if(!tape)return true;
    if(this.loop||![tape.start,tape.end,tape.fade].every(Number.isSafeInteger)||tape.start<0||tape.end>this.source.totalFrames
      ||tape.end-tape.start<this.sampleRate*.15||tape.end-tape.start>this.sampleRate*1.5
      ||tape.fade<1||tape.fade>(tape.end-tape.start)/2)return false;
    this.tape={...tape};return true;
  }
  getTapeStop():Readonly<SourceTapeStop>|null{return this.tape;}
  private readTape(start:number,len:number,L:Float32Array,R:Float32Array,offset:number):boolean {
    const tape=this.tape!,duration=tape.end-tape.start;
    let i=0;
    while(i<len){
      const p=start+i;
      if(p<tape.start){const n=Math.min(len-i,tape.start-p);if(!this.source.read(p,n,L,R,offset+i))return false;i+=n;continue;}
      if(p>=tape.end){L.fill(0,offset+i,offset+len);R.fill(0,offset+i,offset+len);return true;}
      const n=Math.min(len-i,tape.end-p,this.scratchL.length-3),u=p-tape.start;
      const from=Math.floor(tape.start+u-u*u/(2*duration)),last=u+n-1;
      const to=Math.ceil(tape.start+last-last*last/(2*duration))+1;
      if(!this.source.read(from,to-from+1,this.scratchL,this.scratchR,0))return false;
      for(let j=0;j<n;j++){
        const input=u+j,x=tape.start+input-input*input/(2*duration)-from,k=Math.floor(x),f=x-k;
        const gain=Math.min(1,(tape.end-p-j)/tape.fade);
        L[offset+i+j]=(this.scratchL[k]*(1-f)+this.scratchL[k+1]*f)*gain;
        R[offset+i+j]=(this.scratchR[k]*(1-f)+this.scratchR[k+1]*f)*gain;
      }
      i+=n;
    }
    return true;
  }
  read(start: number, len: number, L: Float32Array, R: Float32Array, offset: number): boolean {
    if(this.tape)return this.readTape(start,len,L,R,offset);
    const loop = this.loop;
    if (!loop) return this.source.read(start, len, L, R, offset);
    let i = 0;
    while (i < len) {
      const p = start + i;
      if (p < loop.start) {
        const n = Math.min(len - i, loop.start - p);
        if (!this.source.read(p, n, L, R, offset + i)) return false;
        i += n; continue;
      }
      if (p >= loop.until) { L.fill(0, offset + i, offset + len); R.fill(0, offset + i, offset + len); return true; }
      let length = loop.end - loop.start, origin = loop.start, next = loop.until;
      if(loop.roll)for (const step of loop.roll) {
        if (step.at > p) { next = Math.min(next, step.at); break; }
        origin = step.at; length = step.length;
      }
      const phase = (p - origin) % length;
      const seam = phase >= length - loop.fade;
      const n = Math.min(len - i, next - p, (seam ? length : length - loop.fade) - phase);
      if (!this.source.read(loop.start + phase, n, L, R, offset + i)) return false;
      if (seam) {
        const at = phase - (length - loop.fade);
        if (!this.source.read(loop.start - loop.fade + at, n, this.scratchL, this.scratchR, 0)) return false;
        for (let j = 0; j < n; j++) {
          const x = (at + j + 1) / loop.fade, wet = x * x * (3 - 2 * x), out = offset + i + j;
          L[out] += (this.scratchL[j] - L[out]) * wet;
          R[out] += (this.scratchR[j] - R[out]) * wet;
        }
      }
      i += n;
    }
    return true;
  }
}
