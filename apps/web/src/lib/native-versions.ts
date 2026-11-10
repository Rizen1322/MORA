import { api, type PublicSource, type PublicTrack, type Track } from './api.ts';
import { controller, useApp } from '../store/app.ts';
import { sameSong } from '../components/VersionPanel.tsx';
import { ensurePublic, SOURCE_LABEL } from '../pages/Search.tsx';

type Args = Record<string, unknown>;
type Choice = { local?: Track; remote?: PublicTrack };
const searches = new Map<string, AbortController>();
const sessions = new Map<string, { target: string; choices: Map<string, Choice> }>();
const text = (value: unknown) => typeof value === 'string' ? value : '';
const resolve = async (args: Args) => {
  const session = sessions.get(text(args.session));
  const choice = session?.choices.get(text(args.key));
  if (!session || session.target !== args.target || !choice) throw Error('Результат поиска устарел. Повторите поиск.');
  return choice.local ?? ensurePublic(choice.remote!);
};

export const nativeVersionCommands = {
  versionSearch: async (args: Args) => {
    const target = useApp.getState().tracks.get(text(args.target));
    if (!target) throw Error('Трек не найден');
    searches.get(target.id)?.abort();
    const cancel = new AbortController();
    searches.set(target.id, cancel);
    const query = text(args.query).trim().slice(0, 200);
    const sources: PublicSource[] = ['ytmusic', 'youtube', 'soundcloud'];
    const selected = sources.includes(args.source as PublicSource) ? [args.source as PublicSource] : sources;
    const choices = new Map<string, Choice>();
    const rows: Record<string, unknown>[] = [];
    const row = (key: string, track: Track | PublicTrack, source: string) => ({
      key, source, id: key, title: track.title, artist: track.artist, album: track.album, duration: track.duration,
      cover: track.coverUrl, ok: 'status' in track ? track.status === 'ok' : track.playable,
      tags: 'labels' in track ? track.labels.map(label => label.tag).join(' · ') : '',
    });
    for (const id of useApp.getState().order) {
      const track = useApp.getState().tracks.get(id);
      if (!track || id === target.id || !sameSong(target.title, track.title)) continue;
      const key = `local:${id}`;
      choices.set(key, { local: track }); rows.push(row(key, track, 'Медиатека'));
    }
    const results = await Promise.allSettled(selected.map(async source => ({ source, items: (await api.publicSearch(source, query, cancel.signal)).items })));
    if (searches.get(target.id) === cancel) searches.delete(target.id);
    const errors: string[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') { errors.push(`${SOURCE_LABEL[selected[index]]}: ${(result.reason as Error).message}`); continue; }
      for (const track of result.value.items.filter(track => sameSong(target.title, track.title)).slice(0, 8)) {
        const key = `${result.value.source}:${track.externalId}`;
        choices.set(key, { remote: track }); rows.push(row(key, track, SOURCE_LABEL[result.value.source]));
      }
    }
    const session = text(args.request);
    if (!session) throw Error('Нет идентификатора поиска');
    sessions.set(session, { target: target.id, choices });
    if (sessions.size > 8) sessions.delete(sessions.keys().next().value!);
    return { session, rows, errors };
  },
  versionSource: async (args: Args) => {
    const track = await resolve(args);
    const response = await fetch('/api/mobile/native-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ trackId: track.id, entryId: 'version-preview', file: 0 }], previousId: track.id }) });
    if (!response.ok) throw Error('Не удалось подготовить прослушивание');
    const manifest = await response.json();
    if (!manifest.items?.[0]?.source) throw Error('Запись недоступна');
    return { trackId: track.id, source: manifest.items[0].source };
  },
  versionAudio: async (args: Args) => {
    const track = await resolve(args), offset = Number(args.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 128 * 1024 * 1024) throw Error('Некорректная позиция файла');
    const response = await fetch(`/api/tracks/${encodeURIComponent(track.id)}/audio`, { headers: { Range: `bytes=${offset}-${offset + 262143}` } });
    if (response.status !== 206) throw Error('Не удалось прочитать запись');
    const total = Number(response.headers.get('Content-Range')?.split('/')[1]);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!Number.isSafeInteger(total) || total > 128 * 1024 * 1024 || !bytes.length || bytes.length > 262144 || offset + bytes.length > total) throw Error('Некорректный аудиофайл');
    let binary = '';
    for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    return { base64: btoa(binary), total };
  },
  versionPause: () => {
    const playing = controller.state.status === 'playing' || controller.state.status === 'buffering';
    if (playing) controller.pause();
    return { playing, intent: controller.intentVersion };
  },
  versionResume: (args: Args) => {
    if (args.playing === true && args.intent === controller.intentVersion) return controller.resume();
  },
  versionApply: async (args: Args) => {
    const id = text(args.target), target = useApp.getState().tracks.get(id);
    if (!target) throw Error('Трек не найден');
    if (args.mode === 'separate') {
      const chosen = await resolve(args);
      await api.saveTrack(chosen.id); useApp.getState().upsertTrack({ ...chosen, saved: true });
      return { saved: true };
    }
    const assetId = args.mode === 'restore' ? null : (await resolve(args)).id;
    await api.bindRecording(id, assetId);
    useApp.getState().upsertTrack(await api.track(id));
    const current = controller.currentEntry?.trackId === id;
    if (current) await controller.startAt(controller.state.index, 0, 'skip', args.resume !== true);
    else controller.onRecordingChanged(id);
    return { saved: true };
  },
};
