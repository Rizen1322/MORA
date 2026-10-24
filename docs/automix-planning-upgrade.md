# Планировщик v7 (`am-planner-v7-entry-grid-1`) — 20 октября 2026, Агент 2

Изменён `packages/core/src/plan/planner.ts`; `PLANNER_VERSION` поднят один раз
(включает правки `vocals.ts` Агента 1). `ANALYZER_VERSION` = `am-analyzer-10` не менялся,
DSP/engine и формат плана (`TransitionPlan`, который потребляет `planToArmed`) не менялись:
новые поля только в `debug` (`gridTrust`, `bassSwap.maxPredictedRiseDb`). Новых DSP-примитивов
нет: всё выражено существующими lanes gain/EQ/echo/tempo/vocal, порт на Swift новых узлов не требует.

## Runtime: почему у треков «не было анализа»

Проверено read-only (SQLite, `/api/health`, PID и время старта процесса, mtime файлов):

- Пользовательский сервер 4730 (PID 3712, старт 13:22) работал на коде **до** bump в 13:56:
  `/api/health` отдавал `am-analyzer-9` и `am-planner-v5-drums-1`, у него было 234/235 готовых
  analyzer-9. Пользователь слышал planner v5, без единой техники v6.
- Строки analyzer-10 «6 done / 214 pending / 2 running» оставил короткоживущий экземпляр из
  `.claude/launch.json` на той же data-dev (14:04:05–14:04:16), остановленный посреди работы.
  Это не очередь пользовательского сервера: при следующем запуске `start()` возвращает running→pending.
  Вывод «у runtime 6 анализов» был ошибкой метода: смотрели версию, которую сервер не использовал.
- Дефекта в очереди, версиях или повторах не найдено. После перезапуска сервера (18:25, не мной)
  все 240 треков получили analyzer-10 (`done` 240, очередь 0), stems 240 ready.
- Сейчас 4730 = `am-analyzer-10` + `am-planner-v6-vocal-1`. **v7 станет слышен только после ещё
  одного перезапуска.** Повторный анализ не нужен: меняется только planner, кэш планов ключуется версией.
- Побочный факт: перезапуск запускает фоновую очередь Whisper (`lyricsQueued` 81, GPU).
  На ПК без GPU/Python (`STEMS_PYTHON` пуст) stems и lyrics не строятся, см. «Без stems».

## Что изменено и почему

1. **Вход в B без потери спетого (beatmatch).** В матрице 552 пар 96 планов входили в B на ≥20 с
   и пропускали медиану **19,5 с измеренного пения B** (vocalActivity), в среднем в 3,2 с от любой
   структурной границы. В сведениях по битам стоимость пропуска теперь включает
   `0,03 × (секунды пения − 5)`; первые 5 с бесплатны (подхват, ad-lib). Инструментальное вступление
   по-прежнему дёшево: вход на 20–30 с остаётся, если там нет спетого материала.
   Для unlocked fade/washout это **отключено**. Их поиск входа меряет уровень только в точке
   передачи, и более ранний вход дал в рендерах провалы −3,3…−4,5 LU (Stray → В Прошлых Жизнях,
   Anora → RIDER). Структурный `skipCost` пробовался и убран: он сдвигал вход в тихое начало
   (−1,5…−2,3 LU на парах в STORM II).
2. **Цена маскирования голоса при выборе длины lock.** Штраф `0,02×clash` теперь до 0,4 (было 0,2).
   Иначе 16 тактов прятали до 10 с пения B (max lostB 4,81 → 10,16 в промежуточной версии).
3. **Доверие к сетке по повторам (`structure.gridCheck.periodHint`).** Если лаги повторов — целые доли
   темпа в отношении 2:3 или 3:4, глобальная сетка не используется: нет глобального lock, phrase cut,
   phrase bass swap, bridge и привязки intro-drop к её долям. Локальные регионы того же темпового
   семейства тоже отклоняются, регионы на подсказанном темпе разрешены.
   Основание: Beat This! совпал с подсказкой на 4/4 проверенных треках (Благословлён 84,7 → BT 125,
   hint 127), и все 4 оценённых перехода с такими сетками — «плохо». Правило «дробные лаги» без hint
   отброшено: на «Чё я за тип?» Beat This! подтвердил наш темп. Fallback — washout/fade/intro-drop,
   причина в `fallbackReason` и `debug.gridTrust`.
4. **Выход A на конце структурной единицы.** В beatmatch добавлено `+0,1 × closureAt(A.structure, конец наложения)`.
   Средняя closure на конце наложения 0,53 → 0,75, доля ≥0,5: 46 % → 71 %. Средний пропуск финала A
   2,97 → 2,5 с, то есть не за счёт обрезания.
5. **Phrase bass swap: запрет роста пика.** Перенос отклоняется, если предсказанный пик мощности окна
   выше пика прежнего swap более чем на 0,5 dB (собственный провал рампы не считается). Это отклоняет
   пару Я ТЕБЯ МОГНУ → Листья, где прошлый агент измерил +0,44 LU.
6. **Тональность в unlocked crossfade.** При надёжных ключах (confidence ≥0,4 у обеих) и совместимости
   <0,3 середина меняется по очереди. Затрагивает 2 пары из 552.

Отвергнуто после измерений: структурные arrival-цели в `entryCandidates` (7 пар хуже);
порог уровня intro-drop (убивал 18 из 27 intro-drop, в том числе хорошо оценённую пару);
echo-out для несовместимых BPM (unlocked echo уже был оценён «сбился ритм»; echo-tail в lock и vocal
throw сохранены); loop-assisted переход (в engine нет контракта source-cursor loop).
Half/double time уже был (`tempoRelation`, m = 0,5/2, с тестами) и не менялся.

## A/B: одинаковые исходники и настройки

Control — копия planner.ts до работы плюс живой vocals.ts, поэтому разница — только planner.
Матрица 24 трека (12 local + 12 Yandex, analyzer-10, `user-library-planning-baseline-v10.json`), 552 пары:

| | control | v7 |
|---|---:|---:|
| beatmatch (вкл. echo-tail) | 115 | 89 (−26, все с треком с periodHint; у остальных потерь 0) |
| instrumental bridge | 11 | 11 (та же геометрия) |
| планы без изменений | — | 443/552 |
| пропущено пения B, сумма | 2208 с | 2026 с |
| max lostB / планов с lostB > 3,5 с | 4,81 / 5 | 4,81 / 3 |
| средний lostB / lostA, с | 0,544 / 0,400 | 0,509 / 0,408 |
| средняя длина перехода | 11,28 с | 11,12 с |

Промежуточная версия с ценой пения во всех путях давала 2208 → 1030 с, но с провалами громкости
(см. п. 1); оставлена только безопасная часть.

Оценённые переходы: 42 пары из 64 треков, analyzer-10 офлайн (`user-library-rated-a10-baseline.json`).
7/7 «хорошо» не изменились, изменено 7/35 «плохо».

Рендеры через движок (`renderTransitionOffline`, float PCM; MP3 в `data-dev/reports/previews/planner-v7-*`):

- Выборка: 20 изменённых пар × 2 = 40 рендеров. Все complete и finite, underruns 0, max TP −1,06 dBTP.
  Средний провал −1,46 → −1,44 LU, худший −11,98 → −7,62 LU, средний bump 0,41 → 0,36 LU.
  Хуже более чем на 1 LU — 3 пары (Знак, Младшая сестра, Кровосток → FATHER: beatmatch → washout
  из-за grid trust, −0,2…−0,8 → −1,4…−1,9 LU). Лучше более чем на 1 LU — 2 пары.
- Оценённые: 7 изменённых пар × 2 = 14 рендеров. Все complete и finite, 0 underruns, max TP −1,06 dBTP.
  Средний провал −1,12 → −1,45 LU. Регрессия: **Благословлён → Beautiful Dayy** −0,26 → −5,86 LU.
  Control сводил по сетке, которую отвергают повторы и Beat This!, и входил через 34 с, пропуская
  21,5 с пения; v7 делает intro-drop с 0 с, а вступление там почти тихое. Улучшение:
  Тайны → так похуй −4,12 → −1,44 LU.
- Отсутствие NaN, underrun и клиппинга не доказывает музыкального качества. **Ничего не прослушано.**

Прежние пары: На Крышах → Иногда, Младшая сестра → Я ТЕБЯ МОГНУ, Валентина → Знак (bridge) — планы
идентичны control. Tight Знак → Листья и Знак → LUV — те же. phrase_cut в tight-матрице 88 → 69 (grid trust).

## Без stems/ASR (ПК без GPU или ещё не разделённый трек)

`--no-stems` (vocalActivity удалена, stemMixing выключен), 552 пары: beatmatch 102 → 80, intro-drop 133,
washout 175, fade 155, echo-tail 9, **instrumental bridge 0** (ему нужен измеренный вокал A) — так же,
как в control. Цена пения = 0 (нет данных); grid trust и closure работают, потому что берутся из анализа,
а не из stems. Без stems недоступны vocal handoff и маски, voice echo и bridge; остальные техники
используют те же DSP-lanes.

## Стоимость планировщика (для офлайн-iOS)

`tools/bench-planner.ts`, Node 22, этот ПК, 552 пары на сохранённом анализе:
со stems медиана 5,0 мс на пару, p95 127 мс, max 298 мс; без stems — 7,4 / 87 / 165 мс.
JSON анализа на трек: медиана 153 КиБ (max 325), без вокала 122 КиБ. Рост heap при планировании
≤57 МиБ — временный мусор, не удерживается. Для телефона хватит, если анализ посчитан заранее.
p95 приходится на перебор локальных регионов (`planLocalRhythm`).

## Регрессии и проверки

- `packages/core/test/transition-techniques.test.ts`: +5 тестов (пение B, grid trust и регионы,
  рост пика bass swap, closure). Все три поведенческие проверки падают на control.
- `packages/core/test/planner-render-golden.test.ts`: детерминированный офлайн-рендер путей lock и
  grid-rejected (бит-в-бит повтор, 0 underruns, нет ямы >9 dB) — эталон для будущего Swift-движка.
- `DJplanning.test.ts`: тест vocalBudget адаптирован (4 такта выбираются сразу; проверки ремонта —
  если он сработал).
- Полный `npx vitest run`: 484/486. Под нагрузкой падали `server.test.ts` и `stems.test.ts`,
  отдельный прогон этих файлов — 54/54. Предыдущий полный прогон до golden-теста — 484/484.
  `npm run typecheck` — exit 0. `vite build` в scratch — ok (отдаваемый `apps/web/dist` не трогал:
  web-исходники не менялись).
- Браузер: отдельный экземпляр 4734 (`automix-planner-check`, data-dev, без Python/GPU).
  `/api/health` показывает planner v7; `/api/automix/plan` на живых данных отдаёт grid trust, bridge
  и vocal activity из stems; главная страница рендерится, ошибок в консоли нет. Воспроизведение
  не запускалось, чтобы не писать в историю и очередь пользователя.

```powershell
npx vitest run packages/core/test/transition-techniques.test.ts packages/core/test/planner-render-golden.test.ts packages/core/test/DJplanning.test.ts
npx tsx tools/ab-planner.ts --report user-library-planning-baseline-v10.json --tag planner-v7-sample --render 20 --audio
npx tsx tools/ab-planner.ts --report user-library-rated-a10-baseline.json --rated --tag planner-v7-rated --render 12 --audio
npx tsx tools/ab-planner.ts --report user-library-planning-baseline-v10.json --no-stems --tag planner-v7-nostems
node --expose-gc --import tsx tools/bench-planner.ts [--no-stems]
npx tsx tools/audit-library.ts --providers all --selection-report data-dev/reports/rated-selection-v1.json --analyze --tag rated-a10-baseline
```

Control-копия: `tools/.cache/baseline-planner/planner.ts` (gitignored). Это planner.ts до изменений
с переписанными импортами; оригинал лежит рядом, `planner.orig.ts`.

## Источники (принципы, не пороги)

- Kim et al., ISMIR 2020, [A Computational Analysis of Real-World DJ Mixes](https://arxiv.org/abs/2008.10267):
  у 86 % треков темп меняется меньше чем на 5 %, транспонирована лишь 2,5 % треков,
  cue-out и длины переходов кратны 32 долям (фразы).
- Zehren, Alunno, Bientinesi, [Automatic Detection of Cue Points for DJ Mixing](https://arxiv.org/abs/2007.08411):
  cue по правилам DJ и novelty структуры.
- Algoriddim, [djay Pro AI / Neural Mix](https://algoriddim.com/news/363-algoriddim-reinvents-djing-with-world-s-first-real-time-vocal-and-instrumental-separation-on-new-djay-pro-ai):
  раздельные партии, чтобы голоса не сталкивались. Описано публично, алгоритм не раскрыт.
- rekordbox Phrase analysis (Intro/Verse/Chorus…): известна только по сторонним описаниям, официальной методики нет.
- Serato, [key shifting & sync](https://serato.com/latest/blog/20140/learn-key-shifting-and-sync-w-logan):
  гармоническое сведение. Key shift в проекте нет, поэтому реализован только guard.
- Native Instruments и Pioneer — в прежнем разделе ниже. Внутренний алгоритм Apple не известен.

## Оставшаяся работа

1. Прослушать: Благословлён → Beautiful Dayy, пары с FATHER (grid trust), LUV → STORM II
   (теперь 16 тактов), Бехелит → STORM II (провал −7,6 LU в v7 и −12 LU в control — отдельная проблема).
2. Вход без потери слов для unlocked fade/washout: нужна оценка уровня по всему наложению, а не только в точке передачи.
3. FATHER, angel's tears: periodHint не подтверждён Beat This! — проверить вторым трекером.
4. Повторный поиск момента передачи при cleanA=cleanB=false (вопрос Агента 1).
5. `--verify-only` для 24 lyrics.json (Агент 1) — решение пользователя.
6. Перезапустить 4730, чтобы v7 начал звучать.

---

# Проверенные DJ-переходы — продолжение 20 октября 2026

Изменения сохранены в `packages/core/src/plan/planner.ts`, регрессии —
`packages/core/test/transition-techniques.test.ts`. Контракты DSP, `types.ts`,
анализатор, original f32le PCM и пользовательские данные не менялись.
Интегратор обновляет общую `PLANNER_VERSION` после объединения с вокальной
правкой. Отчёты, созданные до этого bump, сохраняют прежнюю строку версии;
сама строка не подтверждает идентичность промежуточных реализаций.

## Что исправлено и добавлено

1. **Instrumental bridge с подготовкой.** Предыдущий вариант запускал B за
   один бит до окончания A с ослабленными барабанами. В реальных записях эта
   точка уже находилась примерно на 9–10 dB ниже основной части A. Теперь B
   подготавливается за 1–3 собственных такта, максимум 8 секунд. A в начале
   ещё должен иметь измеренный уровень не ниже body −3,5 dB; бас B и его
   верха удерживаются, пока A несёт микс. Обмен басом заканчивается на сильной
   доле B у измеренного начала хвоста. A доигрывает до audibleEnd, темпы
   сохраняются. Дополнительно проверяется мощность B в окнах 750 ms через
   каждые 250 ms, пока старый бас уже ушёл. Предсказанная яма более 3 dB,
   пропуски/NaN в измерениях или нехватка материала возвращают обычный fallback.
   Если в подготовке A ещё поёт, нужны доступная передача вокала или измеренная
   пауза B; выключенные stems и неизвестный голос B не разрешают двойное пение.
2. **Phrase bass swap.** Для уже выбранного beatmatch можно передать только
   бас на уверенной границе фразы B вместо механической середины перехода.
   Нужны phrase confidence B ≥0,6, downbeat confidence обеих дек ≥0,5,
   совпадающая сильная доля обеих сеток, достаточный бас B и предсказанная
   потеря мощности не более 0,5 dB относительно прежних low-lanes.
   Кандидат находится в средних 25–75% перехода, не дальше 5 секунд от
   прежней точки. При drum phase shift, ручном Next, выключенном EQ или
   неподходящих данных сохраняется исходный обмен. Изменение применяется
   **после** выбора вокальных масок и компенсации громкости: точки входа,
   выхода, duration, tempo maps, `swapAt`, vocal masks и echo не сдвигаются.
3. **Downbeat cut в tight** сохранён: короткое снятие щелчка 100–120 ms
   вместо нескольких секунд несовместимых барабанов; измеренная сильная
   доля B и пауза A, когда имеется вокальная активность. Проверен и на
   двух реальных local→Yandex парах.

Это условный выбор музыкального приёма по данным, без случайной смены названий.
Ограничения источников, albums, preserve-opening, skip/stretch и max blend
проходят прежде этих веток. Новый sampler/loop runtime не добавлялся: безопасный
цикл требует отдельного контракта source cursors и проверки шва; произвольный
повтор записи ради разнообразия здесь не выдаётся за готовую технологию.

## Основание в первичных источниках

[Native Instruments: 5 basic DJ transitions](https://blog.native-instruments.com/dj-transitions/)
описывает phrase mixing, bass swap, cut и filter fade. Их
[официальное руководство Traktor](https://docs.native-instruments.com/ni-tech-manuals/traktor-pro-manual/en/basic-usage-tutorials)
показывает подготовку следующей деки без баса и встречный обмен LOW EQ.
[Native Instruments: cue points](https://blog.native-instruments.com/cue-points-djing/)
описывает cue у начала вокала для предотвращения наложения исполнителей.
[Pioneer DJ: pro-level tips](https://blog.pioneerdj.com/djtips/here-are-8-pro-level-dj-tips/)
даёт примеры музыкального применения echo. Уже имеющиеся locked echo-tail и
изолированное voice echo сохранены; новый эффект без подходящего материала
не включался. Это источники музыкальных принципов. Пороги и проверки выше —
наша реализация; внутренние алгоритмы Apple не известны.

## Реальные сравнения и воспроизводимость

`tools/review-planning-techniques.ts` читает сохранённый analyzer-10, только
готовые aligned stems и read-only SQLite. SHA-256 оригиналов проверяется перед
рендером; декодирование — float. Ни нового анализа, ни inference, ни изменений
медиатеки/настроек скрипт не выполняет.

Финальный automatic matrix: **552 пары, 115/115 прежних beatmatch сохраняют
method/aExit/bEntry/duration**, 11 instrumental bridges, 3 phrase bass swaps
внутри существующих beatmatch. Это отдельная офлайн-выборка 12 local + 12 Yandex,
не оценка доступности анализа во всей работающей библиотеке.

`data-dev/reports/planning-techniques-final-bridge-ab.json` содержит одинаковые
исходники для baseline / унаследованного bridge / текущего варианта:

| Пара | Baseline dip LU | Старый bridge | Текущий | Решение |
| --- | ---: | ---: | ---: | --- |
| На Крышах → Иногда | −1,94 | −5,72 | −1,94 | fallback восстановлен |
| Младшая сестра → Я ТЕБЯ МОГНУ | −2,92 | −5,32 | −2,92 | fallback восстановлен |
| Валентина → Знак | −2,84 | −2,76 | −1,66 | bridge с подготовкой |

Сравнение относится к целым планам с их собственными позициями в исходниках.
Особенно показателен старый Валентина bridge: исходный уровень перед ним уже
около −25,4 LUFS вместо примерно −15,2 у раннего baseline. Одна относительная
метрика dip скрывала слишком поздний старт; в отчёте сохранены before/after LUFS.

`planning-techniques-phrase-isolated-ab.json`: три сравнения low-lanes при
**идентичных** остальных lanes, masks, echo, gains, anchors и tempo maps:

| Пара | Bass swap: было → стало | Dip LU: было → стало | Bump LU: было → стало |
| --- | --- | --- | --- |
| STORM II → утекай | 14,033 → 12,276 s | −2,32 → −2,32 | +2,084 → +2,085 |
| Листья → Я ТЕБЯ МОГНУ | 11,798 → 8,904 s | −1,75 → −1,60 | +0,083 → +0,083 |
| Я ТЕБЯ МОГНУ → Листья | 11,196 → 14,090 s | 0 → 0 | +1,80 → +2,24 |

Последний подъём — измеренное ограничение нового варианта, не скрытое улучшение
всех показателей. В STORM II limiter reduction 0,623 dB одинаков в обоих
контролях; в остальных 15 финальных рендерах — 0 dB.

`planning-techniques-tight-review.json`: Знак → Листья (120 ms, dip −0,47 LU)
и Знак → LUV (100 ms, dip −1,46 LU), срез A примерно 1,2 секунды до audibleEnd.
Матрица tight имеет другие settings: её нельзя сравнивать с automatic как
регрессию числа beatmatch.

Во всех **17 финальных** рендерах (9 bridge comparisons + 6 isolated bass
comparisons + 2 cuts) нет underruns/non-finite/incomplete. WAV лежат в
`data-dev/reports/previews/sol-planning-ab/`. Независимая проверка всех 17 файлов
через FFmpeg `ebur128=peak=true`: максимум **−1,1 dBTP** с округлением 0,1 dB,
отчёт `planning-techniques-true-peaks.json`. Промежуточные эксперименты и
повторные рендеры не входят в эти 17; всего в продолжении сделано 50
ограниченных переходных рендеров, без полного повторного анализа песен.
Субъективного прослушивания агент не выполнял.

```powershell
npx vitest run packages/core/test/transition-techniques.test.ts packages/core/test/local-transition.test.ts packages/core/test/DJplanning.test.ts
npx tsc -p packages/core
npx tsx tools/review-planning-techniques.ts --render --audio --tag planning-techniques-final-bridge-ab
npx tsx tools/review-planning-techniques.ts --bass --control planning-techniques-guard-matrix.json --render --audio --tag planning-techniques-phrase-isolated-ab
npx tsx tools/review-planning-techniques.ts --tight --pairs 2 --render --audio --tag planning-techniques-tight-review
```

**60/60** релевантных тестов и core typecheck прошли. Тесты охватывают позднее
падение энергии B, подготовку до тихого хвоста A, NaN/обрезанные curves,
возврат вокала/барабанов, settings/source/album/manual guards, неизменность
vocal masks и математическое отображение bass handoff через tempo glide.
Полный suite/typecheck/build, общий version bump и браузерная интеграция —
обязанность интегратора после объединения работ.

## Ограничение runtime

На момент read-only проверки SQLite: analyzer-10 done=6, pending=214,
running=2; сервер использует точную текущую версию. Остальные analysis-cache
JSON из reports не подхватываются runtime автоматически. Поэтому хороший
552-pair офлайн-отчёт не обещает, что произвольная пара приложения уже имеет
нужные measured features. Числа изменяемы другим работающим процессом.
Массовый анализ, импорт кэша и перезапуск сервера этим агентом не запускались.

Band energy остаётся приблизительным признаком ударных; фразовая сетка
эвристическая и местами предполагает 4/4. Значительное улучшение восприятия
не доказано одной LU-метрикой: следует слушать сохранённые пары, особенно
residual vocals, скрытые слова B, атакующий бас на новом swap и tight cuts.

---

# Предыдущий этап: Measured transition techniques — 2026-10-20

This iteration adds two narrowly guarded DJ techniques in `packages/core/src/plan/planner.ts`.
It preserves existing successful global/local beatmatches and uses existing gain/EQ
lanes, without a new engine contract or additional analysis.

## Musical basis

Working DJ and educator Phil Morse describes changing tempo during beatless
sections, cutting at a suitable boundary, and using half/double-time relationships:
[7 Insider Tips For Making Exciting Tempo Changes While DJing](https://www.digitaldjtips.com/7-insider-tips-making-exciting-tempo-changes-djing/).
Crossfader's own performed example uses a breakdown/build and deliberately prepares
the incoming material before changing genres:
[Creative Trick For Genre Transitions](https://wearecrossfader.co.uk/blog/creative-trick-for-genre-transitions-128bpm-150bpm/).
These sources support the musical principles, not our numerical thresholds or an
assertion that arbitrary pairs can be mixed. Loops, scratching, generated bridges,
and large pitch ramps are outside this change.

## Implemented policy and fallback

- **Instrumental bridge:** after beatmatch fails, find a measured drum-light,
  vocal-light ending of A. Every quarter-second must satisfy the vocal and
  low/high-band thresholds; a quiet average cannot hide a returning phrase or
  drum fill. Require sufficient vocal measurement coverage, an audible preceding
  section, and a bounded tail of at least 2.5 seconds. Bring B up on a confident
  measured downbeat with enough energy; remove A's bass while its existing ending
  continues to the audible end. Both decks retain their original tempo.
  Existing skip/preserve-opening restrictions apply, and skipping appreciable
  measured vocals in B is refused. Missing measurements, unsuitable harmony,
  uncertain downbeats, manual Next, disabled EQ, or an unsuitable tail return to
  the established fallback. Band energy is a percussion proxy, not source-level
  proof of a drum-free recording.
- **Downbeat cut in tight style:** replace the previous multi-second overlap of
  incompatible drums with a maximum 120 ms de-click fade. Require a measured
  downbeat in B and a vocal pause around A's exit when vocal measurements exist.
  Keep the bounded ending loss and existing entry restrictions. A continuing
  vocal phrase or an unaligned preserve-opening entry rejects the cut.

## Verification and limits

The resumed agent reran `transition-techniques.test.ts`, `local-transition.test.ts`,
and `DJplanning.test.ts`: **55/55 passed**. The six technique tests cover positive
selection, voice/drum return, missing measurements, preserve mode, uncertain
downbeats, restrictions, and continuing vocals. No new analysis or model inference
was performed.

Saved analyzer-10 matrix reports:
`data-dev/reports/user-library-planning-baseline-v10.json` and
`data-dev/reports/user-library-planning-techniques-v10.json`.
All 552 pairs planned; 16 instrumental bridges replace existing fade/washout
fallbacks. All 115 previous beatmatches retain method, entry, exit and duration.
The automatic-style matrix does not validate the tight-style cut on real audio.

The already completed `user-library-planning-bridge-review.json` contains three
real offline renders, all complete and finite, without underruns/render errors
or limiter reduction. Maximum true peak is −1.92 dBTP.

| Pair | Duration | Measured dip |
| --- | ---: | ---: |
| На Крышах → Иногда | 6.50 s | −5.72 LU |
| Младшая сестра → Я ТЕБЯ МОГНУ | 2.75 s | −5.32 LU |
| Валентина → Знак | 8.00 s | −2.76 LU |

These dips are material listening targets, not evidence of uniformly improved
energy. No subjective listening was performed by this agent. Review the first
two pairs against the baseline before claiming a perceptual improvement; also
listen to a real tight-style cut. A quiet instrumental tail can still carry
residual voice or percussion. The harmonic estimate can be unknown, and the
planner still treats unknown harmony as compatibility 0.5.

Reports retain the pre-integration planner version `am-planner-v6-vocal-1`;
the parent integrator owns the final planner-version bump and complete suite,
typecheck/build, browser verification, and comparison with concurrent audio
changes. Original float PCM headroom handling was not modified.
