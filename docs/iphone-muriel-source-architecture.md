# iPhone: источники, волна, загрузки и AutoMix после изучения Muriel

Дата:21 октября2026. Исследование исходников и проект архитектуры; IPA не устанавливалась, поведение на реальном iPhone не проверено.

## Что действительно найдено

В основном rootscripts/riff нет официальной iOS-версии. Его README ведёт на страницу community forks, которая указывает `cloverscripts/riff-muriel`. У последнего **ветка main остаётся desktop**, мобильный код находится в **ветке muriel**. Изученный commit: `9dcaec6ac3a437ab34785f853d0e3e45aa1437de`. В releases есть prerelease Muriel.ipa, сборка помечена unsigned. Наличие артефакта не доказывает качество или прохождение App Review.

| Файл Muriel | Что делает |
|---|---|
| mobile/extract.js | Поиск YouTube/YouTube Music через youtubei.js/web; SoundCloud web API; разрешение stream URL на устройстве |
| mobile/bridge.js | Native HTTP через Capacitor; переадресация старых локальных API-вызовов во внутрипроцессный dispatcher |
| mobile/build.mjs | Bundling desktop server.js с browser/native shims, а не запуск Node на телефоне |
| mobile/shims/http.js | Объекты request/response без TCP socket |
| mobile/shims/child_process.js | Заменяет нужные yt-dlp-вызовы JS-функциями, настоящего spawn/execFile на iOS нет |
| mobile/shims/store.js | Файлы через Capacitor Filesystem; локальные URL для media playback |
| mobile/ts2aac.js | Demux/соединение определённых AAC/TS сегментов для локального файла |
| mobile/cache-limit.js | Ограничение cache, oldest-first, сохраняет4 новейших файла |
| mobile/mobile-ui.js | На iPhone отключает AudioContext graph: EQ/reverb/distortion/visualizer выключаются ради plain audio playback |
| ios/App/App/AppDelegate.swift | AVAudioSession playback; также присутствует private WebKit preference, которую в нашем продукте использовать не следует |

Вывод: поиск/получение музыки без собственного сервера технически реализованы в исходниках форка. Полноценный стабильный фоновый DSP и наш AutoMix этим форком не доказаны. Указанные в комментариях extractor форматы, битрейты и доступность без входа — предположения автора конкретного snapshot, а не гарантия сегодняшних ответов сервисов.

## Рекомендуемая архитектура нашего приложения

Сохранить React UI в Capacitor для быстрого первого iOS-клиента, но убрать обязательную зависимость от Fastify, localhost HTTP, Node/Python/desktop executables. UI вызывает platform-neutral API, который на ПК обращается к backend, на iPhone — к native bridge/in-process service. Не нужно эмулировать весь Node fs/http/child_process монолит, как сделал форк для максимального переиспользования своего server.js.

Компоненты:

1. **Catalog adapters:** public search/related/playlist metadata, optional Yandex account adapter. Один нормализованный результат с provider, externalId, canonical URL, title, artists, version, duration, provenance.
2. **Resolver:** canonical ID → временный PlaybackDescriptor: URL, expiry, format, headers policy, direct/HLS, seek/download/PCM capability. JS extractor может быть упакован в приложение и использовать native HTTP; для фоновой работы нельзя полагаться только на WebView timers. Отдельный JS runtime/native реализация потребует проверки зависимостей библиотеки и lifecycle.
3. **Download/asset service:** native URLSession/file storage, durable job DB, проверка/атомарная публикация. Asset хранится независимо от страницы UI.
4. **Wave coordinator:** локальная история/вкусы, candidate pool, очереди подготовки, bounded reserve, причины исключения.
5. **Native audio host:** AVAudioEngine и DSP/AudioUnit/C++ реализация нашего mixer/WSOLA/EQ/limiter. Он владеет временем и очередью после блокировки экрана; UI только показывает snapshot/посылает команды.
6. **Analysis service:** локальные MIR/Accelerate и проверенная mobile/Core ML separation при наличии ресурса. Analysis/stems принадлежат recording hash; процесс Python не переносится.

AVPlayer подходит для прототипа простого streaming, особенно HLS, но его наличие не означает доступный PCM для нашего DJ-mixer. Полный AutoMix требует проверенного decode-to-PCM для выбранного контейнера и доступного полного аудио. Возможны два явно обозначенных режима: plain streaming сейчас и advanced mix после подготовки локального asset. Переключение между host paths должно быть единым state machine, без двух независимых транспортов/двойного звука.

## Как работает поиск и Play

1. Пользователь вводит запрос без регистрации. Search coordinator параллельно спрашивает доступные adapters, показывает готовые результаты, отменяет устаревшие запросы.
2. Metadata cache хранит результаты ограниченное время. Группировка одинаковых песен не стирает разные версии. Строка показывает реальный источник звука, uploader/artist, длительность.
3. Play создаёт queue entry со стабильным canonical reference. Если есть проверенный локальный asset — используем его. Иначе resolver получает краткоживущую ссылку и capabilities.
4. Простой playback стартует как можно раньше. Если файлу нужна подготовка, показывается честный progress; latency измеряется. Нельзя выдавать весь YouTube/SoundCloud каталог как заведомо PCM-ready/downloadable.
5. URL expiry/403 приводит к одному контролируемому re-resolve того же recording, не к подмене первой похожей песней. Если источник требует аккаунт/недоступен — сообщить и показать другие результаты. Никакого обхода DRM/платного доступа/CAPTCHA.
6. Для следующей пары заранее подготавливается asset/PCM/analysis. Не ждём завершения текущих4 песен и не скачиваем всё, что попало в результаты поиска.

Native HTTP помогает устранить браузерную CORS-зависимость, но не отменяет серверные ограничения, доступность записи и условия источника. Provider credentials/внутренний launch token нельзя передавать стороннему CDN. Signed URLs/headers не логируются. TLS verification остаётся включённой.

## Волна без Яндекса

Волна собирается в приложении из публичных related/mix результатов, поиска по артистам/жанрам/seed tracks и локального профиля. Никакой арендуемый recommendation server для первого варианта не обязателен.

Cold start: выбрать3–5 артистов либо нажать «Волна от этого трека». Пока вкуса нет, показывать реальные жанровые старты, не обещать персональную нейросеть.

Резерв имеет три слоя, стартовые параметры требуют измерений:

- **Кандидаты:** примерно30–50 metadata records, без загрузки всех файлов. Dedup source IDs и recording candidates, dislikes/recent history, caps по одному артисту.
- **План очереди:**6–10 рекомендованных позиций с учетом продолжительности и доступности. Считаем минуты резерва, а не только количество песен.
- **Готовый звук:** current + next2–3 проверенных audio assets при согласованной политике cache/трафика; ближайшая пара — PCM/analysis. Только один тяжёлый separation job за раз до реальных замеров.

Refill с hysteresis: низкий резерв, например<8 минут playable audio, запускает singleflight; пополняем до12–15 минут или меньшего лимита байт/количества. Это стартовые engineering defaults, не обещание постоянно хранить15 минут на любой сети. Cellular/Low Data/мало места уменьшают бюджет. Manual Next немедленно повышает приоритет следующей доступной песни.

Ранжирование: интерес пользователя и разнообразие прежде совместимости для перехода. Темп/тональность помогают выбирать порядок нескольких подходящих песен, но не превращают волну в цикл одного BPM. Если анализ не готов — безопасный переход. Ошибка одного кандидата исключает его с backoff и не останавливает весь источник.

При background native coordinator продолжает подготовку, необходимую действующему playback, в рамках возможностей iOS; UI JS не является источником времени. Пока background resolver не доказан на устройстве, готовый резерв обеспечивает только конечное время прослушивания. Не заявлять бесконечную волну после блокировки по одному прохождению foreground теста.

Яндекс-волна остаётся отдельным optional adapter с реальными session/batch/settings. Локальные рекомендации не выдают себя за персонализацию Яндекса; feedback не отправляется за чужой recording.

## Downloads, cache и офлайн

Разделить **временный cache прослушанного**, **умный резерв** и **явно скачанное пользователем**. У каждого — независимый бюджет. Воспроизведение не означает вечное добавление в пользовательскую коллекцию; Download создаёт pin, Add to library — отдельное предпочтение.

Job state: queued → resolving → downloading → verifying → ready. Analysis/stems — дополнительное независимое состояние. Ошибка/отмена/потеря сети сохраняются в БД; ready не выставляется по факту существования файла. Playlist download показывает корректное число успешных и failed треков.

Для обычного файла — background URLSession. Для поддерживаемого HLS — AVAssetDownloadURLSession с проверкой доступности и формата; HLS package может подходить для playback и не давать удобный PCM asset для DSP. Не конкатенировать произвольный HLS: учитывать playlist type, init segments, codecs, discontinuities, шифрование/DRM и право скачивания. Встроенный demux нужен только для поддерживаемого незащищённого формата, не как универсальный converter.

Не повторять Muriel downloadHls, который удерживает массив всех segments в JS RAM и затем пишет base64 через bridge. Для long tracks/playlists данные идут native streaming-to-disk с ограниченными буферами, проверкой размера/места и атомарным manifest. Это снижает пиковую RAM и риск убийства процесса iOS.

LRU исключает current/next и pinned downloads, а не просто сохраняет4 новейших файла. Analysis/PCM/stems — восстановимые производные; их можно чистить отдельно от originals. Запрещено молча удалить собственный оригинальный файл из Files при очистке cache.

Умные офлайн-подборки можно готовить заранее по настройке пользователя: количество/байты, Wi-Fi only, обновление при доступном ресурсе. Это конечный набор, не новая бесконечная онлайн-волна в авиарежиме. В офлайне ранжируем только действительно доступные assets, пропускаем missing и не ждём сеть на каждом Next. Реакции хранятся локально и синхронизируются только подходящему provider/аккаунту.

## AutoMix на iPhone

- MIR лёгкого уровня после загрузки/импорта; current/next важнее полной библиотеки.
- Stems готовить для ожидаемых entry/exit окон, не для каждой песни из candidate pool. Проверить качество mobile/Core ML модели и совместимость с исходным audio timeline.
- EQ пользователя и final peak protection — в native host, чтобы не исчезать при блокировке, как graph в Muriel.
- Нативные generation/transport revisions защищают Pause/Next/seek/source replacement от поздних результатов. Текущий blend не перепланировать посреди исполнения.
- На audio thread нет network/file I/O/ML/неограниченных allocations. При thermal/Low Power Mode сокращается подготовка/визуализация, а не стабильность текущего render.
- Если advanced preparation не успела, честный музыкальный fallback; никаких обязательных пауз на separation.

## Фон, установка и проверка

AVAudioSession playback и UIBackgroundModes audio — публичная основа background playback. Нужны interruption/route change, MPRemoteCommandCenter, Now Playing, restore queue, сохранение пользовательской паузы. Private WebKit preferences из Muriel не использовать как продуктовый фундамент. BackgroundTasks не гарантируют запуск произвольного анализа точно к нужному переходу.

При force quit пользователем не обещать продолжение музыки/всех загрузок. Apple отдельно описывает отмену активных AVAssetDownload background jobs при force quit. Закрытый экран, свёрнутое приложение, suspension и force quit — разные тесты.

App Store и личная IPA-установка — разные сценарии распространения. В App Review Guidelines5.2.3 прямо есть требование разрешения источников на сторонние audio/video downloads; наличие Muriel.ipa в GitHub не подтверждает разрешение/одобрение Apple.2.5.2 также нужно учитывать для обновления executable/extractor code. Для первого технического прототипа уточнить канал установки; никакой канал сам по себе не отменяет права на контент. Это ограничение распространения, не необходимость арендовать сервер.

Первые acceptance gates:

1. Чистая установка, без Яндекс-токена и без ПК: поиск/Play/Next/seek из поддержанных доступных источников.
2.30–60мин при заблокированном экране, несколько полных refill cycles без UI timers; сеть Wi-Fi↔cellular, expired links, источник down. Пока не пройдено, endless background wave не заявлена.
3. Скачать playlist, прервать сеть, закрыть/relaunch, повторить, проверить aviаmode и нехватку места. Pinned файлы остаются.
4. Несколько реальных сложных пар через native DSP; аудиозапись/underrun/true peak/peak RSS/energy/thermal measurements на минимальном целевом устройстве.
5. Перемотка/Next/Pause при pending resolve/ML, звонок, наушники отключены, Bluetooth route/sample rate change, restart, отмена source replacement.

## Практическая последовательность

1. Сейчас на ПК выделять provider contracts/recording assets/settings/local taste так, чтобы они не зависели от Fastify request или DOM.
2. iPhone MVP: Capacitor UI + native HTTP/file store + проверенные source adapters + простой native playback без облака.
3. Durable downloads и волна с реальным background coordinator.
4. Native DJ mixer/планировщик/analysis; затем Core ML vocal tier.

Не требуется сразу полностью переписать UI на SwiftUI. Но перенос веб-страницы без native audio/service lifecycle не удовлетворяет нашему качеству AutoMix.

## Первичные ссылки

- https://github.com/rootscripts/riff#mobile-versions
- https://rootless.shit.vc/fork
- https://github.com/cloverscripts/riff-muriel/tree/muriel
- https://github.com/cloverscripts/riff-muriel/releases/tag/ios-latest
- Все упомянутые mobile-файлы: https://github.com/cloverscripts/riff-muriel/tree/9dcaec6ac3a437ab34785f853d0e3e45aa1437de/mobile
- https://github.com/cloverscripts/riff-muriel/blob/9dcaec6ac3a437ab34785f853d0e3e45aa1437de/ios/App/App/AppDelegate.swift
- https://developer.apple.com/documentation/avfaudio/avaudioengine
- https://developer.apple.com/documentation/foundation/downloading-files-in-the-background
- https://developer.apple.com/documentation/avfoundation/avassetdownloadurlsession
- https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app
- https://developer.apple.com/app-store/review/guidelines/

Подход форка подтверждён чтением исходников; предложенные бюджеты, структура сервисов и rollout — наша рекомендация, требующая прототипа на реальном iPhone. Стабильность публичных extractor endpoints в этом исследовании сетевым playback-тестом не проверялась.
