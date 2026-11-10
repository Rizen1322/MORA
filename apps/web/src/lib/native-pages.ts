import { keyNameRu } from '@automix/core';
import { api, type ExternalTrack, type HealthStatus, type ImportJob, type ImportRow, type ProviderInfo, type Track, type TransitionLogItem } from './api.ts';
import { trackArtists, hasTrackArtist } from './artists.ts';
import { addBatch } from './batchImport.ts';
import { fmtDate, fmtTime, fmtTotal, methodShort, plural, tracksWord } from './format.ts';
import { importFiles } from './importer.ts';
import { likeAllSummary, likeEach, toLike } from './like-all.ts';
import { startArtistRadio, startRadio, useRadio } from './radio.ts';
import { albumHref, artistHref, searchHref } from './router.ts';
import { controller, trackOf, useApp } from '../store/app.ts';
import { useDownloads } from '../store/downloads.ts';
import { likeLibraryTrack } from '../components/LikeAll.tsx';
import { react as reactTrack } from '../components/TrackList.tsx';
import { openVersionPanel } from '../components/VersionPanel.tsx';
import { sortTracks } from '../pages/Library.tsx';

/**
 * Native pages of the iPhone shell (NativePages.swift): the page describes a screen as sections of
 * rows, native draws them and sends row actions back. The data and the logic stay here, next to the
 * web page each screen mirrors; native only knows the row kinds below.
 */

export interface Act { name: string; args?: Record<string, unknown> }
type Tone = 'ok' | 'warn' | 'error' | 'accent';
export interface ItemAction { title: string; symbol: string; act: Act; destructive?: boolean }
export type Row =
  | { kind: 'text'; title: string; detail?: string; value?: string; tone?: Tone }
  /** toggle, choice, slider and prompt buttons add `value` to the action's args. */
  | { kind: 'toggle'; title: string; detail?: string; on: boolean; act: Act; disabled?: boolean }
  | { kind: 'choice'; title: string; detail?: string; value: string; options: [string, string][]; act: Act; disabled?: boolean }
  | { kind: 'slider'; title: string; detail?: string; value: number; min: number; max: number; step: number; unit: string; act: Act; disabled?: boolean }
  /** Buttons add the screen's `field` values as `form`. */
  | { kind: 'button'; title: string; symbol?: string; act: Act; style?: 'primary' | 'destructive'; disabled?: boolean;
      confirm?: { title: string; text: string; button: string }; prompt?: { title: string; initial?: string; placeholder?: string } }
  | { kind: 'link'; title: string; detail?: string; symbol?: string; path: string }
  | { kind: 'url'; title: string; url: string }
  | { kind: 'field'; key: string; title: string; value?: string; placeholder?: string; secure?: boolean; help?: string }
  /** The picked files go one by one to the action as `{ name, base64 }`. */
  | { kind: 'file'; title: string; symbol?: string; types: string[]; multiple?: boolean; act: Act }
  | { kind: 'progress'; title: string; value: number | null; detail?: string }
  | { kind: 'item'; title: string; subtitle?: string; cover?: string | null; tag?: string; tone?: Tone; path?: string; act?: Act; actions?: ItemAction[] }
  /** A library track: native draws it from its snapshot; the section's `play` starts the section's tracks. */
  | { kind: 'track'; id: string; remove?: ItemAction };

export interface Section { title?: string; footer?: string; rows: Row[]; play?: { type: string; id?: string; label: string }; reorder?: Act }
export interface Screen { title: string; sections: Section[]; search?: string; refresh?: number }
/** What an action asks native to do after it ran (it always reloads the screen). */
export interface ActResult { go?: string; share?: { name: string; text: string } }

const st = () => useApp.getState();
const library = () => { const s = st(); return s.order.map((id) => s.tracks.get(id)).filter((t): t is Track => !!t); };
const route = () => {
  const [p, q] = (location.hash.replace(/^#/, '') || '/').split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') };
};
const go = (href: string) => href.replace(/^#/, '');
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const text = (title: string, detail?: string, value?: string, tone?: Tone): Row => ({ kind: 'text', title, detail, value, tone });
const button = (title: string, name: string, args?: Record<string, unknown>, more: Partial<Extract<Row, { kind: 'button' }>> = {}): Row => ({ kind: 'button', title, act: { name, args }, ...more });
const tracks = (list: Track[], play: Section['play'], title?: string): Section => ({ title, play, rows: list.map((t) => ({ kind: 'track', id: t.id })) });
const decode = (base64: unknown) => Uint8Array.from(atob(str(base64)), (c) => c.charCodeAt(0));
const fileText = (a: Record<string, unknown>) => new TextDecoder().decode(decode(a.base64));

/** Play / shuffle / like all for a list of library tracks (CollectionHeader on the web). */
function header(ids: string[], ctx: { type: string; id?: string; label: string }, sub: string, extra: Row[] = []): Section {
  const list = ids.map((id) => trackOf(id)).filter((t): t is Track => !!t);
  const pending = toLike(list, (t) => t.reaction).length;
  return { footer: sub, rows: [
    button('Слушать', 'playAll', { ids, ...ctx }, { symbol: 'play.fill', style: 'primary', disabled: !ids.length }),
    button('Вперемешку', 'playAll', { ids, ...ctx, shuffle: true }, { symbol: 'shuffle', disabled: !ids.length }),
    button(pending ? 'Лайкнуть все' : 'Всё в любимом', 'likeAll', { ids }, { symbol: 'heart', disabled: !pending }),
    ...extra,
  ] };
}

// MARK: Library

function albums(): Screen {
  const m = new Map<string, Track[]>();
  for (const t of library()) {
    if (!t.album) continue;
    const k = `${t.albumArtist || t.artist}\u0000${t.album}`;
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  const rows: Row[] = [...m.values()].sort((a, b) => a[0].album.localeCompare(b[0].album, 'ru')).map((list) => {
    const t = list.find((x) => x.coverUrl) ?? list[0];
    return { kind: 'item', title: t.album, subtitle: `${t.year ? `${t.year} · ` : ''}${t.albumArtist || t.artist}`, cover: t.coverUrl, path: go(albumHref(t.albumArtist || t.artist, t.album)) };
  });
  return { title: 'Альбомы', search: 'Альбом или исполнитель', sections: [{ rows: rows.length ? rows : [text('У треков нет сведений об альбомах.')] }] };
}

function artists(): Screen {
  const m = new Map<string, Track[]>();
  for (const t of library()) {
    const names = trackArtists(t).map((a) => a.name);
    for (const name of names.length ? names : ['Неизвестный исполнитель']) m.set(name, [...(m.get(name) ?? []), t]);
  }
  const rows: Row[] = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([name, list]) => (
    { kind: 'item', title: name, subtitle: tracksWord(list.length), cover: (list.find((x) => x.coverUrl) ?? list[0]).coverUrl, path: go(artistHref(name)) }));
  return { title: 'Исполнители', search: 'Исполнитель', sections: [{ rows }] };
}

function album(artist: string, name: string): Screen {
  const list = sortTracks(library().filter((t) => t.album === name && ((t.albumArtist || t.artist) === artist || artist === '—')), 'album', 1);
  if (!list.length) return { title: name, sections: [{ rows: [text('Альбом не найден.')] }] };
  const ctx = { type: 'album', id: name, label: name }, year = list.find((t) => t.year)?.year;
  return { title: name, sections: [
    header(list.map((t) => t.id), ctx, `${artist}${year ? ` · ${year}` : ''} · ${tracksWord(list.length)}, ${fmtTotal(list.reduce((a, t) => a + t.duration, 0))}`),
    tracks(list, ctx),
  ] };
}

function artist(name: string): Screen {
  const list = sortTracks(library().filter((t) => hasTrackArtist(t, name)), 'album', 1);
  if (!list.length) return { title: name, sections: [{ rows: [text('Исполнитель не найден.')] }] };
  const ctx = { type: 'artist', id: name, label: name };
  return { title: name, sections: [
    header(list.map((t) => t.id), ctx, tracksWord(list.length), [
      button('Радио по исполнителю', 'artistRadio', { artist: name }, { symbol: 'dot.radiowaves.left.and.right' }),
      { kind: 'link', title: 'Найти в каталоге Яндекса', symbol: 'magnifyingglass', path: go(searchHref(name, 'artist')) },
    ]),
    tracks(list, ctx),
  ] };
}

function playlists(): Screen {
  const rows: Row[] = st().playlists.map((p) => ({ kind: 'item', title: p.name, subtitle: tracksWord(p.count), cover: p.coverUrl, path: `/playlist/${p.id}` }));
  return { title: 'Плейлисты', sections: [
    { rows: [button('Создать плейлист', 'createPlaylist', {}, { symbol: 'plus', style: 'primary', prompt: { title: 'Новый плейлист', placeholder: 'Название' } })] },
    { title: 'Собрано вами', footer: rows.length ? undefined : 'Добавляйте музыку в плейлист через меню трека.', rows },
  ] };
}

async function playlist(id: string): Promise<Screen> {
  const pl = await api.playlist(id);
  const rows = pl.entries.map((e) => ({ e, t: trackOf(e.trackId) })).filter((r): r is { e: typeof r.e; t: Track } => !!r.t);
  const ctx = { type: 'playlist', id: pl.id, label: pl.name };
  const list = rows.map((r) => r.t);
  return { title: pl.name, search: list.length ? 'Найти в плейлисте' : undefined, sections: [
    header(list.map((t) => t.id), ctx, `${tracksWord(list.length)}, ${fmtTotal(list.reduce((a, t) => a + t.duration, 0))}`, [
      button('Переименовать', 'renamePlaylist', { id }, { symbol: 'pencil', prompt: { title: 'Переименовать плейлист', initial: pl.name, placeholder: 'Название' } }),
      button('Экспорт', 'exportPlaylist', { id }, { symbol: 'square.and.arrow.up' }),
      // The mix builder runs a web worker and its own preview: it stays a web sheet.
      { kind: 'link', title: 'Собрать микс', symbol: 'wand.and.stars', path: `/playlist/${id}/mix` },
      button('Удалить', 'deletePlaylist', { id }, { symbol: 'trash', style: 'destructive', confirm: { title: 'Удалить плейлист?', text: `Плейлист «${pl.name}» будет удалён. Треки останутся в медиатеке.`, button: 'Удалить' } }),
    ]),
    list.length ? { ...tracks([], ctx), reorder: { name: 'reorderPlaylist', args: { id, entries: rows.map((r) => r.e.entryId) } },
      rows: rows.map(({ e, t }) => ({ kind: 'track', id: t.id, remove: { title: 'Убрать из плейлиста', symbol: 'minus.circle', act: { name: 'removeFromPlaylist', args: { id, entry: e.entryId } } } })) }
      : { title: 'У каждой истории есть первый трек', rows: [text('Добавьте музыку через меню трека.'), { kind: 'link', title: 'Выбрать из медиатеки', path: '/library' }] },
  ] };
}

const END_LABEL: Record<string, string> = { finished: 'дослушан', transition: 'AutoMix-переход', skip: 'пропущен', stop: 'остановлен', error: 'ошибка' };

async function history(): Promise<Screen> {
  const { items } = await api.history(300).catch(() => ({ items: [] }));
  const rows: Row[] = items.flatMap((h) => {
    const t = trackOf(h.trackId);
    return t ? [{ kind: 'item', title: t.title, subtitle: `${t.artist} · ${fmtDate(h.startedAt)} · ${fmtTime(h.playedMs / 1000)}`, cover: t.coverUrl,
      tag: END_LABEL[h.endReason ?? ''] ?? 'играл', tone: h.endReason === 'skip' ? 'warn' : h.endReason === 'transition' ? 'accent' : undefined } as Row] : [];
  });
  return { title: 'История', sections: [
    rows.length ? { rows: [button('Очистить историю', 'clearHistory', {}, { style: 'destructive', confirm: { title: 'Очистить историю?', text: 'Записи о прослушиваниях будут удалены. «Моя волна» начнёт учиться заново, лайки сохранятся.', button: 'Очистить' } })] } : { rows: [text('История пуста.')] },
    { rows },
  ] };
}

// MARK: Wave

let waveSource: 'own' | 'online' | 'yandex' | null = null;

/** Settings for a native sheet; describing them never changes the page route or playback. */
export async function describeWaveSettings(source: unknown): Promise<Screen> {
  if (source !== 'own' && source !== 'online' && source !== 'yandex') throw Error('Неизвестный источник волны');
  const w = st().settings?.wave;
  const seg = (title: string, key: string, value: string, options: [string, string][], detail?: string): Row => ({ kind: 'choice', title, detail, value, options, act: { name: 'set', args: { group: 'wave', key } }, disabled: !w });
  let tuning: Row[];
  if (source === 'yandex') {
    const groups = await api.yandexWaveSettings().then((r) => r.groups, () => null);
    const seeds = w?.yandexSeeds ?? [];
    tuning = !groups ? [text('Не удалось получить настройки Яндекса.', undefined, undefined, 'warn')] : groups.length === 0 ? [text('Яндекс пока не вернул доступные настройки. Попробуйте позже.')]
      : groups.map((g) => ({ kind: 'choice', title: g.name, value: seeds.find((x) => g.values.some((v) => v.seed === x)) ?? '', act: { name: 'yandexSeed', args: { group: g.values.map((v) => v.seed) } },
        options: [['', 'По умолчанию'], ...g.values.map((v) => [v.seed, v.name] as [string, string])], disabled: !w }));
  } else {
    const online = source === 'online', mood = w?.mood ?? 'normal', diversity = w?.diversity ?? 'balanced';
    tuning = [
      seg('Энергия', 'mood', mood, [['calm', 'Спокойнее'], ['normal', 'В моём ритме'], ['energetic', 'Бодрее']],
        online ? 'Энергия учитывается у уже проанализированных записей.' : { calm: 'Выдохнуть и замедлиться', normal: 'Знакомый ритм вашего дня', energetic: 'Добавить движения' }[mood]),
      seg(online ? 'Знакомое и новое' : 'Характер', 'diversity', diversity, [['familiar', online ? 'Ближе к любимому' : 'Любимое'], ['balanced', 'Вперемешку'], ['discover', 'Открытия']],
        online ? undefined : diversity === 'discover' ? 'Больше музыки, которую вы ещё не слышали' : diversity === 'familiar' ? 'Ближе к тому, что уже нравится' : 'Знакомые треки и новые находки'),
      { kind: 'toggle', title: 'Для микса', on: w?.mode === 'mix', act: { name: 'set', args: { group: 'wave', key: 'mode', map: { true: 'mix', false: 'normal' } } }, disabled: !w,
        detail: online ? 'Близкие BPM и тональности получают приоритет, когда есть анализ.' : w?.mode === 'mix' ? 'Больше совместимых по ритму треков' : 'Подбор прежде всего по вашему вкусу' },
    ];
  }

  return { title: 'Настроить волну', sections: [{
    title: source === 'yandex' ? 'Подбор Яндекса' : source === 'online' ? 'Радио по вашему вкусу' : 'Характер подборки',
    footer: source === 'yandex' ? 'Настройки вашего аккаунта Яндекса применятся к продолжению волны.' : 'Новые настройки применятся к следующим трекам.',
    rows: tuning,
  }] };
}

async function wave(): Promise<Screen> {
  const s = st(), p = s.player, radio = useRadio.getState();
  const yandex = s.providers.some((x) => x.id === 'yandex' && x.status === 'connected');
  const waveOn = radio.active || p.context?.type === 'wave' || p.context?.type === 'yandex-wave';
  const active = radio.active ? 'online' : p.context?.type === 'yandex-wave' ? 'yandex' : 'own';
  const source = waveSource ?? (radio.active || p.context?.type === 'online-radio' ? 'online' : p.context?.type === 'yandex-wave' ? 'yandex' : 'own');
  const selected = waveOn && active === source;
  const playing = selected && (p.status === 'playing' || p.status === 'buffering');
  const unavailable = source === 'own' ? !s.order.length : source === 'yandex' ? !yandex : false;
  const loading = !!p.waveLoading || radio.loading;
  const stage: Row[] = [
    { kind: 'choice', title: 'Источник', value: source, act: { name: 'waveSource' }, options: [['own', 'Моя коллекция'], ['online', 'Онлайн-радио'], ...(yandex ? [['yandex', 'Яндекс Музыка'] as [string, string]] : [])] },
    button(selected ? playing ? 'Пауза' : 'Продолжить' : loading ? 'Подбираю музыку…' : source === 'online' ? 'Включить радио' : 'Поймать волну', 'waveLaunch', { source },
      { symbol: playing ? 'pause.fill' : 'play.fill', style: 'primary', disabled: !selected && (loading || unavailable) }),
  ];
  if (selected) stage.push(button('Другой трек', 'next', {}, { symbol: 'forward.fill' }));
  if (unavailable && !selected) stage.push(source === 'own' ? { kind: 'link', title: 'Добавьте музыку в медиатеку, чтобы начать', path: '/library' } : { kind: 'link', title: 'Подключите Яндекс Музыку', path: '/sources' });
  if (p.error) stage.push(text(p.error, undefined, undefined, 'error'));

  const tuning = (await describeWaveSettings(source)).sections[0];

  const cur = waveOn ? trackOf(p.queue[p.index]?.trackId) : undefined;
  const now: Row[] = cur ? [
    { kind: 'item', title: cur.title, subtitle: `${cur.artist} · ${active === 'online' ? 'Онлайн-радио' : active === 'yandex' ? 'Яндекс Музыка' : 'Моя коллекция'}`, cover: cur.coverUrl, actions: [
      { title: cur.reaction > 0 ? 'Убрать из любимого' : 'Нравится', symbol: cur.reaction > 0 ? 'heart.fill' : 'heart', act: { name: 'react', args: { id: cur.id, value: cur.reaction > 0 ? 0 : 1 } } },
      { title: 'Не нравится, убрать из волны', symbol: 'hand.thumbsdown', act: { name: 'react', args: { id: cur.id, value: -1 } }, destructive: true },
    ] },
    ...(p.nextPlan ? [text('Следующий переход', methodShort(p.nextPlan))] : []),
  ] : [text('Всё начинается с вас', 'Лайкайте то, что цепляет. Волна подстроится под ваш вкус.')];
  const upcoming = waveOn ? p.queue.slice(p.index + 1, p.index + 6) : [];
  const left = waveOn ? Math.max(0, p.queue.length - p.index - 1) : 0;
  const next: Row[] = upcoming.flatMap((e, i) => {
    const t = trackOf(e.trackId);
    return t ? [{ kind: 'item', title: t.title, subtitle: t.artist, cover: t.coverUrl, act: { name: 'jump', args: { index: p.index + 1 + i } } } as Row] : [];
  });
  if (p.waveRefillError) next.unshift(text(p.waveRefillError));
  if (left > upcoming.length) next.push(button('Вся очередь', 'queue', {}, { symbol: 'list.bullet' }));
  return { title: 'Моя волна', refresh: loading ? 2 : undefined, sections: [
    { footer: 'Музыка, которая чувствует ваш ритм.', rows: stage },
    { ...tuning, title: 'Настроить звучание' },
    { title: cur ? 'Сейчас в эфире' : 'Ваша частота', rows: now,
      footer: 'Учитываем лайки, дослушивания и пропуски. «Не нравится» исключает трек из подборки. Ваша коллекция использует рекомендации приложения; источник «Яндекс Музыка» — рекомендации вашего аккаунта.' },
    { title: 'На подходе', footer: loading ? 'Готовим продолжение…' : left ? tracksWord(left) : 'Запустите волну — здесь появятся следующие треки вашей подборки.', rows: next },
  ] };
}

// MARK: Downloads

const MB = 1024 * 1024;
const mb = (b: number) => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(1).replace('.', ',')} ГБ` : `${Math.round(b / MB)} МБ`);
const STATE: Record<string, string> = { queued: 'В очереди', downloading: 'Скачивается', waiting: 'Ждём подключения', paused: 'На паузе', failed: 'Ошибка', cancelled: 'Отменено', done: 'Готово' };

async function downloads(): Promise<Screen> {
  await useDownloads.getState().load();
  const usage = await api.downloads().then((r) => r.usage, () => null);
  const active = [...useDownloads.getState().jobs.values()].filter((j) => j.state !== 'done' && j.state !== 'cancelled');
  const pinned = library().filter((t) => t.pinned).sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  const jobAct = (id: string, action: string, title: string, symbol: string): ItemAction => ({ title, symbol, act: { name: 'downloadAction', args: { id, action } } });
  const sections: Section[] = [];
  if (active.length) sections.push({ title: 'Скачивается', rows: active.map((j) => ({
    kind: 'item', title: j.title || 'Трек', tone: j.state === 'failed' ? 'error' : undefined,
    subtitle: `${j.error && j.state !== 'downloading' ? j.error : STATE[j.state]}${j.state === 'downloading' ? ` · ${Math.round(j.progress * 100)}%` : ''}`,
    actions: [
      ...(['queued', 'downloading', 'waiting'].includes(j.state) ? [jobAct(j.id, 'pause', 'Пауза', 'pause')] : []),
      ...(['paused', 'failed'].includes(j.state) ? [jobAct(j.id, 'retry', 'Повторить', 'arrow.clockwise')] : []),
      { ...jobAct(j.id, 'cancel', 'Отменить', 'xmark'), destructive: true },
    ] })) });
  sections.push({ title: `Скачано · ${pinned.length}`, footer: pinned.length ? undefined : 'Пока ничего. В меню трека или результата поиска выберите «Скачать».',
    play: { type: 'library', label: 'Загрузки' }, rows: pinned.map((t) => ({ kind: 'track', id: t.id, remove: { title: 'Удалить загрузку', symbol: 'trash', act: { name: 'removeDownload', args: { id: t.id } } } })) });
  if (usage) sections.push({ title: 'Место на диске', footer: usage.freeBytes !== null ? `Свободно на диске: ${mb(usage.freeBytes)}` : undefined, rows: [
    text('Скачанное', 'Не удаляется автоматически', mb(usage.pinnedBytes)),
    text('Кэш прослушанного', 'Старое удаляется само, когда превышен предел. Текущий и следующий трек защищены.', mb(usage.cacheBytes)),
    { kind: 'choice', title: 'Предел кэша', value: String(Math.round(usage.limitBytes / MB)), act: { name: 'cacheLimit' }, options: [512, 1024, 2048, 5120, 10240, 20480].map((v) => [String(v), mb(v * MB)]) },
    button('Очистить кэш', 'clearAudioCache'),
  ] });
  return { title: 'Загрузки', refresh: active.length ? 2 : undefined, sections: [{ footer: 'Скачанные треки играют без интернета. Подготовка к AutoMix идёт отдельно и не мешает слушать.', rows: [] }, ...sections] };
}

// MARK: Import

const IMPORT_SOURCE: Record<string, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube', soundcloud: 'SoundCloud', file: 'Файл' };
const IMPORT_STATUS: Record<ImportRow['status'], string> = { matched: 'Найдено', uncertain: 'Проверьте', missing: 'Не найдено', pending: 'Ищем…' };
let importJob: ImportJob | null = null;
let importUncertain = false;

async function importPage(): Promise<Screen> {
  const intro: Section = { footer: 'Ссылка на плейлист или альбом Spotify, Apple Music, YouTube, SoundCloud — или файл CSV, JSON, M3U. Из сервисов берутся только названия; звук играет из найденной публичной записи.', rows: [
    { kind: 'field', key: 'url', title: 'Ссылка на плейлист', placeholder: 'https://open.spotify.com/playlist/…' },
    button('Прочитать', 'importUrl', {}, { symbol: 'link', style: 'primary' }),
    { kind: 'file', title: 'Выбрать файл', symbol: 'doc', types: ['csv', 'json', 'm3u', 'm3u8', 'txt'], act: { name: 'importFile' } },
  ] };
  if (importJob) importJob = await api.importJob(importJob.id).catch(() => importJob);
  const job = importJob;
  if (!job) {
    const { jobs } = await api.imports().catch(() => ({ jobs: [] as ImportJob[] }));
    return { title: 'Импорт', sections: [intro, { title: jobs.length ? 'Недавние импорты' : undefined, rows: jobs.map((j) => ({
      kind: 'item', title: j.name, cover: j.cover, act: { name: 'openImport', args: { id: j.id } }, actions: [{ title: 'Удалить отчёт', symbol: 'trash', destructive: true, act: { name: 'deleteImport', args: { id: j.id } } }],
      subtitle: `${IMPORT_SOURCE[j.source] ?? j.source} · ${j.state === 'matching' ? 'сопоставляется' : j.state === 'done' ? 'плейлист создан' : 'ждёт подтверждения'}${j.counts ? ` · найдено ${j.counts.matched}, проверить ${j.counts.uncertain}, нет ${j.counts.missing}` : ''}` })) }] };
  }
  const c = job.rows.reduce((a, r) => ({ ...a, [r.status]: a[r.status] + 1 }), { matched: 0, uncertain: 0, missing: 0, pending: 0 });
  const count = c.matched + (importUncertain ? c.uncertain : 0);
  const head: Row[] = [
    { kind: 'item', title: job.name, cover: job.cover, subtitle: `${IMPORT_SOURCE[job.source] ?? job.source} · прочитано ${job.rows.length}${job.total !== null ? ` из ${job.total}` : ''}` },
    text(`Найдено ${c.matched} · проверьте ${c.uncertain} · не найдено ${c.missing}${c.pending ? ` · ищем ${c.pending}` : ''}`),
  ];
  if (!job.complete) head.push(text(`${job.note ?? 'Источник показал не весь список.'} Остальное без входа недоступно — проверьте, прежде чем создавать.`, undefined, undefined, 'warn'));
  if (job.state === 'matching') head.push({ kind: 'progress', title: 'Сопоставление', value: (job.rows.length - c.pending) / Math.max(1, job.rows.length) });
  head.push(button('Закрыть отчёт', 'closeImport', {}, { symbol: 'xmark' }));
  const rows: Row[] = job.rows.map((r) => {
    const resolve = (choice: unknown): Act => ({ name: 'resolveImport', args: { position: r.position, choice } });
    const actions: ItemAction[] = [];
    if (r.status === 'uncertain') actions.push({ title: 'Принять', symbol: 'checkmark', act: resolve(r.candidate) });
    if (r.status !== 'pending') actions.push({ title: 'Найти вручную', symbol: 'magnifyingglass', act: { name: 'pickImport', args: { position: r.position } } });
    if (r.status === 'uncertain' || (r.status === 'matched' && r.how !== 'source')) actions.push({ title: 'Не добавлять', symbol: 'xmark', destructive: true, act: resolve(null) });
    const cand = r.candidate;
    return { kind: 'item', title: `${r.position + 1}. ${r.title}`, tag: IMPORT_STATUS[r.status], tone: r.status === 'matched' ? 'ok' : r.status === 'uncertain' ? 'warn' : undefined, actions,
      subtitle: cand ? `${cand.artist} — ${cand.title} · ${cand.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}${r.how === 'user' ? ' · выбрано вами' : r.how === 'source' ? ' · из плейлиста' : ` · уверенность ${Math.round(r.confidence * 100)}%`}`
        : `${r.artist}${r.duration ? ` · ${fmtTime(r.duration)}` : ''}` };
  });
  const footer: Row[] = [
    { kind: 'toggle', title: `Добавить и непроверенные (${c.uncertain})`, on: importUncertain, act: { name: 'importUncertain' } },
    button(job.playlistId ? 'Обновить плейлист' : `Создать плейлист · ${count}`, 'importPlaylist', {}, { style: 'primary', disabled: job.state === 'matching' || !count }),
  ];
  if (job.playlistId) footer.push({ kind: 'link', title: 'Открыть плейлист', path: `/playlist/${job.playlistId}` });
  return { title: 'Импорт', refresh: job.state === 'matching' ? 1.2 : undefined, search: 'Найти в отчёте', sections: [
    { rows: head }, { rows }, { rows: footer, footer: 'Ненайденные позиции остаются в этом отчёте со своим местом в списке: найдите их вручную, и они встанут на своё место в плейлисте. Звук скачивается при первом прослушивании.' },
  ] };
}

// MARK: Sources

const SOURCE_STATUS: Record<ProviderInfo['status'], [string, 'ok' | 'warn' | undefined]> = {
  connected: ['Подключено', 'ok'], needs_credentials: ['Требуется подключение', undefined], unavailable: ['Недоступно', 'warn'],
  not_supported: ['Не поддерживается', 'warn'], error: ['Ошибка', 'warn'], disabled: ['Выключено', undefined],
};
const CAPS: [keyof ProviderInfo['capabilities'], string][] = [['search', 'поиск'], ['library', 'медиатека'], ['recommendations', 'рекомендации'], ['playback', 'воспроизведение'], ['seek', 'перемотка'], ['pcm', 'PCM'], ['analysis', 'анализ'], ['mixing', 'AutoMix']];
const AUDIO = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'aiff', 'aif', 'wv', 'ape', 'alac'];
/** Provider search results per provider: what «Найти треки» showed last, and what was added since. */
const browse = new Map<string, { items: ExternalTrack[]; added: Map<string, string> }>();

async function sources(): Promise<Screen> {
  await st().loadProviders();
  const s = st(), providers = s.providers, connected = providers.filter((p) => p.status === 'connected').length;
  const likesJob = providers.some((p) => p.id === 'yandex' && p.status === 'connected') && s.settings?.yandex.importLikes !== false
    ? await api.yandexLikesJob().catch(() => undefined) : undefined;
  const sections: Section[] = [{ footer: 'Откуда MORA берёт музыку. Треки из подключённых источников заранее готовятся к сведению.', rows: [
    text(providers.length ? `Подключено ${connected} из ${providers.length}` : 'Проверяем источники…'),
    button('Проверить подключения', 'checkSources', {}, { symbol: 'arrow.clockwise' }),
  ] }];
  for (const p of providers) {
    const [label, tone] = SOURCE_STATUS[p.status], isConnected = p.status === 'connected';
    const rows: Row[] = [text(label, p.statusText || undefined, p.account ?? (p.id === 'local' ? 'На этом устройстве' : p.official ? 'Официальный API' : 'Неофициальный API'), tone)];
    if (p.id === 'local') rows.push({ kind: 'file', title: 'Выбрать файлы', symbol: 'square.and.arrow.down', types: AUDIO, multiple: true, act: { name: 'importAudio' } });
    else if (p.configFields.length && !isConnected) {
      for (const f of p.configFields) rows.push({ kind: 'field', key: `${p.id}.${f.key}`, title: f.label, value: f.secret ? '' : p.config[f.key] ?? '', secure: f.secret || f.type === 'password', help: f.help,
        placeholder: f.placeholder ?? (f.secret && p.hasSecret ? 'сохранён (оставьте пустым)' : '') });
      rows.push(button('Проверить и сохранить', 'connectSource', { id: p.id }, { style: 'primary' }));
    } else if (p.id === 'yandex' && isConnected) rows.push({ kind: 'link', title: 'Открыть каталог Яндекса', symbol: 'music.note.list', path: '/yandex' });
    if (isConnected && p.id === 'yandex' && s.settings) {
      const y = s.settings.yandex, sync = (title: string, key: keyof typeof y, detail: string): Row => ({ kind: 'toggle', title, detail, on: !!y[key], act: { name: 'set', args: { group: 'yandex', key } } });
      rows.push(
        sync('Синхронизация лайков', 'syncLikes', 'Отметка «Нравится» в MORA ставит лайк в Яндекс Музыке, снятие — убирает его.'),
        sync('Синхронизация дизлайков', 'syncDislikes', 'Отметка «Не нравится» в MORA ставит дизлайк в Яндекс Музыке, снятие — убирает его.'),
        sync('Импорт лайков в медиатеку', 'importLikes', 'Перенос всей коллекции лайков Яндекса в «Любимое» MORA с подготовкой полных треков.'),
        sync('Обучение «Моей волны»', 'waveFeedback', 'Рассказывать Яндексу, что прозвучало и что пропущено. Волна работает и без этого.'),
      );
      if (likesJob !== undefined) rows.push(...yandexLikes(likesJob));
    }
    if (isConnected && p.capabilities.search && p.id !== 'local') rows.push(...providerBrowser(p));
    rows.push(text('Возможности', [...CAPS.map(([k, l]) => `${p.capabilities[k] ? '✓' : '×'} ${l}`), `кэш: ${p.capabilities.caching === 'persistent' ? 'постоянный' : p.capabilities.caching === 'session' ? 'до перезапуска' : 'нет'}`].join(' · ')));
    for (const n of p.notes) rows.push(text(n));
    for (const d of p.docs) rows.push({ kind: 'url', title: new URL(d).host, url: d });
    if (p.configFields.length && isConnected) rows.push(button('Отключить', 'disconnectSource', { id: p.id }, { style: 'destructive' }));
    sections.push({ title: p.name, rows });
  }
  return { title: 'Источники', refresh: likesJob && ['running', 'listing'].includes(likesJob.state) ? 2 : undefined, sections };
}

function yandexLikes(job: Awaited<ReturnType<typeof api.yandexLikesJob>>): Row[] {
  const rows: Row[] = [text('Вся любимая музыка', 'Перенесите всю коллекцию лайков в «Любимое» MORA. Треки готовятся по два, новые остаются сверху.')];
  const active = job?.state === 'running' || job?.state === 'listing', finished = !job || ['done', 'cancelled'].includes(job.state);
  if (job) {
    const processed = job.done + job.failed + job.skipped;
    rows.push({ kind: 'progress', value: job.total ? processed / job.total : null,
      title: job.state === 'listing' ? 'Получаем коллекцию…' : `${job.state === 'done' ? 'Готово' : job.state === 'cancelled' ? 'Остановлен' : job.state === 'paused' ? 'На паузе' : job.state === 'error' ? 'Нужен повтор' : 'Подготавливаем'} · ${processed} из ${job.total}`,
      detail: `В Любимом: ${job.done}${job.failed ? ` · Не удалось: ${job.failed}` : ''}${job.skipped ? ` · Пропущено после изменения оценки: ${job.skipped}` : ''}${job.message ? `. ${job.message}` : ''}` });
  }
  const like = (title: string, kind: string, symbol: string, disabled = false) => button(title, 'yandexLikes', { kind }, { symbol, disabled });
  if (finished) rows.push(like(job ? 'Обновить коллекцию' : 'Добавить все лайки в Любимое', 'start', 'heart', !!job?.busy));
  if (active) rows.push(like('Приостановить', 'pause', 'pause'));
  if (job && !active && !finished) rows.push(like('Продолжить', 'resume', 'play', job.busy));
  if (job && !active && job.state !== 'cancelled' && job.failed > 0) rows.push(like('Повторить ошибки', 'retry', 'arrow.clockwise', job.busy));
  if (job && !finished) rows.push(like('Завершить импорт', 'cancel', 'stop'));
  if (job?.done) rows.push({ kind: 'link', title: 'Открыть Любимое', path: '/liked' });
  return rows;
}

function providerBrowser(p: ProviderInfo): Row[] {
  const b = browse.get(p.id);
  const rows: Row[] = [
    { kind: 'field', key: `${p.id}.q`, title: p.id === 'yandex' ? 'Название, исполнитель или ссылка на трек' : `Поиск в ${p.name}` },
    button('Найти', 'providerSearch', { id: p.id }, { symbol: 'magnifyingglass' }),
    button(p.id === 'yandex' ? 'Мои любимые треки' : 'Показать подборку', 'providerSearch', { id: p.id, all: true }),
  ];
  if (!b) return rows;
  if (!b.items.length) return [...rows, text('Ничего не найдено.')];
  if (b.items.some((t) => t.playable)) rows.push(button('Все в медиатеку', 'providerBatch', { id: p.id }, { symbol: 'plus' }), button('Все в Любимое', 'providerBatch', { id: p.id, like: true }, { symbol: 'heart' }));
  for (const t of b.items) {
    const ready = t.libraryTrackId ?? b.added.get(t.externalId);
    rows.push({ kind: 'item', title: t.title, subtitle: `${t.artist} · ${fmtTime(t.duration)}`, cover: t.coverUrl, tag: ready ? 'В медиатеке' : t.playable ? undefined : 'Недоступно',
      act: ready ? { name: 'providerPlay', args: { id: p.id, track: ready } } : undefined,
      actions: ready || !t.playable ? [] : [{ title: 'Добавить в медиатеку', symbol: 'plus', act: { name: 'providerImport', args: { id: p.id, external: t.externalId } } }] });
  }
  return rows;
}

// MARK: Settings

let backup: { data: unknown; count: number; name: string } | null = null;
let backupMessage = '';

async function settings(): Promise<Screen> {
  const s = st().settings;
  if (!s) return { title: 'Настройки', sections: [] };
  const health = await api.health().catch(() => null);
  const a = s.automix, off = !a.enabled;
  const sw = (title: string, key: string, on: boolean, detail: string, disabled = false, group = 'automix'): Row => ({ kind: 'toggle', title, detail, on, disabled, act: { name: 'set', args: { group, key } } });
  const pick = (title: string, key: string, value: string, options: [string, string][], detail: string, group = 'automix', disabled = false, num = false): Row =>
    ({ kind: 'choice', title, detail, value, options, disabled, act: { name: 'set', args: { group, key, num } } });
  const slide = (title: string, key: string, value: number, min: number, max: number, step: number, unit: string, detail: string): Row =>
    ({ kind: 'slider', title, detail, value, min, max, step, unit, disabled: off, act: { name: 'set', args: { group: 'automix', key } } });
  const backupRows: Row[] = [
    button('Сохранить копию', 'exportPlaylists', {}, { symbol: 'square.and.arrow.up' }),
    { kind: 'file', title: 'Восстановить из файла', symbol: 'square.and.arrow.down', types: ['json'], act: { name: 'inspectBackup' } },
  ];
  if (backup) backupRows.push(text(backup.name, `Плейлистов: ${backup.count}. Будут созданы отдельные копии. Повторное восстановление этого набора обновит его копии.`),
    button('Восстановить', 'restoreBackup', {}, { style: 'primary' }), button('Отмена', 'cancelBackup'));
  if (backupMessage) backupRows.push(text(backupMessage));
  const sections: Section[] = [
    { title: 'Переходы', footer: off ? 'AutoMix выключен: треки играют подряд без наложения.' : 'AutoMix ищет в следующем треке подходящую фразу и сводит песни в темп.', rows: [
      sw('AutoMix', 'enabled', a.enabled, 'Плавные музыкальные переходы между треками.'),
      sw('Сводить по кнопке «Следующий»', 'mixOnNext', a.mixOnNext ?? true, 'Первое нажатие — короткий переход, второе переключает сразу.', off),
      pick('Характер переходов', 'style', a.style, [['auto', 'Авто · рекомендуется'], ['smooth', 'Длинные и плавные'], ['tight', 'Короткие, по фразе']], 'В режиме «Авто» способ и длина зависят от музыки.', 'automix', off),
      pick('Начало следующего трека', 'entryMode', a.entryMode ?? 'smart', [['smart', 'Умный вход'], ['preserve', 'Сохранять начало']], '«Умный вход» может пропустить часть вступления ради лучшего перехода.', 'automix', off),
    ] },
    { title: 'Воспроизведение', rows: [
      sw('Продолжать радио после конца очереди', 'continueRadio', s.wave.continueRadio !== false, 'Когда альбом или плейлист доиграл, дальше без паузы звучит похожая музыка. Без сети — «Моя волна» из медиатеки. Не включается при повторе.', false, 'wave'),
      sw('Альбомы без наложения', 'respectAlbums', a.respectAlbums, 'Соседние треки одного альбома играют подряд, как задумал автор.', off),
      pick('Выравнивание громкости', 'loudnessTarget', a.loudnessTarget === null ? 'off' : String(a.loudnessTarget),
        [['off', 'Выключено'], ['-14', 'Громче (−14 LUFS)'], ['-16', 'Обычно (−16 LUFS) · рекомендуется'], ['-18', 'Тише, больше запаса (−18 LUFS)']], 'Треки звучат одинаково громко, без перегрузки.', 'automix', false, true),
    ] },
    { title: 'Офлайн', footer: 'Загрузка идёт через любое подключение, в том числе мобильное.', rows: [
      sw('Скачивать лайкнутые треки', 'autoLiked', !!s.downloads?.autoLiked, 'Треки из YouTube, SoundCloud и Яндекс Музыки с отметкой «Нравится» сохраняются на устройство. Снятие отметки скачанное не удаляет.', false, 'downloads'),
      { kind: 'link', title: 'Загрузки', symbol: 'arrow.down.circle', path: '/downloads' },
    ] },
    { title: 'DJ-приёмы', footer: off ? 'Включите AutoMix, чтобы использовать DJ-приёмы.' : undefined, rows: [
      sw('Обмен басом', 'eqHandoff', a.eqHandoff, 'Бас двух треков не звучит одновременно, середина приглушается при конфликте мелодий.', off),
      sw('DJ-подводки', 'djPhrasing', a.djPhrasing ?? true, 'Фильтр, передача баса на сильной доле и короткое эхо — только там, где не режут вокальную фразу.', off || !a.eqHandoff || a.stemMixing === false),
      sw('Стабильный темп вокала', 'masterTempo', a.masterTempo ?? true, 'При небольшой разнице темпа подстраивается следующий трек, а не текущий голос.', off || a.stemMixing === false),
      sw('Инструментальные петли', 'loopBridges', a.loopBridges ?? true, 'Затухающий финал поддерживается повтором подходящего такта без вокала.', off || !a.eqHandoff || a.stemMixing === false),
    ] },
    { title: 'Оформление', rows: [
      pick('Анимации', 'motion', s.ui.motion ?? 'system', [['system', 'Как в системе'], ['full', 'Полные анимации'], ['reduced', 'Минимум движения']], '«Минимум движения» заменяет визуализации статичным оформлением.', 'ui'),
    ] },
    { title: 'Медиатека', rows: [button('Проверить файлы', 'verifyLibrary', {}, { symbol: 'checkmark.circle' })] },
    { title: 'Ваши плейлисты с собой', footer: 'Сохраните названия, порядок песен и ссылки на записи. Аудиофайлы и подключения аккаунтов в копию не входят.', rows: backupRows },
    { title: 'Тонкая настройка переходов', footer: 'Это пределы: точные точки и длину AutoMix выбирает по анализу музыки.', rows: [
      ...((a.entryMode ?? 'smart') === 'smart' ? [slide('Пропуск вступления', 'maxEntrySkipSeconds', a.maxEntrySkipSeconds ?? 45, 0, 75, 1, 'с', 'Насколько глубоко можно войти в следующий трек.')] : []),
      slide('Изменение темпа', 'maxStretchPercent', a.maxStretchPercent, 0, 16, 0.5, '%', 'Предел для каждого трека, высота тона сохраняется.'),
      slide('Длина перехода', 'maxBlendSeconds', a.maxBlendSeconds, 8, 48, 1, 'с', 'Сколько максимум звучат два трека вместе.'),
      slide('Резервный кроссфейд', 'fallbackSeconds', a.fallbackSeconds, 1, 12, 1, 'с', 'Пока анализ трека не готов.'),
    ] },
  ];
  if (health) sections.push({ title: 'Служебные сведения', rows: [
    text('Декодер', health.ffmpeg ?? 'ffmpeg не найден', health.ffmpeg ? 'Готов' : 'Нет', health.ffmpeg ? 'ok' : 'warn'),
    text('Анализ звука', `Анализатор ${health.analyzer}, планировщик ${health.planner}, потоков ${health.analysis.workers}.`, `в работе ${health.analysis.running} · в очереди ${health.analysis.queued}`),
    text('Кэш звука', `${mbRaw(health.pcmCacheBytes)} из ${mbRaw(health.pcmCacheLimit)}${health.pcmCacheProtectedBytes ? `, сейчас используется ${mbRaw(health.pcmCacheProtectedBytes)}` : ''}. Старое удаляется само; текущий и следующий трек сохраняются.`),
    button('Очистить кэш звука', 'clearCache', {}, { confirm: { title: 'Очистить кэш звука?', text: 'Декодированный звук и сохранённые планы переходов будут удалены и созданы заново при воспроизведении. Медиатека, анализ и история не затрагиваются.', button: 'Очистить' } }),
  ] });
  sections.push({ rows: [{ kind: 'link', title: 'Посмотреть, как сводятся треки', symbol: 'chart.xyaxis.line', path: '/diagnostics' }] });
  return { title: 'Настройки', refresh: 10, sections };
}
const mbRaw = (bytes: number) => `${(bytes / MB).toFixed(0)} МБ`;

// MARK: Diagnostics

let diagSelection = 'next';

async function diagnostics(): Promise<Screen> {
  const trackId = route().query.get('track');
  if (trackId) return trackAnalysis(trackId);
  const s = st(), p = s.player;
  const [log, health] = await Promise.all([api.transitions(30).then((r) => r.items, () => [] as TransitionLogItem[]), api.health().catch(() => null)]);
  const live = p.transition?.plan ?? p.nextPlan;
  const last = p.lastTransition ?? (log[0] ? { plan: log[0].plan } : null);
  const chosen = diagSelection === 'next' ? (live ? { plan: live } : last) : (() => { const l = log.find((x) => String(x.id) === diagSelection); return l ? { plan: l.plan } : null; })();
  const checks = healthChecks(health, p.audioHealth, chosen?.plan, s.settings?.automix.enabled !== false);
  const worst = checks.some((c) => c.tone === 'warn') ? 'Есть что проверить' : checks.some((c) => !c.tone) ? 'Всё работает' : 'Всё в порядке';
  const sections: Section[] = [{ title: worst, rows: checks.map((c) => text(c.text, undefined, undefined, c.tone)) }];
  const options: [string, string][] = [['next', p.transition?.active ? 'Идёт сейчас' : live ? 'Запланирован' : 'Последний'],
    ...log.map((l) => [String(l.id), `${trackOf(l.fromTrackId)?.title ?? '?'} → ${trackOf(l.toTrackId)?.title ?? '?'} · ${fmtDate(l.executedAt)}`] as [string, string])];
  const transition: Row[] = [{ kind: 'choice', title: 'Какой переход показать', value: diagSelection, options, act: { name: 'diagSelect' } }];
  if (chosen) {
    const plan = chosen.plan, ba = plan.beatAlign;
    transition.push(
      button('Послушать переход', 'previewPair', { from: plan.fromTrackId, to: plan.toTrackId }, { symbol: 'play.fill', style: 'primary' }),
      text(methodShort(plan), plan.vocalA || plan.vocalB || plan.voiceEcho ? 'План с отдельными вокальными партиями' : 'План по исходному звуку треков'),
      text('Выход из трека', trackOf(plan.fromTrackId)?.title ?? 'Текущий трек', fmtTime(plan.aExit)),
      text('Вход в следующий', trackOf(plan.toTrackId)?.title ?? 'Следующий трек', fmtTime(plan.bEntry)),
      text('Уверенность', plan.fallbackReason ?? undefined, `${Math.round(plan.confidence * 100)} %`),
      text('Длительность', undefined, `${plan.duration.toFixed(2)} с${plan.gap ? `, пауза ${plan.gap.toFixed(2)} с` : ''}`),
    );
    if (ba) transition.push(
      text('Темп', undefined, `${ba.bpmA.toFixed(2)} → ${ba.bpmB.toFixed(2)} BPM${ba.relation !== 1 ? ` (×${ba.relation})` : ''}`),
      text('Наложение', undefined, `${ba.overlapBeats} ${plural(ba.overlapBeats, 'доля', 'доли', 'долей')}${ba.phraseAligned ? ', по фразам' : ''}`),
    );
    transition.push({ kind: 'link', title: 'Анализ выходящего трека', path: `/diagnostics?track=${encodeURIComponent(plan.fromTrackId)}` },
      { kind: 'link', title: 'Анализ входящего трека', path: `/diagnostics?track=${encodeURIComponent(plan.toTrackId)}` });
  } else transition.push(text('Послушайте пару треков', 'Выберите музыку в медиатеке и включите AutoMix. Здесь появятся выбранные точки входа и выхода и причины перехода.'));
  // The waveform and automation charts stay on the web page.
  transition.push({ kind: 'link', title: 'Графики перехода', symbol: 'chart.xyaxis.line', path: '/diagnostics/charts' });
  sections.push({ title: 'Переходы', rows: transition });
  const h = p.audioHealth;
  sections.push({ title: 'Технические подробности', footer: 'Счётчики относятся к текущему запуску плеера.', rows: [
    ...(h ? [text('Нехватка звука', 'Сколько раз плееру не хватило готового звука', String(h.pcmUnderruns)),
      text('Долгие блоки', 'Задержка вычисления, не обязательно слышимая', `${h.slowBlocks} · до ${h.maxRenderMs.toFixed(1)} мс`),
      text('Буфер устройства', undefined, `${h.latencyMs.toFixed(0)} мс`)] : [text('Счётчики появятся после начала воспроизведения.')]),
    ...(health ? [text('Анализ', `Анализатор ${health.analyzer}, планировщик ${health.planner}`, `потоков ${health.analysis.workers}`)] : []),
  ] });
  return { title: 'Диагностика AutoMix', sections };
}

function healthChecks(health: HealthStatus | null, audio: { pcmUnderruns: number } | undefined, plan: { fallbackReason?: string | null; confidence: number } | undefined, automixOn: boolean) {
  const out: { tone?: 'ok' | 'warn'; text: string }[] = [];
  if (!health) out.push({ tone: 'warn', text: 'Нет связи со встроенным сервером MORA. Перезапустите приложение, если это не пройдёт.' });
  if (health && !health.ffmpeg) out.push({ tone: 'warn', text: 'Декодер звука не найден — файлы не воспроизводятся.' });
  if (!automixOn) out.push({ text: 'AutoMix выключен в настройках: треки играют подряд без переходов.' });
  if (audio) out.push(audio.pcmUnderruns > 0 ? { tone: 'warn', text: `Звук прерывался: ${audio.pcmUnderruns} ${plural(audio.pcmUnderruns, 'раз', 'раза', 'раз')} с запуска.` } : { tone: 'ok', text: 'Звук идёт без пропусков.' });
  if (health) {
    const pending = health.analysis.running + health.analysis.queued;
    out.push(pending > 0 ? { text: `Анализируем треки: осталось ${pending}. Пока анализ не готов, переходы проще.` } : { tone: 'ok', text: 'Все треки проанализированы.' });
  }
  if (plan) out.push(plan.fallbackReason ? { text: `Переход упрощён: ${plan.fallbackReason}` } : { tone: 'ok', text: `Переход рассчитан, уверенность ${Math.round(plan.confidence * 100)} %.` });
  return out;
}

async function trackAnalysis(id: string): Promise<Screen> {
  const t = trackOf(id);
  const r = await api.analysis(id).catch((e: Error) => ({ status: e.message, analysis: null, error: null }));
  const a = r.analysis;
  const rows: Row[] = [text(t?.title ?? 'Трек', t?.artist)];
  if (!a) rows.push(text('Анализ', undefined, r.status === 'error' ? `ошибка: ${r.error}` : r.status === 'done' ? 'готов' : 'ещё не готов'));
  else rows.push(
    text('Темп', undefined, a.beat ? `${a.beat.bpm.toFixed(2)} BPM, уверенность ${Math.round(a.beat.confidence * 100)} %` : 'устойчивого ритма нет'),
    ...(a.beat ? [text('Сетка', undefined, `${a.beat.stable ? 'постоянный темп' : 'плавающий темп'}, разброс ${a.beat.jitterMs} мс, долей ${a.beat.beats.length}`),
      text('Сильные доли', undefined, `уверенность ${Math.round(a.beat.downbeatConfidence * 100)} %`)] : []),
    text('Фразы', undefined, `${a.phrases.length} (уверенность ${Math.round(a.phraseConfidence * 100)} %)`),
    text('Тональность', undefined, `${keyNameRu(a.key)}${a.key.camelot ? ` (${a.key.camelot}), уверенность ${Math.round(a.key.confidence * 100)} %` : ''}`),
    text('Громкость', undefined, `${a.loudness.integratedLufs.toFixed(1)} LUFS, пик ${a.loudness.truePeakDb.toFixed(1)} dBTP`),
    text('Звук', undefined, `${fmtTime(a.audibleStart)}–${fmtTime(a.audibleEnd)} из ${fmtTime(a.duration)}`),
    text('Энергия', undefined, `${Math.round(a.features.energy * 100)} %`),
    text('Вокальная партия', a.vocalActivity ? `Подготовлена локально · Demucs (${a.vocalActivity.model})` : 'Ещё не подготовлена'),
    text('Анализ занял', undefined, `${(a.elapsedMs / 1000).toFixed(1)} с · ${a.version}`),
    ...(a.warnings.length ? [text('Пометки', a.warnings.join(', '))] : []),
  );
  rows.push({ kind: 'link', title: 'Волновая форма', symbol: 'waveform', path: `/diagnostics/charts?track=${encodeURIComponent(id)}` });
  return { title: 'Анализ трека', sections: [{ rows }] };
}

// MARK: routes and actions

/** The native page for a hash route, or null when it stays web (NativeRoute in NativeShellState.swift lists the same routes). */
export function describe(): Promise<Screen> | Screen | null {
  const { parts } = route();
  const [a, b, c] = parts;
  if (a === 'library' && !c) return b === 'albums' ? albums() : b === 'artists' ? artists() : b === 'playlists' ? playlists() : null;
  if (a === 'album' && parts.length === 3) return album(b, c);
  if (a === 'artist' && parts.length === 2) return artist(b);
  if (a === 'playlist' && parts.length === 2) return playlist(b);
  if (parts.length === 1) {
    switch (a) {
      case 'history': return history();
      case 'wave': return wave();
      case 'downloads': return downloads();
      case 'import': return importPage();
      case 'sources': return sources();
      case 'settings': return settings();
      case 'diagnostics': return diagnostics();
    }
  }
  return null;
}

type Args = Record<string, unknown>;
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const form = (a: Args) => (a.form && typeof a.form === 'object' ? a.form as Record<string, string> : {});
const PLAY_TYPES = ['library', 'album', 'artist', 'playlist', 'liked', 'search', 'history'] as const;
const playContext = (a: Args) => ({ type: PLAY_TYPES.find((x) => x === a.type) ?? 'library', id: str(a.id) || undefined, label: str(a.label) || 'Медиатека' });
const SETTING_GROUPS = ['automix', 'wave', 'ui', 'downloads', 'yandex'] as const;

async function importBody(body: Parameters<typeof api.startImport>[0]) { importJob = await api.startImport(body); }

export const actions: Record<string, (a: Args) => unknown> = {
  playAll: (a) => {
    const list = ids(a.ids).filter((id) => trackOf(id)?.status === 'ok');
    if (!list.length) return;
    const shuffle = a.shuffle === true;
    if (shuffle !== controller.state.shuffle) controller.toggleShuffle();
    return controller.playTracks(list, shuffle ? Math.floor(Math.random() * list.length) : 0, playContext(a));
  },
  likeAll: async (a) => {
    const list = ids(a.ids).map((id) => trackOf(id)).filter((t): t is Track => !!t);
    const { liked, failed } = await likeEach(toLike(list, (t) => t.reaction), likeLibraryTrack);
    st().toast(likeAllSummary(liked, failed, list.filter((t) => t.reaction < 0).length), failed ? 'error' : 'success');
  },
  artistRadio: (a) => startArtistRadio(str(a.artist)),
  createPlaylist: async (a): Promise<ActResult | void> => {
    const name = str(a.value).trim();
    if (!name) return;
    const pl = await api.createPlaylist(name);
    await st().loadPlaylists();
    return { go: `/playlist/${pl.id}` };
  },
  renamePlaylist: async (a) => {
    const name = str(a.value).trim();
    if (!name) return;
    await api.renamePlaylist(str(a.id), name);
    await st().loadPlaylists();
  },
  deletePlaylist: async (a): Promise<ActResult> => { await api.deletePlaylist(str(a.id)); await st().loadPlaylists(); return { go: '/library/playlists' }; },
  exportPlaylist: async (a): Promise<ActResult> => ({ share: { name: 'MORA-playlist.json', text: await (await fetch(`/api/backup/playlists?playlist=${encodeURIComponent(str(a.id))}`)).text() } }),
  removeFromPlaylist: async (a) => {
    await api.removeFromPlaylist(str(a.id), Number(a.entry));
    await st().loadPlaylists();
    st().toast('Убрано из плейлиста');
  },
  /** `from` and `to` are positions in `entries`, as SwiftUI's onMove gives them. */
  reorderPlaylist: async (a) => {
    const entries = Array.isArray(a.entries) ? a.entries.map(Number) : [];
    const from = Number(a.from), to = Number(a.to);
    if (!entries[from]) return;
    const [x] = entries.splice(from, 1);
    entries.splice(to > from ? to - 1 : to, 0, x);
    try { await api.reorderPlaylist(str(a.id), entries); }
    catch (error) { st().toast(`Не удалось сохранить порядок: ${(error as Error).message}`, 'error'); }
  },
  clearHistory: () => api.clearHistory(),
  waveSource: (a) => { const v = str(a.value); waveSource = v === 'online' || v === 'yandex' ? v : 'own'; },
  waveLaunch: (a) => {
    const source = str(a.source), s = st(), radio = useRadio.getState();
    const active = radio.active ? 'online' : s.player.context?.type === 'yandex-wave' ? 'yandex' : s.player.context?.type === 'wave' ? 'own' : null;
    if (active === source) return controller.toggle();
    return source === 'online' ? startRadio() : controller.startWave(source === 'yandex' ? 'yandex' : 'own');
  },
  next: () => controller.nextTrack(),
  jump: (a) => controller.jumpTo(Number(a.index)),
  queue: () => st().setQueueOpen(true),
  react: (a) => { const t = trackOf(str(a.id)), v = Number(a.value); return t && [-1, 0, 1].includes(v) ? reactTrack(t, v) : undefined; },
  /** A settings switch, menu or slider: `group.key = value` (mapped through `map` or to a number when asked). */
  set: async (a) => {
    const s = st().settings, group = SETTING_GROUPS.find((g) => g === a.group), key = str(a.key);
    if (!s || !group || !key) return;
    let value = a.value;
    if (a.map && typeof a.map === 'object') value = (a.map as Record<string, unknown>)[String(value)];
    else if (a.num === true) value = value === 'off' ? null : Number(value);
    await st().saveSettings({ [group]: { ...s[group], [key]: value } });
  },
  yandexSeed: async (a) => {
    const s = st().settings;
    if (!s) return;
    const group = ids(a.group), seed = str(a.value);
    const rest = (s.wave.yandexSeeds ?? []).filter((x) => !group.includes(x));
    await st().saveSettings({ wave: { ...s.wave, yandexSeeds: seed ? [...rest, seed] : rest } });
    await controller.refreshYandexWave();
  },
  downloadAction: (a) => {
    const action = str(a.action);
    if (action === 'pause' || action === 'resume' || action === 'cancel' || action === 'retry') return api.downloadAction(str(a.id), action);
  },
  removeDownload: async (a) => { await api.removeDownload(str(a.id)); st().patchTrack(str(a.id), { pinned: false }); },
  cacheLimit: (a) => api.setCacheLimit(Number(a.value)),
  clearAudioCache: async () => { const r = await api.clearAudioCache(); st().toast(r.removed ? `Удалено файлов: ${r.removed}` : 'Нечего очищать'); },
  importUrl: (a) => { const url = (form(a).url ?? '').trim(); return url ? importBody({ url }) : undefined; },
  importFile: (a) => importBody({ file: { name: str(a.name), text: fileText(a) } }),
  openImport: async (a) => { importJob = await api.importJob(str(a.id)); },
  closeImport: () => { importJob = null; },
  deleteImport: (a) => api.deleteImport(str(a.id)),
  resolveImport: async (a) => { if (importJob) importJob = await api.resolveImport(importJob.id, Number(a.position), (a.choice ?? null) as Parameters<typeof api.resolveImport>[2]); },
  /** The version picker is a web sheet; native steps aside while it is open (uiState.overlay). */
  pickImport: (a) => {
    const job = importJob, row = job?.rows.find((r) => r.position === Number(a.position));
    if (!job || !row) return;
    openVersionPanel({ title: row.title, artist: row.artist, duration: row.duration ?? 0, onPick: (p) => void api.resolveImport(job.id, row.position,
      'trackId' in p ? p : { provider: p.audioProvider, externalId: p.externalId, title: p.title, artist: p.artist, duration: p.duration, coverUrl: p.coverUrl, labels: p.labels })
      .then((j) => { importJob = j; }, (e: Error) => st().toast(e.message, 'error')) });
  },
  importUncertain: (a) => { importUncertain = a.value === true; },
  importPlaylist: async () => {
    if (!importJob) return;
    importJob = await api.importPlaylist(importJob.id, importUncertain);
    await Promise.all([st().loadPlaylists(), st().loadLibrary()]);
    st().toast('Плейлист готов', 'success');
  },
  importAudio: (a) => importFiles([new File([decode(a.base64)], str(a.name))]),
  checkSources: () => st().loadProviders(true),
  connectSource: async (a) => {
    const p = st().providers.find((x) => x.id === str(a.id));
    if (!p) return;
    const values = form(a), config: Record<string, string> = {}, secret: Record<string, string> = {};
    for (const f of p.configFields) (f.secret ? secret : config)[f.key] = values[`${p.id}.${f.key}`] ?? '';
    await api.connectProvider(p.id, config, secret);
    st().toast(`${p.name}: подключено`, 'success');
    await st().loadProviders(true);
  },
  disconnectSource: async (a) => {
    const p = st().providers.find((x) => x.id === str(a.id));
    if (!p) return;
    await api.disconnectProvider(p.id);
    await st().loadProviders(true);
    st().toast(`${p.name}: отключено`);
  },
  yandexLikes: async (a) => {
    const kind = str(a.kind);
    await (kind === 'start' ? api.startYandexLikes() : kind === 'pause' ? api.pauseYandexLikes() : kind === 'cancel' ? api.cancelYandexLikes() : api.resumeYandexLikes(kind === 'retry'));
    void st().loadLibrary();
  },
  providerSearch: async (a) => {
    const id = str(a.id), q = a.all === true ? '' : form(a)[`${id}.q`] ?? '';
    browse.set(id, { items: (await api.providerSearch(id, q)).items, added: browse.get(id)?.added ?? new Map() });
  },
  providerImport: async (a) => {
    const id = str(a.id), b = browse.get(id), t = b?.items.find((x) => x.externalId === str(a.external));
    if (!b || !t) return;
    const { trackId } = await api.providerImport(id, t);
    b.added.set(t.externalId, trackId);
    await st().loadLibrary();
    st().toast(`«${t.title}» в медиатеке`, 'success');
  },
  providerPlay: (a) => {
    const b = browse.get(str(a.id)), p = st().providers.find((x) => x.id === str(a.id));
    if (!b) return;
    const list = b.items.map((i) => i.libraryTrackId ?? b.added.get(i.externalId)).filter((x): x is string => !!x);
    return controller.playTracks(list, Math.max(0, list.indexOf(str(a.track))), { type: 'search', label: p?.name ?? '' });
  },
  /** «Выбрать все» and «В медиатеку» / «В Любимое» of the web provider browser. */
  providerBatch: async (a) => {
    const id = str(a.id), b = browse.get(id), like = a.like === true;
    if (!b) return;
    const chosen = b.items.filter((t) => t.playable), byKey = new Map(chosen.map((t) => [t.externalId, t]));
    const r = await addBatch(chosen.map((t) => ({ key: t.externalId, trackId: t.libraryTrackId ?? b.added.get(t.externalId) ?? null })), like, {
      importOne: async ({ key }) => { const { trackId } = await api.providerImport(id, byKey.get(key)!); b.added.set(key, trackId); return trackId; },
      isLiked: async (trackId) => (await api.track(trackId)).reaction > 0,
      like: async (trackId) => { await api.react(trackId, 1); },
      onProgress: () => {},
      cancelled: () => false,
    });
    if (like && r.added.length) await api.orderFavorites([...new Set(r.added)]).catch(() => {});
    await st().loadLibrary();
    st().toast(`Добавлено ${like ? 'в Любимое' : 'в медиатеку'}: ${r.added.length}${r.failed ? `, не удалось: ${r.failed}${r.error ? ` (${r.error})` : ''}` : ''}`, r.failed ? 'error' : 'success');
  },
  verifyLibrary: async () => {
    const r = await api.verify();
    await st().loadLibrary();
    st().toast(r.missing ? `Не найдено файлов: ${r.missing}` : 'Все файлы на месте', r.missing ? 'error' : 'success');
  },
  exportPlaylists: async (): Promise<ActResult> => ({ share: { name: 'MORA-playlists.json', text: await (await fetch('/api/backup/playlists')).text() } }),
  inspectBackup: (a) => {
    backupMessage = '';
    const bytes = decode(a.base64);
    if (bytes.length > 16 * MB) throw new Error('Файл больше 16 МБ');
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data?.format !== 'mora-playlists' || data.version !== 1 || !Array.isArray(data.playlists)) throw new Error('Выберите резервную копию плейлистов MORA');
    backup = { data, count: data.playlists.length, name: str(a.name) };
  },
  restoreBackup: async () => {
    if (!backup) return;
    const r = await api.restorePlaylists(backup.data);
    await Promise.all([st().loadLibrary(), st().loadPlaylists()]);
    backupMessage = `Восстановлено плейлистов: ${r.playlists}.${r.missingFiles ? ` Не найдено локальных файлов: ${r.missingFiles}. Их места в плейлистах сохранены.` : ''}`;
    backup = null;
  },
  cancelBackup: () => { backup = null; },
  clearCache: () => api.clearCache(),
  diagSelect: (a) => { diagSelection = str(a.value) || 'next'; },
  previewPair: async (a) => { await controller.previewPair(str(a.from), str(a.to)); diagSelection = 'next'; },
};
