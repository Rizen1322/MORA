import { expect, it } from 'vitest';
import { actionFor, comboLabel, comboOf, hotkeys, resetHotkeys, setHotkey } from '../src/lib/hotkeys.ts';

it('binds physical keys and swaps a key that is already in use', () => {
  resetHotkeys();
  expect(comboOf({ code: 'KeyM', shiftKey: false } as KeyboardEvent)).toBe('KeyM');
  expect(comboOf({ code: 'ShiftLeft', shiftKey: true } as KeyboardEvent)).toBeNull();
  setHotkey('mute', 'KeyL');
  expect(actionFor('KeyL')).toBe('mute');
  expect(hotkeys().like).toBe('KeyM');
  expect(comboLabel('Shift+ArrowRight')).toBe('Shift + →');
  expect(actionFor(comboOf({ code: 'ArrowUp', altKey: true, shiftKey: false } as KeyboardEvent)!)).toBe('queueUp');
  setHotkey('queueUp', 'KeyU');
  expect(actionFor('KeyU')).toBe('queueUp');
  resetHotkeys();
  expect(actionFor('KeyL')).toBe('like');
});
