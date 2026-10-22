import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/onest';
import '@fontsource-variable/unbounded';
import './styles/app.css';
import './styles/music-studio.css';
import './styles/home-focus.css';
import './styles/desktop.css';
import './styles/search.css';
import './styles/listening.css';
import { App } from './App.tsx';
import { controller, trackOf } from './store/app.ts';
import { desktop } from './lib/desktop.ts';

// handle for debugging from the browser console: automix.state
(window as unknown as { automix: typeof controller }).automix = controller;

if (desktop) {
  document.documentElement.classList.add('desktop');
  desktop.onCompact((on) => document.documentElement.classList.toggle('compact', on));
  // Tray, taskbar and sleep commands go to the one existing controller.
  desktop.onCommand((cmd) => {
    if (cmd === 'toggle') controller.toggle();
    else if (cmd === 'pause') { if (controller.state.status !== 'idle' && controller.state.status !== 'paused') controller.pause(); }
    else if (cmd === 'next') void controller.nextTrack();
    else void controller.prevTrack();
  });
  let last = '';
  controller.subscribe((s) => {
    const t = trackOf(s.queue[s.index]?.trackId);
    const report = { playing: s.status === 'playing' || s.status === 'buffering', title: t?.title ?? '', artist: t?.artist ?? '' };
    const key = JSON.stringify(report);
    if (key !== last) { last = key; desktop!.reportPlayer(report); }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
