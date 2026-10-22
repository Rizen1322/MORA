import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowBendDownRight, Heart, HeartBreak, ListPlus, MusicNotesPlus, PencilSimple, Play, Trash, User, VinylRecord, ChartLine, ArrowSquareOut, Waveform, Swap, DownloadSimple, Radio } from '@phosphor-icons/react';
import { startRadio } from '../lib/radio.ts';
import { openVersionPanel } from './VersionPanel.tsx';
import { api, type Track } from '../lib/api.ts';
import { trackAlbumHref, trackArtistLinks, go } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { ConfirmModal, Menu, Modal, PromptModal } from './common.tsx';
import { react } from './TrackList.tsx';

export function TrackMenu({ track, x, y, onClose, onPlay, extra }: { track: Track; x: number; y: number; onClose: () => void; onPlay: () => void; extra?: ReactNode }) {
  const [modal, setModal] = useState<'playlist' | 'edit' | 'delete' | null>(null);
  const toast = useApp((s) => s.toast);
  const close = () => {
    setModal(null);
    onClose();
  };
  return createPortal(
    <>
      {!modal && (
        <Menu x={x} y={y} onClose={onClose}>
          <button role="menuitem" onClick={onPlay} disabled={track.status !== 'ok'}>
            <Play size={18} /> Слушать
          </button>
          <button
            role="menuitem"
            onClick={() => {
              controller.addToQueue([track.id], true);
              toast(`«${track.title}» сыграет следующим`);
            }}
          >
            <ArrowBendDownRight size={18} /> Играть следующим
          </button>
          <button
            role="menuitem"
            onClick={() => {
              controller.addToQueue([track.id]);
              toast('Добавлено в очередь');
            }}
          >
            <ListPlus size={18} /> Добавить в очередь
          </button>
          <button
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setModal('playlist');
            }}
          >
            <MusicNotesPlus size={18} /> Добавить в плейлист
          </button>
          {track.sourceKind === 'remote' && (
            <button role="menuitem" onClick={() => { onClose(); void (track.pinned ? api.removeDownload(track.id).then(() => toast('Загрузка удалена')) : api.download({ trackId: track.id }).then(() => toast('Скачиваем — прогресс в «Загрузках»'))).catch((e) => toast((e as Error).message, 'error')); }}>
              <DownloadSimple size={18} /> {track.pinned ? 'Удалить загрузку' : 'Скачать'}
            </button>
          )}
          <button role="menuitem" onClick={() => { onClose(); void startRadio({ title: track.title, artist: track.artist }); }}>
            <Radio size={18} /> Радио по треку
          </button>
          <button role="menuitem" onClick={() => { onClose(); openVersionPanel({ trackId: track.id, title: track.title, artist: track.artist, duration: track.duration }); }}>
            <Swap size={18} /> Найти другую версию
          </button>
          <hr />
          <button role="menuitem" onClick={() => void react(track, track.reaction > 0 ? 0 : 1)}>
            <Heart size={18} weight={track.reaction > 0 ? 'fill' : 'regular'} /> {track.reaction > 0 ? 'Убрать из любимого' : 'Нравится'}
          </button>
          <button role="menuitem" onClick={() => void react(track, track.reaction < 0 ? 0 : -1)}>
            <HeartBreak size={18} weight={track.reaction < 0 ? 'fill' : 'regular'} /> {track.reaction < 0 ? 'Отменить «Не нравится»' : 'Не нравится'}
          </button>
          <hr />
          {track.album && (
            <a role="menuitem" href={trackAlbumHref(track)}>
              <VinylRecord size={18} /> К альбому
            </a>
          )}
          {trackArtistLinks(track).map(artist => (
            <a key={artist.href} role="menuitem" href={artist.href}>
              <User size={18} /> {artist.name}
            </a>
          ))}
          <button role="menuitem" onClick={() => go(`/diagnostics?track=${track.id}`)}>
            <ChartLine size={18} /> Анализ звука
          </button>
          {track.mixingAllowed && (track.provider === 'local' || track.provider === 'yandex') && <button role="menuitem" onClick={async () => {
            try {
              const result = await api.rebuildVocals(track.id);
              toast(result.quality?.status === 'ready' ? 'Для этого трека уже готова новая обработка голоса' : 'Голос поставлен в очередь. Можно продолжать слушать.', 'success');
            }
            catch (error) { toast((error as Error).message, 'error'); }
          }}><Waveform size={18} /> Обновить обработку голоса</button>}
          {track.sourceUrl && (
            <a role="menuitem" href={track.sourceUrl} target="_blank" rel="noreferrer noopener">
              <ArrowSquareOut size={18} /> Страница у источника
            </a>
          )}
          <button
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setModal('edit');
            }}
          >
            <PencilSimple size={18} /> Изменить сведения
          </button>
          {extra}
          <hr />
          <button
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setModal('delete');
            }}
          >
            <Trash size={18} /> Удалить из медиатеки
          </button>
        </Menu>
      )}
      {modal === 'playlist' && <PlaylistPicker trackIds={[track.id]} onClose={close} />}
      {modal === 'edit' && <EditTrack track={track} onClose={close} />}
      {modal === 'delete' && (
        <ConfirmModal
          title="Удалить трек?"
          text={
            track.sourceKind === 'linked'
              ? `«${track.title}» исчезнет из медиатеки. Сам файл на диске останется на месте.`
              : `«${track.title}» и его копия в папке приложения будут удалены. Исходный файл, который вы загружали, не затрагивается.`
          }
          confirm="Удалить"
          danger
          onConfirm={async () => {
            await api.deleteTrack(track.id);
            await useApp.getState().loadLibrary();
            toast('Трек удалён');
          }}
          onClose={close}
        />
      )}
    </>,
    document.body,
  );
}

export function PlaylistPicker({ trackIds, onClose }: { trackIds: string[]; onClose: () => void }) {
  const playlists = useApp((s) => s.playlists);
  const toast = useApp((s) => s.toast);
  const [creating, setCreating] = useState(false);
  if (creating)
    return (
      <PromptModal
        title="Новый плейлист"
        label="Название"
        confirm="Создать"
        onSubmit={async (name) => {
          await api.createPlaylist(name, trackIds);
          await useApp.getState().loadPlaylists();
          toast(`Создан плейлист «${name}»`, 'success');
        }}
        onClose={onClose}
      />
    );
  return (
    <Modal title="Добавить в плейлист" onClose={onClose} actions={<button className="btn btn-ghost" onClick={onClose}>Закрыть</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
        <button className="side-item" onClick={() => setCreating(true)}>
          <MusicNotesPlus size={20} /> Новый плейлист
        </button>
        {playlists.map((p) => (
          <button
            key={p.id}
            className="side-item"
            onClick={async () => {
              const r = await api.addToPlaylist(p.id, trackIds);
              await useApp.getState().loadPlaylists();
              toast(`Добавлено в «${p.name}»: ${r.added}`, 'success');
              onClose();
            }}
          >
            <span className="ellipsis">{p.name}</span>
            <span className="meta" style={{ marginLeft: 'auto' }}>
              {p.count}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function EditTrack({ track, onClose }: { track: Track; onClose: () => void }) {
  const [v, setV] = useState({ title: track.title, artist: track.artist, album: track.album, genre: track.genre });
  const save = async () => {
    await api.updateTrack(track.id, v);
    useApp.getState().patchTrack(track.id, v);
    onClose();
  };
  return (
    <Modal
      title="Сведения о треке"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!v.title.trim()}>
            Сохранить
          </button>
        </>
      }
    >
      {(['title', 'artist', 'album', 'genre'] as const).map((k) => (
        <div className="field" key={k}>
          <label htmlFor={`edit-${k}`}>{{ title: 'Название', artist: 'Исполнитель', album: 'Альбом', genre: 'Жанр' }[k]}</label>
          <input id={`edit-${k}`} className="input" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        </div>
      ))}
      <p className="caption dim" style={{ margin: 0 }}>
        Изменения хранятся в медиатеке приложения, теги в самом файле не переписываются.
      </p>
    </Modal>
  );
}
