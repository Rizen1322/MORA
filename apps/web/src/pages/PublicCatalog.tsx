import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowClockwise, MagnifyingGlass, Play, SpinnerGap, X } from '@phosphor-icons/react';
import { api, type PublicCatalogPage as PageData, type PublicTrack } from '../lib/api.ts';
import { useApp } from '../store/app.ts';
import { LikeAllButton, likeLibraryTrack } from '../components/LikeAll.tsx';
import { publicAlbumHref, publicArtistHref, useRoute } from '../lib/router.ts';
import { publicPlayer, usePublicPlayback } from '../store/catalog.ts';
import { Cover } from '../components/common.tsx';
import { PublicRow, asCatalog } from './Search.tsx';
import '../styles/catalog.css';
import '../styles/public-catalog.css';

/** "Like all" for YouTube Music and SoundCloud: a like belongs to a library song, so each one is
 * prepared (downloaded) first, two at a time to keep the phone cool. */
export function PublicLikeAll({ tracks }: { tracks: PublicTrack[] }) {
  const library = useApp((s) => s.tracks);
  const known = (t: PublicTrack) => publicPlayer.known(asCatalog(t));
  const items = tracks.filter((t) => t.playable || known(t));
  const reaction = (t: PublicTrack) => { const id = known(t); return id ? library.get(id)?.reaction ?? 0 : 0; };
  return <LikeAllButton items={items} reaction={reaction} parallel={2} like={async (t) => likeLibraryTrack({ id: await publicPlayer.ensure(asCatalog(t)) })} />;
}

export function PublicCatalogPage() {
  const { parts } = useRoute(), kind = parts[1], id = parts[2] ?? '';
  const [state, setState] = useState<{ key: string; data?: PageData; error?: string }>({ key: '' });
  const [attempt, setAttempt] = useState(0), prep = usePublicPlayback();
  const key = `${kind}:${id}`, valid = kind === 'artist' || kind === 'album';
  useEffect(() => {
    if (!valid) return;
    const ctl = new AbortController();
    setState({ key });
    void api.publicCatalog(kind, id, ctl.signal).then(data => { if (!ctl.signal.aborted) setState({ key, data }); })
      .catch(e => { if (!ctl.signal.aborted) setState({ key, error: (e as Error).message }); });
    return () => ctl.abort();
  }, [key, attempt, valid, kind, id]);
  const page = state.key === key ? state.data : undefined, error = state.key === key ? state.error : undefined;
  const play = (index = 0) => { if (page) void publicPlayer.play(page.tracks.map(asCatalog), index, { type: page.type, label: `${page.title} · YouTube Music`, id: page.id }); };
  return <div className="main-inner catalog-page public-catalog-page">
    <nav className="catalog-nav"><button className="icon-btn" aria-label="Назад" onClick={() => history.back()}><ArrowLeft size={21} /></button><a href="#/search"><MagnifyingGlass size={17} />Поиск</a><span>YouTube Music</span></nav>
    {!valid || error ? <div className="catalog-error" role="alert"><h1>Не удалось открыть страницу</h1><p>{error ?? 'Неизвестный раздел каталога'}</p>{valid && <button className="btn btn-ghost" onClick={() => setAttempt(x => x + 1)}><ArrowClockwise size={18} />Повторить</button>}<a href="#/search">Найти музыку</a></div>
      : !page ? <div className="catalog-skeleton" role="status"><SpinnerGap size={28} className="spin" /><p>Открываем {kind === 'artist' ? 'исполнителя' : 'альбом'}…</p><div className="catalog-skeleton-hero" aria-hidden="true" /></div>
        : <>
          <header className="catalog-hero">
            <Cover url={page.coverUrl} seed={id} round={page.type === 'artist'} />
            <div className="catalog-hero-content"><p className="catalog-eyebrow">{page.type === 'artist' ? 'Исполнитель' : 'Альбом'} · YouTube Music</p><h1>{page.title}</h1>
              {page.type === 'album' && <p className="public-catalog-credits">{page.artists.map((artist, index) => <span key={artist.id}>{index > 0 && ', '}<a href={publicArtistHref(artist.id)}>{artist.name}</a></span>)}</p>}
              {page.description && <p className="public-catalog-description">{page.description}</p>}
              <div className="catalog-hero-actions"><button className="btn btn-primary" disabled={!page.tracks.length} onClick={() => play()}><Play size={20} weight="fill" />Слушать</button>{page.tracks.length > 0 && <PublicLikeAll tracks={page.tracks} />}<a className="btn btn-ghost" href={`#/search?${new URLSearchParams({ q: page.title, src: 'ytmusic' })}`}>Искать ещё</a></div>
            </div>
          </header>
          {(prep.phase !== 'idle' || prep.error) && <div className="catalog-playback-notice" role={prep.error ? 'alert' : 'status'}><span>{prep.error ?? `Готовим: ${prep.title}`}</span><button className="icon-btn" aria-label="Закрыть" onClick={() => prep.error ? publicPlayer.dismissError() : publicPlayer.cancel()}><X size={18} /></button></div>}
          <section className="catalog-section"><div className="catalog-section-heading"><h2>{page.type === 'artist' ? 'Популярное' : 'Треки'}</h2><span className="caption muted">{page.tracks.length} треков</span></div>
            {!page.tracks.length ? <p className="muted">У источника пока нет доступных треков на этой странице.</p>
              : <div role="listbox" aria-label="Треки" className="search-results">{page.tracks.map((track, index) => <PublicRow key={`${track.externalId}:${index}`} t={track} id={`public-${index}`} active={false} onPlay={() => play(index)} />)}</div>}
            {page.limited && <p className="caption muted public-catalog-note">Показана подборка источника. Полную дискографию можно найти через альбомы или поиск.</p>}
          </section>
          {!!page.albums.length && <section className="catalog-section"><div className="catalog-section-heading"><h2>{page.type === 'artist' ? 'Альбомы и синглы' : 'Другие релизы'}</h2></div><div className="catalog-card-grid">{page.albums.map(album => <a className="catalog-card" key={album.id} href={publicAlbumHref(album.id)}><Cover url={album.coverUrl} seed={album.id} /><h3>{album.title}</h3><p>{album.artist}</p></a>)}</div></section>}
        </>}
  </div>;
}
