import { useApp } from '../store/app.ts';
import { Switch } from './common.tsx';

function Toggle({ title, desc, label, checked, onChange }: { title: string; desc: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting">
      <div>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="desc">{desc}</div>
      </div>
      <div className="setting-control">
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
    </div>
  );
}

/** What the connected Yandex Music account is used for. Stored on the server (AppSettings.yandex)
 *  and enforced there: an off switch never queues the corresponding remote writes. */
export function YandexIntegrationSettings() {
  const settings = useApp((st) => st.settings);
  const save = useApp((st) => st.saveSettings);
  if (!settings) return null;
  const y = settings.yandex;
  const set = (patch: Partial<typeof y>) => void save({ yandex: { ...y, ...patch } });
  return (
    <section className="yandex-integration" aria-label="Настройки интеграции с Яндекс Музыкой">
      <h3>Синхронизация с Яндексом</h3>
      <Toggle
        title="Лайки"
        desc="Отметка «Нравится» в MORA ставит лайк в Яндекс Музыке, снятие — убирает его. Оценка всегда сохраняется в MORA."
        label="Синхронизация лайков"
        checked={y.syncLikes}
        onChange={(v) => set({ syncLikes: v })}
      />
      <Toggle
        title="Дизлайки"
        desc="Отметка «Не нравится» в MORA ставит дизлайк в Яндекс Музыке, снятие — убирает его."
        label="Синхронизация дизлайков"
        checked={y.syncDislikes}
        onChange={(v) => set({ syncDislikes: v })}
      />
      <Toggle
        title="Импорт лайков в медиатеку"
        desc="Перенос всей коллекции лайков Яндекса в «Любимое» MORA с подготовкой полных треков."
        label="Импорт лайков в медиатеку"
        checked={y.importLikes}
        onChange={(v) => set({ importLikes: v })}
      />
      <Toggle
        title="Обучение «Моей волны»"
        desc="Рассказывать Яндексу, что прозвучало и что пропущено, чтобы «Моя волна» подстраивалась. Волна работает и без этого."
        label="Обучение «Моей волны»"
        checked={y.waveFeedback}
        onChange={(v) => set({ waveFeedback: v })}
      />
    </section>
  );
}
