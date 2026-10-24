import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { controller, useApp } from '../store/app.ts';

type Group = Awaited<ReturnType<typeof api.yandexWaveSettings>>['groups'][number];

export function YandexWaveTuning() {
  const settings = useApp((s) => s.settings);
  const save = useApp((s) => s.saveSettings);
  const refillError = useApp((s) => s.player.context?.type === 'yandex-wave' ? s.player.waveRefillError : null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(''); setGroups(null);
    void api.yandexWaveSettings().then((r) => { if (alive) setGroups(r.groups); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [revision]);
  const choose = async (group: Group, seed: string) => {
    if (!settings || saving) return;
    const old = settings.wave.yandexSeeds ?? [];
    const rest = old.filter((s) => !group.values.some((v) => v.seed === s));
    const seeds = seed ? [...rest, seed] : rest;
    setSaving(true); setError('');
    try {
      await save({ wave: { ...settings.wave, yandexSeeds: seeds } });
      await controller.refreshYandexWave();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <div className="yandex-wave-tuning" aria-busy={saving}>
    <p className="ws-help">Подбор Яндекса из вашего аккаунта. Новые настройки применятся к продолжению волны; текущий трек продолжит играть.</p>
    {!groups && !error && <p role="status" className="ws-help">Получаем настройки Яндекса…</p>}
    {error && <div role="alert" className="ws-error">{error} <button className="btn btn-ghost" onClick={() => setRevision((v) => v + 1)}>Повторить</button></div>}
    {groups?.length === 0 && <p className="ws-help">Яндекс пока не вернул доступные настройки. Попробуйте позже.</p>}
    <div className="yandex-tuning-grid">{groups?.map((group) => {
      const selected = (settings?.wave.yandexSeeds ?? []).find((s) => group.values.some((v) => v.seed === s)) ?? '';
      return <fieldset className="ws-control" key={group.id} disabled={!settings || saving}>
        <legend>{group.name}</legend>
        <div className="ws-segments"><button aria-pressed={!selected} onClick={() => void choose(group, '')}>По умолчанию</button>{group.values.map((v) => <button key={v.seed} aria-pressed={selected === v.seed} onClick={() => void choose(group, v.seed)}>{v.name}</button>)}</div>
      </fieldset>;
    })}</div>
    {saving && <p className="ws-help" role="status">Обновляем продолжение волны…</p>}
    {refillError && <p className="ws-help" role="status">{refillError}</p>}
  </div>;
}
