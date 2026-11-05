import { describe, expect, it } from 'vitest';
import { windowRmsDb } from '../../../tools/audition-deck-energy.ts';
describe('audition deck energy',()=>{it('measures half-second stereo RMS and reports missing windows',()=>{const l=new Float32Array([1,1,0,0]),r=new Float32Array([1,1,0,0]);expect(windowRmsDb(l,r,0,4)).toBe(0);expect(windowRmsDb(l,r,.5,4)).toBe(-120);expect(windowRmsDb(l,r,1,4)).toBeNull()})});
