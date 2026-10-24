import { useState } from 'react';
import { Heart } from '@phosphor-icons/react';
import { api, type Track } from '../lib/api.ts';
import { likeAllSummary, likeEach, toLike } from '../lib/like-all.ts';
import { useApp } from '../store/app.ts';

/** "Like all" for a playlist, album or artist page. */
export function LikeAllButton<T>({ items, reaction, like, parallel }: { items: T[]; reaction: (item: T) => number; like: (item: T) => Promise<void>; parallel?: number }) {
  const [busy, setBusy] = useState(false);
  const pending = toLike(items, reaction);
  const run = async () => {
    setBusy(true);
    try {
      const { liked, failed } = await likeEach(pending, like, parallel);
      useApp.getState().toast(likeAllSummary(liked, failed, items.filter((item) => reaction(item) < 0).length), failed ? 'error' : 'success');
    } finally { setBusy(false); }
  };
  return (
    <button className="btn btn-ghost" disabled={busy || !pending.length} onClick={() => void run()} aria-label={pending.length ? `Лайкнуть все: ${pending.length}` : 'Всё уже в любимом'}>
      <Heart size={18} weight={pending.length ? 'regular' : 'fill'} /> {busy ? 'Добавляю в любимое…' : pending.length ? 'Лайкнуть все' : 'Всё в любимом'}
    </button>
  );
}

/** Library songs: the reaction is stored without a toast per song. */
export async function likeLibraryTrack(t: Pick<Track, 'id'>): Promise<void> {
  const result = await api.react(t.id, 1);
  useApp.getState().patchTrack(t.id, { reaction: result.value, reactionSync: result.sync });
}

export function LikeAllTracks({ tracks }: { tracks: Track[] }) {
  return <LikeAllButton items={tracks} reaction={(t) => t.reaction} like={likeLibraryTrack} />;
}
