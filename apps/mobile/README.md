# MORA для iPhone

Полная версия MORA, которая работает на самом iPhone: без ПК и без своего сервера. Интерфейс — тот же `apps/web` в мобильной раскладке с доводкой под телефон. Весь `apps/server` (медиатека, поиск, загрузки, анализ, планировщик AutoMix, волна, тексты, импорт плейлистов) работает внутри приложения. Звук играет тот же движок AutoMix на AudioWorklet, что и на ПК.

Старый нативный прототип в `apps/ios` с этой версией не связан.

## Как устроено

```
WKWebView (Capacitor 8)
├─ страница: apps/web + mora-bridge.js
│   • /api-запросы (fetch, XHR, EventSource, <img>/<audio> src) → server worker
│   • для worker: decodeAudioData (декодирование и ресэмплинг), внешний HTTP (CapacitorHttp)
│   • navigator.mediaSession → WebKit (Now Playing, экран блокировки и его команды)
│   • MoraAudio → прерывания, наушники, состояние нагрева/энергосбережения
└─ server-worker.js: apps/server без изменений маршрутов
    • node:fs → OPFS (синхронные SyncAccessHandle), node:sqlite → sql.js (файл в OPFS)
    • ffmpeg → декодирование на странице, probe через music-metadata
    • yt-dlp → youtubei.js + HLS visionOS (YouTube), api-v2 (SoundCloud), склейка HLS в .aac/.m4a
    • анализ → analysis-worker.js (тот же AnalysisAccumulator из packages/core)
```

| Файл | Что делает |
|---|---|
| `build.mjs` | Vite-сборка `apps/web` + esbuild для bridge и worker с подменой Node-модулей |
| `src/bridge/` | Страница: перехват `/api`, RPC для worker, Media Session → натив |
| `src/worker/opfs-fs.ts` | `fs` и `fs/promises` поверх OPFS |
| `src/worker/shims/` | `fastify`, `node:sqlite`, `crypto`, `worker_threads`, `child_process` и др. |
| `src/worker/replace/` | Замены `ffmpeg.ts` и `public/ytdlp.ts` для iOS |
| `ios/App/App/MoraAudioPlugin.swift` | Прерывания, наушники, нагрев и запасная активация AVAudioSession; Now Playing принадлежит WebKit |
| `dev/serve.mjs` | Тот же бандл в браузере, внешний HTTP через `/__proxy` |

## Сборка на Mac

Нужны macOS с Xcode 26+, Node.js 22.13+, iPhone на iOS 17.4 или новее (рекомендуется 17.5+). CocoaPods не нужен: Capacitor 8 подключается через Swift Package Manager. [Требования Capacitor 8](https://capacitorjs.com/docs/getting-started/environment-setup).

```sh
sh apps/mobile/scripts/ios-mac.sh
```

Скрипт выполнит `npm ci`, соберёт `www/`, сделает `npx cap sync ios` и откроет проект в Xcode. Дальше:

1. Схема **App**, сверху выбрать свой iPhone (кабель или та же Wi‑Fi сеть).
2. **Signing & Capabilities** → Team: свой Apple ID (бесплатный подходит). Если Xcode пишет, что идентификатор занят, заменить Bundle Identifier `ru.mora.player` на свой.
3. Run. Сборку с бесплатного Apple ID нужно переустанавливать раз в 7 дней.

Проверка компиляции без подписи: `sh apps/mobile/scripts/ios-mac.sh --check`.

Сборка IPA для Sideloadly/AltStore: `sh apps/mobile/scripts/ios-mac.sh --ipa`.
Результат — `apps/mobile/MORA-unsigned.ipa`; подпись выполняется при установке через выбранный sideload-инструмент. На Windows этот скрипт не компилирует iOS-приложение.

После изменений в `apps/web` или `apps/server`: `npm run mobile:build`, затем `cd apps/mobile && npx cap sync ios` и Run в Xcode.

## Проверка в браузере (Windows/macOS)

```sh
npm run mobile:dev
```

Откроется `http://localhost:4741`. В DevTools включите размер телефона. Медиатека этой версии лежит в OPFS браузера, отдельно от медиатеки ПК. `dev/serve.mjs` пересылает внешние запросы через `/__proxy` и слушает только `127.0.0.1`.

## Что работает и чего нет

Работает на устройстве: свои файлы через «Файлы» (кнопка импорта), поиск YouTube Music / YouTube / SoundCloud, публичные страницы артистов и альбомов, онлайн-радио, «Моя волна», загрузки для офлайна, импорт плейлистов (Spotify, Apple Music, YouTube, SoundCloud), тексты, эквалайзер, анализ треков и AutoMix-переходы. Яндекс Музыка использует тот же код провайдера, что на ПК (по токену аккаунта); на этой сборке она ещё не проверялась.

Ограничения:

- **Вокальные партии Demucs** (Python/PyTorch) на iPhone не запускаются. Сервер честно отдаёт `stems: unavailable`, планировщик идёт по запасному пути без отделения голоса. Перенос модели в Core ML — отдельный этап.
- **Воспроизведение во время скачивания** — для HLS-потоков YouTube и SoundCloud в ADTS/MP3: сегменты пишутся по порядку, декодер отдаёт начало файла после первых ~256 КБ (кроме последней секунды перед срезом), затем продолжает с того же места по полному файлу. MP4/M4A и прямые ссылки по-прежнему играют после полной загрузки.
- **Токены провайдеров** (Яндекс) шифруются AES-GCM ключом, который хранится в Keychain только на этом устройстве (как DPAPI на ПК). При переносе на новый телефон из резервной копии аккаунт нужно подключить заново.
- **Кэш PCM:** 384 МБ, 16 бит с запасом 6 дБ над полной шкалой (около 33 минут музыки 48 кГц; вдвое меньше записи на флеш, чем float), лишнее вытесняется.
- **Фон:** `UIBackgroundModes audio`, AVAudioSession `.playback` и `navigator.audioSession.type = 'playback'`. Дополнительно выставляется непубличная настройка WebKit `requiresPageVisibilityToPlayAudio = false` (только если она есть). Для App Store её нужно убрать. Работу AudioWorklet при заблокированном экране нужно проверить на iPhone.
- **YouTube** может поменять API. Резолвер (`src/worker/replace/ytdlp.ts`) обновляется вместе с приложением.

Доработки и источники: перенос идей и запросов YouTube/SoundCloud — из [Muriel](https://github.com/cloverscripts/riff-muriel/tree/muriel) (MIT), iOS-форка [Riff](https://github.com/rootscripts/riff).
