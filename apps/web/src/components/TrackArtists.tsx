import { Fragment } from 'react';
import type { Track } from '../lib/api.ts';
import { trackArtistLinks } from '../lib/router.ts';

export function TrackArtists({ track, className, onNavigate }: { track: Track; className?: string; onNavigate?: () => void }) {
  const artists = trackArtistLinks(track);
  if (!artists.length) return <>Неизвестный исполнитель</>;
  return <>{artists.map(a => <Fragment key={a.href}><a className={className} href={a.href} onClick={onNavigate}>{a.name}</a>{a !== artists[artists.length - 1] && ', '}</Fragment>)}</>;
}
