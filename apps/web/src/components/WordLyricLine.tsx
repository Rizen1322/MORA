import {memo} from 'react';
import type {Lyrics} from '../lib/api.ts';

/** Inactive lines receive a constant clock so playback ticks only redraw current words. */
export const WordLyricLine=memo(function WordLyricLine({line,index,now,active,past,onSeek}:{
  line:NonNullable<Lyrics['wordLines']>[number];index:number;now:number;active:boolean;past:boolean;onSeek:(time:number)=>void;
}){
  return <button data-line={index} className={`lyrics-line ${active?'now':past?'past':''}`}
    aria-current={active?'true':undefined} onClick={()=>onSeek(line.t)}>
    {line.words.map((word,i)=><span key={i} className={`lyrics-word ${now>=word.t&&now<word.end?'now':now>=word.end?'past':''}`}>{word.text}</span>)}
  </button>;
});
