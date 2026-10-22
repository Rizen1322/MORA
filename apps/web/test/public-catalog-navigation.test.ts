import { describe, expect, it } from 'vitest';
import type { PublicTrack, Track } from '../src/lib/api.ts';
import { publicTrackArtistLinks, trackAlbumHref, trackArtistLinks } from '../src/lib/router.ts';

const artistId = 'UCOd9uX6JP374Wgu9c0m4qlw', albumId = 'MPREb_Br5t7blIZ0N';
describe('public catalog credit routing', () => {
  it('keeps individual collaborator links and never sends all artists to the first upstream id', () => {
    const links = publicTrackArtistLinks({ artist: 'Yanix, Guest', source: 'ytmusic', audioProvider: 'youtube', artistId } as PublicTrack);
    expect(links).toEqual([{ name: 'Yanix', href: `#/public/artist/${artistId}` }, { name: 'Guest', href: '#/artist/Guest' }]);
    expect(publicTrackArtistLinks({ artist: 'Uploader', source: 'youtube', audioProvider: 'youtube', artistId } as PublicTrack)[0].href).toBe('#/artist/Uploader');
  });
  it('uses persisted confirmed YTM ids after playback while local/Yandex routing stays intact', () => {
    const t = { provider: 'youtube', artist: 'Yanix, Guest', album: 'Album', origin: { metadataSource: 'ytmusic', artistId, albumId } } as Track;
    expect(trackArtistLinks(t)[0].href).toBe(`#/public/artist/${artistId}`);
    expect(trackArtistLinks(t)[1].href).toBe('#/artist/Guest');
    expect(trackAlbumHref(t)).toBe(`#/public/album/${albumId}`);
    expect(trackArtistLinks({ ...t, provider: 'local', origin: undefined })[0].href).toBe('#/artist/Yanix');
    expect(trackArtistLinks({ ...t, provider: 'yandex', catalogArtists: [{ id: '17', name: 'Yanix' }] })[0].href).toBe('#/catalog/artist/17');
  });
  it('keeps a SoundCloud profile available after the track is saved or starts playing',()=>{
    const t={provider:'soundcloud',artist:'Yanix, Guest',origin:{metadataSource:'soundcloud',artistId:'12345'}} as Track;
    expect(trackArtistLinks(t)).toEqual([{name:'Yanix',href:'#/soundcloud/artist/12345'},{name:'Guest',href:'#/artist/Guest'}]);
    expect(publicTrackArtistLinks({artist:t.artist,source:'soundcloud',audioProvider:'soundcloud',artistId:'12345'} as PublicTrack)[0].href).toBe('#/soundcloud/artist/12345');
    expect(trackArtistLinks({...t,origin:{...t.origin!,artistId:'bad-id'}})[0].href).toBe('#/artist/Yanix');
  });
});
