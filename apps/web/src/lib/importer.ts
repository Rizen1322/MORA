import { uploadFile } from './api.ts';
import { useApp } from '../store/app.ts';

const AUDIO = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|alac|aiff?|wma|wv|ape|mka|webm)$/i;

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void };
}

async function walk(entry: FsEntry, out: File[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File | null>((res) => entry.file!(res, () => res(null)));
    if (f) out.push(f);
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

/** Collects files from a drop event, descending into dropped folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.()).filter(Boolean) as FsEntry[];
  if (entries.length) {
    for (const e of entries) await walk(e, out);
  } else {
    out.push(...Array.from(dt.files ?? []));
  }
  return out;
}

let running = false;

/** Uploads files into the library, two at a time, reporting progress in the store. */
export async function importFiles(files: File[]): Promise<void> {
  const audio = files.filter((f) => AUDIO.test(f.name));
  const skipped = files.length - audio.length;
  const st = useApp.getState();
  if (!audio.length) {
    st.toast(files.length ? 'Среди выбранных файлов нет аудио поддерживаемых форматов' : 'Файлы не выбраны', 'error');
    return;
  }
  if (running) {
    st.toast('Импорт уже идёт, дождитесь окончания', 'info');
    return;
  }
  running = true;
  const job = { total: audio.length, done: 0, failed: [] as { name: string; error: string }[], duplicates: 0, current: null as string | null, active: true };
  st.setUpload({ ...job });
  let i = 0;
  const worker = async () => {
    while (i < audio.length) {
      const f = audio[i++];
      job.current = f.name;
      useApp.getState().setUpload({ ...job });
      try {
        const r = await uploadFile(f);
        if (r.duplicate) job.duplicates++;
      } catch (e) {
        job.failed.push({ name: f.name, error: (e as Error).message });
      }
      job.done++;
      useApp.getState().setUpload({ ...job });
    }
  };
  await Promise.all([worker(), worker()]);
  job.active = false;
  job.current = null;
  useApp.getState().setUpload({ ...job });
  running = false;
  const added = job.total - job.failed.length - job.duplicates;
  const parts = [`Добавлено: ${added}`];
  if (job.duplicates) parts.push(`уже были: ${job.duplicates}`);
  if (job.failed.length) parts.push(`с ошибками: ${job.failed.length}`);
  if (skipped) parts.push(`пропущено не аудио: ${skipped}`);
  useApp.getState().toast(parts.join(', '), job.failed.length ? 'error' : 'success');
  await useApp.getState().loadLibrary();
  if (!job.failed.length) setTimeout(() => useApp.getState().setUpload(null), 2500);
}
