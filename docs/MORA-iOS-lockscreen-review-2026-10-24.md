# MORA: независимый разбор управления музыкой на экране блокировки iPhone

Дата: 24 октября 2026 года. Состояние приложения: MORA iOS **1.0.7, build 8**, диагностическая IPA.

## 1. Задание для ИИ, которому передали документ

Изучи архитектуру и факты ниже. Предложи проверяемое исправление Play/Pause, Next/Previous и перемотки на экране блокировки iOS с сохранением существующего DJ AutoMix. Нужен независимый технический разбор, а не согласие с предыдущей гипотезой.

Отделяй факты кода, наблюдения пользователя, события журналов и предположения. Если нужны дополнительные данные, назови минимальный эксперимент и ожидаемые результаты для каждой гипотезы. Не считай отсутствие callback доказательством недоставки конкретного нажатия, если время самого нажатия не записано. Не объявляй проблему исправленной по unit-тестам или успешной сборке Xcode.

В конце документа есть конкретные вопросы, формат ответа и критерии испытаний. В сопровождающем ZIP находятся оба исходных JSON и выбранные исходники **именно выпущенной диагностической версии**, а не произвольная новая ветка.

## 2. Что видит пользователь

Устройство: **iPhone 15 Pro Max**. Диагностический отчёт: `machine=iPhone16,2`, **iOS 27.0.1 (24A446)**.

Сообщения пользователя по существу:

1. Изначально на экране блокировки Next не переключает трек; перемотка недоступна. Pause тоже не останавливает музыку либо кажется неработающей.
2. В диагностике пользователь выключил «Автовозобновление звука» и сообщил, что после этого **Pause и Play стали нормально работать**.
3. При этом системный индикатор времени визуально ведёт себя так, будто музыка начинается заново. На слух песня продолжается с правильного места.
4. Next и перемотка после отключения автовозобновления всё равно не работают/недоступны.
5. Пользователь не помнит, нажимал ли Play именно в период второй присланной записи. Известный ему результат относится к опыту с выключенным переключателем в целом.

Важно: отдельного видео, точных времён системных нажатий и сопоставленного прогона с включённым автовозобновлением нет. Не смешивать «пользователь слышал музыку» с состояниями в конкретном интервале JSON.

## 3. Версия исходников и сборки

- Репозиторий: https://github.com/Rizen1322/MORA
- Рабочая ветка iOS: **`ios`**. Не создавать вместо неё `codex/ios`.
- Диагностический тег: **`ios-v1.0.7-diagnostic`**.
- Commit: **`2ee80d59d5558c3b3dbaa632b6eca2443b4658bc`**.
- Релиз: https://github.com/Rizen1322/MORA/releases/tag/ios-v1.0.7-diagnostic
- Успешная macOS/Xcode сборка: https://github.com/Rizen1322/MORA/actions/runs/40109057259
- Bundle ID: `ru.mora.player`; deployment target **iOS 17.4**.
- Capacitor Core/iOS **8.5.3**; Swift language version **5.0**; TypeScript, React, Vite.
- CI: `macos-15`, `/Applications/Xcode_26.2.app/Contents/Developer`, Node.js 24.
- Отчёт установленного приложения подтверждает SDK **`iphoneos26.2`**.
- На Windows выполняются разработка/TS-проверки; физическая IPA собирается через macOS CI. IPA unsigned, пользователь подписывает её для установки.

Минимальная версия iOS приложения и установленная версия телефона — разные ограничения. Применение нового API требует проверки его наличия и в SDK сборки, и на целевых версиях iOS. Runtime `#available` сам по себе не добавляет отсутствующий framework в SDK.

**Основное мобильное приложение — `apps/mobile`. Каталог `apps/ios` относится к отдельному старому прототипу; анализ только его приведёт к неправильному исправлению.**

## 4. Как реально воспроизводится звук

```text
React UI / PlayerController (TypeScript в WKWebView)
     │
     ├─ очередь, intent/status, подготовка PCM, планирование переходов
     │
     └─ AudioWorkletNode.port.postMessage(...)
                   │
          AutoMixProcessor → MixerCore (TypeScript)
                   │
              AudioContext → системный аудиовыход
```

Серверная логика мобильного приложения встроена в Web Worker. Хранилище и сетевые операции адаптированы под мобильную среду. Готовятся PCM-данные, которые контроллер порциями передаёт в worklet. Это не простой `AVPlayer(url:)` и не воспроизведение всего трека через обычный `<audio src>`.

`packages/core/src/engine/mixer.ts` содержит реальный микшер. Используются два дека, sample-based тайминг переходов, PCM-буферизация, WSOLA/time stretching, регулировки темпа/уровня/тона и переходные автоматизации. Формат плана перехода и музыкальная логика уже существуют. Локальная ML-модель для решения текущей задачи не нужна.

Нативный Swift-плагин сейчас **не рендерит звук** и не владеет нативной очередью аудиофайлов. Он занимается навигационными командами, прерываниями/аудиомаршрутом, power state, Keychain и диагностикой. В текущем пути нет нативного AVPlayer/AVAudioEngine как основного исполнителя AutoMix.

## 5. Текущая схема системного управления: разделённый маршрут

### Метаданные и Play/Pause

Контроллер регистрирует обработчики через `navigator.mediaSession.setActionHandler` и задаёт `navigator.mediaSession.metadata`.

Мобильный мост переопределяет эти методы. Для Play/Pause настоящие WebKit handlers остаются зарегистрированными. Метаданные, обложка, duration, position, rate и playbackState публикуются через **WebKit MediaSession**. Мост не создаёт отдельный нативный `MPNowPlayingInfoCenter` publisher.

### Next/Previous/Seek

Для `nexttrack`, `previoustrack`, `seekto`, `seekforward`, `seekbackward` мост сохраняет JS handlers в Map, но передаёт в исходный WebKit `setActionHandler` значение **`null`**. Навигация сознательно выделена в нативный путь:

```text
MPRemoteCommandCenter.shared() в Swift
    → addTarget callback
    → DispatchQueue.main.async
    → Capacitor notifyListeners("command", {action, seekTime, id, source})
    → сохранённый JS handler
    → PlayerController
    → AudioWorklet / MixerCore
```

Смысл прежней правки — обойти ограничения WebAudio и избежать двойного выполнения Next. Проблема: это **не доказывает**, что показанная iOS карточка WebKit действительно отправляет команды в нативный command center приложения.

Факты реализации:

- Swift регистрирует Next/Previous/changePlaybackPosition/skip ±10 секунд.
- В этом коде не регистрируются нативные Play/Pause targets для системной карточки. Нативные уведомления о прерывании могут послать `pause`/`play` в JS отдельно.
- `setRemoteNavigation` выставляет `isEnabled` для нативных команд; seek включается при наличии duration и соответствующего handler.
- `.success` возвращается из нативного callback **до доставки в JS и обработки звука**.
- Нет подтверждения реального владельца выбранной системной карточки.
- Текст комментария в коде «native navigation bypasses ...» описывает намерение; пользовательские результаты не подтверждают, что обход работает на телефоне.

## 6. Ключевые фрагменты кода

Фрагменты ниже сокращены; полный код находится в ZIP. Все ссылки привязаны к commit диагностической сборки.

### 6.1. Автоматическое resume при остановке AudioContext

`apps/web/src/audio/controller.ts`, `createEngine`, около строк 300–309:

```ts
const keepRunning = (event: Event) => {
  tracePlayback('context.event', {
    reason: event.type, context: ctx.state,
    status: this.state.status, hidden: document.hidden,
  });
  if (ctx.state !== 'running' && ctx.state !== 'closed' &&
      (this.state.status === 'playing' || this.state.status === 'buffering')) {
    if (playbackDiagnostics()?.allowAutoResume === false) {
      tracePlayback('context.autoResume.suppressed', { context: ctx.state });
      return;
    }
    void ctx.resume().then(/* log outcome */);
  }
};
ctx.onstatechange = keepRunning;
document.addEventListener('visibilitychange', keepRunning);
```

Переключатель диагностической сборки отключает **только эту автоматическую попытку**. Явный `resume()`/Play в контроллере продолжает вызывать `ensureEngine()` и снимать паузу с микшера. Переключатель по умолчанию включён; после перезапуска приложения снова включается.

Возможный конфликт: WebKit выполняет системную Pause остановкой AudioContext; JS `pause()` при этом может не вызваться; controller.status остаётся playing; `keepRunning` немедленно восстанавливает контекст. Код допускает такой сценарий. Наблюдение пользователя согласуется с ним, но присланные JSON не содержат самой этой последовательности переходов.

### 6.2. Пауза микшера и состояние контекста — отдельные вещи

```ts
pause(): void {
  this.traceAction('pause');
  this.previewRevision++;
  this.post({ cmd: 'pause', paused: true });
  this.set({ status: 'paused' });
  this.scheduleSave(true);
}

// В resume(), если текущий трек уже существует:
await this.ensureEngine();
if (intent !== this.previewRevision) return;
this.post({ cmd: 'pause', paused: false });
this.set({ status: 'playing' });
```

AudioContext не обязан немедленно переходить в suspended при паузе микшера: worklet может продолжать рендерить тишину. Через **3 минуты** состояния paused/idle контекст может быть усыплён отдельным idle timer. Поэтому `context=running` не означает, что звучит песня, а восстановление одного контекста не обязательно снимает `MixerCore.paused`.

### 6.3. Разделение WebKit и native handlers

`apps/mobile/src/bridge/native.ts`:

```ts
const navigation = new Set<MediaSessionAction>([
  'nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward',
]);
ms.setActionHandler = (action, handler) => {
  handlers.set(action, handler);
  registerAction(action,
    nativeNavigation && navigation.has(action) ? null : wrapped(action, handler));
  if (navigation.has(action)) syncNavigation();
};
void MoraAudio.addListener('command', ({ action, seekTime, id, source }) => {
  dispatch(action, { action, seekTime } as MediaSessionActionDetails,
    source ?? 'native', id);
});
```

Для старой оболочки без `setRemoteNavigation` предусмотрен fallback на WebKit registration. Текущая IPA имеет новый метод, поэтому fallback не является обычным рабочим режимом.

### 6.4. Публикация времени и playbackState

`onTick` контроллера публикует `duration`, `position`, `playbackRate` через MediaSession. В мобильном мосте публикации ограничены примерно разом в 2 секунды, с немедленной коррекцией при заметном seek/rate/duration change. Для позиции вычисляется прошедшее время от последней принятой точки, пока локальная переменная `playing=true`.

При смене статуса контроллера мост задаёт:

```ts
const now = s.status === 'playing';
if (now === playing) return;
playing = now;
ms.playbackState = playing ? 'playing' : 'paused';
if (typeof s.position === 'number') position = s.position;
sentAt = performance.now();
publishPosition();
void MoraAudio.setPlaybackState({ playing, webAudioSession });
```

Следовательно, позиция/системное состояние зависят от controller.status, а реальное звучание ещё зависит от AudioContext и MixerCore. Прямая системная остановка/запуск контекста потенциально обходят это согласование. Это направление проверки визуального сброса, **не установленная причина сброса в ноль**.

Поздняя загрузка обложки повторно публикует MediaMetadata и позицию; в мосте есть защита от применения обложки предыдущего трека. Нужна проверка, не вызывает ли републикация на данном WebKit пересоздание/сброс системной временной шкалы.

### 6.5. AVAudioSession и конфигурация WebView

- `UIBackgroundModes` содержит `audio`.
- В page bridge запрашивается `navigator.audioSession.type = 'playback'`, когда API имеется.
- `setPlaybackState` вызывает нативную активацию только при переходе в playing и **если Web Audio Session не управляется WebKit**. Это сделано, чтобы не прерывать уже запущенный звук повторным `setActive` из другого процесса.
- Нативная активация использует `.playback`, `.default`, policy `.default`, `setActive(true)` в отдельной очереди.
- Разрешены inline media и отсутствие обязательного пользовательского жеста для каждого media playback.
- Есть существующий guarded вызов непубличного WebKit preference `requiresPageVisibilityToPlayAudio=false`. Он не добавлен диагностической сборкой. Рассматривать отдельно ограничения личного sideload и App Store; не считать этот preference гарантией фоновой доставки команд.

## 7. Что уже пробовали и что реально проверено

1. Зарегистрировали JS MediaSession handlers. Это само по себе не исправило системную навигацию.
2. Вынесли Next/Previous/Seek в Swift `MPRemoteCommandCenter`, сохранив WebKit publisher метаданных. Пользователь после пересборок по-прежнему сообщил о проблеме.
3. Добавили ограниченные публикации времени, защиту от устаревшей обложки, обработку настоящих аудиопрерываний и потери аудиомаршрута. Доказательства исправления Next/Seek на телефоне нет.
4. Выпустили 1.0.7 (8) с персистентным журналом, экспортом JSON, тестовыми bridge-командами и переключателем automatic resume.
5. Пользователь сообщил об улучшении Pause/Play с выключенным automatic resume. Next/Seek и визуальный сброс времени остались.

Перед выпуском диагностики прошли **117 тестов в 8 файлах**, TypeScript-проверки всех workspace, production mobile web build и Xcode-сборка unsigned arm64 IPA. Эти результаты подтверждают соответствующие локальные пути и компиляцию; они не проверяют настоящий Now Playing election и нажатия на физическом iPhone.

Есть отдельные изменения общего плеера, исправлявшие рассинхронизацию UI от устаревших tick и обрезанный progressive PCM на ПК. Они уже входят в базовую версию; это не доказанный источник рассматриваемой проблемы iOS. Не откатывать их ради lock-screen эксперимента без причины.

## 8. Два реальных журнала: факты и ограничения

Общие поля обоих JSON:

```json
{
  "version": "1.0.7", "build": "8", "schema": 1,
  "machine": "iPhone16,2",
  "os": "Version 27.0.1 (Build 24A446)",
  "sdk": "iphoneos26.2", "appState": 0,
  "category": "AVAudioSessionCategorySoloAmbient",
  "mode": "AVAudioSessionModeDefault",
  "sampleRate": 48000, "outputs": ["Speaker"],
  "nativeSessionActive": "unknown",
  "remoteEnabled": {"next": true, "previous": true, "seek": true}
}
```

`category` — снимок `AVAudioSession.sharedInstance()` **процесса приложения во время экспорта**. Нельзя из него без дополнительных данных заключать, что аудиосессия процесса WebKit/GPU имеет ту же категорию, что background playback вообще не разрешён или что виновата именно SoloAmbient. `nativeSessionActive=unknown` — честное отсутствие измерения активности; это не false. `remoteEnabled=true` подтверждает флаги локального command center, а не выбранный системой endpoint.

| Показатель | `MORA-playback-diagnostics.json` | `MORA-playback-diagnostics (2).json` |
|---|---:|---:|
| События | 3 | 41 |
| Интервал между первым и последним событием | 0,822 с | 124,001 с |
| Автовозобновление | false | false |
| `native.remote.callback` | 0 | 0 |
| `js.command.received` | 0 | 0 |
| `controller.action` | 0 | 0 |
| `engine.tick` | 0 | 25 |
| ticks при `hidden=true` | 0 | 15 |
| position в ticks | нет | всегда 75,5226666667 с |
| AudioContext в ticks | нет | всегда running |
| MixerCore.paused в ticks | нет | всегда true |
| controller.status в ticks | нет | всегда paused |

Первый файл начинается с `js.test.begin`, затем идёт snapshot paused и export через 0,822 с. В нём нет прогона управления.

Второй продолжает ту же запись; это **не независимый A/B тест**, потому что начало и исходные события совпадают с первым файлом. Он фиксирует уход в фон и возврат, но микшер весь период на одной позиции paused. Пример события:

```json
{
  "stage": "engine.tick",
  "context": "running", "hidden": true,
  "paused": true, "status": "paused",
  "position": 75.52266666666667,
  "clock": 2808192,
  "id": "js-mvmllj8m-5"
}
```

`clock` здесь — счётчик аудиофреймов микшера, `position` — секунды, `monotonicMs` — JS-миллисекунды, `uptime` — нативные секунды, `time` — Unix wall-clock секунды. Их нельзя сравнивать как одну шкалу без преобразования.

Что можно заключить: в показанном фоновом интервале main JS и worklet продолжали обмениваться событиями; объяснение «WebView целиком замёрз на всё это время» не согласуется с этими ticks. Нельзя распространять этот вывод на паузу дольше 3 минут или другие прогоны.

Чего заключить нельзя: что каждый реальный tap точно потерян до bridge; что системная Pause обязательно меняет только контекст; что в период этих JSON звучала песня; что визуальная позиция действительно стала 0. Для этого нет привязанных событий нажатия и нужных переходов состояния.

Хэши исходных файлов:

```text
7efaf09e71b6497f7e1b72eca2a8d306f5b72349f8b6510a6c4ea0c28e1e0aeb  MORA-playback-diagnostics.json
64d6b9d24ca64071e3006deef7f2e12df49b7625cf18e6af160366bd27758baf  MORA-playback-diagnostics (2).json
```

## 9. Как устроена диагностика и где она недостаточна

- Feature flag: `MoraPlaybackDiagnostics=true` в Info.plist.
- JS и mobile bridge собираются разными bundler-путями. Общий diagnostic object хранится в `window.moraDiagnostics`, чтобы ID были доступны обоим bundles.
- Последовательность наблюдений: `native.remote.callback` → `native.send` → `js.command.received` → `controller.action` → `controller.post` → `engine.ack` → `engine.render`.
- `source=remote`, `webkit`, `test` и notification-путь различаются. Тестовая кнопка **не является настоящим системным tap**.
- `engine.ack` — обработка сообщения в worklet. `engine.render` — снимок output block, не гарантия завершения seek/перехода. Для Pause ждётся полный paused-блок либо таймаут в 0,5 с аудиофреймов.
- `engine.tick` диагностически записывается раз в 5 секунд.
- Native ring: до 1200 событий, персистентная запись не чаще двух раз в секунду плюс flush при background. JS ограничивает число незавершённых bridge-записей до 64 и при перегрузке отбрасывает новые наблюдения.
- Разрешены только указанные числовые, булевы и короткие code-поля. Не записываются токены, track/provider IDs, URL, названия треков, raw errors и имена Bluetooth-устройств.
- `controller.post` использует последний entered playback intent. При асинхронной подготовке совпадение ID не доказывает идеальную причинную связь всех последующих команд. Есть отдельный `seq` для сопоставления post/ack/render.
- **«Начать запись» сейчас вызывает clear(): стирает историю**, затем пишет `js.test.begin`. Если нажать его после воспроизведения проблемы, важные события потеряются. Это недостаток диагностического UX; полезнее marker без стирания и отдельная явно названная очистка.
- Нет отдельного подробного журнала фактических публикаций position/duration/rate/metadata identity в систему. Поэтому визуальный reset трудно отделить от перепубликации карточки, смены состояния, неверной экстраполяции или особенностей WebKit.

## 10. Что показало чтение WebKit, а что ещё нужно проверить

В просмотренных исходниках WebKit `AudioContext::didReceiveRemoteControlCommand` обрабатывает Play/Pause/Stop/Toggle изменением контекста; `AudioContext::supportsSeeking()` возвращает false. В просмотренном platform-client интерфейсе DOM MediaSession `canReceiveRemoteControlCommands()` и `supportsSeeking()` также false. Это серьёзное основание не ожидать, что одна регистрация JS handlers исправит все команды AudioContext.

Но исходники WebKit main/отдельного commit **не удостоверяют точный бинарный WebKit iOS 27.0.1 (24A446)**. Нужны проверяемые выводы о поставляемой версии и реальном маршруте команд. Отличать DOM MediaSession, внутреннюю PlatformMediaSession, WebKit/GPU Now Playing и нативный MediaPlayer API приложения.

Ранее рассматривался framework Apple `NowPlaying`, включая возможный primary-session API на новых системах. Это **не реализовано в MORA**. Не считать доступность, сигнатуры, minimum OS и наличие в Xcode 26.2 установленным фактом из этого документа. Если предлагается этот путь, проверить актуальные официальные docs и реальные SDK declarations. Не смешивать API разных поколений без объяснения, кто становится единственным владельцем управления.

Источники для независимой проверки:

- AudioContext.cpp: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp
- AudioContext.h: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.h
- MediaSession.cpp: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.cpp
- MediaSession.h: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.h
- GPUConnectionToWebProcess.cpp: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/GPUProcess/GPUConnectionToWebProcess.cpp
- WebKit Now Playing WebAudio test: https://github.com/WebKit/WebKit/blob/main/LayoutTests/media/now-playing-webaudio.html
- Apple remote events: https://developer.apple.com/documentation/mediaplayer/handling-external-player-events-notifications
- Apple changePlaybackPositionCommand: https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter/changeplaybackpositioncommand
- Apple Now Playing: https://developer.apple.com/documentation/nowplaying
- Media Session routing: https://wicg.github.io/mediasession/#routing

Просьба в своём ответе зафиксировать проверенный commit/дату источника. Наличие старого исправленного WebKit bug не доказывает, что телефон столкнулся с тем же багом.

## 11. Гипотезы для проверки, без заранее назначенного победителя

**H1. Automatic resume отменяет системную Pause.** Поддерживается кодом и наблюдением пользователя. Требуется trace `running → suspended/interrupted → autoResume.request → running` без явного Play. Исправление должно различать пользовательский intent, системную паузу и допускаемое восстановление после прерывания. Нельзя просто превращать любой не-running state в playing.

**H2. Publisher карточки и native navigation endpoint не совпадают.** Поддерживается разделённой архитектурой и тем, что enabled-флаги не привели к работающей навигации по сообщению пользователя. Текущие логи не содержат контролируемого tap. Требуется проверить ownership и доставку, а не ещё раз выставить `isEnabled=true`.

**H3. Системные часы расходятся с intent/микшером.** Возможны прямые Pause/Play AudioContext без обновления controller.status, неверная экстраполяция и републикация метаданных. Нужны фактические publication snapshots и видеозапись/отметки системной шкалы. В JSON нет подтверждённого reset в 0.

**H4. Фоновая подготовка следующего трека/моста блокируется.** Возможный отдельный риск для Next: подготовка PCM, `api.mixNow` и загрузка буферов асинхронны. В наблюдённом paused-интервале JS не был полностью остановлен. Сначала проверить два заранее подготовленных локальных трека; затем cold-cache/network case.

**H5. На результат влияет конфигурация/ownership аудиосессий процессов.** Нативный snapshot SoloAmbient требует интерпретации, но не является основанием для слепого многократного `setActive(true)` во время WebKit playback. Нужен план измерений и безопасный порядок активации.

## 12. Какие направления решения стоит сравнить

| Вариант | Что можно сохранить | Главный вопрос/риск |
|---|---|---|
| Исправить intent/recovery и текущие публикации | Почти весь код | Лечит ли только Pause/часы? Чем обоснована работа Next/Seek при ограничениях AudioContext? |
| Единый native control plane при текущем WebAudio DSP | UI, TS-планировщик и worklet | Как доказать ownership, не допустить конкурирующих карточек и доставить команды при остановленном WebContent? |
| Реальный seekable HTMLAudioElement/MediaSession путь | UI и часть подготовки/анализа | Как сохранить фактический AutoMix/DSP и фон? Настоящий media source, не фиктивный silent keeper. |
| Native audio host + native queue/transport | UI, библиотеку, TS-анализ/планы | Как исполнять/перенести DSP, передавать PCM и планы, обеспечить точность/latency и не упростить AutoMix незаметно? |
| Новый Now Playing API на поддерживаемой OS | Зависит от варианта host | Наличие SDK, minimum OS, fallback для 17.4+, primary ownership и совместимость с WebKit. Это не самостоятельный ответ о том, кто исполняет звук. |

Это кандидаты, а не утверждение, что каждый из них работоспособен. Допустимо предложить другой вариант, если описан действительный аудиопуть и есть проверяемое основание.

## 13. Ограничения и желаемый результат

- Сохранить существующие DJ-переходы и качество звука. Замена на обычный AVPlayer crossfade может быть отдельным компромиссом, но должна быть явно названа и оценена, а не выдана за эквивалентный перенос.
- Локальные ML-модели не использовать.
- Не ломать общий Windows-плеер и существующие защиты от устаревших audio ticks/intent races.
- Не требовать постоянного удержания открытого экрана или приложения на переднем плане как окончательного решения.
- Не удалять библиотеку/приложение ради обновления; сохранять bundle ID и аккаунт подписи при sideload.
- Не считать silent-loop/dummy media player надёжным окончательным решением без обсуждения ownership, App Store, энергии и фонового поведения.
- Для публичного решения предпочитать public API. У существующего private preference должен быть явный статус и план совместимости.
- Источником позиции/статуса должен быть согласованный реальный transport, включая состояние во время перехода двух деков.
- После системной Pause автоматический recovery не должен сам включать музыку. Play должен действительно возобновлять звук, а не только менять иконку.
- Next/Previous не должны исполняться дважды. Определить политику Next в середине перехода и seek во время перехода.

## 14. Вопросы, на которые нужен конкретный ответ

1. Какой текущий маршрут команд наиболее вероятен и какие факты отличают его от альтернатив? Что именно нынешние JSON не доказывают?
2. Может ли установленный AudioContext/WebKit гарантированно доставлять Next/Seek в JS? Покажи источник/публичный контракт, а не только `setActionHandler`.
3. Если предлагается native control plane: как один publisher становится владельцем карточки и сохраняет ownership после Play/Pause/смены трека/возврата из фона? Как это измерить?
4. Как исполняется Pause/Next/Seek, когда WebView приостановлен после долгой паузы? Есть ли native transport, который может выполнить действие независимо от JS?
5. Как согласовать controller intent, MixerCore.paused, AudioContext state, фактический звук и системные часы? Как различать interruption и явную системную Pause?
6. Какой именно участок может сбрасывать системную временную шкалу при сохранении позиции песни? Какие дополнительные поля дадут проверяемый ответ?
7. Как интерпретировать нативный `SoloAmbient` snapshot при playback в WebKit/GPU? Какой безопасный порядок настройки/активации предлагается?
8. Если нужно менять audio host: что остаётся в TypeScript, что переносится в Swift/C++/другой runtime? Как сохраняются WSOLA/tempo/EQ/переходы и frame accuracy?
9. Что требуется для iOS 17.4+ и что можно использовать только на новых OS? Какой Xcode/SDK действительно необходим?
10. Какой минимальный патч/эксперимент первым различит гипотезы? Какие конкретные файлы/функции менять и как откатить только эксперимент?
11. Какие риски по батарее, CPU, памяти, сети/PCM starvation и системным аудиопрерываниям добавляет вариант?
12. Какие результаты физического теста позволят честно назвать его исправлением, а не очередной регистрацией обработчиков?

## 15. Формат полезного ответа от другого ИИ

Пожалуйста, ответь по структуре:

1. **Диагноз:** отдельно подтверждённые факты, вероятные причины и неизвестное; уверенность по каждой причине.
2. **Рекомендуемый вариант:** почему он подходит именно этой архитектуре и какие симптомы он закрывает.
3. **Альтернативы:** 2–3 варианта с объёмом изменений, потерями функций и рисками; не оценивать точное время без основания.
4. **Конкретная реализация:** файлы/функции, порядок настройки сессии, publisher/command owner, схема транспорта/ACK и согласование времени. Псевдокод допустим, выдуманные API — нет.
5. **Самый маленький проверяемый первый шаг:** ожидаемые события/звук/поведение для успеха и для провала; что этот шаг ещё не исправляет.
6. **Тесты и откат:** локальные regression tests плюс обязательный физический прогон.
7. **Первичные источники:** точные ссылки, версии API/SDK/commit; явно отметить, если не удалось проверить.

Не ограничивайся фразами «используйте MediaSession», «включите background audio», «добавьте handlers» или «перепишите на native». Всё это нуждается в привязке к текущему коду и маршруту звука.

## 16. Минимальная программа испытаний выбранного решения

1. Два уже подготовленных локальных трека: controls в Control Center при открытом приложении, затем controls на экране блокировки.
2. Во время реального звучания: Pause → 5 секунд тишины → Play. Проверить продолжение с правильной позиции и движение системной шкалы без видимого обнуления.
3. Next/Previous: однократное выполнение, правильная очередь/метаданные, проверка при playing и paused. Учесть текущую политику Previous: после 3 секунд он может перематывать текущий трек в начало.
4. Seek 10 → 60 секунд: совпадение фактической слышимой позиции, controller snapshot, engine/native position и системной шкалы.
5. Повтор после паузы **более 3 минут**, когда существующий idle timer мог усыпить AudioContext.
6. Next и seek во время AutoMix-перехода: заранее определить ожидаемое поведение и отсутствие двойного skip/скачка состояния.
7. Cold-cache Next/потеря сети: отделить отсутствие системной команды от доставки команды с последующей подготовкой/ошибкой PCM.
8. Headphones/Bluetooth disconnect, настоящее interruption и допустимое восстановление, возврат foreground/background.
9. Для каждого системного tap — отметка времени или видео. Одновременно журнал command receipt → handler → transport ACK → изменение слышимого звука. Сам по себе `.success`/enabled-флаг недостаточен.

## 17. Карта исходников и содержимое приложения к документу

Полная неизменяемая версия: https://github.com/Rizen1322/MORA/tree/2ee80d59d5558c3b3dbaa632b6eca2443b4658bc

В ZIP папка `source/` содержит выбранные исходники из этого commit:

- `apps/mobile/src/bridge/native.ts` — registration split, WebKit metadata, часы, native listener.
- `apps/mobile/src/bridge/diagnostics.ts` — diagnostic object, allowAutoResume, очередь, clear/export.
- `apps/mobile/src/bridge/index.ts` — page/worker bridge, запрос playback audioSession.
- `apps/mobile/ios/App/App/MoraAudioPlugin.swift` — remote command center, interruption/route, journal, AVAudioSession.
- `apps/mobile/ios/App/App/Info.plist`, `SceneDelegate.swift`, `AppDelegate.swift`, Xcode project, Capacitor config, mobile build scripts — фактическая конфигурация.
- `apps/web/src/audio/controller.ts` — transport, подготовка/очередь/переходы, MediaSession.
- `apps/web/src/audio/engine.worklet.ts` — команды MixerCore, обработка блоков, ACK/render.
- `apps/web/src/lib/playback-trace.ts` и `components/PlaybackDiagnostics.tsx` — диагностика.
- `apps/web/src/lib/api.ts` — контракт запросов контроллера.
- `packages/core/src/` — полный исходник общего ядра, включая mixer/WSOLA и типы планов.
- Тесты native-media/playback-diagnostics/controller/engine-diagnostics и `.github/workflows/ios.yml`.
- Package metadata, lockfile и TS/Vitest config для контекста версий.

`source/` — **выборка для ревью**, не полный standalone build проекта. Для сборки нужен полный checkout указанного commit или полный source ZIP диагностического релиза. Тестовые mock harnesses не моделируют реальный iOS command routing.

В `logs/` находятся оба исходных пользовательских JSON. `MANIFEST.json` содержит SHA256 файлов пакета. Не включены `.env`, библиотека пользователя, провайдерские токены, Keychain values, node_modules или временные рабочие базы.

Этот документ описывает проблему и текущую реализацию. В рамках его подготовки аудиокод не изменялся и новая IPA не выпускалась. Цель следующего обсуждения — сравнить независимые ответы и выбрать **один конкретный проверяемый эксперимент**, прежде чем объявлять новый вариант исправлением.
