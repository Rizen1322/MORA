import { useRef, useState } from 'react';
import { DownloadSimple, UploadSimple } from '@phosphor-icons/react';
import { api } from '../lib/api.ts';
import { useApp } from '../store/app.ts';

export function PlaylistBackup() {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ data: unknown; count: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inspect = async (file?: File) => {
    setError(''); setMessage(''); setPending(null);
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('Файл больше 16 МБ');
      const data = JSON.parse(await file.text());
      if (data?.format !== 'mora-playlists' || data.version !== 1 || !Array.isArray(data.playlists)) throw new Error('Выберите резервную копию плейлистов MORA');
      setPending({ data, count: data.playlists.length, name: file.name });
    } catch (e) { setError((e as Error).message); }
  };
  const restore = async () => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.restorePlaylists(pending.data);
      await Promise.all([useApp.getState().loadLibrary(), useApp.getState().loadPlaylists()]);
      setMessage(`Восстановлено плейлистов: ${result.playlists}.${result.missingFiles ? ` Не найдено локальных файлов: ${result.missingFiles}. Их места в плейлистах сохранены.` : ''}`);
      setPending(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="playlist-backup" aria-labelledby="backup-heading">
    <h2 className="section-title" id="backup-heading">Ваши плейлисты с собой</h2>
    <p className="small muted">Сохраните названия, порядок песен и ссылки на записи. Аудиофайлы и подключения аккаунтов в копию не входят.</p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
      <a className="btn btn-secondary" href="/api/backup/playlists" download="MORA-playlists.json"><DownloadSimple size={17} /> Сохранить копию</a>
      <button className="btn btn-ghost" disabled={busy} onClick={() => input.current?.click()}><UploadSimple size={17} /> Восстановить из файла</button>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { void inspect(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
    {pending && <div className="setting" style={{ marginTop: 14 }}><div><strong>{pending.name}</strong><p className="desc">Плейлистов: {pending.count}. Будут созданы отдельные копии. Повторное восстановление этого набора обновит его копии.</p></div><div className="setting-control"><button className="btn btn-primary" disabled={busy} onClick={() => void restore()}>{busy ? 'Восстанавливаем…' : 'Восстановить'}</button><button className="btn btn-ghost" disabled={busy} onClick={() => setPending(null)}>Отмена</button></div></div>}
    {error && <p role="alert" className="error-text small">{error}</p>}
    {message && <p role="status" className="small muted">{message}</p>}
  </section>;
}
