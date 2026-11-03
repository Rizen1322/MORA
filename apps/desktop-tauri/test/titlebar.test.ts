import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

it('routes window controls and drags only empty title-bar areas', async () => {
  const listeners = new Map<string, (e: any) => void>();
  const invoke = vi.fn().mockResolvedValue(null);
  class Element {
    constructor(private bar: boolean, private interactive = false) {}
    closest(selector: string) { return selector === '.titlebar, .fp-top' ? this.bar : this.interactive; }
  }
  const window: any = { __TAURI_INTERNALS__: { invoke } };
  const document = { cookie: '', addEventListener: (type: string, callback: (e: any) => void) => listeners.set(type, callback) };
  const script = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { window, document, location: { origin: 'http://127.0.0.1:__MORA_PORT__' }, Element, EventSource: class {} });
  const down = (target: unknown, button = 0, detail = 1) => listeners.get('mousedown')!({ target, button, detail, preventDefault() {} });
  down(new Element(true));
  down(new Element(true), 0, 2);
  down(new Element(true, true));
  down(new Element(false));
  down(new Element(true), 2);
  down(null);
  expect(invoke.mock.calls.map(call => call[1].action)).toEqual(['window-drag', 'window-maximize']);
  for (const action of ['minimize', 'maximize', 'close']) await window.automixDesktop.windowCommand(action);
  expect(invoke.mock.calls.slice(2).map(call => call[1].action)).toEqual(['window-minimize', 'window-maximize', 'window-close']);
});
