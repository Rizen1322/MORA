import type { Track } from './api.ts';

export interface ArtistCredit { name: string; catalogId?: string }

/** Structured credits are authoritative: commas may be part of an artist name. */
export function trackArtists(track: Pick<Track, 'artist' | 'provider' | 'catalogArtists'>): ArtistCredit[] {
  const structured = track.catalogArtists?.filter(a => a.name.trim());
  const credits: ArtistCredit[] = structured?.length
    ? structured.map(a => ({ name: a.name.trim(), catalogId: track.provider === 'yandex' && a.id ? a.id : undefined }))
    : track.artist.split(/\s*[,;]\s*|\s+(?:feat\.?|ft\.?)\s+/i).map(name => ({ name: name.trim() }));
  const seen = new Set<string>();
  return credits.filter(a => {
    const key = a.catalogId ? `id:${a.catalogId}` : `name:${a.name.toLocaleLowerCase()}`;
    if (!a.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasTrackArtist(track: Pick<Track, 'artist' | 'provider' | 'catalogArtists'>, name: string): boolean {
  return (track.artist || 'Неизвестный исполнитель') === name || trackArtists(track).some(a => a.name === name);
}
