# Подготовка к настольному приложению

## Что готово

- Главная переработана: центральная «Моя волна» с существующей 3D-скульптурой, выбор источника, компактное текущее прослушивание, небольшие коллекции ниже. Адаптивность проверена на1440×1000 и390×844, горизонтального переполнения документа нет. Существующая медиатека/любимое/плейлисты/player dock сохранены.
- Настройки Яндекс-волны настоящие: GET `/rotor/wave/settings?seeds=user:onyourwave`, названия и `serializedSeed` из `settingRestrictions`. На реальном аккаунте вернулись «По характеру», «Под настроение», «По языку», включая «Без слов». Это не аппроксимация локальными mood/diversity.
- Клиент получает нормализованные группы через GET `/api/providers/yandex/wave/settings`; выбранные seeds сохраняются в `wave.yandexSeeds`. PUT настроек проверяет доступность значений и не допускает двух разных значений одной группы. Правка локальной волны сохраняет настройки Яндекса.
- Новые Rotor session получают `['user:onyourwave', ...yandexSeeds]`. Действующая сессия обновляется через `controller.refreshYandexWave()` после сохранения: текущий трек, подготовленный ближайший переход и ручные entries сохраняются; дальние рекомендации заменяются. Старая session/batch attribution уже играющего трека остаётся корректной.
- На главной встроена раскрываемая панель, на странице волны показываются настройки выбранного источника. Ошибки загрузки доступны для retry, ошибки резерва видны, Pause не теряется.

## Аудит трёх агентов и проверка интеграции

1. Planner: исправлены выход drum alignment за maxEntrySkip/audibleStart и fade короткого cut за audibleEnd. Агент подтвердил сначала падавшими регрессиями,99 targeted tests и1104 планами сохранённых анализов. Подробности: `audit-automix-desktop.md`.
2. Engine: удалён постоянный pin начального cue; окна текущего PCM, seek destination и будущего vocal cue удерживаются раздельно. Устранён underrun при удалении ещё звучащего старого окна во время backward seek. Подробности: `audit-audio-desktop.md`.
3. Player: устранены отмена Pause поздней загрузкой/Resume/start и присвоение истории старого прослушивания повтору той же queue entry; добавлен refresh настроек. Подробности: `audit-player-desktop.md`.

Корень прочитал отчёты, проверил соответствующие engine/transport изменения, связал backend/UI/controller и запустил общий suite. Planner cache version обновлена до **am-planner-v7-entry-grid-2**: старые cached plans не используют прошлые ограничения. Analyzer остаётся am-analyzer-10.

## Проверено

- `npm run typecheck` — успешно.
- `npm run build` — успешно.
- `npx vitest run --maxWorkers=2` — **500/500**,31 файл,84.81s. Включена новая server fixture: динамические настройки, запрет неизвестных/конфликтующих seeds, сохранение при local edits, передача seeds в session/new.
- Production UI в реальном браузере: центр главной, собственный/Yandex источник, раскрытие настоящих групп Яндекса, mobile390px; данные аккаунта не заменялись тестовыми.
- Сервер4730 перезапущен на новой версии; health подтвердил v7-entry-grid-2.

Аудит не включает субъективное прослушивание всех переходов, packaged desktop lifecycle и измерения на iPhone.100% unit suite не означает100% идеальных музыкальных переходов.

## Передать Claude

Основной промпт: `CLAUDE_DESKTOP_APP_PROMPT.md`. Архитектура iPhone и offline: `iphone-local-offline-plan.md`.

Не откатывать PCM f32 headroom, shared-WSOLA, vocal generation/ACK, stem verification и новые bounded windows. До desktop релиза проверить sleep/wake/audio device/tray на установленной сборке; существующие unit-тесты этого не заменяют.

## Источники Yandex API

Неофициальный первичный исходник библиотеки:
https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/wave.py
https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/wave/wave_settings.py
https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/rotor_sessions.py

Используются enum values с реальными serializedSeed. Старые discrete numeric scales без готовых seeds не подменяются выдуманными параметрами; контексты-занятия сейчас не добавлены. Настройки влияют на сессии этого клиента; синхронизация глобальных настроек приложения Яндекса не заявляется.
