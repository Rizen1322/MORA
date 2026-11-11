import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowBendDownRight, Heart, HeartBreak, ListPlus, MusicNotesPlus, PencilSimple, Play, Trash, User, VinylRecord, ChartLine, ArrowSquareOut, Waveform, Swap, DownloadSimple, Radio, CaretRight, ArrowLeft } from '@phosphor-icons/react';
import { startArtistRadio, startSimilar } from '../lib/radio.ts';
import { openVersionPanel } from './VersionPanel.tsx';
import { api, type Track } from '../lib/api.ts';
import { trackAlbumHref, trackArtistLinks, go } from '../lib/router.ts';
import { controller, useApp } from '../store/app.ts';
import { ConfirmModal, Menu, Modal, PromptModal } from './common.tsx';
import { react } from './TrackList.tsx';
import { desktop } from '../lib/desktop.ts';

export function TrackMenu({ track, x, y, onClose, onPlay, extra }: { track: Track; x: number; y: number; onClose: () => void; onPlay: () => void; extra?: ReactNode }) {
  const [modal, setModal] = useState<'playlist' | 'edit' | 'delete' | null>(null);
  const [section, setSection] = useState<'discover' | 'info' | 'manage' | null>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const toast = useApp((s) => s.toast);
  const finish = () => { onClose(); returnFocus.current?.focus(); };
  const close = () => {
    setModal(null);
    finish();
  };
  return createPortal(
    <>
      {!modal && (
        <Menu x={x} y={y} onClose={finish}>
          {section && <button role="menuitem" autoFocus onClick={(e) => { e.stopPropagation(); setSection(null); }}><ArrowLeft size={18} /> Назад</button>}
          {!section && <>
          <button role="menuitem" autoFocus onClick={onPlay} disabled={track.status !== 'ok'}>
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
          <hr />
          <button role="menuitem" onClick={(e) => { e.stopPropagation(); setSection('discover'); }}><Radio size={18} /> Найти похожее <CaretRight size={16} style={{ marginLeft: 'auto' }} /></button>
          <button role="menuitem" onClick={(e) => { e.stopPropagation(); setSection('info'); }}><VinylRecord size={18} /> Сведения о треке <CaretRight size={16} style={{ marginLeft: 'auto' }} /></button>
          <button role="menuitem" onClick={(e) => { e.stopPropagation(); setSection('manage'); }}><PencilSimple size={18} /> Ещё действия <CaretRight size={16} style={{ marginLeft: 'auto' }} /></button>
          </>}
          {section === 'discover' && <>
          <button role="menuitem" onClick={() => { onClose(); void startSimilar(track); }} disabled={track.reaction < 0}>
            <Radio size={18} /> Похожее на этот трек
          </button>
          <button role="menuitem" onClick={() => { onClose(); void startArtistRadio(trackArtistLinks(track)[0]?.name ?? track.artist); }}>
            <Radio size={18} /> Радио по исполнителю
          </button>
          <button role="menuitem" onClick={() => { onClose(); openVersionPanel({ trackId: track.id, title: track.title, artist: track.artist, duration: track.duration }); }}>
            <Swap size={18} /> Найти другую версию
          </button>
          </>}
          {!section && <>
          <button role="menuitem" onClick={() => void react(track, track.reaction > 0 ? 0 : 1)}>
            <Heart size={18} weight={track.reaction > 0 ? 'fill' : 'regular'} /> {track.reaction > 0 ? 'Убрать из любимого' : 'Нравится'}
          </button>
          <button role="menuitem" onClick={() => void react(track, track.reaction < 0 ? 0 : -1)}>
            <HeartBreak size={18} weight={track.reaction < 0 ? 'fill' : 'regular'} /> {track.reaction < 0 ? 'Отменить «Не нравится»' : 'Не нравится'}
          </button>
          </>}
          {section === 'info' && <>
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
          {!desktop && track.mixingAllowed && (track.provider === 'local' || track.provider === 'yandex') && <button role="menuitem" onClick={async () => {
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
          </>}
          {section === 'manage' && <>
          {track.sourceKind === 'remote' && (
            <button role="menuitem" onClick={() => { onClose(); void (track.pinned ? api.removeDownload(track.id).then(() => toast('Загрузка удалена')) : api.download({ trackId: track.id }).then(() => toast('Скачиваем — прогресс в «Загрузках»'))).catch((e) => toast((e as Error).message, 'error')); }}>
              <DownloadSimple size={18} /> {track.pinned ? 'Удалить загрузку' : 'Скачать'}
            </button>
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
          </>}
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
  const [v, setV] = useState({ title: track.title, artist: track.artist, album: track.album, genre: track.genre, albumArtist: track.albumArtist, year: String(track.year ?? '') });
  const save = async () => {
    const patch = { ...v, year: v.year.trim() ? Number(v.year) : null };
    await api.updateTrack(track.id, patch);
    useApp.getState().patchTrack(track.id, patch);
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
      {(['title', 'artist', 'album', 'albumArtist', 'year', 'genre'] as const).map((k) => (
        <div className="field" key={k}>
          <label htmlFor={`edit-${k}`}>{{ title: 'Название', artist: 'Исполнитель', album: 'Альбом', albumArtist: 'Исполнитель альбома', year: 'Год', genre: 'Жанр' }[k]}</label>
          <input id={`edit-${k}`} className="input" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        </div>
      ))}
      <p className="caption dim" style={{ margin: 0 }}>
        Изменения хранятся в медиатеке приложения, теги в самом файле не переписываются.
      </p>
    </Modal>
  );
}
