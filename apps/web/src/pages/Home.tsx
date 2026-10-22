import { TrackArtists } from '../components/TrackArtists.tsx';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useState } from 'react';
import { useDragScroll } from '../lib/dragScroll.ts';
import { startRadio, useRadio } from '../lib/radio.ts';
import { RadioTuning } from '../components/RadioTuning.tsx';
import { ArrowUpRight, Heart, MagnifyingGlass, Play, Pause, Waveform, Stack, Books } from '@phosphor-icons/react';
import type { Track } from '../lib/api.ts';
import { albumHref } from '../lib/router.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { Cover, Swap } from '../components/common.tsx';
import { fmtTime, tracksWord } from '../lib/format.ts';
import { ImportActions } from '../components/ImportActions.tsx';
import { WaveSculpture } from '../components/WaveSculpture.tsx';
import { YandexWaveTuning } from '../components/YandexWaveTuning.tsx';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

export function TrackCard({ t, list, index, label }: { t: Track; list: Track[]; index: number; label: string }) {
  return (
    <div className="card">
      <button className="art-wrap" aria-label={`Играть: ${t.title}`} onClick={() => void controller.playTracks(list.map((x) => x.id), index, { type: 'library', label })}>
        <Cover url={t.coverUrl} seed={t.album || t.id} alt="" />
        <span className="play-circle" aria-hidden="true">
          <Play size={20} weight="fill" />
        </span>
      </button>
      <div style={{ minWidth: 0 }}>
        <div className="card-title ellipsis">{t.title}</div>
        <div className="card-sub ellipsis"><TrackArtists track={t} /></div>
      </div>
    </div>
  );
}

export function Rail({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  const rail = useDragScroll<HTMLDivElement>();
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {href && <a href={href}>Показать все</a>}
      </div>
      <div className="rail" ref={rail}>{children}</div>
    </section>
  );
}

export function WaveHero() {
  const radio = useRadio();
  const p = useApp(useShallow((s) => ({ context: s.player.context, status: s.player.status, waveLoading: s.player.waveLoading, error: s.player.error })));
  const tracks = useApp((s) => s.order.length);
  const providers = useApp((s) => s.providers);
  const connected = providers.some((v) => v.id === 'yandex' && v.status === 'connected');
  const [source, setSource] = useState<'own' | 'yandex' | 'online'>(p.context?.type === 'yandex-wave' ? 'yandex' : tracks ? 'own' : 'online');
  const [tuning, setTuning] = useState(false);
  useEffect(() => {
    if (radio.active || p.context?.type === 'online-radio') setSource('online');
    else if (p.context?.type === 'yandex-wave') setSource('yandex');
    else if (p.context?.type === 'wave') setSource('own');
    else if (connected) setSource('yandex');
    else if (!tracks) setSource('online');
  }, [connected, p.context?.type, tracks, radio.active]);
  // Personal radio uses distinct liked artists; an empty profile starts with search.
  const startOnline = () => {
    void startRadio();
  };
  const waveOn = p.context?.type === 'wave' || p.context?.type === 'yandex-wave';
  const selectedActive = source === 'online' ? radio.active : waveOn && (p.context?.type === 'yandex-wave' ? 'yandex' : 'own') === source;
  const playing = selectedActive && (p.status === 'playing' || p.status === 'buffering');
  return (
    <section className="wave-hero" aria-label="Моя волна">
      <div className="home-wave-object"><WaveSculpture energy={0.5} /></div>
      <div className="wave-hero-copy">
        <h2 className="wave-hero-title">Моя волна<span>.</span></h2>
        <p>Знакомое, любимое и то, что ещё предстоит открыть.</p>
        <div className="home-wave-source" role="group" aria-label="Источник волны">
          <button aria-pressed={source === 'own'} onClick={() => { setSource('own'); setTuning(false); }}>Моя коллекция</button>
          <button aria-pressed={source === 'online'} onClick={() => { setSource('online'); setTuning(false); }} title="Радио YouTube Music без аккаунта">Онлайн-радио</button>
          {connected && <button aria-pressed={source === 'yandex'} onClick={() => setSource('yandex')}>Яндекс Музыка</button>}
        </div>
        <div className="hero-actions">
          {source === 'online' ? (
            <button className="btn btn-primary" disabled={radio.loading} onClick={() => selectedActive ? controller.toggle() : startOnline()}>{playing ? <Pause size={18} weight="fill"/> : <Waveform size={18} weight="bold" />} {radio.loading ? 'Подбираю…' : selectedActive ? playing ? 'Пауза' : 'Продолжить' : 'Включить радио'}</button>
          ) : selectedActive ? (
            <button className="btn btn-primary" onClick={() => controller.toggle()}>
              {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />} {playing ? 'Пауза' : 'Продолжить'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={(source === 'own' ? !tracks : !connected) || p.waveLoading} onClick={() => void controller.startWave(source as 'own' | 'yandex')}>
              <Waveform size={18} weight="bold" /> {p.waveLoading ? 'Подбираю…' : 'Слушать волну'}
            </button>
          )}
          {source === 'online' || source === 'yandex' ? <button className="btn btn-ghost" aria-expanded={tuning} aria-controls="home-wave-tuning" onClick={() => setTuning((v) => !v)}>Настроить волну</button> : <a className="btn btn-ghost" href="#/wave">Настроить волну <ArrowUpRight size={15} aria-hidden="true" /></a>}
        </div>
        {p.error && <p className="ws-error" role="alert">{p.error}</p>}
      </div>
      {source === 'yandex' && tuning && <section className="home-wave-tuning" id="home-wave-tuning" aria-label="Настройки Яндекс-волны"><YandexWaveTuning /></section>}
      {source === 'online' && tuning && <section className="home-wave-tuning" id="home-wave-tuning" aria-label="Настройки онлайн-радио"><RadioTuning /></section>}
    </section>
  );
}

export function HomePage() {
  const order = useApp((s) => s.order);
  const tracksMap = useApp((s) => s.tracks);
  const playlists = useApp((s) => s.playlists);
  const loaded = useApp((s) => s.loaded);
  const player = useApp((s) => s.player);
  const current = trackOf(player.queue[player.index]?.trackId);
  const setFull = useApp((s) => s.setFullPlayer);
  const playing = player.status === 'playing' || player.status === 'buffering';
  const all = useMemo(() => order.map((id) => tracksMap.get(id)!).filter(Boolean), [order, tracksMap]);
  const recent = all.slice(0, 16);
  const liked = all.filter((t) => t.reaction > 0).slice(0, 16);
  const forgotten = useMemo(
    () =>
      all
        .filter((t) => t.playCount > 0 && t.lastPlayedAt && Date.now() - t.lastPlayedAt > 3 * 86400000)
        .sort((a, b) => (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0))
        .slice(0, 16),
    [all],
  );
  const albums = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const t of all) if (t.album) m.set(`${t.albumArtist || t.artist}\u0000${t.album}`, [...(m.get(`${t.albumArtist || t.artist}\u0000${t.album}`) ?? []), t]);
    return [...m.values()].slice(0, 16);
  }, [all]);

  return (
    <div className="main-inner home-page">
      <header className="home-heading">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="page-title home-greeting">{greeting()}<span className="studio-period">.</span></h1>
        </div>
        <a className="btn btn-ghost home-search-link" href="#/search" aria-label="Найти музыку"><MagnifyingGlass size={18} /> Найти музыку</a>
      </header>
      <div className="home-featured">
        <WaveHero />
        {current ? (
          <section className="home-session" aria-label="Текущее прослушивание">
            <div className="home-session-heading"><span className="session-dot" data-playing={playing} aria-hidden="true" />{playing ? 'Сейчас играет' : 'Продолжить слушать'}</div>
            <div className="home-session-track">
              <button className="home-session-art" aria-label="Открыть плеер" onClick={() => setFull(true)}><Swap k={current.id}><Cover url={current.coverUrl} seed={current.album || current.id} size={80} /></Swap></button>
              <div>
                <div className="caption dim ellipsis">{player.context?.label ?? 'Ваша очередь'}</div>
                <button className="home-session-title" onClick={() => setFull(true)} title={current.title}><Swap k={current.id}>{current.title}</Swap></button>
                <p className="small muted ellipsis"><Swap k={current.id}>{current.artist || 'Неизвестный исполнитель'}</Swap></p>
              </div>
            </div>
            <div className="home-session-progress" aria-hidden="true"><i style={{ width: `${player.duration ? Math.min(100, Math.max(0, player.position / player.duration * 100)) : 0}%` }} /></div>
            <div className="home-session-footer">
              <span className="caption dim tnum">{fmtTime(player.position)} / {fmtTime(player.duration)}</span>
              <button className="play-circle" aria-label={playing ? 'Пауза' : 'Продолжить слушать'} onClick={() => controller.toggle()}>{playing ? <Pause size={21} weight="fill" /> : <Play size={21} weight="fill" />}</button>
            </div>
          </section>
        ) : (
          <a className="home-discover" href="#/search">
            <MagnifyingGlass size={28} aria-hidden="true" />
            <div><span className="caption dim">За пределами медиатеки</span><h2>Найдите свой новый трек</h2><p>Артисты, альбомы и песни из каталога Яндекса.</p></div>
            <ArrowUpRight size={22} aria-hidden="true" />
          </a>
        )}
      </div>
      {all.length > 0 && <nav className="home-shortcuts" aria-label="Ваша музыка"><a href="#/library"><Books size={19} /> Медиатека <span>{tracksWord(all.length)}</span><ArrowUpRight size={15} aria-hidden="true" /></a><a href="#/liked"><Heart size={19} aria-hidden="true" /> Любимое <span>{all.filter((track) => track.reaction > 0).length}</span><ArrowUpRight size={15} aria-hidden="true" /></a><a href="#/library/playlists"><Stack size={19} /> Плейлисты <span>{playlists.length}</span><ArrowUpRight size={15} /></a></nav>}
      {loaded && all.length === 0 && (
        <section className="section">
          <div className="empty">
            <h2>Добавьте свою музыку</h2>
            <p>Перетащите файлы или целую папку в это окно либо выберите их вручную. Приложение прочитает теги и обложки, проанализирует темп, тональность и структуру треков, чтобы сводить их между собой.</p>
            <ImportActions />
            <p className="caption dim">Не знаете, с чего начать? В папке проекта examples/library есть демонстрационные треки, синтезированные самим приложением.</p>
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <Rail title="Недавно добавленные" href="#/library">
          {recent.map((t, i) => (
            <TrackCard key={t.id} t={t} list={recent} index={i} label="Недавно добавленные" />
          ))}
        </Rail>
      )}
      {liked.length > 0 && (
        <Rail title="Любимое" href="#/liked">
          {liked.map((t, i) => (
            <TrackCard key={t.id} t={t} list={liked} index={i} label="Любимое" />
          ))}
        </Rail>
      )}
      {playlists.length > 0 && (
        <Rail title="Плейлисты">
          {playlists.map((p) => (
            <a key={p.id} className="card" href={`#/playlist/${p.id}`}>
              <Cover url={p.coverUrl} seed={p.id} />
              <div>
                <div className="card-title ellipsis">{p.name}</div>
                <div className="card-sub">{p.count} в плейлисте</div>
              </div>
            </a>
          ))}
        </Rail>
      )}
      {albums.length > 0 && (
        <Rail title="Альбомы" href="#/library/albums">
          {albums.map((list) => {
            const t = list[0];
            return (
              <a key={`${t.albumArtist}${t.album}`} className="card" href={albumHref(t.albumArtist || t.artist, t.album)}>
                <Cover url={t.coverUrl} seed={t.album} />
                <div style={{ minWidth: 0 }}>
                  <div className="card-title ellipsis">{t.album}</div>
                  <div className="card-sub ellipsis">{t.albumArtist || t.artist}</div>
                </div>
              </a>
            );
          })}
        </Rail>
      )}
      {forgotten.length > 0 && (
        <Rail title="Давно не звучали">
          {forgotten.map((t, i) => (
            <TrackCard key={t.id} t={t} list={forgotten} index={i} label="Давно не звучали" />
          ))}
        </Rail>
      )}
      {all.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Добавить ещё</h2>
          </div>
          <ImportActions compact />
        </section>
      )}
    </div>
  );
}
