# MORA iOS: Capacitor и встроенный сервер — дизайн

Дата: 22 октября 2026. Вариант A одобрен пользователем. Исследование: `docs/iphone-muriel-source-architecture.md`.

## Цель

Автономное приложение для iPhone в `apps/mobile`, которое работает без ПК и без нашего сервера. Интерфейс тот же `apps/web`, с мобильной доводкой. Код `apps/server` работает внутри WebView, его маршруты не переписываются. AutoMix работает на том же AudioWorklet-движке, что и на ПК. Старый `apps/ios` не трогаем.

## Архитектура

```
WKWebView (capacitor://localhost)
├─ главный поток: apps/web (React) + bridge
│   ├─ перехват fetch('/api/…'), EventSource('/api/events'), <img>/<audio> src → RPC в server-worker
│   ├─ сервисы для worker: decodeAudioData (декодирование и ресэмплинг), внешний HTTP (CapacitorHttp на iOS, /__proxy в браузере)
│   └─ плагин MoraAudio: Now Playing, команды экрана блокировки, прерывания, маршрут
└─ server worker (Dedicated Worker)
    ├─ apps/server: createApp() на мини-роутере вместо Fastify
    ├─ fs → OPFS (синхронные SyncAccessHandle) + индекс метаданных в памяти
    ├─ node:sqlite → sql.js; файл БД сохраняется в OPFS с задержкой и при уходе в фон
    ├─ ffmpeg → RPC decode в главный поток; probe через music-metadata
    ├─ yt-dlp → youtubei.js + HLS visionOS (TS→AAC) + SoundCloud web API (как в Muriel)
    └─ worker_threads анализа → вложенный Web Worker с тем же @automix/core
```

Почему worker: в главном потоке OPFS даёт только асинхронный доступ, а серверу нужен синхронный `fs`. В worker есть `createSyncAccessHandle`, поэтому `existsSync/readFileSync/statSync` работают честно. Сам интерфейс при этом не блокируется.

Сборка: esbuild с alias для Node-модулей. Замена модулей уровня класса (`ffmpeg.ts`, `public/ytdlp.ts`, `stems.ts`/`vocal-cuda.ts`, `analysisWorker`) делается плагином resolve, файлы сервера не меняются.

## Честные ограничения

- Вокальные партии Demucs (Python) на iPhone недоступны. `stemsPython=null`: сервер уже сообщает `unavailable`, и планировщик идёт по запасному пути. Маркировку UI не подделываем.
- Прогрессивного воспроизведения во время загрузки нет: `decodeAudioData` нужен полный файл. Трек начинает играть после загрузки (~4 МБ AAC).
- Хранилище — OPFS внутри WKWebView. Capacitor-приложения не подпадают под 7-дневный лимит Safari ITP (по сторонним данным); дополнительно вызывается `navigator.storage.persist()`, резервная копия плейлистов остаётся. Нужна проверка на устройстве.
- Фон: AVAudioSession `.playback`, UIBackgroundModes `audio`, `navigator.audioSession.type='playback'`. Работа AudioWorklet при заблокированном экране не проверена на устройстве.
- YouTube может менять API; резолвер обновляется вместе с приложением.

## Проверка

- Тот же бандл в браузере (Chrome) через `apps/mobile/dev/serve.mjs` на порту 4741, внешний HTTP через `/__proxy`.
- Мобильный режим built-in browser: импорт файла, поиск, Play, Next, AutoMix-переход, загрузка.
- `npm test` и `npm run typecheck` не должны ломаться.
- Сборка Xcode и работа на iPhone здесь невозможны (Windows) — это первый шаг на Mac.

## План

1. Каркас `apps/mobile`: package.json, capacitor.config, build.mjs (vite build web + esbuild worker + bridge).
2. Мини-роутер, bridge fetch/EventSource/src, RPC.
3. Shims: fs/OPFS, sqlite/sql.js, crypto, stream/buffer/events, child_process, worker_threads, music-metadata, ffmpeg, ytdlp.
4. Dev-сервер с /__proxy; запуск в браузере, отладка импорта и воспроизведения.
5. Резолвер YouTube/SoundCloud; поиск, загрузка, импорт плейлистов.
6. Мобильная доводка CSS (safe-area, tabbar, крупные цели, облегчённые эффекты).
7. Capacitor iOS: проект, AppDelegate/Info.plist, Swift-плагин MoraAudio.
8. README, скрипт для Mac, отчёт в docs/.
