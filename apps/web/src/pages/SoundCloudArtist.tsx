import { ArrowClockwise, ArrowLeft, ArrowSquareOut, MagnifyingGlass, Play, SpinnerGap, X } from '@phosphor-icons/react';
import { api, type SoundCloudArtistPage as PageData } from '../lib/api.ts';
import { useCatalogResource, type CatalogCacheEntry } from '../lib/catalog-resource.ts';
import { useRoute } from '../lib/router.ts';
import { publicPlayer, usePublicPlayback } from '../store/catalog.ts';
import { Cover } from '../components/common.tsx';
import { PublicRow, asCatalog } from './Search.tsx';
import { PublicLikeAll } from './PublicCatalog.tsx';
import '../styles/catalog.css';
import '../styles/public-catalog.css';

const pageCache = new Map<string, CatalogCacheEntry<PageData>>();

export function SoundCloudArtistPage() {
  const { parts } = useRoute(), id = parts[2] ?? '';
  const prep = usePublicPlayback();
  const { data: page, error, retry } = useCatalogResource(`soundcloud:${id}`, (signal) => api.soundCloudArtist(id, signal), pageCache);
  const play = (index = 0) => { if (page) void publicPlayer.play(page.tracks.map(asCatalog), index, { type: 'artist', label: `${page.title} · SoundCloud`, id: page.id }); };
  return <div className="main-inner catalog-page public-catalog-page">
    <nav className="catalog-nav"><button className="icon-btn" aria-label="Назад" onClick={() => history.back()}><ArrowLeft size={21} /></button><a href="#/search"><MagnifyingGlass size={17} />Поиск</a><span>SoundCloud</span></nav>
    {error ? <div className="catalog-error" role="alert"><h1>Не удалось открыть страницу</h1><p>{error}</p><button className="btn btn-ghost" onClick={retry}><ArrowClockwise size={18} />Повторить</button><a href="#/search">Найти музыку</a></div>
      : !page ? <div className="catalog-skeleton" role="status"><SpinnerGap size={28} className="spin" /><p>Открываем исполнителя…</p><div className="catalog-skeleton-hero" aria-hidden="true" /></div>
        : <>
          <header className="catalog-hero">
            <Cover url={page.coverUrl} seed={page.id} round />
            <div className="catalog-hero-content"><p className="catalog-eyebrow">Исполнитель · SoundCloud</p><h1>{page.title}</h1>
              {page.description && <p className="public-catalog-description">{page.description}</p>}
              <div className="catalog-hero-actions"><button className="btn btn-primary" disabled={!page.tracks.length} onClick={() => play()}><Play size={20} weight="fill" />Слушать</button>{page.tracks.length > 0 && <PublicLikeAll tracks={page.tracks} />}<a className="btn btn-ghost" href={`https://soundcloud.com/${encodeURIComponent(page.permalink)}`} target="_blank" rel="noreferrer noopener"><ArrowSquareOut size={17} />SoundCloud</a></div>
            </div>
          </header>
          {(prep.phase !== 'idle' || prep.error) && <div className="catalog-playback-notice" role={prep.error ? 'alert' : 'status'}><span>{prep.error ?? `Готовим: ${prep.title}`}</span><button className="icon-btn" aria-label="Закрыть" onClick={() => prep.error ? publicPlayer.dismissError() : publicPlayer.cancel()}><X size={18} /></button></div>}
          <section className="catalog-section"><div className="catalog-section-heading"><h2>Треки</h2><span className="caption muted">{page.tracks.length}</span></div>
            {!page.tracks.length ? <p className="muted">У исполнителя нет доступных публичных треков.</p>
              : <div role="listbox" aria-label="Треки SoundCloud" className="search-results">{page.tracks.map((track, index) => <PublicRow key={track.externalId} t={track} id={`soundcloud-${index}`} active={false} onPlay={() => play(index)} />)}</div>}
            <p className="caption muted public-catalog-note">Показана первая подборка публичных треков исполнителя.</p>
          </section>
        </>}
  </div>;
}
