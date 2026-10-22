import { useEffect, useState } from 'react';
import { WifiSlash } from '@phosphor-icons/react';
import { useRoute } from './lib/router.ts';
import { connectEvents, controller, trackOf, useApp } from './store/app.ts';
import { DropTarget, Sidebar, TabBar, TitleBar, Toasts, UploadCard } from './components/Layout.tsx';
import { desktop } from './lib/desktop.ts';
import { FullPlayer, MiniPlayer, PlayerBar } from './components/Player.tsx';
import { QueuePanel } from './components/QueuePanel.tsx';
import { react } from './components/TrackList.tsx';
import { HomePage } from './pages/Home.tsx';
import { WavePage } from './pages/Wave.tsx';
import { AlbumPage, ArtistPage, LibraryPage } from './pages/Library.tsx';
import { HistoryPage, LikedPage, PlaylistPage } from './pages/Collections.tsx';
import { SourcesPage } from './pages/Sources.tsx';
import { MorePage, SettingsPage } from './pages/Settings.tsx';
import { DiagnosticsPage } from './pages/Diagnostics.tsx';
import { YandexSearchPage, CatalogArtistPage, CatalogAlbumPage, CatalogPlaybackNotice } from './pages/Catalog.tsx';
import { SearchPage } from './pages/Search.tsx';
import { PublicCatalogPage } from './pages/PublicCatalog.tsx';
import { SoundCloudArtistPage } from './pages/SoundCloudArtist.tsx';
import { DownloadsPage } from './pages/Downloads.tsx';
import { ImportPage } from './pages/Import.tsx';
import { VersionPanel } from './components/VersionPanel.tsx';
import { SoundPanel } from './components/SoundPanel.tsx';
import { LyricsPanel } from './components/LyricsPanel.tsx';

function Page() {
  const { parts } = useRoute();
  switch (parts[0]) {
    case undefined:
      return <HomePage />;
    case 'wave':
      return <WavePage />;
    case 'search':
      return <SearchPage />;
    case 'yandex':
      return <YandexSearchPage />;
    case 'downloads':
      return <DownloadsPage />;
    case 'import':
      return <ImportPage />;
    case 'catalog':
      return parts[1] === 'artist' ? <CatalogArtistPage /> : <CatalogAlbumPage />;
    case 'public':
      return <PublicCatalogPage />;
    case 'soundcloud':
      return <SoundCloudArtistPage />;
    case 'library':
      return <LibraryPage />;
    case 'album':
      return <AlbumPage />;
    case 'artist':
      return <ArtistPage />;
    case 'playlist':
      return <PlaylistPage />;
    case 'liked':
      return <LikedPage />;
    case 'history':
      return <HistoryPage />;
    case 'sources':
      return <SourcesPage />;
    case 'settings':
      return <SettingsPage />;
    case 'diagnostics':
      return <DiagnosticsPage />;
    case 'more':
      return <MorePage />;
    default:
      return (
        <div className="main-inner">
          <h1 className="page-title">Страница не найдена</h1>
          <a className="btn btn-primary" href="#/">
            На главную
          </a>
        </div>
      );
  }
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.defaultPrevented || el.closest('[role="menu"], [role="dialog"]')) return;
      if (el.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey) return;
      if (el.closest('[role="slider"]') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') history.back();
        else history.forward();
        return;
      }
      const p = controller.state;
      switch (e.key) {
        case ' ':
          if (el.closest('button, a')) return;
          e.preventDefault();
          controller.toggle();
          break;
        case 'ArrowRight':
          if (e.shiftKey) void controller.nextTrack();
          else controller.seek(p.position + 5);
          break;
        case 'ArrowLeft':
          if (e.shiftKey) void controller.prevTrack();
          else controller.seek(p.position - 5);
          break;
        case 'ArrowUp':
          if (e.altKey) return;
          e.preventDefault();
          controller.setVolume(p.volume + 0.05);
          break;
        case 'ArrowDown':
          if (e.altKey) return;
          e.preventDefault();
          controller.setVolume(p.volume - 0.05);
          break;
        case 'm':
        case 'M':
        case 'ь':
          controller.toggleMute();
          break;
        case 'l':
        case 'L':
        case 'д': {
          const t = trackOf(p.queue[p.index]?.trackId);
          if (t) void react(t, t.reaction > 0 ? 0 : 1);
          break;
        }
        case 'q':
        case 'Q':
        case 'й':
          useApp.getState().setQueueOpen(!useApp.getState().queueOpen);
          break;
        case 'f':
        case 'F':
        case 'а':
          useApp.getState().setFullPlayer(!useApp.getState().fullPlayer);
          break;
        case '/':
          e.preventDefault();
          location.hash = '/search';
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Connection banner. The desktop shell restarts its service itself; offer a manual retry only after that fails. */
function OfflineNotice() {
  const [backend, setBackend] = useState<string>('ready');
  useEffect(() => desktop?.onBackend(setBackend), []);
  if (!desktop) {
    return (
      <div className="toast error" role="alert" style={{ margin: '16px 32px 0' }}>
        <WifiSlash size={18} /> Нет связи с локальным сервером MORA. Запустите его командой «npm start» и обновите страницу.
      </div>
    );
  }
  const failed = backend === 'failed';
  return (
    <div className="toast error" role="alert" style={{ margin: '16px 32px 0' }}>
      <WifiSlash size={18} />
      <span style={{ flex: 1 }}>{backend === 'importing' ? 'Импортируем медиатеку…' : failed ? 'Медиатека недоступна.' : 'Нет подключения к медиатеке. Восстанавливаем…'}</span>
      {failed && <button className="btn btn-secondary btn-sm" onClick={() => void desktop!.restartBackend()}>Продолжить</button>}
    </div>
  );
}

export function App() {
  const motion = useApp((s) => s.settings?.ui.motion ?? (desktop ? 'full' : 'system'));
  useEffect(() => { document.documentElement.dataset.motion = motion; }, [motion]);
  const queueOpen = useApp((s) => s.queueOpen);
  const panel = useApp((s) => s.panel);
  const full = useApp((s) => s.fullPlayer);
  const online = useApp((s) => s.serverOnline);
  useShortcuts();
  useEffect(() => {
    const st = useApp.getState();
    void (async () => {
      await Promise.all([st.loadLibrary(), st.loadPlaylists(), st.loadSettings(), st.loadProviders()]);
      await controller.restore();
    })();
    return connectEvents();
  }, []);
  return (
    <div className="app">
      <TitleBar />
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Перейти к музыке</a>
      <Sidebar />
      <main className="main" id="main" tabIndex={-1}>
        {!online && <OfflineNotice />}
        <CatalogPlaybackNotice />
        <Page />
      </main>
      {queueOpen && <QueuePanel />}
      {panel === 'sound' && <SoundPanel />}
      {panel === 'lyrics' && <LyricsPanel />}
      <PlayerBar />
      <MiniPlayer />
      <TabBar />
      {full && <FullPlayer />}
      <VersionPanel />
      <Toasts />
      <UploadCard />
      <DropTarget />
    </div>
  );
}
