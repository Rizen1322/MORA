# MORA iOS 1.0.16 — аудит Astra high по рекомендациям Apple

Дата: 25 октября 2026. Проверен коммит `12b005f9610079d3bf3f8565fedd646baa8a6802`,
ветка `ios`, тег `ios-v1.0.16-diagnostic`, версия 1.0.16, сборка 17.

Проверку выполнил отдельный агент **gpt-6-astra, reasoning high**. Код приложения
не изменялся. Ниже отделены подтверждённые дефекты кода от предположений о причине
остановки на конкретном iPhone.

## 1. P1 — нет восстановления после изменения конфигурации AVAudioEngine

Код: [MoraAudioPlugin.swift:81](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/MoraAudioPlugin.swift:81),
[NativeMixHost.swift:596](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:596).

Наблюдаются interruption, route change и media reset, но не
`AVAudioEngineConfigurationChange`. При изменении аппаратной частоты или числа
каналов Apple останавливает и деинициализирует engine. Текущий обработчик route
реагирует только на отключение старого устройства через Pause. Новый маршрут с
другим форматом может оставить `wantsPlaying=true` при остановленном движке.
Это не означает, что любое подключение Bluetooth обязательно вызывает дефект.

Источник: [Apple — AVAudioEngineConfigurationChange](https://developer.apple.com/documentation/foundation/nsnotification/name-swift.struct/avaudioengineconfigurationchange).

**Исправление:** наблюдать конкретный engine, отправлять восстановление на `work`,
сохранять слышимую позицию и намерение Play/Pause, инвалидировать старые callbacks
через epoch, восстанавливать connections и расписание буферов.

**Проверка:** во время воспроизведения сменить route с изменением sample rate;
проверить продолжение звука/позиции, отсутствие скачка через непроигранные буферы
и корректную паузу при отключении наушников.

## 2. P2 — Previous может выбрать уже удалённый PCM и остановить весь плеер

Код: [команда Previous:519](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:519),
[очистка файлов:146](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:146).

На индексе 3 очистка уже удаляет PCM индексов 0 и 1. Быстрые Previous позволяют
перейти 3 → 2 → 1. Последнего файла нет. `select()` останавливает текущий звук
до открытия выбранного файла; ошибка `FileSource` приводит к `fail()`.
Кнопка Previous постоянно включена и не учитывает доступность истории.

**Исправление:** проверять доступность перед остановкой звука; нативно
восстанавливать удалённый источник либо согласовать границу истории и доступность
команды. Отсутствующий файл истории не должен разрушать рабочий сеанс.

**Проверка:** дойти до четвёртого трека и быстро нажать Previous дважды.
Плеер не должен переходить в `failed` и уничтожать воспроизведение.

## 3. P2 — после перезапуска WebContent контроллер не подключается к живому плееру

Код: [controller.ts:2276](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/web/src/audio/controller.ts:2276),
[native.ts:350](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/src/bridge/native.ts:350).

Bridge восстанавливает владение аудио через `mixActive/probeActive`, но не передаёт
слышимые index/position/metadata новому PlayerController. Его `nativeAt` остаётся
равным -1. Polling запускается только после нового `nativeStartAt()`, а `restore()`
показывает сохранённую в БД очередь со статусом idle, которая может отставать.
Pause в этом состоянии не отправляет native command, а Play повторно запускает
сохранённую позицию. Исправленный session rebind не закрывает восстановление UI.

Это доказуемый сценарий рассинхронизации после reload, но наличие reload в конкретных
пользовательских скриншотах без журнала не установлено.

**Исправление:** после загрузки библиотеки и `controls.ready` принять активный
native snapshot как источник истины, сопоставить entryId и запустить polling без
повторного upload/start.

**Проверка:** создать новый controller при native index 4/position 37 и сохранённом
index 1. После restore нужны index 4/37, работающая Pause и отсутствие нового start.

## 4. P2 — Media Services Reset оставляет осиротевшие аудиообъекты

Код: [mediaReset:600](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:600),
[fail:471](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:471),
[создание graph:169](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:169).

`mediaReset()` вызывает `fail()`, сохраняя engine/player/format/ownsSession.
Remote Play отклоняется из-за failed. Новое `start()` из UI снова использует старый
graph: создание объектов и настройка session находятся внутри `engine == nil`.
Apple требует освобождать осиротевшие аудиообъекты и создавать новые после reset;
возобновление должно следовать действию пользователя.

Источник: [Apple QA1749](https://developer.apple.com/library/archive/qa/qa1749/).

**Исправление:** отдельный reset-путь, инвалидирующий graph и состояние session,
но сохраняющий восстанавливаемые очередь и позицию. Следующий пользовательский
Play должен создать новые engine/player и настроить session.

**Проверка:** настоящий Reset Media Services → Play. Проверить новые экземпляры,
повторную настройку session и реальный звук. Одна искусственная Notification
проверяет ветвление, но не заменяет системный reset.

## 5. P2 — необязательная обложка блокирует готовое аудио и producer

Код: [NativeQueuePreparation.swift:155](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeQueuePreparation.swift:155),
[NativeMediaHTTP.swift:41](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMediaHTTP.swift:41).

После download/decode/planning producer ждёт `http.data(coverUrl)` и только потом
вызывает `accept(at, track)`. У картинки общие таймауты: 30 секунд бездействия и
180 секунд на ресурс. Медленная картинка удерживает готовый PCM и задерживает
подготовку следующего трека. При Next или EOF это создаёт ненужное ожидание звука.

Это подтверждённая зависимость критического пути от обложки. Она может объяснять
часть наблюдаемых остановок, но ещё не доказана как причина конкретного случая.

**Исправление:** принимать готовое аудио до загрузки обложки, затем отдельно
обновлять artwork с проверкой актуальной сессии и идентичности трека.

**Проверка:** аудио отдаётся сразу, cover endpoint задержан на 60 секунд.
Следующий трек должен стать ready и играть до получения картинки.

## 6. P3 — Now Playing сообщает 1× при другой скорости DSP

Код: [NativeMixHost.swift:452](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:452),
[live settings:355](F:/вин/ПРОЕКТЫ/music/tools/.cache/ios-release-1.0.5/apps/mobile/ios/App/App/NativeMixHost.swift:355).

DSP поддерживает изменение speed, но `MPNowPlayingInfoPropertyPlaybackRate`
публикуется как 1.0 при Play. Поэтому системная экстраполяция elapsed time между
публикациями неверна; частые ticks лишь уменьшают видимый дрейф.

Источники: [Apple — playback rate](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertyplaybackrate),
[WWDC — elapsed time](https://developer.apple.com/videos/play/wwdc2022/110338/).

**Исправление:** публиковать фактическую скорость соответствующей временной шкалы,
обновлять её при settings change и ставить 0 на паузе.

**Проверка:** 0.8×, 1.2× и Pause должны давать правильный rate и согласованный прогресс.

## Что уже сделано корректно

- Playback audio session и `UIBackgroundModes: audio` присутствуют.
- `dataPlayedBack` передаёт работу на serial queue; `stop()` не вызывается прямо
  внутри completion callback. Это соответствует [предупреждению Apple](https://developer.apple.com/documentation/avfaudio/avaudioplayernode).
- Interruption сохраняет намерение Play и проверяет shouldResume; отключение
  наушников вызывает Pause.
- Файлы используют [completeUntilFirstUserAuthentication](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication)
  для доступа после повторной блокировки устройства.
- MIR/planning выполняются последовательно в отдельной JavaScriptCore VM;
  [Apple допускает работу с VM из разных потоков](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine).
- Ephemeral/dataTask сам по себе не является ошибкой: приложениям с подходящим
  background mode Apple разрешает [обычные URL sessions/data tasks](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).
- Исправления duration через NSNumber, фактического blend, начального hasMore,
  повторов и terminal command capabilities действительно присутствуют в релизе.

## Что установлено о трёх треках

Универсальный лимит в три трека в этой версии **не подтверждён**. Gate `index + 2`
ограничивает запас, а не размер всей очереди; publish продвигает его по слышимому
индексу. Есть намеренный предохранитель: producer прекращает работу после трёх
последовательных ошибок. Это диагностическая развилка, а не доказанная причина.

При EOF с незавершённой подготовкой host сохраняет continueWhenPrepared, но
останавливает engine. Если затем iOS приостановит процесс, in-process подготовка
не имеет гарантированного времени до нового wake. Это риск живучести, особенно
при ожидании обложки, а не подтверждённая на устройстве первопричина.

## Проверки и границы

Агент запустил **35 тестов в пяти файлах — все прошли**: native controller,
native mix client, native sources, native media, native mixer. Локальная среда —
Windows без Swift/iOS runtime; новые проверки UIKit на устройстве не запускались.

Изученный Simulator harness действительно проверяет background state и восемь
локальных WAV. Он не покрывает физическую блокировку, реальные provider HTTP,
задержанные обложки, смену route или системный Media Services Reset.

Следующие направленные проверки: восемь реальных provider-треков с locked screen;
медленный cover/download до исчерпания готового PCM; изменение аппаратного формата
route; системный reset; reload WebContent при активном native playback.
Сопоставлять index/entryId, gateUpper/gateWaiting, remaining/running/hasMore,
stage/error и pendingNext с моментом исчезновения звука.

Приоритет для исходных пользовательских симптомов: убрать обложку из критического
пути и восстановить подключение UI после reload; затем закрыть lifecycle и
безопасность навигации по очищенной истории. Эти рекомендации не являются
утверждением, что точная причина остановки конкретного iPhone уже доказана.
