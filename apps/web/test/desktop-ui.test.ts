import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Exercise the actual handlers and effect updates without a browser or live library.
const h = vi.hoisted(() => ({
  values: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false,
  state: {} as any, route: {} as any,
  play: vi.fn(), toggle: vi.fn(), toast: vi.fn(), lyricsOffset: vi.fn(),
  publicSearch: vi.fn(async () => ({ items: [] })), restore: vi.fn(), updateTrack: vi.fn(),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const i = h.cursor++;
    if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial;
    return [h.values[i], (value: any) => {
      const next = typeof value === 'function' ? value(h.values[i]) : value;
      if (!Object.is(h.values[i], next)) { h.values[i] = next; h.dirty = true; }
    }];
  },
  useRef: (initial: any) => {
    const i = h.cursor++;
    return h.values[i] ??= { current: initial };
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  useEffect: (fn: () => unknown, deps: unknown[]) => {
    const i = h.cursor++, old = h.values[i];
    if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
    h.values[i] = { deps };
    h.effects.push(() => { old?.cleanup?.(); h.values[i].cleanup = fn(); });
  },
}));
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
vi.mock('zustand/react/shallow', () => ({ useShallow: (select: unknown) => select }));
vi.mock('../src/store/app.ts', () => ({
  useApp: Object.assign((select: any) => select(h.state), { getState: () => h.state }),
  controller: { playTracks: h.play, toggle: h.toggle }, trackOf: (id: string) => h.state.tracks.get(id),
}));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: null }));
vi.mock('../src/lib/router.ts', () => ({ useRoute: () => h.route }));
vi.mock('../src/store/catalog.ts', () => ({ usePublicPlayback: () => ({ phase: 'idle' }), publicPlayer: {} }));
vi.mock('../src/lib/api.ts', () => ({ api: { publicSearch: h.publicSearch, setLyricsOffset: h.lyricsOffset, restorePlaylists: h.restore, updateTrack: h.updateTrack } }));
vi.mock('../src/lib/intent-warmup.ts', () => ({ useIntentWarmup: () => ({}) }));
vi.mock('../src/lib/radio.ts', () => ({}));
vi.mock('../src/components/VersionPanel.tsx', () => ({}));
vi.mock('../src/lib/playlist-export.ts', () => ({ exportPlaylistBackup: vi.fn() }));

import { SearchPage } from '../src/pages/Search.tsx';
import { TrackList } from '../src/components/TrackList.tsx';
import { ConfirmModal, PromptModal } from '../src/components/common.tsx';
import { LyricsPanel } from '../src/components/LyricsPanel.tsx';
import { PlaylistBackup } from '../src/components/PlaylistBackup.tsx';
import { TrackMenu } from '../src/components/TrackMenu.tsx';

function render(fn: () => ReactElement, effects = false): ReactElement {
  for (let n = 0; n < 20; n++) {
    h.cursor = 0; h.dirty = false;
    const node = fn();
    if (!effects) return node;
    for (const effect of h.effects.splice(0)) effect();
    if (!h.dirty) return node;
  }
  throw Error('Render did not settle');
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
const inputOf = (node: any) => find(node, child => child.type === 'input');
const track = { id: 'a', title: 'song', artist: '', album: '', albumArtist: '', genre: '', duration: 100, status: 'ok', reaction: 0, analysis: {}, addedAt: 0 } as any;
beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; h.dirty = false;
  h.state = { tracks: new Map([['a', track]]), order: ['a'], providers: [], toast: h.toast,
    player: { queue: [{ trackId: 'a', entryId: 'current', sourcePlaylistId: 'p', playlistEntryId: 1 }], index: 0, status: 'playing', position: 9.8 } };
  h.route = { query: new URLSearchParams('q=song&src=local') };
  vi.useFakeTimers(); vi.clearAllMocks();
  h.lyricsOffset.mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('document', { documentElement: { dataset: {} }, getElementById: () => null });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  for (const value of h.values) value?.cleanup?.();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('leaves buttons alone and submits a changed query instead of playing old results', () => {
  let page = render(SearchPage, true);
  expect(page.props.onKeyDown).toBeUndefined();
  const key = { key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: vi.fn() };
  inputOf(page).props.onChange({ target: { value: 'new song' } });
  page = render(SearchPage);
  inputOf(page).props.onKeyDown(key);
  expect(key.preventDefault).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
  find(page, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  page = render(SearchPage, true);
  expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '#/search?q=new+song&src=local');
});

it('restores route query/source even when navigating to the original query after a local edit', async () => {
  let page = render(SearchPage, true);
  inputOf(page).props.onChange({ target: { value: 'edited' } });
  render(SearchPage, true); await vi.advanceTimersByTimeAsync(300); render(SearchPage, true);
  h.route = { query: new URLSearchParams('q=song&src=local') };
  page = render(SearchPage, true);
  expect(inputOf(page).props.value).toBe('song');
  h.route = { query: new URLSearchParams('q=other&src=youtube') };
  page = render(SearchPage, true);
  expect(inputOf(page).props.value).toBe('other');
  expect(h.publicSearch).toHaveBeenCalledWith('youtube', 'other', expect.any(AbortSignal));
});

it('clears the address when the query is cleared', async () => {
  const page = render(SearchPage, true);
  inputOf(page).props.onChange({ target: { value: '' } });
  render(SearchPage, true); await vi.advanceTimersByTimeAsync(300); render(SearchPage, true);
  expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '#/search?q=&src=local');
});

it('plays a different occurrence of the same playlist track and only pauses the current occurrence', () => {
  const play = vi.fn();
  const page = render(() => TrackList({ tracks: [track, track], onPlay: play, playlistId: 'p', playlistEntryIds: [1, 2] }));
  const first = find(page, node => node.props?.['aria-rowindex'] === 1);
  const second = find(page, node => node.props?.['aria-rowindex'] === 2);
  find(second, node => node.props?.className === 'track-art-play').props.onClick();
  expect(play).toHaveBeenCalledWith(1); expect(h.toggle).not.toHaveBeenCalled();
  find(first, node => node.props?.className === 'track-art-play').props.onClick();
  expect(h.toggle).toHaveBeenCalledOnce();
});

it.each(['prompt', 'confirm'])('blocks duplicate %s mutations and reports failures without closing', async kind => {
  let reject!: (error: Error) => void;
  const action = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; })), close = vi.fn();
  const page = render(() => kind === 'prompt'
    ? PromptModal({ title: 'New', label: 'Name', initial: 'name', confirm: 'Save', onSubmit: action, onClose: close })
    : ConfirmModal({ title: 'Delete', text: 'Confirm', confirm: 'Delete', onConfirm: action, onClose: close }));
  const submit = kind === 'prompt' ? () => inputOf(page).props.onKeyDown({ key: 'Enter' }) : () => find(page.props.actions, node => node.props?.className?.includes('btn-primary')).props.onClick();
  const first = submit(); await submit(); expect(action).toHaveBeenCalledOnce();
  reject(Error('Disk unavailable')); await first;
  expect(h.toast).toHaveBeenCalledWith('Disk unavailable', 'error'); expect(close).not.toHaveBeenCalled();
});

it('reports metadata save errors and blocks a duplicate save', async () => {
  const menu = () => TrackMenu({ track, x: 0, y: 0, onClose: vi.fn(), onPlay: vi.fn() });
  render(menu); h.values[0] = 'edit';
  const edit = find(render(menu), node => node.type?.name === 'EditTrack');
  h.values = [];
  const page = render(() => edit.type(edit.props));
  let reject!: (error: Error) => void;
  h.updateTrack.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const save = find(page.props.actions, node => node.props?.className === 'btn btn-primary');
  const first = save.props.onClick(); await save.props.onClick();
  expect(h.updateTrack).toHaveBeenCalledOnce();
  reject(Error('Metadata save failed')); await first;
  expect(h.toast).toHaveBeenCalledWith('Metadata save failed', 'error');
});

it('moves lyric highlighting earlier and later in the direction stated on the buttons', () => {
  render(LyricsPanel);
  const stateIndex = h.values.findIndex(value => value === null);
  h.values[stateIndex] = { id: 'a/', data: { status: 'synced', lines: [{ t: 10, text: 'line' }] } };
  let page = render(LyricsPanel);
  find(page, node => node.props?.['aria-label'] === 'Текст раньше на 0,25 с').props.onClick();
  page = render(LyricsPanel);
  expect(h.lyricsOffset).toHaveBeenLastCalledWith('a', 250);
  expect(find(page, node => node.props?.['data-line'] === 0).props['aria-current']).toBe('true');
  find(page, node => node.props?.['aria-label'] === 'Текст позже на 0,25 с').props.onClick();
  page = render(LyricsPanel);
  expect(h.lyricsOffset).toHaveBeenLastCalledWith('a', 0);
  expect(find(page, node => node.props?.['data-line'] === 0).props['aria-current']).toBeUndefined();
});

it('accepts backups above the former 16 MiB limit and rejects oversized files before reading', async () => {
  const fn = () => PlaylistBackup();
  let page = render(fn);
  const text = vi.fn(async () => JSON.stringify({ format: 'mora-playlists', version: 1, playlists: [] }));
  inputOf(page).props.onChange({ target: { files: [{ size: 20 * 1024 ** 2, name: 'backup.json', text }], value: '' } });
  await Promise.resolve(); page = render(fn);
  expect(find(page, node => node.type === 'strong').props.children).toBe('backup.json');
  text.mockClear();
  inputOf(page).props.onChange({ target: { files: [{ size: 129 * 1024 ** 2, text }], value: '' } });
  page = render(fn);
  expect(text).not.toHaveBeenCalled();
  expect(find(page, node => node.props?.role === 'alert').props.children).toContain('128 МБ');
});
