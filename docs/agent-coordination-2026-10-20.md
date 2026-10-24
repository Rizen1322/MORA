# Координация агентов — 20 октября 2026

Только дописывать (append). Формат: время, агент, что делает / какие файлы / вопрос.

## 18:00 — Агент 1 (ВОКАЛ)
Начинаю. Читаю `packages/core/src/plan/vocals.ts`, `tools/transcribe-vocals.py`,
`tools/separate-vocals.py`, `apps/server/src/stems.ts`, lyrics в snapshot data-dev.
Планирую менять: `packages/core/src/plan/vocals.ts` (доверие к ASR-границам,
слияние ASR с измеренной активностью, непрерывный вокал), тесты
`packages/core/test/lyrics-handoff.test.ts` / новый `packages/core/test/asr-trust.test.ts`.
DSP/engine, PLANNER_VERSION, ANALYZER_VERSION — не трогаю. Если потребуется
поднять PLANNER_VERSION — напишу заявку здесь.
GPU: пока только опрос (nvidia-smi, torch), без inference. Перед любым
separation/ASR запуском напишу отдельную запись и подожду 
ответа/отсутствия тяжёлых задач Агента 2.

## 18:02 — Агент 2 (ПЛАНИРОВЩИК/ИНТЕГРАЦИЯ)
(Моя первая запись 18:00 была перезаписана при одновременном создании файла — повторяю. Дальше только append, используйте `>>`.)
Принял. Мои файлы: `packages/core/src/plan/planner.ts`, `packages/core/src/mir/*`,
`packages/core/test/transition-techniques.test.ts` и новые тесты планировщика, `tools/review-planning-techniques.ts`.
Runtime анализа (`apps/server/src/analysis*.ts`, `automix.ts`) — только при доказанном дефекте, запишу заранее.
vocals.ts и ASR/separation не трогаю. PLANNER_VERSION бампаю я один раз в конце — сообщите здесь, когда ваши изменения готовы.
Находка (read-only): пользовательский сервер 4730 (PID 3712, старт 13:22) отдаёт /api/health
analyzer=am-analyzer-9, planner=am-planner-v5-drums-1 — то есть работает код ДО bump 13:56; у него 234/235 analyzer-9 done.
Строки analyzer-10 (6 done, 214 pending, 2 running от 14:04) оставлены другим, уже завершённым экземпляром на той же data-dev.
Сервер 4730 не перезапускаю. GPU не использую. Рендеры объявлю отдельно.

## 18:25 — Агент 1 (ВОКАЛ)
Извини за перезапись — дальше только `>>`.
Находка (CPU, read-only, 24 трека с lyrics.json, огибающая vocal stem 10 мс):
ASR-«паузы» 60–250 мс между словами почти никогда не тишина в stem: медиана −5,8 dB от p95,
тише −25 dB только 7%; в 77% нет тихого участка ≥30 мс даже в ±150 мс. Паузы акустических
фраз — медиана −32,6 dB, 67% тише −25 dB. Начала слов Whisper: IQR −90…+130 мс, ±40 мс лишь 21%.
Вывод: точные кандидаты коротких пауз Sol опираются на ненадёжные границы ASR; «79 мс → 0»
измерено против тех же ASR-слов (кругово).
План (мои файлы):
1. `packages/core/src/plan/vocals.ts`: ASR не может создать паузу без подтверждения измеренной
   активностью; длинные/непокрытые активностью «слова» обрезаются по activity; короткие паузы
   ASR доверяются только при `lyrics.timing === 'stem-verified-1'`.
2. `tools/transcribe-vocals.py`: `verify_timing` (огибающая stem, без модели, CPU) + режим
   `--verify-only` для существующих lyrics.json (исходные ASR-времена сохраняются в asrStart/asrEnd).
3. ЗАЯВКА на общие файлы (1–2 строки каждая): `packages/core/src/types.ts` — опциональное поле
   `timing?: string` в `vocalActivity.lyrics`; `apps/server/src/stems.ts` `readLyrics` — пробросить
   `timing`. LYRICS_VERSION не меняю (иначе сервер перезапустит Whisper на всей библиотеке).
   Агент 2, подтверди или возрази.
4. Матрица 552 планов (только декоратор vocals, без аудио) + 1–3 офлайн PCM-рендера A/B — CPU.
GPU inference НЕ планирую. PLANNER_VERSION бампнешь ты, когда скажу «готово».

## 18:07 — Агент 2
Ответ на заявку 18:25: **подтверждаю** оба изменения — `types.ts`: опциональное `timing?: string` в `vocalActivity.lyrics`;
`apps/server/src/stems.ts` `readLyrics`: проброс `timing`. Планировщик это поле не читает; ключ кэша планов
(`automix.ts vocalKey` = fnv1a(JSON activity)) сам инвалидирует планы при изменении lyrics. LYRICS_VERSION не трогать — согласен.
Я в `types.ts` в конце меняю только PLANNER_VERSION (ANALYZER_VERSION НЕ поднимаю: иначе повторный анализ всей медиатеки).
Мой план (planner.ts, без DSP/engine):
1) доверие к сетке по `structure.gridCheck` (periodHint / низкая доля целых долей) — без глобального lock по такой сетке;
2) структурный выбор выхода A/входа B (`closureAt`, `skipCost`, начала сегментов) из `mir/repetition.ts`;
3) проверка bump у phrase bass swap; ключевой guard в crossfade.
Новый DSP-примитив мне пока не нужен (echo-out можно собрать на существующей echo-lane). Если понадобится — заявка здесь.
CPU-задачи сейчас: офлайн analyzer-10 для 58 треков из оценённых переходов (1 поток, ~3–4 мин, пишет только
`data-dev/reports/analysis-cache`, БД не трогает) + матрицы планов (секунды). GPU не использую.
Офлайн-рендеры A/B (несколько десятков переходов, 1 поток) объявлю отдельной записью.

## 18:45 — Агент 1
Спасибо. Уточнение к заявке: кроме `timing?: string` добавляю второе опциональное поле
`voiced?: [number, number][]` (измеренные по stem интервалы звучащего голоса, 10 мс) в тот же
`vocalActivity.lyrics` (types.ts) и его проброс в `readLyrics` (stems.ts). Слова Whisper остаются
без изменений. Старые lyrics.json без этих полей валидны. Делаю сейчас.

## 19:15 — Агент 1
Сделано в коде (мои файлы + подтверждённые types.ts/stems.ts): см. ниже итог позже.
Матрица 552 (только декоратор, CPU, ~3 с) → `data-dev/reports/agent1-vocal-matrix.json`.
Сейчас: офлайн PCM-рендеры 3 пар × 3 варианта (baseline/raw/verified), CPU, 1 поток, ~1 мин,
пишет только `data-dev/reports/previews/agent1-vocal-ab/` и `data-dev/reports/agent1-vocal-real-ab.json`.


## 19:40 — Агент 1: ГОТОВО (прошу bump PLANNER_VERSION)
Изменены: `packages/core/src/plan/vocals.ts`, `packages/core/test/lyrics-handoff.test.ts`,
`tools/transcribe-vocals.py`, `tools/test-separate-vocals.py`, `packages/core/src/types.ts` (поля
lyrics.timing/voiced), `apps/server/src/stems.ts` (readLyrics), `docs/automix-audio-upgrade.md`.
Целевые 5 файлов: 84/84; Python 10/10; typecheck exit 0.
Полный vitest: 475/476 — падает `DJplanning.test.ts` «keeps B's opening instead of suppressing...»
(`debug.vocalBudget` undefined, строка 155). В тесте нет lyrics, мой код этот путь не меняет
(только добавил debug cleanA/cleanB); planner.ts менялся в 18:21 — проверь, пожалуйста.
Вопросы: (1) bump PLANNER_VERSION; (2) применять ли `--verify-only` к 24 существующим lyrics.json
в кэше (атомарно, слова Whisper не меняются, добавляются timing/voiced) — решение за пользователем/тобой;
(3) re-search момента передачи при `debug.stems.cleanA===false && cleanB===false` в длинном beatmatch.

## 18:31 — Агент 2
Принял «ГОТОВО». Падение `DJplanning.test.ts` «keeps B's opening…» — моё: в planner.ts штраф за наложение голосов
в beatmatch теперь до 0,4 (было 0,2), и 4-тактовое сведение выбирается сразу, без ремонта `vocalBudget`.
Тест адаптирован (если ремонт сработал — прежние проверки; итог bEntry=0, ≤3,5 с маски, 16 долей), core 247/247.
(1) PLANNER_VERSION подниму один раз после своих рендеров A/B: `am-planner-v7-entry-grid-1` (ваши vocals.ts учтены).
(2) `--verify-only` к 24 lyrics.json сейчас НЕ применять: это меняет живые кэши, которые читает пользовательский сервер;
оставляю решение пользователю/главному агенту, опишу в отчёте.
(3) Повторный поиск момента передачи при cleanA=cleanB=false — не в этой итерации (меняет геометрию плана, нужен отдельный A/B);
частично покрывается тем, что длинные маскирующие наложения теперь дороже при выборе. Запишу как оставшуюся работу.
СЕЙЧАС: офлайн-рендеры A/B planner (control vs current), CPU 1 поток, ~25–40 переходов × 2 варианта, ~10–15 мин,
пишут только `data-dev/reports/previews/planner-v7-*` и `data-dev/reports/planner-ab-*.json`. Прошу не запускать тяжёлое параллельно.

## 18:40 — Агент 2
`types.ts`: PLANNER_VERSION → `am-planner-v7-entry-grid-1` (один bump, включает ваши vocals.ts). ANALYZER_VERSION не менялся.
Рендеры A/B идут (~40 мин). Потом полный suite/typecheck/build и браузер на 4731 (data-dev, без воспроизведения,
чтобы не писать историю/очередь пользователя). Прошу не менять общие файлы до моей записи «проверка завершена».

## 20:05 — Агент 1
Повторил веб-исследование моделей разделения (только чтение, веса НЕ скачивались). Итог — подраздел «Разделение: первичные источники» в docs/automix-audio-upgrade.md. GPU не использовал.

## 20:20 — Агент 1: A/B разделения (разрешение пользователя через главного агента)
Качаю ТОЛЬКО: MelBandRoformer.ckpt (KimberleyJSN, MIT) + yaml + attend.py (ZFTurbo MIT) → data-dev/cache/models/melband/; SCNet Large starrytong ckpt + yaml + код models/scnet (ZFTurbo MIT) → data-dev/cache/models/scnet/.
GPU: сейчас GPU занят пользовательским сервером 4730 (фоновый Whisper, lyricsQueued=104, ~6,5 ГБ занято). Свой GPU-прогон (5 треков × 3 модели, по одному процессу) запущу только когда очередь освободит VRAM или в минимальном режиме; объявлю отдельной записью. Вывод только data-dev/reports/sep-ab/. Кэш stems/production не трогаю.

## 19:01 — Агент 2: проверка завершена
Полный vitest 484/486 (2 серверных теста падали под нагрузкой; отдельно 54/54), typecheck 0, vite build в scratch ok,
браузер на 4734 без GPU (остановлен). Документация: docs/automix-planning-upgrade.md (раздел v7). Общие файлы больше не меняю.
4730 работает на planner v6 — для v7 нужен перезапуск (решение пользователя).
