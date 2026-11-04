import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ play: vi.fn(), enqueue: vi.fn(), toast: vi.fn() }));
vi.mock('../src/store/app.ts', () => ({ controller: { state: {} }, trackOf: () => undefined, useApp: { getState: () => ({ toast: h.toast, order: [], tracks: new Map() }) } }));
vi.mock('../src/store/catalog.ts', () => ({ catalogPlayer: {}, publicPlayer: { play: h.play, enqueue: h.enqueue } }));
vi.mock('../src/store/downloads.ts', () => ({ useDownloads: { getState: () => ({}) } }));
vi.mock('../src/components/LikeAll.tsx', () => ({ likeLibraryTrack: vi.fn() }));
vi.mock('../src/components/TrackList.tsx', () => ({ react: vi.fn() }));
vi.mock('../src/components/VersionPanel.tsx', () => ({ openVersionPanel: vi.fn() }));
vi.mock('../src/pages/Library.tsx', () => ({ sortTracks: (x: unknown) => x }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: object) => ({ ...t, artists: [] }) }));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: vi.fn(), startArtistRadio: vi.fn(), useRadio: { getState: () => ({}) } }));
vi.mock('../src/lib/api.ts', () => ({ api: { publicCatalog: vi.fn(async () => ({ id: 'MPRE1', type: 'album', title: 'Album', tracks: [
  { externalId: 'v1', title: 'One', artist: 'A', duration: 61, coverUrl: null, playable: true, explicit: true },
  { externalId: 'v2', title: 'Two', artist: 'A', duration: 62, coverUrl: null, playable: false, explicit: false },
] })) } }));

it('describes a YouTube Music album natively and plays its rows through the public player', async () => {
  vi.stubGlobal('location', { hash: '#/public/album/MPRE1' });
  const { describe, actions } = await import('../src/lib/native-pages.ts');
  const screen = (await describe())!;
  expect(screen.title).toBe('Album');
  const rows = screen.sections[1].rows as any[];
  expect(rows.map((r) => [r.title, r.tag, !!r.act])).toEqual([['One', 'E', true], ['Two', undefined, false]]);
  await actions[rows[0].act.name](rows[0].act.args);
  expect(h.play).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ externalId: 'v1' })]), 0, { type: 'album', id: 'MPRE1', label: 'Album · YouTube Music' });
  await actions.onlineQueue(rows[0].actions[0].act.args);
  expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'v1' }));
  expect(() => actions.onlinePlay({ key: 'gone', index: 0 })).toThrow('устарела');
});
