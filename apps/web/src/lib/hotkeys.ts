/** Rebindable player shortcuts. Bindings are physical keys (KeyboardEvent.code), so they work in any layout. */
export const HOTKEY_ACTIONS = [
  { id: 'toggle', label: 'пауза и продолжение', key: 'Space' },
  { id: 'seekBack', label: 'назад на 5 с', key: 'ArrowLeft' },
  { id: 'seekForward', label: 'вперёд на 5 с', key: 'ArrowRight' },
  { id: 'prev', label: 'предыдущий трек', key: 'Shift+ArrowLeft' },
  { id: 'next', label: 'следующий трек', key: 'Shift+ArrowRight' },
  { id: 'volumeUp', label: 'громче', key: 'ArrowUp' },
  { id: 'volumeDown', label: 'тише', key: 'ArrowDown' },
  { id: 'mute', label: 'без звука', key: 'KeyM' },
  { id: 'like', label: 'нравится', key: 'KeyL' },
  { id: 'queue', label: 'очередь', key: 'KeyQ' },
  { id: 'fullPlayer', label: 'полноэкранный плеер', key: 'KeyF' },
  { id: 'search', label: 'поиск в медиатеке', key: 'Slash' },
  // handled by the focused queue row, not globally
  { id: 'queueUp', label: 'переместить трек в очереди выше', key: 'Alt+ArrowUp' },
  { id: 'queueDown', label: 'переместить трек в очереди ниже', key: 'Alt+ArrowDown' },
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]['id'];

const STORAGE = 'mora.hotkeys';
const defaults = (): Record<HotkeyAction, string> => Object.fromEntries(HOTKEY_ACTIONS.map(a => [a.id, a.key])) as Record<HotkeyAction, string>;

let bindings = defaults();
try { Object.assign(bindings, JSON.parse(localStorage.getItem(STORAGE) ?? '{}')); } catch { /* private window: defaults */ }

export const hotkeys = (): Readonly<Record<HotkeyAction, string>> => bindings;

/** Binds a key; an action that already had it takes this action's old key instead. */
export function setHotkey(id: HotkeyAction, combo: string): void {
  const other = HOTKEY_ACTIONS.find(a => a.id !== id && bindings[a.id] === combo);
  bindings = { ...bindings, ...(other ? { [other.id]: bindings[id] } : {}), [id]: combo };
  save();
}

export function resetHotkeys(): void {
  bindings = defaults();
  save();
}

function save(): void {
  try { localStorage.setItem(STORAGE, JSON.stringify(bindings)); } catch { /* kept for this session */ }
}

/** "Alt+Shift+KeyM"-style combo of a key press; null for a lone modifier. Ctrl/Meta stay with the system. */
export function comboOf(e: KeyboardEvent): string | null {
  if (/^(Shift|Alt|Control|Meta)/.test(e.code) || !e.code) return null;
  return `${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
}

/** Alt + ← / → always navigates back and forward. */
export const reservedCombo = (combo: string) => combo === 'Alt+ArrowLeft' || combo === 'Alt+ArrowRight';

export function actionFor(combo: string): HotkeyAction | undefined {
  return HOTKEY_ACTIONS.find(a => bindings[a.id] === combo)?.id;
}

const NAMES: Record<string, string> = {
  Space: 'Пробел', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Slash: '/', Backslash: '\\', Period: '.', Comma: ',',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Enter: 'Enter', Backspace: 'Backspace',
};

export function comboLabel(combo: string): string {
  return combo.split('+').map(part => NAMES[part] ?? part.replace(/^(Key|Digit|Numpad)/, '')).join(' + ');
}
