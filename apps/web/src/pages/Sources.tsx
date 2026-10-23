import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, MagnifyingGlass, Plus, Check, ArrowSquareOut, Play, SpinnerGap, Heart } from '@phosphor-icons/react';
import { addBatch } from '../lib/batchImport.ts';
import { api, type ExternalTrack, type ProviderInfo } from '../lib/api.ts';
import { fmtTime } from '../lib/format.ts';
import { controller, useApp } from '../store/app.ts';
import { Cover } from '../components/common.tsx';
import { ImportActions } from '../components/ImportActions.tsx';
import { YandexLikesImport } from '../components/YandexLikesImport.tsx';
import { YandexIntegrationSettings } from '../components/YandexIntegrationSettings.tsx';

const STATUS: Record<ProviderInfo['status'], { label: string; cls: string }> = {
  connected: { label: 'Подключено', cls: 'ok' },
  needs_credentials: { label: 'Требуется подключение', cls: '' },
  unavailable: { label: 'Недоступно', cls: 'warn' },
  not_supported: { label: 'Не поддерживается', cls: 'warn' },
  error: { label: 'Ошибка', cls: 'warn' },
  disabled: { label: 'Выключено', cls: '' },
};

const CAP_LABEL: [keyof ProviderInfo['capabilities'], string][] = [
  ['search', 'поиск'],
  ['library', 'медиатека'],
  ['recommendations', 'рекомендации'],
  ['playback', 'воспроизведение'],
  ['seek', 'перемотка'],
  ['pcm', 'PCM'],
  ['analysis', 'анализ'],
  ['mixing', 'AutoMix'],
];

export function SourcesPage() {
  const providers = useApp((s) => s.providers);
  const load = useApp((s) => s.loadProviders);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="main-inner">
      <h1 className="page-title">Источники</h1>
      <p className="muted" style={{ maxWidth: '70ch' }}>
        Подключите свою медиатеку или музыкальный сервис. Доступные треки подготавливаются заранее, чтобы AutoMix мог выбрать музыкальный вход и свести следующую песню.
      </p>
      <div className="toolbar">
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await load(true);
            setBusy(false);
          }}
        >
          <ArrowClockwise size={16} /> {busy ? 'Проверяю…' : 'Проверить подключения'}
        </button>
      </div>
      <div className="source-grid" style={{ marginTop: 8 }}>
        {providers.map((p) => (
          <SourceCard key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}

function SourceCard({ p }: { p: ProviderInfo }) {
  const toast = useApp((s) => s.toast);
  const load = useApp((s) => s.loadProviders);
  const importLikes = useApp((s) => s.settings?.yandex.importLikes !== false);
  const [form, setForm] = useState<Record<string, string>>(() => ({ ...p.config }));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = STATUS[p.status];
  const connectable = p.configFields.length > 0;

  const connect = async () => {
    setBusy(true);
    setErr(null);
    const config: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const f of p.configFields) (f.secret ? secret : config)[f.key] = form[f.key] ?? '';
    try {
      await api.connectProvider(p.id, config, secret);
      toast(`${p.name}: подключено`, 'success');
      setOpen(false);
      await load(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      // never keep secrets in component state longer than needed
      setForm((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !p.configFields.find((x) => x.key === k)?.secret)));
    }
  };

  return (
    <article className="source-card" aria-label={p.name}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <h3>{p.name}</h3>
          <div className="caption dim" style={{ marginTop: 2 }}>
            {p.official ? 'официальный API' : 'неофициальный API'}
            {p.account ? ` · ${p.account}` : ''}
          </div>
        </div>
        <span className={`tag ${st.cls}`}>{st.label}</span>
      </div>
      <div className="small">{p.statusText}</div>
      <div className="caps" aria-label="Возможности">
        {CAP_LABEL.map(([k, l]) => (
          <span key={k} className={`cap ${p.capabilities[k] ? 'yes' : ''}`} title={p.capabilities[k] ? 'есть' : 'нет'}>
            {p.capabilities[k] ? '✓ ' : '× '}
            {l}
          </span>
        ))}
        <span className="cap yes">кэш: {p.capabilities.caching === 'persistent' ? 'постоянный' : p.capabilities.caching === 'session' ? 'до перезапуска' : 'нет'}</span>
      </div>
      <ul className="notes">
        {p.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      {p.docs.length > 0 && (
        <div className="caption" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {p.docs.map((d) => (
            <a key={d} href={d} target="_blank" rel="noreferrer noopener" className="muted" style={{ textDecoration: 'underline' }}>
              {new URL(d).host}
              <ArrowSquareOut size={11} style={{ marginLeft: 2, verticalAlign: '-1px' }} />
            </a>
          ))}
        </div>
      )}
      {p.id === 'local' && <ImportActions compact />}
      {connectable && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {p.status === 'connected' ? (
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await api.disconnectProvider(p.id);
                await load(true);
                toast(`${p.name}: отключено`);
              }}
            >
              Отключить
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Скрыть' : 'Подключить'}
            </button>
          )}
        </div>
      )}
      {open && p.status !== 'connected' && (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
          autoComplete="off"
        >
          {p.configFields.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={`${p.id}-${f.key}`}>{f.label}</label>
              <input
                id={`${p.id}-${f.key}`}
                className="input"
                type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'}
                placeholder={f.placeholder ?? (f.secret && p.hasSecret ? 'сохранён (оставьте пустым)' : '')}
                value={form[f.key] ?? ''}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
              {f.help && <span className="caption dim">{f.help}</span>}
            </div>
          ))}
          {err && <div className="small" style={{ color: 'var(--danger)' }}>{err}</div>}
          <div>
            <button className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? 'Проверяю…' : 'Проверить и сохранить'}
            </button>
          </div>
        </form>
      )}
      {p.status === 'connected' && p.id === 'yandex' && <a className="btn btn-primary" href="#/yandex">Открыть каталог Яндекса</a>}
      {p.status === 'connected' && p.id === 'yandex' && <YandexIntegrationSettings />}
      {p.status === 'connected' && p.id === 'yandex' && importLikes && <YandexLikesImport />}
      {p.status === 'connected' && p.capabilities.search && p.id !== 'local' && <ProviderBrowser p={p} />}
    </article>
  );
}

function ProviderBrowser({ p }: { p: ProviderInfo }) {
  const searchRevision = useRef(0);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ExternalTrack[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Map<string, string>>(new Map());
  const [preparing, setPreparing] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number; failed: number } | null>(null);
  const cancel = useRef(false);
  const toast = useApp((s) => s.toast);
  const selectable = (items ?? []).filter((t) => t.playable);
  const allSelected = selectable.length > 0 && selectable.every((t) => selected.has(t.externalId));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runBatch = async (like: boolean) => {
    const chosen = selectable.filter((t) => selected.has(t.externalId));
    if (!chosen.length) return;
    cancel.current = false;
    setBatch({ done: 0, total: chosen.length, failed: 0 });
    const byKey = new Map(chosen.map((t) => [t.externalId, t]));
    const r = await addBatch(chosen.map((t) => ({ key: t.externalId, trackId: t.libraryTrackId ?? added.get(t.externalId) ?? null })), like, {
      importOne: async ({ key }) => {
        setPreparing((s) => new Set(s).add(key));
        try {
          const { trackId } = await api.providerImport(p.id, byKey.get(key)!);
          setAdded((s) => new Map(s).set(key, trackId));
          return trackId;
        } finally {
          setPreparing((s) => { const n = new Set(s); n.delete(key); return n; });
        }
      },
      // Tracks liked in the service arrive liked; asking the server avoids a second like there.
      isLiked: async (id) => (await api.track(id)).reaction > 0,
      like: async (id) => { await api.react(id, 1); },
      onProgress: setBatch,
      cancelled: () => cancel.current,
    });
    let orderError = '';
    if (like && r.added.length) {
      try { await api.orderFavorites([...new Set(r.added)]); }
      catch (error) { orderError = ` Не удалось сохранить порядок: ${(error as Error).message}`; }
    }
    setBatch(null);
    setSelected(new Set());
    await useApp.getState().loadLibrary();
    const what = like ? `в Любимое: ${r.added.length}` : `в медиатеку: ${r.added.length}`;
    toast(`Добавлено ${what}${r.failed ? `, не удалось: ${r.failed}${r.error ? ` (${r.error})` : ''}` : ''}${cancel.current ? ' (остановлено)' : ''}${orderError}`, r.failed || orderError ? 'error' : 'success');
  };
  const search = async (query: string) => {
    const revision = ++searchRevision.current;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.providerSearch(p.id, query);
      if (revision === searchRevision.current) setItems(result.items);
    } catch (e) {
      if (revision === searchRevision.current) setErr((e as Error).message);
    } finally {
      if (revision === searchRevision.current) setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search(q);
        }}
      >
        <MagnifyingGlass size={18} />
        <input type="search" placeholder={p.id === 'yandex' ? 'Название, исполнитель или ссылка на трек' : `Поиск в ${p.name}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Поиск в ${p.name}`} />
      </form>
      <div>
        <button className="btn btn-ghost btn-sm" onClick={() => void search('')} disabled={busy}>
          {busy ? 'Загружаю…' : p.id === 'yandex' ? 'Мои любимые треки' : 'Показать подборку'}
        </button>
      </div>
      {err && <div className="small" style={{ color: 'var(--danger)' }}>{err}</div>}
      {items && items.length === 0 && <div className="small muted">Ничего не найдено.</div>}
      {p.id === 'yandex' && <p className="caption dim" style={{ margin: 0 }}>Добавление подготавливает полный трек. Анализ и вокальная партия обрабатываются в фоне; после этого доступно DJ-сведение.</p>}
      {selectable.length > 0 && (
        <div className="source-batch">
          <label className="source-check">
            <input type="checkbox" checked={allSelected} disabled={!!batch} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((t) => t.externalId)))} />
            Выбрать все
          </label>
          {batch ? (
            <>
              <span className="small muted tnum" role="status">Добавляю {batch.done} из {batch.total}{batch.failed ? ` · ошибок ${batch.failed}` : ''}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => { cancel.current = true; }}>Остановить</button>
            </>
          ) : (
            <>
              <button className="btn btn-secondary btn-sm" disabled={!selected.size} onClick={() => void runBatch(false)}><Plus size={16} /> В медиатеку{selected.size ? ` · ${selected.size}` : ''}</button>
              <button className="btn btn-ghost btn-sm" disabled={!selected.size} onClick={() => void runBatch(true)} title="Уже отмеченные в источнике треки не отмечаются там повторно"><Heart size={16} /> В Любимое</button>
            </>
          )}
        </div>
      )}
      <div className="source-results" role="list" aria-label={`Треки: ${p.name}`}>
      {items?.map((t) => {
        const readyId = t.libraryTrackId ?? added.get(t.externalId);
        const inLib = !!readyId;
        const pending = preparing.has(t.externalId);
        return (
          <div key={t.externalId} role="listitem" className="q-item" style={{ gridTemplateColumns: readyId ? '20px 40px minmax(0,1fr) auto auto' : '20px 40px minmax(0,1fr) auto' }}>
            <input type="checkbox" className="source-row-check" aria-label={`Выбрать: ${t.title}`} checked={selected.has(t.externalId)} disabled={!t.playable || !!batch} onChange={() => toggle(t.externalId)} />
            <Cover url={t.coverUrl} seed={t.externalId} size={40} />
            <div style={{ minWidth: 0 }}>
              <div className="t-title ellipsis" style={{ fontSize: 14 }}>
                {t.title}
              </div>
              <div className="caption muted ellipsis">
                {t.artist} · {fmtTime(t.duration)}
                {t.license ? (
                  <>
                    {' · '}
                    <a href={t.license} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'underline' }}>
                      лицензия
                    </a>
                  </>
                ) : null}
              </div>
            </div>
            <button
              className="icon-btn"
              disabled={pending || inLib || !t.playable}
              title={pending ? 'Загружаю и проверяю полный трек…' : inLib ? 'Трек уже в медиатеке' : 'Подготовить для AutoMix'}
              aria-label={pending ? `Подготовка: ${t.title}` : inLib ? 'Уже в медиатеке' : `Добавить в медиатеку: ${t.title}`}
              onClick={async () => {
                setPreparing((s) => new Set(s).add(t.externalId));
                try {
                  const result = await api.providerImport(p.id, t);
                  setAdded((s) => new Map(s).set(t.externalId, result.trackId));
                  await useApp.getState().loadLibrary();
                  toast(`«${t.title}» в медиатеке`, 'success');
                } catch (e) {
                  toast((e as Error).message, 'error');
                } finally {
                  setPreparing((s) => { const next = new Set(s); next.delete(t.externalId); return next; });
                }
              }}
            >
              {pending ? <SpinnerGap size={18} /> : inLib ? <Check size={18} /> : <Plus size={18} />}
            </button>
            {readyId && <button className="icon-btn" aria-label={`Слушать: ${t.title}`} onClick={() => {
              const ids = items.map((i) => i.libraryTrackId ?? added.get(i.externalId)).filter((id): id is string => !!id);
              void controller.playTracks(ids, ids.indexOf(readyId), { type: 'search', label: p.name });
            }}><Play size={18} weight="fill" /></button>}
          </div>
        );
      })}
      </div>
    </div>
  );
}
