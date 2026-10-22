import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {WordLyricLine} from '../src/components/WordLyricLine.tsx';
it('highlights only the timed word and leaves actual pauses unhighlighted',()=>{
  const line={t:1,text:'Hello world',words:[{t:1,end:1.3,text:'Hello '},{t:1.5,end:1.8,text:'world'}]};
  const render=(now:number)=>renderToStaticMarkup(createElement(WordLyricLine,{line,index:0,now,active:true,past:false,onSeek:()=>{}}));
  expect(render(1.1)).toContain('class="lyrics-word now">Hello ');
  expect(render(1.4)).not.toContain('lyrics-word now');
  expect(render(1.6)).toContain('class="lyrics-word now">world');
});
