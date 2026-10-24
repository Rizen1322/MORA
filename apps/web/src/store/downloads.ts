import { create } from 'zustand';
import { api, type DownloadJob } from '../lib/api.ts';

/** Download jobs, kept current by server events. */
export const useDownloads = create<{ jobs: Map<string, DownloadJob>; load: () => Promise<void>; upsert: (j: DownloadJob) => void }>((set, get) => ({
  jobs: new Map(),
  load: async () => {
    try { const r = await api.downloads(); set({ jobs: new Map(r.jobs.map((j) => [j.id, j])) }); } catch { /* offline */ }
  },
  upsert: (j) => { const m = new Map(get().jobs); m.set(j.id, j); set({ jobs: m }); },
}));
