import { describe, expect, it } from 'vitest';
import { handoffCropStart } from '../../../tools/audition-handoff-crop.ts';
describe('audition handoff crop',()=>{it('retains up to six seconds before the handoff',()=>{expect(handoffCropStart(100,10,100)).toBe(500);expect(handoffCropStart(100,2,100)).toBe(0)})});
