import { create } from 'zustand';
import { api } from '../lib/api.ts';
import { CatalogPlayer } from '../lib/catalog-player.ts';
import { controller, useApp } from './app.ts';
import { radioIdentity } from '../lib/radio-taste.ts';

export const catalogPlayer = new CatalogPlayer({
  transport: controller,
  known: (track) => track.libraryTrackId,
  exists: (id) => useApp.getState().tracks.get(id)?.status === 'ok',
  prepare: async (track) => {
    const result = await api.providerImport('yandex', track);
    await useApp.getState().loadLibrary();
    return result.trackId;
  },
  notify: (message) => useApp.getState().toast(message),
});
export const useCatalogPlayback = create(() => catalogPlayer.state);
catalogPlayer.subscribe((state) => useCatalogPlayback.setState(state));

/** Same queue logic for public search results: prepares the chosen recording and two ahead. */
export const publicPlayer = new CatalogPlayer({
  allow: (track) => controller.state.context?.type !== 'online-radio' || ![...useApp.getState().tracks.values()].some(t => t.reaction < 0 && radioIdentity(t) === radioIdentity(track)),
  key: (track) => `${(track as unknown as { audioProvider?: string }).audioProvider ?? 'youtube'}:${track.externalId}`,
  transport: controller,
  known: (track) => track.libraryTrackId,
  exists: (id) => useApp.getState().tracks.get(id)?.status === 'ok',
  prepare: async (track) => {
    const provider = (track as unknown as { audioProvider?: 'youtube' | 'soundcloud' }).audioProvider ?? 'youtube';
    const { trackId } = await api.publicPrepare(provider, track.externalId, 0);
    useApp.getState().upsertTrack(await api.track(trackId));
    return trackId;
  },
  notify: (message) => useApp.getState().toast(message),
});
export const usePublicPlayback = create(() => publicPlayer.state);
publicPlayer.subscribe((state) => usePublicPlayback.setState(state));
