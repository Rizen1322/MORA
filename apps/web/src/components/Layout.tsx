import { useEffect, useState } from 'react';
import { House, Waveform, Books, Heart, ClockCounterClockwise, Plugs, GearSix, Plus, MagnifyingGlass, DotsThreeCircle, X, CheckCircle, WarningCircle, Info, ChartLine, CaretLeft, CaretRight, DownloadSimple } from '@phosphor-icons/react';
import { api } from '../lib/api.ts';
import { filesFromDrop, importFiles } from '../lib/importer.ts';
import { useRoute } from '../lib/router.ts';
import { desktop } from '../lib/desktop.ts';
import { CompactToggle } from './Player.tsx';
import { useApp } from '../store/app.ts';
import { Cover, PromptModal } from './common.tsx';

function active(path: string, prefix: string, exact = false): 'page' | undefined {
  if (exact) return path === prefix ? 'page' : undefined;
  return path === prefix || path.startsWith(`${prefix}/`) ? 'page' : undefined;
}

export function Sidebar() {
  const { path } = useRoute();
  const playlists = useApp((s) => s.playlists);
  const contextType = useApp((s) => s.player.context?.type);
  const [creating, setCreating] = useState(false);
  const waveOn = contextType === 'wave' || contextType === 'yandex-wave';
  return (
    <nav className="sidebar" aria-label="Разделы">
      <a className="brand" href="#/" aria-label="MORA — главная">
        <img className="brand-logo" src="/logo-mark.png" alt="" aria-hidden="true" />
        <span>MORA</span>
      </a>
      <div className="nav nav-primary">
        <a href="#/" aria-current={active(path, '/', true)}>
          <House size={22} weight={path === '/' ? 'fill' : 'regular'} />
          <span className="label-text">Главная</span>
        </a>
        <a href="#/search" aria-current={path.startsWith('/search') || path.startsWith('/catalog') || path.startsWith('/yandex') ? 'page' : undefined}>
          <MagnifyingGlass size={22} /><span className="label-text">Поиск</span>
        </a>
        <a href="#/wave" aria-current={active(path, '/wave')}>
          <Waveform size={22} weight={path === '/wave' ? 'fill' : 'regular'} />
          <span className="label-text">Моя волна</span>
          {waveOn && <span className="wave-dot" aria-label="играет" />}
        </a>
      </div>
      <div className="nav-group-label">Ваша музыка</div>
      <div className="nav nav-library">
        <a href="#/library" aria-current={active(path, '/library')}>
          <Books size={22} weight={path.startsWith('/library') ? 'fill' : 'regular'} />
          <span className="label-text">Медиатека</span>
        </a>
        <a href="#/liked" aria-current={active(path, '/liked')}>
          <Heart size={22} weight={path === '/liked' ? 'fill' : 'regular'} />
          <span className="label-text">Любимое</span>
        </a>
        <a href="#/downloads" aria-current={active(path, '/downloads')}>
          <DownloadSimple size={22} />
          <span className="label-text">Загрузки</span>
        </a>
        <a href="#/history" aria-current={active(path, '/history')}>
          <ClockCounterClockwise size={22} />
          <span className="label-text">История</span>
        </a>
      </div>
      <div className="side-section">
        <div className="side-head">
          <span>Плейлисты</span>
          <span style={{ display: 'flex' }}>
            <a className="icon-btn" href="#/import" aria-label="Импорт плейлиста" title="Импорт из Spotify, Apple Music, YouTube, файла"><DownloadSimple size={17} style={{ transform: 'rotate(180deg)' }} /></a>
            <button className="icon-btn" aria-label="Создать плейлист" onClick={() => setCreating(true)}>
              <Plus size={18} />
            </button>
          </span>
        </div>
        <div className="side-list">
          {playlists.length === 0 && <p className="caption dim" style={{ padding: '0 6px' }}>Создайте первый плейлист: кнопка «+» или меню трека.</p>}
          {playlists.map((p) => (
            <a key={p.id} className="side-item" href={`#/playlist/${p.id}`} aria-current={path === `/playlist/${p.id}` ? 'page' : undefined}>
              <Cover url={p.coverUrl} seed={p.id} size={40} />
              <span style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 600, color: 'var(--text)' }}>
                  {p.name}
                </div>
                <div className="meta">Плейлист · {p.count}</div>
              </span>
            </a>
          ))}
        </div>
      </div>
      <div className="nav nav-utility" aria-label="Приложение">
        <a href="#/sources" aria-current={active(path, '/sources')}><Plugs size={20} weight={path === '/sources' ? 'fill' : 'regular'} /><span className="label-text">Источники</span></a>
        <a href="#/diagnostics" aria-current={active(path, '/diagnostics')}><ChartLine size={20} /><span className="label-text">Диагностика</span></a>
        <a href="#/settings" aria-current={active(path, '/settings')}><GearSix size={20} weight={path === '/settings' ? 'fill' : 'regular'} /><span className="label-text">Настройки</span></a>
      </div>
      {creating && (
        <PromptModal
          title="Новый плейлист"
          label="Название"
          confirm="Создать"
          onSubmit={async (name) => {
            const r = await api.createPlaylist(name);
            await useApp.getState().loadPlaylists();
            location.hash = `/playlist/${r.id}`;
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </nav>
  );
}

/** Integrated Windows title bar: drag area, in-app history and search. Native caption buttons sit on the right (titleBarOverlay). */
export function TitleBar() {
  useRoute(); // re-render on navigation so back/forward availability stays current
  if (!desktop) return null;
  const nav = (window as unknown as { navigation?: { canGoBack: boolean; canGoForward: boolean } }).navigation;
  return (
    <header className="titlebar">
      <button className="icon-btn" aria-label="Назад" title="Назад (Alt + ←)" disabled={nav ? !nav.canGoBack : false} onClick={() => history.back()}>
        <CaretLeft size={16} weight="bold" />
      </button>
      <button className="icon-btn" aria-label="Вперёд" title="Вперёд (Alt + →)" disabled={nav ? !nav.canGoForward : false} onClick={() => history.forward()}>
        <CaretRight size={16} weight="bold" />
      </button>
      <span className="compact-only titlebar-compact"><CompactToggle /></span>
      <button className="titlebar-search" onClick={() => (location.hash = '/search')}>
        <MagnifyingGlass size={15} aria-hidden="true" />
        <span>Поиск музыки</span>
        <kbd>/</kbd>
      </button>
    </header>
  );
}

export function TabBar() {
  const { path } = useRoute();
  const items = [
    { href: '#/', label: 'Главная', Icon: House, on: path === '/' },
    { href: '#/wave', label: 'Волна', Icon: Waveform, on: path === '/wave' },
    { href: '#/library', label: 'Медиатека', Icon: Books, on: (path.startsWith('/library') && path !== '/library/search') || path.startsWith('/playlist') || path.startsWith('/album') || path.startsWith('/artist') },
    { href: '#/search', label: 'Поиск', Icon: MagnifyingGlass, on: path === '/library/search' || path === '/search' || path.startsWith('/catalog') },
    { href: '#/more', label: 'Ещё', Icon: DotsThreeCircle, on: ['/more', '/settings', '/sources', '/history', '/liked', '/diagnostics'].includes(path) },
  ];
  return (
    <nav className="tabbar" aria-label="Разделы">
      {items.map(({ href, label, Icon, on }) => (
        <a key={href} href={href} aria-current={on ? 'page' : undefined}>
          <Icon size={24} weight={on ? 'fill' : 'regular'} />
          {label}
        </a>
      ))}
    </nav>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <WarningCircle size={18} color="var(--danger)" /> : t.kind === 'success' ? <CheckCircle size={18} color="var(--ok)" /> : <Info size={18} />}
          <span style={{ flex: 1 }}>{t.text}</span>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label="Закрыть уведомление" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function UploadCard() {
  const u = useApp((s) => s.upload);
  const set = useApp((s) => s.setUpload);
  const [open, setOpen] = useState(false);
  if (!u) return null;
  const pct = u.total ? (u.done / u.total) * 100 : 0;
  return (
    <div className="upload-card" role="status" aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{u.active ? `Импорт: ${u.done} из ${u.total}` : `Импорт завершён: ${u.total - u.failed.length} из ${u.total}`}</strong>
        {!u.active && (
          <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Скрыть" onClick={() => set(null)}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
      {u.current && <div className="caption dim ellipsis" style={{ marginTop: 6 }}>{u.current}</div>}
      {!u.active && <div className="caption dim" style={{ marginTop: 6 }}>Анализ звука продолжается в фоне. Слушать можно уже сейчас.</div>}
      {u.failed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="small" style={{ color: 'var(--danger)', fontWeight: 600 }} onClick={() => setOpen(!open)}>
            Не удалось добавить: {u.failed.length} {open ? '▴' : '▾'}
          </button>
          {open && (
            <ul className="caption" style={{ margin: '6px 0 0', paddingLeft: 16, maxHeight: 140, overflow: 'auto' }}>
              {u.failed.map((f, i) => (
                <li key={i}>
                  <span style={{ fontWeight: 600 }}>{f.name}</span>: <span className="muted">{f.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Window-wide drag-and-drop of files and folders. */
export function DropTarget() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = await filesFromDrop(e.dataTransfer!);
      void importFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!over) return null;
  return (
    <div className="drop-overlay">
      <div className="drop-box">
        <Waveform size={40} color="var(--accent-soft)" />
        <h2>Отпустите, чтобы добавить</h2>
        <p className="muted">Файлы и папки целиком. MP3, FLAC, WAV, OGG, Opus, M4A и другие.</p>
      </div>
    </div>
  );
}
