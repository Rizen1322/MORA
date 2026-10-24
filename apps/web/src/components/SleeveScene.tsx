import { Heart, MusicNotes } from '@phosphor-icons/react';
import { Cover } from './common.tsx';
import type { Track } from '../lib/api.ts';

/** CSS 3D record sleeves: actual collection artwork, no extra WebGL context. */
export function SleeveScene({ tracks = [], liked = false }: { tracks?: Track[]; liked?: boolean }) {
  return <div className={`sleeve-scene ${liked ? 'sleeve-liked' : ''}`} aria-hidden="true">
    <div className="sleeve-disc"><span /><i /></div>
    <div className="sleeve-stack">
      <div className="sleeve-back" />
      <div className="sleeve-mid" />
      <div className="sleeve-front">
        {liked ? <Heart weight="fill" /> : tracks[0] ? <Cover url={tracks[0].coverUrl} seed={tracks[0].album || tracks[0].id} /> : <MusicNotes weight="duotone" />}
        <span className="sleeve-shine" />
      </div>
    </div>
  </div>;
}
