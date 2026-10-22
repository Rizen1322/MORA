import { useEffect, useLayoutEffect, useState } from 'react';
import type { PublicTrack, Track } from './api.ts';
import { trackArtists } from './artists.ts';

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  const path = p.startsWith('/') ? p : `/${p}`;
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => {
      setR(parse());
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const routeKey = `${r.path}?${r.query.toString()}`;
  useLayoutEffect(() => {
    // Reset after React has committed the new page. Resetting in hashchange
    // scrolls the previous page and lets scroll anchoring undo the position.
    const main = document.querySelector<HTMLElement>('.main');
    main?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [routeKey]);
  return r;
}

export function go(path: string): void {
  location.hash = path;
}

export const href = (path: string) => `#${path}`;
export const albumHref = (artist: string, album: string) => `#/album/${encodeURIComponent(artist || '—')}/${encodeURIComponent(album)}`;
export const artistHref = (artist: string) => `#/artist/${encodeURIComponent(artist)}`;
export const catalogArtistHref = (id: string) => `#/catalog/artist/${encodeURIComponent(id)}`;
export const catalogAlbumHref = (id: string) => `#/catalog/album/${encodeURIComponent(id)}`;
export const publicArtistHref = (id: string) => `#/public/artist/${encodeURIComponent(id)}`;
export const publicAlbumHref = (id: string) => `#/public/album/${encodeURIComponent(id)}`;
export const soundCloudArtistHref = (id: string) => `#/soundcloud/artist/${encodeURIComponent(id)}`;
export const publicTrackArtistLinks = (track: PublicTrack) => trackArtists({ artist: track.artist, provider: track.audioProvider }).map((artist, i) => ({
  name: artist.name,
  href: i === 0 && track.source === 'ytmusic' && /^UC[\w-]{22}$/.test(track.artistId ?? '') ? publicArtistHref(track.artistId!)
    : i === 0 && track.source === 'soundcloud' && /^\d{1,20}$/.test(track.artistId ?? '') ? soundCloudArtistHref(track.artistId!) : artistHref(artist.name),
}));
export const searchHref = (q = '', type = 'all') => `#/yandex${q ? `?${new URLSearchParams({ q, type })}` : ''}`;
export const trackArtistLinks = (track: Track) => trackArtists(track).map((a, i) => ({
  name: a.name,
  href: a.catalogId ? catalogArtistHref(a.catalogId) : track.provider === 'yandex' ? searchHref(a.name, 'artist')
    : i === 0 && track.origin?.metadataSource === 'ytmusic' && /^UC[\w-]{22}$/.test(track.origin.artistId ?? '') ? publicArtistHref(track.origin.artistId!)
    : i === 0 && track.provider === 'soundcloud' && /^\d{1,20}$/.test(track.origin?.artistId ?? '') ? soundCloudArtistHref(track.origin!.artistId!) : artistHref(a.name),
}));
export const trackArtistHref = (track: Track) => trackArtistLinks(track)[0]?.href ?? artistHref(track.artist);
export const trackAlbumHref = (track: Track) => track.provider === 'yandex'
  ? track.catalogAlbumId ? catalogAlbumHref(track.catalogAlbumId) : searchHref(`${track.artist} ${track.album}`, 'album')
  : track.origin?.metadataSource === 'ytmusic' && /^MPRE[\w-]{6,80}$/.test(track.origin.albumId ?? '') ? publicAlbumHref(track.origin.albumId!) : albumHref(track.albumArtist || track.artist, track.album);
