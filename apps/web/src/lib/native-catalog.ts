import type { CatalogTrack, CatalogSearchType, CatalogArtistPage } from '@automix/core';
import { api, type PublicSource, type PublicTrack } from './api.ts';
import type { Screen, Row, ItemAction, ActResult } from './native-pages.ts';
import { useApp } from '../store/app.ts';
import { catalogPlayer, publicPlayer } from '../store/catalog.ts';
import { asCatalog, SOURCE_LABEL } from '../pages/Search.tsx';
import { publicTrackArtistLinks, publicAlbumHref, catalogAlbumHref, catalogArtistHref } from './router.ts';
import { react } from '../components/TrackList.tsx';
import { startRadio } from './radio.ts';
import { fmtTime } from './format.ts';

type Args = Record<string, unknown>;
type Source = PublicSource | 'yandex';
type Item = PublicTrack | CatalogTrack;
type Context = { type: 'search' | 'artist' | 'album'; label: string; id?: string };
interface Session { source: Source; q: string; scope: CatalogSearchType; page: number; items: Item[]; context: Context; artists: Link[]; albums: Link[] }
interface Link { id: string; title: string; detail: string; cover?: string | null; path: string }
const sessions = new Map<string, Session>();
const requests = new Map<Source, AbortController>();
const metadata = new Map<string, { at: number; result: Promise<any> }>();
const str = (v: unknown) => typeof v === 'string' ? v : '';
const label = (source: Source) => source === 'yandex' ? 'Яндекс Музыка' : SOURCE_LABEL[source];
const catalog = (item: Item): CatalogTrack => 'audioProvider' in item ? asCatalog(item) : item;
const player = (source: Source) => source === 'yandex' ? catalogPlayer : publicPlayer;
const checkPlayback = (transport: typeof catalogPlayer) => { if (transport.state.error) throw Error(transport.state.error); };
function remember(value: Session) {
  const id = crypto.randomUUID();
  sessions.set(id, value);
  if (sessions.size > 24) sessions.delete(sessions.keys().next().value!);
  return id;
}
function session(args: Args) {
  const value = sessions.get(str(args.session));
  if (!value) throw Error('Результаты устарели. Повторите поиск.');
  return value;
}
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const old = metadata.get(key);
  if (old && Date.now() - old.at < 60000) return old.result;
  const result = load();
  metadata.set(key, { at: Date.now(), result });
  if (metadata.size > 16) metadata.delete(metadata.keys().next().value!);
  try { return await result; } catch (error) { if (metadata.get(key)?.result === result) metadata.delete(key); throw error; }
}
const artistLink = (artist: { id: string; name: string; imageUrl?: string | null }): Link => ({
  id: artist.id, title: artist.name, detail: 'Исполнитель', cover: artist.imageUrl, path: catalogArtistHref(artist.id).slice(1),
});
const albumLink = (album: { id: string; title: string; imageUrl?: string | null; year?: number | null }): Link => ({
  id: album.id, title: album.title, detail: album.year ? String(album.year) : 'Альбом', cover: album.imageUrl, path: catalogAlbumHref(album.id).slice(1),
});
function result(value: Session, more = false) {
  const token = remember(value);
  return { session: token, page: value.page, more, artists: value.artists, albums: value.albums, tracks: value.items.map(item => {
    const known = player(value.source).known(catalog(item)), local = known ? useApp.getState().tracks.get(known) : undefined;
    return { id: item.externalId, title: item.title, artist: item.artist, album: item.album, duration: item.duration,
      reaction: local?.reaction ?? ('reaction' in item ? item.reaction : 0) ?? 0, cover: item.coverUrl, ok: item.playable,
      saved: !!local?.saved, explicit: item.explicit, tags: 'labels' in item ? item.labels.map(v => v.tag).join(' · ') : '' };
  }) };
}
const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
export const nativeCatalogCommands = {
  search: async (args: Args) => {
    const source = str(args.source) as Source;
    if (!['ytmusic', 'youtube', 'soundcloud', 'yandex'].includes(source)) throw Error('Неизвестный источник');
    const q = str(args.q).trim().slice(0, 200);
    const scope: CatalogSearchType = ['track', 'artist', 'album'].includes(str(args.scope)) ? args.scope as CatalogSearchType : 'all';
    const previous = args.more === true ? session(args) : null;
    if (previous && (previous.source !== source || previous.q !== q || previous.scope !== scope)) throw Error('Поиск уже изменился');
    const page = previous ? previous.page + 1 : 0;
    if (page > 1000) throw Error('Слишком много страниц результатов');
    const request = new AbortController();
    requests.get(source)?.abort(); requests.set(source, request);
    try {
    if (source !== 'yandex') {
      const items = (await api.publicSearch(source, q, request.signal)).items;
      return result({ source, q, scope, page: 0, items, artists: [], albums: [], context: { type: 'search', label: label(source) + ' · ' + q } });
    }
    const found = q ? await api.catalogSearch(q, scope, page, request.signal) : await api.catalogHome(request.signal);
    const value: Session = { source, q, scope, page: found.page,
      items: unique([...(previous?.items ?? []), ...found.tracks], v => v.externalId),
      artists: unique([...(previous?.artists ?? []), ...found.artists.map(artistLink)], v => v.id),
      albums: unique([...(previous?.albums ?? []), ...found.albums.map(albumLink)], v => v.id),
      context: { type: 'search', label: 'Яндекс Музыка' + (q ? ' · ' + q : '') } };
    return result(value, Object.values(found.hasMore).some(Boolean));
    } finally { if (requests.get(source) === request) requests.delete(source); }
  },
  searchAction: async (args: Args): Promise<ActResult> => {
    const value = session(args), kind = str(args.kind), item = value.items.find(v => v.externalId === args.id);
    if (kind === 'playAll' || kind === 'shuffleAll') {
      const items = value.items.map(catalog);
      if (kind === 'shuffleAll') for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      await player(value.source).play(items, 0, value.context); checkPlayback(player(value.source)); return {};
    }
    if (!item) throw Error('Трек не найден в результатах');
    if (kind === 'artist' || kind === 'album') {
      let path: string | undefined;
      if (value.source === 'yandex') {
        const track = item as CatalogTrack;
        path = kind === 'artist' && track.artists[0] ? catalogArtistHref(track.artists[0].id) : kind === 'album' && track.albumId ? catalogAlbumHref(track.albumId) : undefined;
      } else {
        const track = item as PublicTrack;
        const artistPage = track.source === 'ytmusic' && /^UC[\w-]{22}$/.test(track.artistId ?? '') || track.source === 'soundcloud' && /^\d{1,20}$/.test(track.artistId ?? '');
        path = kind === 'artist' ? artistPage ? publicTrackArtistLinks(track)[0]?.href : undefined : track.source === 'ytmusic' && /^MPRE[\w-]{6,80}$/.test(track.albumId ?? '') ? publicAlbumHref(track.albumId!) : undefined;
      }
      return { go: path?.replace(/^#/, '') ?? '/search?' + new URLSearchParams({ q: kind === 'artist' ? item.artist : item.album, src: value.source }) };
    }
    const track = catalog(item), transport = player(value.source);
    if (kind === 'play') { await transport.play(value.items.map(catalog), value.items.indexOf(item), value.context); checkPlayback(transport); return {}; }
    if (kind === 'next' || kind === 'queue') { await transport.enqueue(track, kind === 'next'); checkPlayback(transport); return {}; }
    if (kind === 'radio') { await startRadio({ title: item.title, artist: item.artist }); return {}; }
    if (!['save', 'like', 'dislike', 'download', 'playlist', 'versions'].includes(kind)) throw Error('Неизвестное действие');
    if ((kind === 'like' || kind === 'dislike') && value.source === 'yandex' && !transport.known(track)) {
      const wanted = kind === 'like' ? 1 : -1;
      const response = await api.catalogReact(item.externalId, (item as CatalogTrack).reaction === wanted ? 0 : wanted);
      if (response.value !== -1 && response.value !== 0 && response.value !== 1) throw Error('Некорректная реакция');
      (item as CatalogTrack).reaction = response.value;
      if (response.sync?.status === 'error' || response.sync?.status === 'pending') useApp.getState().toast(response.sync.error ?? 'Реакция сохранена. Отправка в Яндекс продолжится автоматически.');
      return {};
    }
    if (kind === 'playlist' && !useApp.getState().playlists.some(v => v.id === str(args.playlist))) throw Error('Плейлист не найден');
    const id = await transport.ensure(track);
    const local = useApp.getState().tracks.get(id) ?? await api.track(id);
    if (kind === 'versions') return { versions: id };
    if (kind === 'save') { await api.saveTrack(id); useApp.getState().upsertTrack({ ...local, saved: true }); useApp.getState().toast('Трек сохранён в медиатеку'); }
    if (kind === 'download') { await api.download({ trackId: id }); useApp.getState().toast('Скачиваем — прогресс в «Загрузках»'); }
    if (kind === 'playlist') {
      const playlist = str(args.playlist);
      if (!useApp.getState().playlists.some(v => v.id === playlist)) throw Error('Плейлист не найден');
      await api.addToPlaylist(playlist, [id]); await useApp.getState().loadLibrary();
    }
    if (kind === 'like' || kind === 'dislike') { const wanted = kind === 'like' ? 1 : -1; await react(local, local.reaction === wanted ? 0 : wanted); }
    return {};
  },
  searchCancel: () => { catalogPlayer.cancel(); publicPlayer.cancel(); },
  catalogRefresh: () => { metadata.clear(); return null; },
  catalogMore: async (args: Args) => {
    const id = str(args.id), key = 'yandex/artist/' + id;
    const old = await cached(key, () => api.catalogArtist(id));
    if (!old.hasMoreAlbums) return;
    const next = await api.catalogArtist(id, old.page + 1);
    metadata.set(key, { at: Date.now(), result: Promise.resolve({ ...old, page: next.page, hasMoreAlbums: next.hasMoreAlbums,
      albums: unique([...old.albums, ...next.albums], v => v.id) }) });
  },
};

function trackRows(value: Session, numbered = false): Row[] {
  const token = remember(value);
  return value.items.map((item, i) => {
    const known = player(value.source).known(catalog(item));
    const reaction = (known ? useApp.getState().tracks.get(known)?.reaction : undefined) ?? ('reaction' in item ? item.reaction : 0) ?? 0;
    const act = (kind: string) => ({ name: 'searchItem', args: { session: token, id: item.externalId, kind } });
    const actions: ItemAction[] = [
      ['Играть следующим', 'text.line.first.and.arrowtriangle.forward', 'next'], ['В очередь', 'text.append', 'queue'],
      ['Сохранить в медиатеку', 'plus', 'save'], [reaction > 0 ? 'Убрать лайк' : 'Нравится', reaction > 0 ? 'heart.fill' : 'heart', 'like'], [reaction < 0 ? 'Убрать дизлайк' : 'Не нравится', 'hand.thumbsdown', 'dislike'],
      ['Скачать', 'arrow.down.circle', 'download'], ['Другая версия', 'arrow.triangle.swap', 'versions'],
      ['Исполнитель', 'music.mic', 'artist'], ['Альбом', 'square.stack', 'album'], ['Радио по треку', 'dot.radiowaves.left.and.right', 'radio'],
    ].map(([title, symbol, kind]) => ({ title, symbol, act: act(kind) }));
    // artist pages from YouTube Music carry no durations: no "0:00" tag then
    const tag = [item.explicit ? 'E' : '', item.duration ? fmtTime(item.duration) : ''].filter(Boolean).join(' · ') || undefined;
    return { kind: 'item', title: item.title, subtitle: item.artist, ...(numbered ? { number: i + 1 } : { cover: item.coverUrl }), tag,
      act: item.playable ? act('play') : undefined, actions: item.playable ? actions : [], tone: item.playable ? undefined : 'warn' };
  });
}
/** Cards in a horizontal shelf; artists get round pictures. */
const shelf = (items: Link[], round = false): Row[] => items.length
  ? [{ kind: 'shelf', items: items.map(item => ({ title: item.title, subtitle: item.detail, cover: item.cover, path: item.path, round })) }] : [];
/** The page header with play and shuffle for the page's tracks (none when nothing on it can play). */
function hero(style: 'artist' | 'album', value: Session, title: string, cover: string | null | undefined, subtitle?: string, detail?: string): Row {
  const token = remember(value), playable = value.items.some(v => v.playable);
  const act = (kind: string) => playable ? { name: 'searchItem', args: { session: token, kind } } : undefined;
  return { kind: 'hero', style, title, subtitle, detail, cover, play: act('playAll'), shuffle: act('shuffleAll') };
}
const tracksWord = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'трек' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'трека' : 'треков'}`;
const top = (value: Session, n = 10): Session => ({ ...value, items: value.items.slice(0, n) });
export async function describeNativeCatalog(parts: string[]): Promise<Screen> {
  const [source, kind, id] = parts;
  if (!id || !['artist', 'album'].includes(kind)) throw Error('Неизвестная страница каталога');
  if (source === 'catalog') {
    if (kind === 'album') {
      const data = await cached('yandex/album/' + id, () => api.catalogAlbum(id));
      const value: Session = { source: 'yandex', q: '', scope: 'all', page: 0, items: data.tracks, artists: [], albums: [], context: { type: 'album', id, label: data.album.title } };
      const detail = [data.album.year, tracksWord(data.tracks.length)].filter(Boolean).join(' · ');
      return { title: data.album.title, style: 'catalog', sections: [
        { rows: [hero('album', value, data.album.title, data.album.imageUrl, data.album.artists.map(v => v.name).join(', '), detail)] },
        { rows: trackRows(value, true) },
        { title: 'Исполнители', rows: shelf(data.album.artists.map(artistLink), true) }] };
    }
    const data: CatalogArtistPage = await cached('yandex/artist/' + id, () => api.catalogArtist(id));
    const value: Session = { source: 'yandex', q: '', scope: 'all', page: 0, items: data.popularTracks, artists: [], albums: [], context: { type: 'artist', id, label: data.artist.name } };
    return { title: data.artist.name, style: 'catalog', sections: [
      { rows: [hero('artist', value, data.artist.name, data.artist.imageUrl, data.artist.genres.join(' · '))] },
      { title: 'Популярные треки', rows: trackRows(top(value)) },
      { title: 'Альбомы', rows: [...shelf(data.albums.map(albumLink)), ...(data.hasMoreAlbums ? [{ kind: 'button' as const, title: 'Ещё альбомы', act: { name: 'catalogMore', args: { id } } }] : [])] },
      { title: 'Похожие исполнители', rows: shelf(data.similarArtists.map(artistLink), true) },
      ...(data.artist.description ? [{ title: 'Об исполнителе', rows: [{ kind: 'text' as const, title: data.artist.description }] }] : [])] };
  }
  const data = source === 'soundcloud'
    ? await cached('soundcloud/artist/' + id, () => api.soundCloudArtist(id))
    : await cached('public/' + kind + '/' + id, () => api.publicCatalog(kind as 'artist' | 'album', id));
  const value: Session = { source: data.source, q: '', scope: 'all', page: 0, items: data.tracks, artists: [], albums: [], context: { type: kind as 'artist' | 'album', id, label: data.title } };
  const albums: Link[] = 'albums' in data ? data.albums.map(album => ({ id: album.id, title: album.title, detail: album.artist, cover: album.coverUrl, path: publicAlbumHref(album.id).slice(1) })) : [];
  const artist = kind === 'artist';
  return { title: data.title, style: 'catalog', sections: [
    { rows: [artist ? hero('artist', value, data.title, data.coverUrl, data.description || undefined)
      : hero('album', value, data.title, data.coverUrl, data.tracks[0]?.artist, tracksWord(data.tracks.length))] },
    { title: artist ? 'Популярные треки' : undefined, rows: trackRows(value, !artist), footer: data.limited ? 'Показаны записи, доступные в этом источнике.' : undefined },
    ...(albums.length ? [{ title: 'Альбомы', rows: shelf(albums) }] : [])] };
}
