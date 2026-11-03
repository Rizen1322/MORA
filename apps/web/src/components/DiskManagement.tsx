import { useEffect, useState } from 'react';
import { api, type DownloadUsage, type HealthStatus } from '../lib/api.ts';
import { useApp } from '../store/app.ts';
import { ConfirmModal } from './common.tsx';

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`;

export function DiskManagement() {
  const [usage, setUsage] = useState<DownloadUsage | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useApp(s => s.toast);
  const refresh = async () => { const [d, h] = await Promise.all([api.downloads(), api.health()]); setUsage(d.usage); setHealth(h); setOffline(false); };
  useEffect(() => {
    let alive = true;
    const load = () => { if (alive) void refresh().catch(() => { if (alive) setOffline(true); }); };
    load(); const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <section className="pref-group" aria-label="Место на диске">
    <h2 className="pref-group-title">Место на диске</h2>
    <div className="pref-card">
      <div className="pref-row"><div className="pref-text"><div className="pref-title">Скачанные оригиналы</div><div className="pref-desc">Сохраняются для офлайна. Очистка кэша их не удаляет.</div></div><a href="#/downloads" className="pref-control">{usage ? size(usage.pinnedBytes) : 'Загрузки'}</a></div>
      <div className="pref-row"><div className="pref-text"><div className="pref-title">Временный кэш оригиналов</div><div className="pref-desc">{usage ? `${size(usage.cacheBytes)} · предел ${size(usage.limitBytes)}. ` : ''}Нескачанные записи удаляются автоматически.</div></div><select className="select" aria-label="Предел кэша оригиналов" disabled={!usage || busy} value={usage ? Math.round(usage.limitBytes / 1024 ** 2) : 512} onChange={async e => { setBusy(true); try { setUsage((await api.setCacheLimit(Number(e.target.value))).usage); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } }}>
        {[...new Set([512, 1024, 4096, 8192, ...(usage ? [Math.round(usage.limitBytes / 1024 ** 2)] : [])])].sort((a, b) => a - b).map(mb => <option key={mb} value={mb}>{size(mb * 1024 ** 2)}</option>)}
      </select></div>
      <div className="pref-row"><div className="pref-text"><div className="pref-title">Временный звук для переходов (PCM)</div><div className="pref-desc">{health ? `${size(health.pcmCacheBytes)} · предел ${size(health.pcmCacheLimit)}. ` : ''}Создаётся заново при воспроизведении; текущий и следующий трек защищены.</div></div><button className="btn btn-ghost btn-sm" disabled={busy || !health} onClick={() => setAsk(true)}>Очистить кэш</button></div>
    </div>
    <p className="pref-footer" role="status">{offline ? 'Не удалось обновить размер — сервер недоступен.' : usage?.freeBytes != null ? `Свободно на диске: ${size(usage.freeBytes)}. Очистка не затронет медиатеку, скачанные оригиналы, лайки и историю.` : 'Медиатека, скачанные оригиналы, лайки и история сохраняются.'}</p>
    {ask && <ConfirmModal title="Очистить временный кэш?" text="Удалятся временные оригиналы, PCM и планы переходов. Скачанная музыка останется. Звук, используемый сейчас, будет сохранён." confirm="Очистить" onClose={() => setAsk(false)} onConfirm={async () => { setBusy(true); try { await Promise.all([api.clearAudioCache(), api.clearCache()]); await refresh(); toast('Кэш очищен, скачанная музыка сохранена', 'success'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } }} />}
  </section>;
}
