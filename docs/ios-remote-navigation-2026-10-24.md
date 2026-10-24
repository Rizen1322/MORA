# iPhone: Next/Previous и перемотка с экрана блокировки

24 октября 2026. Пользователь сообщил, что Next нажимается без переключения, а перемотка недоступна. Предыдущее исправление 1.0.2 проверяло регистрацию MediaSession handlers, но не выполнение команд самим AudioContext на iOS.

## Причина и изменение

В текущем исходнике WebKit `AudioContext::didReceiveRemoteControlCommand` обрабатывает только Play/Pause/Stop/Toggle; Next/Previous не передаются в JS. В `AudioContext.h` `supportsSeeking()` возвращает false. Поэтому наличия `setActionHandler('seekto', ...)` и длительности недостаточно для этого аудиопути. Это соответствует симптомам; точная версия WebKit установленного iPhone здесь не исследовалась.

В MoraAudioPlugin добавлены публичные MPRemoteCommandCenter обработчики Next, Previous, changePlaybackPosition и skip ±10 секунд. Они передают action/seekTime через Capacitor в существующие обработчики PlayerController. Регистрация происходит один раз, при освобождении плагина удаляются только его targets.

Мост использует для навигации нативные обработчики и снимает соответствующие WebKit handlers, чтобы одна команда не исполнялась дважды. Доступность команд синхронизируется при регистрации и вместе с ограниченными публикациями позиции; перемотка включается после получения длительности. Удалённый handler перестаёт получать команды. Для старой установленной оболочки без нового метода сохранён прежний WebKit путь; это совместимость, а не исправление старой IPA.

Метаданные, обложки и часы остаются у WebKit: новый MPNowPlayingInfoCenter не добавлен. Play/Pause, настройки AutoMix и качество DSP не менялись.

## Проверки и установка

- 95 тестов в `apps/mobile/test/native-media.test.ts` и `apps/web/test/controller.test.ts` прошли: native navigation routing, однократная передача Next/Previous/seekTime, отключение удалённого handler, включение перемотки после duration, fallback старой оболочки; прежние проверки metadata/clock также прошли.
- `tsc -p apps/mobile` и `npm run mobile:build` прошли.
- Xcode/Swift и физический iPhone здесь недоступны. Эти тесты не доказывают работу системной карточки на устройстве; особенно нужно проверить, что WebKit не переопределяет доступность нативной перемотки после смены состояния.

Нужно пересобрать **нативное приложение**, одной замены www недостаточно. На Mac из обновлённого проекта:

```sh
sh apps/mobile/scripts/ios-mac.sh --ipa
```

После подписи и установки проверить минимум три трека: Next и Previous на экране блокировки и в Control Center; перемотка 10→60 секунд; следующая смена трека и повторная перемотка; повторить после паузы и с Bluetooth. Если Next всё ещё не действует, нужно проверить доставку MPRemoteCommandCenter → Capacitor на конкретной версии iOS, а не считать регистрацию тестового callback доказательством исправления.

## Первичные источники

- [WebKit AudioContext.cpp — didReceiveRemoteControlCommand](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)
- [WebKit AudioContext.h — supportsSeeking](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.h)
- [Apple: Handling external player events notifications](https://developer.apple.com/documentation/mediaplayer/handling-external-player-events-notifications)
- [Apple: changePlaybackPositionCommand](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter/changeplaybackpositioncommand)
