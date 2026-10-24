# MORA для iPhone (Capacitor): отчёт о сборке

Дата: 22 октября 2026. Код: `apps/mobile`. Дизайн и план: `docs/superpowers/specs/2026-10-22-mora-ios-capacitor-design.md`.

## Что сделано

Автономное iOS-приложение, работает без ПК и без своего сервера:

- **Интерфейс.** Без изменений тот же `apps/web` в мобильной раскладке, плюс `apps/mobile/src/mobile.css`:
  - без размытия под фиксированными панелями: в WKWebView оно перерисовывается на каждом кадре прокрутки;
  - зоны нажатия 44 pt в мини-плеере и шапке плеера;
  - отклик на касание, без выделения текста и выносок;
  - на iPhone скрыты импорт папки и «папка на диске».
- **Графика.** По умолчанию лёгкая canvas вместо WebGL, переключается в «Настройки → Звук и вид».
- **Сервер внутри приложения.** `apps/server` целиком в Dedicated Worker, маршруты `register*Routes` не менялись:
  - Fastify → мини-роутер (`shims/fastify.ts`);
  - `node:fs` → OPFS (`opfs-fs.ts`);
  - `node:sqlite` → sql.js;
  - ffmpeg → `decodeAudioData` на странице;
  - yt-dlp → `youtubei.js`, HLS visionOS-клиента и SoundCloud api-v2 (`replace/ytdlp.ts`);
  - worker_threads → `analysis-worker.js`.
- **Мост.** `mora-bridge.js` перехватывает `fetch`, `XMLHttpRequest` (загрузка файлов), `EventSource` и атрибуты `src` у `<img>`/`<audio>`.
- **Нативная часть.** `MoraAudioPlugin.swift`:
  - AVAudioSession `.playback` / `.longFormAudio`, `UIBackgroundModes audio`;
  - Now Playing и команды экрана блокировки / наушников (через `navigator.mediaSession`);
  - прерывания (звонок) и смена маршрута (наушники отключены → пауза).
- **Оформление и сборка.** Иконка и splash из логотипа MORA. Скрипт для Mac: `apps/mobile/scripts/ios-mac.sh`.

## Что проверено (Windows, Chrome, built-in browser, 375×812)

| Сценарий | Результат |
|---|---|
| Запуск сервера в worker, `/api/health`, `/api/library` | 200, медиатека в OPFS |
| Поиск YouTube Music / YouTube / SoundCloud | 20 / 20 / 12 результатов, 0,5–1,4 с |
| Загрузка YouTube (HLS visionOS → .aac), декодирование в PCM 48 кГц | ~5 с до первых PCM |
| Загрузка SoundCloud (HLS fMP4 → .m4a) | PCM получен |
| Анализ на устройстве | BPM 122,9 / 10B для «One More Time», 6 треков `done` |
| Play из поиска через интерфейс, мини-плеер, полный плеер | играет, `ctx: running` |
| Next: короткое сведение | crossfade, вход B на 15 с, 0 underruns, рендер ≤ 1 мс |
| Автоматический переход в конце трека | по плану (выход 214,9 с), не forced, не late, 0 underruns |
| Следующий план пары с разным BPM | «Мост темпа · 16 тактов» |
| Импорт своего файла (XHR) | трек добавлен, анализ `done` |
| Загрузка для офлайна | `done`, учтено в «закреплено» |
| Перезагрузка страницы | медиатека, очередь и обложки (blob из OPFS) сохранились |
| Тексты, импорт плейлиста YouTube, Spotify-альбом, онлайн-радио | 90 строк; 14 треков; «Discovery»; 49 кандидатов |
| Планировщик am-planner-v12-fullmix-2 + am-analyzer-13 (пересборка) | первый расчёт плана 2,9–7,6 с, пошаговый; чтение PCM при этом ждёт ≤ 296 мс (медиана 7 мс). Voyager→Technologic и Technologic→Aerodynamic: сведение по битам 16 тактов (31,05 / 30,7 с). Пары со Starboy (нестабильная сетка): crossfade. Переход 31 с сыгран до конца: 0 underruns, рендер ≤ 3 мс |
| Тесты | `apps/mobile/test/shims.test.ts`: 4/4 |

## Что не проверено и риски

Сборка Xcode и работа на iPhone здесь невозможны: Windows, нет Xcode. Первый запуск — на Mac по `apps/mobile/README.md`.

1. **Фон при заблокированном экране.** Главный риск. AudioWorklet и подкачка PCM из worker должны продолжать работать в фоне. Для этого включены `navigator.audioSession.type = 'playback'` (в iOS 17.5 исправлен WebKit 261554), фоновый режим `audio` и непубличная `requiresPageVisibilityToPlayAudio = false`, если она есть. Таймеры главного потока в фоне могут замедляться. Проверить 30–60 минут с заблокированным экраном, включая переходы.
2. **Стабильность YouTube-резолвера.** YouTube может закрыть HLS-путь visionOS или потребовать PO-token. Запасной путь — прямой m4a через youtubei.js (клиенты IOS, MWEB, TV).
3. **OPFS в WKWebView под `capacitor://`.** Наличие `createSyncAccessHandle` и долговременное хранение (Capacitor-приложения не подпадают под 7-дневный лимит ITP по сторонним данным) нужно подтвердить на устройстве. Вызывается `navigator.storage.persist()`.
4. **Декодирование fMP4/ADTS в Safari** (`decodeAudioData`) проверено только в Chrome.
5. **Now Playing.** WebKit сам публикует Media Session и может конфликтовать с плагином. Проверить экран блокировки и команды с наушников.
6. **Яндекс Музыка** не проверялась: нужен токен. Код провайдера тот же, что на ПК.
7. **Вокальные партии Demucs** на iPhone отключены честно: «Локальная модель недоступна», запасной путь планировщика.
8. **Расчёт плана на iPhone.** Он идёт шагами, и встроенный сервер в это время отвечает: ожидание PCM ≤ 0,3 с в Chrome. Полный расчёт пары в Chrome длится 3–8 с, на iPhone 12 будет дольше. Обычно план готовится заранее, но проверить, что он успевает до перехода.
9. **Ресурсы.** Пиковая память на iPhone 12 не измерена. Декодирование 4-минутного трека держит в памяти ~90 МБ float PCM.

## Следующие шаги

1. На Mac: `sh apps/mobile/scripts/ios-mac.sh --check`, затем установка на iPhone и проверка пунктов 1–5.
2. Если звук в фоне рвётся: нативный плеер для заранее отрендеренных переходов (`renderTransitionOffline`) как запасной транспорт.
3. Core ML для вокальных партий — отдельный этап (см. `docs/ios-automix-plan-2026-10-22.md`).
