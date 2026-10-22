import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { Track } from '../src/lib/api.ts';
import { hasTrackArtist, trackArtists } from '../src/lib/artists.ts';
import { trackArtistLinks } from '../src/lib/router.ts';
import { TrackArtists } from '../src/components/TrackArtists.tsx';

const track = (artist: string, extra: Partial<Track> = {}) => ({ artist, provider: 'local', ...extra }) as Track;

describe('individual artist navigation', () => {
  it('links every Yandex credit to its own id, including names containing commas', () => {
    const t = track('A, B, C', { provider: 'yandex', catalogArtists: [{ id: '11', name: 'A, B' }, { id: '22', name: 'C' }] });
    expect(trackArtistLinks(t)).toEqual([{ name: 'A, B', href: '#/catalog/artist/11' }, { name: 'C', href: '#/catalog/artist/22' }]);
    const html = renderToStaticMarkup(createElement(TrackArtists, { track: t }));
    expect(html).toContain('<a href="#/catalog/artist/11">A, B</a>, <a href="#/catalog/artist/22">C</a>');
  });
  it('includes collaborations on each local artist page without matching substrings', () => {
    const t = track('Shiny Ruby, Babypikachu, galaxxy4r, !owee');
    expect(trackArtists(t).map(a => a.name)).toEqual(['Shiny Ruby', 'Babypikachu', 'galaxxy4r', '!owee']);
    expect(hasTrackArtist(t, 'Babypikachu')).toBe(true);
    expect(hasTrackArtist(t, 'Ruby')).toBe(false);
    expect(trackArtistLinks(t)[1].href).toBe('#/artist/Babypikachu');
  });
  it('keeps ampersand artist names intact and omits repeated or empty credits', () => {
    expect(trackArtists(track('Tyler, The Creator', { catalogArtists: [{ id: '', name: 'Tyler, The Creator' }] }))).toEqual([{ name: 'Tyler, The Creator', catalogId: undefined }]);
    expect(trackArtists(track('AC/DC; Simon & Garfunkel feat. Guest, Guest, ')).map(a => a.name)).toEqual(['AC/DC', 'Simon & Garfunkel', 'Guest']);
    expect(trackArtistLinks(track(''))).toEqual([]);
  });
});
