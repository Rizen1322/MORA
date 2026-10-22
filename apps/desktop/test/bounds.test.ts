import { describe, expect, it } from 'vitest';
import { placeWindow } from '../src/bounds.mjs';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('window placement', () => {
  it('opens 1280×820 centred on the primary display by default', () => {
    expect(placeWindow(null, [primary], primary)).toEqual({ width: 1280, height: 820, x: 320, y: 110 });
  });

  it('keeps saved bounds on a second monitor that is still connected', () => {
    const saved = { x: 2100, y: 200, width: 1400, height: 900 };
    expect(placeWindow(saved, [primary, right], primary)).toEqual(saved);
  });

  it('moves a window back when its monitor was unplugged', () => {
    const saved = { x: 2100, y: 200, width: 1400, height: 900 };
    const b = placeWindow(saved, [primary], primary);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
    expect(b.y + b.height).toBeLessThanOrEqual(1040);
  });

  it('does not keep a window whose title bar is above every screen', () => {
    const b = placeWindow({ x: 100, y: -600, width: 1280, height: 820 }, [primary], primary);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  it('shrinks to a small work area instead of overflowing it', () => {
    const small = { x: 0, y: 0, width: 1024, height: 728 };
    expect(placeWindow(null, [small], small)).toEqual({ width: 1024, height: 728, x: 0, y: 0 });
    expect(placeWindow({ x: 50, y: 30, width: 1600, height: 1000 }, [small], small)).toEqual({ width: 1024, height: 728, x: 0, y: 0 });
  });

  it('rejects damaged saved values', () => {
    expect(placeWindow({ x: NaN, y: 0, width: 10, height: 10 }, [primary], primary).width).toBe(1280);
  });
});
