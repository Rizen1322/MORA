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
import { controller, trackOf, useApp } from './store/app.ts';
import { desktop } from './lib/desktop.ts';
import { playSplash, splashEnabled } from './lib/splash.ts';

// handle for debugging from the browser console: automix.state
(window as unknown as { automix: typeof controller }).automix = controller;

if (desktop) {
  document.documentElement.classList.add('desktop');
  desktop.onCompact((on) => document.documentElement.classList.toggle('compact', on));
  let updateNotice = '';
  desktop.onAppUpdate?.((state) => {
    if (state.phase !== 'available' && state.phase !== 'downloaded') return;
    const key = `${state.phase}:${state.version}`;
    if (key === updateNotice) return;
    updateNotice = key;
    useApp.getState().toast(state.phase === 'downloaded'
      ? `MORA ${state.version} готова к установке. Откройте настройки приложения, когда закончите слушать.`
      : `Доступна MORA ${state.version}. Обновление — в настройках приложения.`);
  });
  // Tray, taskbar and sleep commands go to the one existing controller.
  desktop.onCommand((cmd) => {
    if (cmd === 'toggle') controller.toggle();
    else if (cmd === 'play') { if (controller.state.status === 'paused') controller.resume(); }
    else if (cmd === 'pause') { if (controller.state.status !== 'idle' && controller.state.status !== 'paused') controller.pause(); }
    else if (cmd === 'next') void controller.nextTrack();
    else void controller.prevTrack();
  });
  desktop.onSeek?.((position) => controller.seek(position));
  let last = '';
  controller.subscribe((s) => {
    const t = trackOf(s.queue[s.index]?.trackId);
    const report = { playing: s.status === 'playing' || s.status === 'buffering', title: t?.title ?? '', artist: t?.artist ?? '' };
    const key = JSON.stringify(report);
    if (key !== last) { last = key; desktop!.reportPlayer(report); }
  });
}

// Launch intro on the desktop app; `?splash` shows it in a browser too.
if ((desktop && splashEnabled()) || new URLSearchParams(location.search).has('splash')) {
  let fonts = false;
  void document.fonts.ready.then(() => { fonts = true; });
  playSplash({
    ready: () => fonts && (useApp.getState().loaded || !useApp.getState().serverOnline),
    target: () => document.querySelector('.wave-hero-title span'),
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
