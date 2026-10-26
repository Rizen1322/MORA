import { AnalysisAccumulator } from '../../../packages/core/src/mir/analyzePcm.ts';
import { planTransition } from '../../../packages/core/src/plan/planner.ts';
import { fallbackWithoutVocalStems } from '../../../packages/core/src/plan/first-words.ts';
import { planToArmed } from '../../../packages/core/src/engine/arm.ts';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, type AutoMixSettings, type PlannerTrack } from '../../../packages/core/src/types.ts';

// Runs on the native preparation queue in app-process JavaScriptCore, never in
// WebContent and never in the Swift audio producer. DSP playback remains Swift.
declare const moraPreparationRead: (offset: number, frames: number) => string;
declare const moraPreparationCancelled: () => boolean;
declare const moraPreparationProgress: (stage: string) => void;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const values = new Uint8Array(128);
for (let i = 0; i < alphabet.length; i++) values[alphabet.charCodeAt(i)] = i;
function pcm(text: string): Float32Array {
  if (!text || text.length % 4) throw Error('short_pcm');
  const bytes = new Uint8Array(text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0));
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const value = values[text.charCodeAt(i)] << 18 | values[text.charCodeAt(i + 1)] << 12
      | values[text.charCodeAt(i + 2)] << 6 | values[text.charCodeAt(i + 3)];
    bytes[at++] = value >>> 16;
    if (at < bytes.length) bytes[at++] = value >>> 8;
    if (at < bytes.length) bytes[at++] = value;
  }
  if (bytes.length % 8) throw Error('unaligned_pcm');
  return new Float32Array(bytes.buffer);
}
export const analyzerVersion = ANALYZER_VERSION;
export function analyzeJSON(input: string): string {
  const { frames } = JSON.parse(input) as { frames: number };
  if (!Number.isSafeInteger(frames) || frames <= 0) throw Error('invalid_length');
  const acc = new AnalysisAccumulator(frames / 44100 + 5);
  const left = new Float32Array(32768), right = new Float32Array(32768);
  const checkCancel = () => { if (moraPreparationCancelled()) throw Error('cancelled'); };
  moraPreparationProgress('feedingPcm');
  for (let at = 0; at < frames; at += 32768) {
    checkCancel();
    const length = Math.min(32768, frames - at), input = pcm(moraPreparationRead(at, length));
    if (input.length !== length * 2) throw Error('short_pcm');
    for (let i = 0; i < length; i++) { left[i] = input[i * 2]; right[i] = input[i * 2 + 1]; }
    acc.push(left.subarray(0, length), right.subarray(0, length), length);
  }
  return JSON.stringify(acc.finish({ checkCancel, onProgress: (_, stage) => moraPreparationProgress(stage) }));
}
export function planJSON(input: string): string {
  const request = JSON.parse(input) as { a: PlannerTrack; b: PlannerTrack; settings?: AutoMixSettings; sampleRate: number };
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...request.settings };
  const plan = fallbackWithoutVocalStems(planTransition(request.a, request.b, settings));
  return JSON.stringify({ plan, transition: planToArmed(plan, request.sampleRate, 'A', 'B'), gainDb: plan.gainB });
}
