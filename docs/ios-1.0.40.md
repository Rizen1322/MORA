# MORA iOS 1.0.40 (build 41)

Рабочая ветка: `claude/ios-1.0.39-features`, отдельная копия `builds/ios-likes-1.0.29`. Основная ветка не изменялась. Bundle ID `ru.mora.player`, расширение `ru.mora.player.widgets`, App Group `group.ru.mora.player`, iPhone / iOS 17.4 / тёмная тема сохранены. Обход оптимизатора в `NativeShell.receive()` сохранён.

## Изменения по фазам

| Фаза | Реализация и основные файлы | Автоматическая проверка |
|---|---|---|
| 1 | Существующая анимация «Одна линия» в `apps/web/src/lib/splash.ts`, без нового рисунка. На iPhone около 2.2 с при готовой медиатеке, ожидание готовности под оверлеем, предел ожидания 10 с для выхода к ошибке загрузки. Холодный foreground, одна сессия, Reduce Motion, очередь deep links. `SceneDelegate.swift`, `NativeShell.swift`, `NativeIntents.swift`, `native-ui.ts`. Конфигурируемый источник и Lock Screen в `MORAWidgets.swift`. | `splash.test.ts`, `native-ui.test.ts`, Swift `native-wave-link`, `native-widget`, скриншот в `--native-ui-check`. |
| 2 | `NativeStationSnapshot.swift`, `NativeStationFiles.swift`, `StationStarter.swift`: версия схемы, очередь до 50 треков, настройки, позиция, атомарный снимок, проверка локальных файлов. Siri, autoplay deep link и CarPlay используют единый host. | Swift `native-station`, тест компактного payload в `native-ui.test.ts`. |
| 3 | `NativeCarPlay.swift`: Продолжить / Волна / Любимое / Загрузки / Недавние, обложки 40×40, состояние воспроизведения, локальный старт. Флаг `carplay` workflow, проверка entitlement после подписи. | Компиляция Release, проверки identity/entitlements IPA. Физическая машина не проверена. |
| 4 | `NativeActivityShared.swift`, `NativeLiveActivity.swift`, `MORAActivityWidget.swift`: Lock Screen, Dynamic Island, play/pause/next/like через intents, coalescing обновлений. ControlWidget только iOS 18+. | Swift `native-activity`, компиляция app и extension с target 17.4. |
| 5 | `NativeDownloadQueue.swift`, `NativeDownloadManager.swift`: системная фоновая URLSession, постоянная очередь, прогресс/ETA, пауза/повтор/отмена, Wi-Fi-only, лимит и место. `native-downloads.ts`, `native-pages.ts`, bridge/API: любимое и следующие 5/10/20/50 треков волны. Скачанные файлы доступны host без повторной передачи через WebKit. | Swift `native-download-queue`; JS `native-downloads`, `native-sources`, `native-source-manifest`; диагностический экран прогресса в UI check. |
| 6 | `NativeBackupStore.swift`, `library-backup.ts`, `routes/backup.ts`: настройки, плейлисты, реакции, история, умные правила; без секретов/аудио. Автокопии при сворачивании и каждые 10 минут изменений, последние 5, экспорт/восстановление. iCloud Drive только при `MORA_ICLOUD=1`. | Swift `native-backup`, JS full-library/legacy backup: повторы импорта, повреждение, секреты, вращение копий. |
| 7 | `smart-playlists.ts`, `routes/smart-library.ts`, `native-pages.ts`: редактор правил, дубликаты, перенос ссылок/счётчиков/реакций, безопасное удаление только собственных файлов; метаданные и обложка без ID3, статистика. `NativeIntents.swift`, `NativeSpotlight.swift`, quick actions: плейлист, таймер, скачивание, Spotlight. | JS правила, merge owned/linked files, сохранность очереди, метаданные, статистика и бэкап; Swift remap реакций. |
| 8 | `providers/yandex.ts`, `routes/catalog.ts`: подтверждённые upstream endpoints списка/импорта плейлистов, порядок и повторения сохранены, недоступные треки видны, аудио не скачивается. `NativeMetrics.swift`, `NativeDiagnosticArchive.swift`: MetricKit и локальный ZIP из служебных сведений. | JS fixture HTTP + существующие Yandex catalog/reactions; Swift ZIP signature/entry check. |
| 9 | `NativePlayer.swift`, `NativePlayerState.swift`, `NativeMixHost.swift`: fade 5 с, остановка после 2/5/10/20 треков, отмена восстанавливает отдельный gain без изменения громкости пользователя; нет сети в player/CarPlay, share `mora://track/id`. Использованы существующие haptics лайка/очереди/переключения. | Swift sleep decisions в `native-player`: переход, повторяющиеся треки по entryId, пауза, границы fade. |

Все исходники Swift расположены в `apps/mobile/ios/App/App/`; новые файлы явно включены в нужный target Xcode. Тесты Swift — `apps/mobile/test/native-*/main.swift`. Все коммиты фаз доступны в истории ветки.

## Проверки

- `npm run typecheck` проходит локально.
- Полный Vitest в GitHub Actions запускается на Linux с ffmpeg/ffprobe. На Windows исходный baseline имел 7 падающих suites из-за отсутствия этих программ; это не объявлено регрессией релиза.
- Обычная сборка [43017076416](https://github.com/Rizen1322/MORA/actions/runs/43017076416) на коммите `f3753bd`: Vitest, Swift-проверки, Release IPA, entitlement gate, Rust MIR, DSP, HTTP transport, фоновый host, очередь PCM и запуск приложения в симуляторе — зелёные. Обе IPA собраны из этого коммита.
- Вариант [43017092785](https://github.com/Rizen1322/MORA/actions/runs/43017092785): та же сборка с `com.apple.developer.carplay-audio` и `com.apple.developer.icloud-services`; в обычной IPA оба entitlement отсутствуют.
- Обе IPA повторно проверены локально `verify-ipa-1.0.40.cjs`: обычная — 4 785 392 байта, SHA-256 `95204be8d0541a9225e8845711c625adaf347500e3d3de99d5b59b85b8447070`; CarPlay/iCloud — 4 785 792 байта, SHA-256 `aafe7e9cc08fd858b2b457f24ad563d17848bdaa97c9a9c667b995f2c0be7ddc`.
- UI-прогон [43024458162](https://github.com/Rizen1322/MORA/actions/runs/43024458162) на коммите `e30d112` (в нём только увеличен таймаут проверки до 75 минут): заставка подтверждена скриншотом видимого полноэкранного canvas «Одной линии», `mora://wave?source=yandex` дошёл до команды волны, экран загрузок с прогрессом, поиск, импорт WAV, плеер и восстановление очереди — все сценарии прошли. Предыдущий прогон срезал 45-минутный лимит на шаге проверки, поэтому бюджет поднят.
- Сценарии UI используют явно диагностические fixtures и не выдают fixture за реальную загрузку.
- `apps/mobile/scripts/verify-ipa-1.0.40.cjs` проверяет CRC каждого ZIP entry, arm64, bundle/version/build/minOS, iPhone-only, dark, Live Activities, расширение, ad-hoc signatures/App Group, отсутствие provisioning profile, feature symbols, entitlement gates. Создаёт рядом `.sha256` и `.verification.json` с commit и URL run.

## Ограничения и безопасное поведение

- **CarPlay:** бинарник содержит поддержку, но реальная работа требует одобренного Apple `com.apple.developer.carplay-audio` и подходящей подписи. Обычная IPA его не запрашивает. Флаг CI проверяет запрос entitlement, не получение разрешения Apple.
- **iCloud:** включается отдельно `MORA_ICLOUD=1`, нужен настроенный контейнер `iCloud.ru.mora.player` и подпись. Синхронизация CloudKit и разрешение конфликтов между двумя устройствами отложены, как разрешено заданием. В обычной IPA iCloud отсутствует.
- **Переустановка:** Documents/backup удаляется при удалении приложения. До удаления экспортировать копию в Files либо использовать отдельно настроенный iCloud. Установка поверх сохраняет контейнер. Обещания восстановления удалённой локальной копии нет.
- **Нативная станция:** локальный старт использует полные сжатые файлы, уже переданные нативному host; отдельный запас до 512 МиБ. Не вся OPFS-медиатека автоматически доступна без WebView. При отсутствии текущего файла — понятный отказ и открытие MORA; протухшие URL не используются. Возобновлённая локальная очередь играет без AutoMix, настройки волны сохранены для дальнейшего старта из приложения. Подготовка/декодирование не даёт доказанной гарантии старта за 2 с.
- **Загрузки:** отдельный background путь поддерживает прямой HTTPS/разрешённый MP3. Для HLS/источников, требующих WebKit, возвращается явная ошибка; существующий foreground worker сохранён. После пользовательского force quit iOS отменяет background transfers: JSON-очередь сохраняется, на открытии предлагается повтор с новым URL. Продолжение скачивания после force quit не обещается. Настройка Wi-Fi применяется к новым и пересозданным задачам.
- **Live Activity:** новая активность создаётся при игре в foreground и обновляется в фоне. При чистом background старте новая активность не создаётся из-за ограничений ActivityKit. Системные лимиты виджетов/ActivityKit могут задерживать обновление. Кнопки при отсутствии host безопасно ничего не делают.
- **Яндекс:** вводится готовый access token. Нет refresh token и собственного OAuth client ID/secret: автоматический refresh не имитируется, 401/403 предлагают переподключение. Мультиаккаунт отложен: текущая схема provider ID имеет один набор credentials. Лайк/дизлайк использует существующие подтверждённые endpoints и durable outbox; выдуманные типы rotor feedback не добавлялись.
- **MetricKit:** доставка зависит от iOS и устройства. Отсутствие payload сразу после установки нормально; экспорт содержит доступные локальные данные, ничего не отправляет наружу.
- **Измерения:** физического iPhone 12 и автомобиля в окружении нет. Холодный первый кадр <1.5 с, память <250 МиБ, расход батареи на паузе, 10 реальных фоновых загрузок, 30 минут CarPlay и haptics не измерены. Симулятор не считается заменой этим измерениям.

Подтверждение поведения платформы/API: [Apple background URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background%28withidentifier%3A%29), [ActivityKit intents](https://developer.apple.com/documentation/appintents/liveactivityintent), [MetricKit subscriber](https://developer.apple.com/documentation/metrickit/mxmetricmanagersubscriber), [Foundation ZIP snapshot](https://developer.apple.com/documentation/foundation/nsfilecoordinator/readingoptions/foruploading), [Yandex upstream playlist endpoints](https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/playlists.py), [OAuth refresh](https://www.yandex.ru/dev/id/doc/ru/tokens/refresh-client).

## Готовый пакет

- `builds/MORA-iOS-1.0.40-build-41.ipa` — обычная ad-hoc IPA без CarPlay/iCloud: 4 785 392 байта, SHA-256 `95204be8d0541a9225e8845711c625adaf347500e3d3de99d5b59b85b8447070`.
- `builds/MORA-iOS-1.0.40-build-41-carplay-icloud.ipa` — с `com.apple.developer.carplay-audio` и `com.apple.developer.icloud-services`: 4 785 792 байта, SHA-256 `aafe7e9cc08fd858b2b457f24ad563d17848bdaa97c9a9c667b995f2c0be7ddc`.
- Рядом лежат `.sha256` и `.verification.json`; опубликованы как pre-release `ios-v1.0.40`.

## Ручная проверка на устройстве

- [ ] Экспортировать backup из 1.0.38, установить 1.0.40 поверх: плейлисты, лайки, история, настройки и файлы на месте.
- [ ] Холодный запуск: существующая «Одна линия», нет белой вспышки, данные грузятся под ней, по окончании нет пустого экрана. Повторное foreground без заставки. Reduce Motion — короткий fade. Медленная/ошибочная загрузка даёт понятный интерфейс ошибки, не вечную заставку.
- [ ] Deep link во время заставки исполняется после неё; фоновые Siri/CarPlay/widget не показывают анимацию.
- [ ] Два экземпляра Wave widget с разными источниками; default уважает приложение. Неподключённый Яндекс предлагает подключение. Small/medium, все Lock Screen families, timestamp «Продолжить».
- [ ] Сначала проиграть собственную локальную станцию, заблокировать/перезапустить без сети; проверить локальный старт Siri и CarPlay, недостающий файл, отсутствие дубликатов playback.
- [ ] Играть 30 минут в фоне; AirPods → динамик → CarPlay, звонок/прерывание, блокировка/разблокировка. Сверять Now Playing, паузу, like/dislike и очередь.
- [ ] Live Activity / Dynamic Island: pause/next/like синхронны; конец очереди/stop/ошибка убирают активность. Нет дубликатов. Без host кнопки не крашат; Control Center iOS18+.
- [ ] 10 реальных HTTPS-треков: свернуть/заблокировать, проверить завершение, ETA, pause/resume/cancel/retry. Wi-Fi-only на сотовой сети, смена настройки во время скачивания, лимит кэша и нехватка места, истёкший URL, force quit и новый запуск.
- [ ] Keep wave 5/10/20/50: нет дубликатов, лимит соблюдён; скачать всё любимое, удаление и сортировка.
- [ ] Изменить данные → фон → проверить 5 авто-бэкапов. Экспорт в Files → удаление → установка → импорт: плейлисты/лайки/история восстановлены, повтор импорта не дублирует историю. Отдельно iCloud при подписанном контейнере.
- [ ] Умные правила по каждому полю; слияние дубликатов с повторениями в плейлисте, лайком и linked file, сохранность текущей очереди. Метаданные/обложка после перезапуска, ID3 исходника не изменился. Статистика и смена часового пояса.
- [ ] Siri находит плейлист по имени; таймер, скачивание, Spotlight и quick actions. Share link открывает нужный трек. Haptics на устройстве.
- [ ] Яндекс: плейлист с повторениями и недоступным треком, истёкший токен, отказ сети во время волны, восстановление feedback outbox после reconnect.
- [ ] ZIP служебных сведений открывается в Files, содержит версию/логи/состояние/ошибки и доступный MetricKit; не содержит токенов.
- [ ] Таймер: последние 5 с плавно затихают, пользовательская громкость после нового Play сохранена; N треков учитывает разные entryId одного трека, отмена и пауза работают.
- [ ] Instruments на iPhone 12-класса: отдельно записать первый кадр, RSS после 30 минут и расход/CPU на паузе; memory warning, убийство/восстановление, сеть пропала посреди волны. До измерений бюджеты не подтверждены.
