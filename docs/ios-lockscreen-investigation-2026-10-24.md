# iPhone: почему не работают Pause, Next и перемотка на экране блокировки

24 октября 2026. Устройство по словам пользователя: **iPhone 15 Pro Max, iOS 27**. Не работают не только Next/Previous и перемотка, но и Pause. Исследованы текущие `apps/mobile` и общий контроллер. Исходники не менялись, новая IPA не выпускалась. `apps/ios` — отдельный старый прототип.

**Вывод:** предыдущая правка не установила единый маршрут управления системным плеером. Она зарегистрировала native navigation отдельно от WebKit, который продолжает публиковать Now Playing. Дополнительно контроллер способен немедленно отменять системную Pause. Это подтверждённые свойства кода; точная последовательность событий на телефоне ещё не записана.

## Подтверждённые находки

1. **Метаданные и навигация относятся к разным управляющим путям.** `native.ts:118` передаёт `null` вместо WebKit handlers Next/Previous/Seek, при этом `native.ts:149` продолжает публиковать WebKit metadata. Swift `MoraAudioPlugin.swift:74` регистрирует `MPRemoteCommandCenter.shared()` и шлёт события в JS (`:71`). Плагин не публикует собственный Now Playing и не подтверждает, что именно его command center выбран системой. `isEnabled=true` доказывает доступность зарегистрированной команды в этом endpoint, а не получение им нажатия из выбранной системной карточки.

2. **У WebKit есть свой межпроцессный путь.** В изученном WebKit Now Playing owner выбирается среди кандидатов. GPU-процесс передаёт команды конкретному WebContent session через IPC; его supported commands обновляются отдельно. Поэтому нельзя считать системную карточку WebKit автоматически связанной с `MPRemoteCommandCenter.shared()` приложения. Это наиболее вероятное объяснение недоставки native Next/Seek, но для этого телефона пока нет callback-логов. [GPUConnectionToWebProcess.cpp:935–947](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebKit/GPUProcess/GPUConnectionToWebProcess.cpp#L935), [GPUProcess.cpp:419](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebKit/GPUProcess/GPUProcess.cpp#L419).

3. **WebAudio не получает весь контракт MediaSession.** `AudioContext::didReceiveRemoteControlCommand` обрабатывает Play/Pause/Stop/Toggle непосредственно через состояние контекста, без вызова JS action handler. `supportsSeeking()` возвращает false. Сам DOM MediaSession в его platform-client интерфейсе не принимает remote commands; наличие JS handlers не превращает его в самостоятельный аппаратный плеер. [AudioContext.cpp:585](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebCore/Modules/webaudio/AudioContext.cpp#L585), [AudioContext.h:145](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebCore/Modules/webaudio/AudioContext.h#L145), [MediaSession.h:198](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebCore/Modules/mediasession/MediaSession.h#L198).

4. **В MORA есть конфликт с системной Pause.** `apps/web/src/audio/controller.ts:294–298`: любой переход AudioContext в не-running/не-closed вызывает `ctx.resume()`, пока snapshot.status остаётся playing/buffering. Если WebKit остановил AudioContext своим remote Pause, а JS handler не был вызван, snapshot остаётся playing — MORA возобновляет звук. Это объясняет сценарий «кнопка нажалась, но паузы нет». Для подтверждения на устройстве нужно увидеть `running → suspended → running` без пользовательского Play. Нельзя автоматически приписать этому все случаи недоставки Next.

5. **Перемотка блокируется ещё до JS.** При отсутствии seeking capability WebKit не рекламирует seek-команды и отклоняет соответствующий remote request. Настройка native `changePlaybackPositionCommand.isEnabled` не меняет capability AudioContext у WebKit. Удаление handlers также удаляет supported command в WebKit; текущий bridge делает именно это. [RemoteCommandListenerCocoa.mm:102](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebCore/platform/cocoa/RemoteCommandListenerCocoa.mm#L102), [MediaSession.cpp:298](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/Source/WebCore/Modules/mediasession/MediaSession.cpp#L298).

6. **Текущие тесты проверяют обход реального источника проблемы.** `apps/mobile/test/native-media.test.ts:42–69` вручную вызывает сохранённый native listener. В тесте нет iOS Now Playing election, GPU origin, настоящего lock-screen tap, suspension WebContent и AudioContext statechange. Xcode BUILD SUCCEEDED подтверждает компиляцию, а не delivery системных команд. Swift `:92` отвечает `.success` до JS-ack/изменения звука, поэтому и этот статус не подтверждает выполнение.

Изученный WebKit зафиксирован на commit `d878117d5b773fb1151dabcb11e8617390f3c74d` (24.10.2026). Он показывает реализацию актуальной ветки, но не доказывает, что бинарный WebKit конкретной сборки iOS 27 полностью совпадает с этим commit.

## Что меняет iOS 27

Apple предоставляет **NowPlaying.MediaSession** с единой наблюдаемой моделью метаданных, времени и команд. Это публичный кандидат для native control plane на iOS 27. Apple требует не смешивать его с native `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` для того же локального playback. [Официальная документация Now Playing](https://developer.apple.com/documentation/nowplaying).

`requestToBecomeSystemPrimary()` можно вызвать из foreground после выбора воспроизведения пользователем. Нужно наблюдать `isApplicationPrimary`/`isSystemPrimary`; сам вызов не гарантирует появление карточки. Он не является публичным выключателем публикаций WKWebView. На фоне такой запрос не действует. [Publishing media sessions](https://developer.apple.com/documentation/nowplaying/publishing-media-sessions), [requestToBecomeSystemPrimary](https://developer.apple.com/documentation/nowplaying/mediasession/requesttobecomesystemprimary()).

Новый API не означает, что прежние MediaPlayer API обязаны перестать работать на iOS 27. И он сам не решает выполнение JS в фоне. Текущий workflow использует Xcode 26.2: для импорта NowPlaying нужен SDK, содержащий новый framework; одной проверки `if #available(iOS 27, *)` недостаточно.

В просмотренных публичных `WKWebView`, `WKWebViewConfiguration`, `WKPreferences` headers **не найден API «выключить только Now Playing WebAudio, сохранив звук»**. `_mediaSessionEnabled` находится в private header и относится к JS MediaSession; AudioContext eligibility зависит отдельно от playback audio session. Менять audioSession.type на auto/ambient ради исчезновения карточки рискованно для фонового playback. `setAllMediaPlaybackSuspended` выключает воспроизведение, а не только публикацию.

## Одна диагностическая IPA перед следующим исправлением

Следующий рекомендуемый шаг — короткая **диагностическая сборка**, а не очередной релиз, который только добавляет handlers. В ней нужны:

- Встроенный экран отчёта: версия/build приложения, SDK, точная iOS version/build, модель, app foreground/background, native audio-session category/mode/active/interruption. Ни токенов, ни URL источников, ни пользовательских названий треков.
- Для каждого tap единый sequence ID и время: **native callback → Capacitor listener → controller action → AudioWorklet command/ack → фактическая позиция/status/ctx.state**. Запись ограниченного кольцевого журнала с нативным сохранением, доступного после разблокировки. Отдельно писать каждую автоматическую попытку `resume()` и её причину.
- Безопасная диагностическая кнопка в приложении, вызывающая тот же bridge. Если она работает на foreground, но настоящий lock-screen tap не появляется в native callback, причина до Capacitor. Если native callback есть, а JS-ack появляется только после разблокировки, проблема фонового исполнения/моста. Если JS и worklet получили команду, искать transport/preparation/PCM, а не регистрацию command center.
- Для Pause: записать ctx transition. Наблюдение `suspended → автоматический resume` при неизменном playing подтвердит конфликт keepRunning. Отключение этого восстановления только в диагностическом режиме должно оставить звук на паузе. Это отдельная проверка; она не считается ремонтом Next/Seek.
- Сравнить три тестовых режима на **двух локальных файлах**: текущий WebAudio hybrid; обычный seekable HTMLAudioElement с настоящими MediaSession handlers; native-only AVAudioPlayer/AVPlayer с одним native publisher. Первый тест исключает сеть/декодирование следующего трека. Второй отличает ограничения AudioContext от общего WKWebView поведения. Третий проверяет системную native-интеграцию приложения.

Прогон: Control Center при открытом приложении → экран блокировки во время звучания → Pause/Play → Next/Previous → seek 10→60 → повтор после паузы дольше 3 минут; отдельно cold-cache Next. Если Pause не работает даже в foreground Control Center, начинать с route/intent; не объявлять фоновые таймеры основной причиной без журналов.

`UIBackgroundModes=audio` уже есть (`Info.plist:54`), `navigator.audioSession.type='playback'` тоже (`bridge/index.ts:357`). Они разрешают соответствующий аудиосценарий, но не гарантируют произвольную работу Web Worker, decodeAudioData или evaluateJavaScript в фоне. В текущем Next дополнительно есть асинхронная подготовка и `api.mixNow` (`controller.ts:855,914`); это вторичный риск для непрогретого трека, который не объясняет отсутствие Pause.

## Практические варианты после журнала

| Вариант | Оценка |
|---|---|
| Оставить WebKit metadata и ещё раз включать native isEnabled | Не рекомендую. Владелец карточки и endpoint команд остаются несогласованными. |
| Только WebKit MediaSession с настоящими handlers | Хороший сравнительный тест на HTMLAudioElement. Для текущего AudioContext Next/Seek не становятся реализованными от одной регистрации handlers. Silent audio loop/фиктивный медиаплеер — не надёжное производственное решение. |
| Единый native control plane при существующем WebAudio | Ограниченный эксперимент: все команды, включая Play/Pause, один publisher, native intent и JS/worklet ack. На iOS 27 можно испытать NowPlaying primary API, на 17.4+ — отдельную legacy MediaPlayer ветку. Проверить, что WebKit не перехватывает ownership и фоновые команды доходят до DSP. Без этого нельзя обещать устойчивость. |
| **Единый native audio host + очередь + control plane** | **Наиболее устойчивый целевой путь для iOS 17.4+.** Команды исполняются рядом с реальным transport даже при приостановке WebView, а JS-интерфейс отображает подтверждённое состояние. Legacy MP publisher/commands подходят для 17.4+; NowPlaying на 27 — отдельная доступная версия реализации, не обязательное условие исправности. |

Native audio host не требует переписывать интерфейс, медиатеку и TS-планировщик. Формат `TransitionPlan` можно сохранить. Но сохранение всего текущего AudioWorklet DSP потребует отдельного переноса/эквивалентной реализации realtime-исполнителя и проверки аудио. Нельзя незаметно заменить beatmatch/WSOLA на простой AVPlayer crossfade и назвать результат тем же AutoMix. Не нужна локальная ML-модель.

Независимо от выбранного пути, **transport intent и состояние AudioContext должны быть согласованы**: явная Pause не отменяется автоматическим keepRunning, Play действует и на контекст, и на paused-состояние микшера. Автовосстановление разрешается по конкретной причине (окончание допустимого прерывания при сохранённом playing intent), а не при каждом не-running state.

## Дополнительные первичные источники и границы

- [Apple: handling external player events](https://developer.apple.com/documentation/mediaplayer/handling-external-player-events-notifications) — native команды обслуживают текущий Now Playing app; регистрация не является тестом фактического нажатия.
- [WebKit: now-playing-webaudio test](https://github.com/WebKit/WebKit/blob/d878117d5b773fb1151dabcb11e8617390f3c74d/LayoutTests/media/now-playing-webaudio.html) — проверяет eligibility контекста и предпочтение HTMLMediaElement; не проверяет MORA transport.
- [WebKit bug 261554](https://bugs.webkit.org/show_bug.cgi?id=261554) — исторический сбой фонового AudioContext с playback audioSession, исправленный; не доказательство такого же дефекта на iOS 27.
- [WebKit bug 229068](https://bugs.webkit.org/show_bug.cgi?id=229068) — старый исправленный mapping Next/Previous. Его обсуждение отдельно отмечает ограниченность mock-проверок для настоящего MediaRemote UI. Не следует выдавать его за действующий баг телефона.
- [Media Session specification: routing](https://wicg.github.io/mediasession/#routing) — metadata/playbackState не гарантируют выбор active session.

Это исследование не содержит логов iPhone пользователя и не подтверждает ни доставку native callback, ни успешность нового native ownership-эксперимента. Подтверждены кодовые конфликты и отсутствие проверки настоящего системного маршрута в прежнем исправлении.
