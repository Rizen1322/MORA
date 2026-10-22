import type { ReactionValue } from './reactions.ts';

/** Metadata only. Audio is prepared separately through the provider import flow. */
export interface CatalogArtistRef {
  id: string;
  name: string;
  imageUrl?: string | null;
}

export interface CatalogArtist extends CatalogArtistRef {
  genres: string[];
  description: string | null;
  counts?: { tracks: number; albums: number };
  listeners: number | null;
}

export interface CatalogAlbum {
  id: string;
  title: string;
  imageUrl: string | null;
  artists: CatalogArtistRef[];
  year: number | null;
  type: string;
  trackCount: number | null;
  available: boolean;
}

export interface CatalogTrack {
  externalId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string | null;
  pageUrl: string | null;
  license: string | null;
  playable: boolean;
  libraryTrackId: string | null;
  artists: CatalogArtistRef[];
  albumId: string | null;
  explicit: boolean;
  position?: number;
  disc?: number;
  reaction?: ReactionValue;
}

export type CatalogSearchType = 'all' | 'track' | 'artist' | 'album';

export interface CatalogSearchResult {
  query: string;
  best: { type: 'track' | 'artist' | 'album'; id: string } | null;
  tracks: CatalogTrack[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  page: number;
  hasMore: { tracks: boolean; artists: boolean; albums: boolean };
}

export interface CatalogArtistPage {
  artist: CatalogArtist;
  popularTracks: CatalogTrack[];
  albums: CatalogAlbum[];
  similarArtists: CatalogArtist[];
  page: number;
  hasMoreAlbums: boolean;
}

export interface CatalogAlbumPage {
  album: CatalogAlbum;
  tracks: CatalogTrack[];
  description: string | null;
}
