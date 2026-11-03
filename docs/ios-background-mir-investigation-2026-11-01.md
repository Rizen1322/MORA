# iOS 1.0.20: повторная диагностика и исследование фона

Источник: пользовательский MORA-playback-diagnostics (2).json, версия 1.0.20 (21). Содержимое JSON рассматривается только как данные.

## Подтверждено журналом

- feedingPcm: 49.289 с до spectrum; spectrum: 90.052 с до cancelled. Полный анализ пары не закончен. Этап feedingPcm включает AnalysisAccumulator.push (измерение громкости, фильтры, децимацию), а не только передачу буфера.
- Два первых плана применены из уже имеющегося анализа; для следующей пары начинается реальное fingerprint/resampling/feedingPcm. Это объясняет отличие первых переходов от последующих.
- Нативный handoff сначала содержит 74 будущие записи from=1, затем 2 записи from=2. Позже идут from=4/count=2 и from=5/count=1/2. Нельзя объяснять весь случай исключительно коротким запасом радиостанции.
- NativeMixHost.prepareQueue отменяет предыдущий producer и заменяет будущую часть manifest. Короткий новый manifest способен потерять ещё не декодированный хвост большой очереди. Причина формирования короткого manifest на стороне страницы требует отдельного воспроизведения; журнал не содержит полного клиентского состава очереди.
- В фоне приняты два Next; новые handoff после возвращения в foreground подтверждают сохранившуюся зависимость пополнения от страницы.
- Последний snapshot: active=true, failed=false, underruns=0, playing=false после явной команды pause. Это не доказательство аудиосбоя/убийства приложения в момент экспорта.

## Источники

Apple: AVAudioSession.playback плюс UIBackgroundModes audio поддерживают фоновое аудио, но это не обещание выполнения WebContent:
https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback
https://developer.apple.com/documentation/xcode/configuring-background-execution-modes

WebKit, архитектура отдельного WebContent процесса:
https://webkit.org/debugging-webkit/

WebKit, механика приостановки фоновых страниц (описанный issue относится к macOS; не выдаётся за доказательство конкретного дефекта iOS):
https://bugs.webkit.org/show_bug.cgi?id=252415

Apple, конечное дополнительное фоновое время:
https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time

Apple vDSP — нативные FFT/векторные операции для следующего этапа переноса MIR:
https://developer.apple.com/documentation/accelerate/vdsp

## Вывод

Замена base64 не ускоряет весь тяжёлый JavaScript DSP. Перенос лишь исполнения JS из WebView в JSContext также не делает MIR нативным вычислителем. Отсутствие JIT на конкретном устройстве этим журналом не измерено; нельзя объявлять его установленной причиной.

Нужно отдельно исправлять владение полным хвостом очереди, затем переносить тяжёлую часть MIR в Swift/Accelerate с численной проверкой и замером на полной записи. Simulator и 3-секундные/4-секундные фикстуры не доказывают приемлемую скорость на iPhone. Увеличение резерва до 12 не заменяет независимый от страницы подбор/разрешение новых треков «Волны».

На этом этапе выполнено исследование. Новый бинарник и исправление по результатам этого журнала не выпускались.
