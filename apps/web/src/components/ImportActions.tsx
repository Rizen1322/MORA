import { useRef, useState } from 'react';
import { FolderOpen, UploadSimple, HardDrives } from '@phosphor-icons/react';
import { api } from '../lib/api.ts';
import { importFiles } from '../lib/importer.ts';
import { desktop } from '../lib/desktop.ts';
import { useApp } from '../store/app.ts';
import { Modal } from './common.tsx';

export function ImportActions({ compact = false }: { compact?: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [pathOpen, setPathOpen] = useState(false);
  const toast = useApp((s) => s.toast);
  // The Windows app shows the system folder picker instead of a typed path.
  const linkFolder = async () => {
    if (!desktop) return setPathOpen(true);
    const dir = await desktop.pickFolder();
    if (!dir) return;
    try {
      const r = await api.importFolder(dir);
      toast(r.total ? `Найдено файлов: ${r.total}. Добавляю в фоне…` : 'В папке не найдено аудиофайлов', r.total ? 'info' : 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <button className={`btn btn-primary ${compact ? 'btn-sm' : ''}`} onClick={() => files.current?.click()}>
        <UploadSimple size={18} weight="bold" /> Выбрать файлы
      </button>
      <button className={`btn btn-secondary ${compact ? 'btn-sm' : ''}`} onClick={() => folder.current?.click()}>
        <FolderOpen size={18} /> Папку
      </button>
      <button className={`btn btn-ghost ${compact ? 'btn-sm' : ''}`} onClick={() => void linkFolder()} title="Файлы останутся на месте, приложение запомнит путь">
        <HardDrives size={18} /> Папка на диске
      </button>
      <input ref={files} type="file" multiple accept="audio/*,.flac,.opus,.m4a,.wv,.ape,.alac,.aiff,.aif" hidden onChange={(e) => e.target.files && void importFiles(Array.from(e.target.files)).finally(() => (e.target.value = ''))} />
      <input
        ref={folder}
        type="file"
        hidden
        // non-standard but supported by Chromium, Firefox and Safari
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => e.target.files && void importFiles(Array.from(e.target.files)).finally(() => (e.target.value = ''))}
      />
      {pathOpen && <FolderPathModal onClose={() => setPathOpen(false)} />}
    </div>
  );
}

function FolderPathModal({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useApp((s) => s.toast);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importFolder(p.trim());
      toast(r.total ? `Найдено файлов: ${r.total}. Добавляю в фоне…` : 'В папке не найдено аудиофайлов', r.total ? 'info' : 'error');
      if (r.total) onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Папка на этом компьютере"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!p.trim() || busy} onClick={submit}>
            Добавить
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="folder-path">Полный путь к папке</label>
        <input id="folder-path" className="input" placeholder="D:\Музыка" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} aria-describedby="folder-help" />
        <span id="folder-help" className="caption dim">
          Файлы не копируются: приложение читает их на месте. Если переместить или удалить файлы, трек будет отмечен как недоступный.
        </span>
        {err && <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>
    </Modal>
  );
}
