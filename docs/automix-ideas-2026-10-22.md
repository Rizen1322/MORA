# AutoMix: что ещё сделать, чтобы переходы звучали как у живого DJ (22.10.2026)

Это исследование и предложение. Production-код не менялся. Базы `data-dev/automix.sqlite` и установленного профиля читались только read-only.

Обозначения достоверности: **[офиц.]** — документация или пресс-релиз производителя; **[статья]** — научная публикация; **[пресса]** — пересказ журналистов или обзор; **[не подтверждено]** — наш вывод или слух без первоисточника; **[код]** — проверено по коду MORA; **[данные]** — посчитано по локальным базам.

Прошлые исследования не повторяются: [dj-automix.md](dj-automix.md), [automix-research-v5.md](automix-research-v5.md), [apple-automix.md](apple-automix.md), [automix-planning-upgrade.md](automix-planning-upgrade.md), [automix-audio-upgrade.md](automix-audio-upgrade.md), [automix-regressions-2026-10-22.md](automix-regressions-2026-10-22.md), [automix-abrupt-entries-2026-10-22.md](automix-abrupt-entries-2026-10-22.md).

## 1. Что уже есть и работает

Planner `am-planner-v11-dj-7`. Кратко, со ссылками на файлы:

- **Выбор метода.** `buildTransition` в [planner.ts](../packages/core/src/plan/planner.ts) выбирает beatmatch при растяжении ≤8 % (≤10 % только при длинном плавном glide), иначе локальные ритм-регионы, затем unlocked: phrase cut (только `tight`), intro drop, instrumental bridge, crossfade/washout. Мост темпа, drop между грувами и echo поверх чужого ритма удалены по оценкам.
- **Сравнение кандидатов.** `chooseMusicalPlan` строит до трёх планов (baseline, short-phrase, phrase-cut) и сравнивает цену: `0,16·lostA + 0,8·lostB + 0,5·voiceOverlap + 0,2·drumOverlap + 0,2·hole`. Веса заданы вручную.
- **Вход B.** `entryCandidates`, `arrivalFit`, `voiceTooSoon`, `pickHandoffEntry`: вход по структуре, штраф за пропуск спетого, запрет входа за такт до голоса.
- **Голос.** [vocals.ts](../packages/core/src/plan/vocals.ts), [first-words.ts](../packages/core/src/plan/first-words.ts), [answer.ts](../packages/core/src/plan/answer.ts): один голос за раз, конец голоса A в паузе, поднятая маска голоса B до `VOICE_LIFT_MAX = 2.5`, эхо только по вокалу в измеренной паузе.
- **Декораторы плана** (`finishPlan`): master tempo ([master-tempo.ts](../packages/core/src/plan/master-tempo.ts)), `holdLoudness`, phrase bass swap, инструментальная петля ([loop.ts](../packages/core/src/plan/loop.ts)), filter release на прибытие B ([dj-phrasing.ts](../packages/core/src/plan/dj-phrasing.ts)), micro-onset, гармонический mid-handoff ([harmonic.ts](../packages/core/src/plan/harmonic.ts), не больше −1 дБ середины), tape-stop ([tape-stop.ts](../packages/core/src/plan/tape-stop.ts)).
- **Движок.** [mixer.ts](../packages/core/src/engine/mixer.ts): полосы `gain/low/mid/high/echo/voiceEcho/filter`, трёхполосный LR4-изолятор ([crossover.ts](../packages/core/src/dsp/crossover.ts)), true-peak limiter. [engine/vocals.ts](../packages/core/src/engine/vocals.ts): `original + (mask − 1)·vocals` **до** одного WSOLA, поэтому голос и аккомпанемент не расходятся по фазе. [engine/loop.ts](../packages/core/src/engine/loop.ts): конечная петля по исходному курсору, тоже до WSOLA.
- **Анализ.** `mir/*`: сетка битов и локальные регионы, проверка сетки по повторам (`gridCheck.periodHint`), структура по SSM, тональность, кривые полос.
- **Порядок очереди.** [rec/mix-set.ts](../packages/core/src/rec/mix-set.ts): жадный порядок по темпу (0,6), Camelot (0,25), энергии (0,15). Используется только в `apps/web/src/lib/mix-set.worker.ts`.
- **Разделение.** [tools/separate-vocals.py](../tools/separate-vocals.py): `HDEMUCS_HIGH_MUSDB_PLUS`, окна 8 с с контекстом, s16 на диске.

### Данные оценок [данные]

Пересчитано 22.10.2026 обеими базами read-only (`transition_log`, поле `rating`):

| База | Оценено | Плохо | Хорошо | Из оценённых `forced=true` | Всего `forced=true` в журнале |
|---|---:|---:|---:|---:|---:|
| `data-dev` | 50 | 41 | 9 | 0 | 34 из 500 |
| установленный MORA (`%LOCALAPPDATA%/MORA/data`) | 10 | 10 | 0 | 0 | 9 из 269 |
| **итого** | **60** | **51** | **9** | 0 | 43 |

- **Ровно 60 оценок.** Число 61 в первой версии документа было ошибкой.
- **Хорошие:** 6 beatmatch, 2 crossfade, 1 tempo_bridge; все из `data-dev`. В установленном профиле хороших оценок нет.
- **`forced` — отдельный сигнал.** Ни один оценённый переход не был принудительным. 43 события `forced=true` не оценены. Это повторное нажатие Next во время перехода: пользователь мог спешить, а не слышать плохой переход. Это не дизлайк, а слабый отдельный признак.
- **Дублей пар нет.** Ни одна упорядоченная или неупорядоченная пара не повторяется ни по `content_hash`, ни по названию, в том числе между базами. Но треки повторяются: «1ST DAY SMOKE» участвует в 4 оценках (№226, 228, 443 dev; №250 installed), «Тайны» — в 3 (№248, 393, 505). Оценки одного трека не независимы.
- **Версии planner** берутся из `plan.version` в журнале. 11 разных версий: `am-planner-16` (13), `v2-5` (10), `v5-drums-1` (10), `v11-dj-4` (6), `17` (5), `v7-entry-grid-1` (5), `v3-phrases-2` (4), `v2-2` (2), `v11-dj-5` (2), `v11-dj-6` (2), `v2-4` (1). Только 10 оценок относятся к линии v11, все они плохие.
- **Версия analyzer** в плане не сохраняется. Ниже указана последняя версия, готовая в `analysis` к моменту перехода (`updated_at ≤ executed_at`). Это верхняя граница: сервер мог работать на старом коде (так было с v7, см. [automix-planning-upgrade.md](automix-planning-upgrade.md)). Распределение: analyzer-8 — 35 оценок, analyzer-9 — 8, analyzer-10 — 11 (+2 пары 9/10), analyzer-11 — 4.

Вывод: 60 оценок из 11 версий planner и 4 версий analyzer — это история разработки, а не однородная обучающая выборка. Подбор весов (И6в) отложен до трёх условий: точная версия planner+analyzer в каждой новой записи, учёт повторяющихся треков, парное прослушивание.

Полная таблица по каждой оценке — в приложении А.

## 2. Что делают лучшие системы (свежие источники)

- **Apple Music AutoMix, iOS 27.** [пресса] 9to5Mac по личному тесту беты: AutoMix «ремиксует» outro и intro, чтобы выровнять темп, и **повторяет части outro/intro как мост**; «подводный» фильтр-эффект iOS 26 в основном заменён естественными сведениями; обычный Crossfade остался ([9to5Mac, 16.07.2026](https://9to5mac.com/2026/07/16/ios-27-makes-one-of-my-favorite-apple-music-features-even-better/); пересказ: [RouteNote](https://routenote.com/radar/apple-music-automix-gets-a-major-upgrade-in-ios-27/)). [офиц.] Apple подтверждает только time stretching и beat matching. Длина петель, BPM-пороги и алгоритм не опубликованы. Вывод: тренд — **удлинение и повтор материала самих треков**, а не эффекты поверх.
- **Spotify Mix.** [офиц.] Редактор переходов плейлиста с авто-режимом, пресетами Fade/Rise, ручными кривыми громкости, EQ и эффектов; показывает BPM и тональность ([Spotify Newsroom, 19.08.2025](https://newsroom.spotify.com/2025-08-19/mix-your-favorite-playlists-seamlessly-by-adding-your-own-transitions/), [Spotify Support](https://support.spotify.com/bt/article/mixed-playlists/)). В 2026 году вышел на desktop. Авто-алгоритм не описан. Стемов в описаниях нет.
- **djay (Algoriddim).** [офиц.] Automix-переходы Dissolve, Riser, Echo; Neural Mix делит трек на 4 партии (vocals, harmonic, bass, drums), каждую можно зациклить, обработать эффектом и **сводить отдельно между деками**; bounce loop поверх вложенной петли ([пресс-релиз Algoriddim, 2021](https://algoriddim.com/press_releases/435-algoriddim-announces-major-update-to-djay-pro-ai), [сообщество Algoriddim](https://community.algoriddim.com/t/now-available-major-update-to-djay-pro-ai-on-ios/13690)). Это материалы 2021 года; текущее поведение не проверено.
- **Rekordbox, Serato, Traktor, Mixxx.** Описаны в [automix-research-v5.md](automix-research-v5.md). Новое: 4-стемовое разделение стало стандартом DJ-программ ([пресса] [DJ.Studio benchmark 2026](https://dj.studio/blog/dj-software-stem-separation-benchmark)).
- **MixWeaver (ISMIR 2026).** [статья] «Stem-Aware Automatic DJ Transition Generation via Structured Discrete Optimization», Zhou, Jiang, Zhi, Wu, McAuley, UC San Diego ([список принятых статей](https://ismir2026.ismir.net/accepted-papers)). По названию и описанию задачи: дискретный поиск траекторий громкости **отдельных стемов** в переходе. Рецензия ([cseweb.ucsd.edu](https://cseweb.ucsd.edu/~jmcauley/reviews/ismir26c.txt)) с этой машины не открылась (connection refused), полный текст не найден. Детали метода и результатов прослушивания **не проверены**.
- **Там же на ISMIR 2026:** «Rethinking Automatic Music Mixing as Sequential Stem Blending» (Yeh, Chan, Hung, Yang) — тот же тренд «смешивать по стемам», но для мастеринга микса, а не DJ-перехода.
- **Chen et al., ICASSP 2022** [статья]: GAN + дифференцируемые EQ и фейдер, обучение на реальных DJ-миксах, в прослушивании «конкурентно» с базовыми методами ([arXiv 2110.06525](https://arxiv.org/abs/2110.06525)). Чисел в аннотации нет. Для нас полезна сама параметризация: переход = кривые gain + EQ, как у нас.
- **Hein, Princeton 2025** [статья, бакалаврская работа]: CNN по mel-спектрограммам предсказывает кривые громкости и EQ по данным 1001Tracklists; воспроизводит переход «при обучении на одном примере» ([Princeton DataSpace](https://theses-dissertations.princeton.edu/entities/publication/86237923-6f8a-4172-a6e7-d639e97d38d1/full)). Доказательства обобщения нет.
- **DJ-AI, Audio Mostly 2025** [статья]: порядок плейлиста оптимизацией по графу + эмбеддинги MERT + генерация перехода MusicGen ([PDF](https://research.sabanciuniv.edu/52373/1/AI_DJ_AM2025.pdf)). Цифра «70,5 % предпочтений» встречается только в блоге — [не подтверждено]. Генерация нового звука противоречит нашему принципу «только материал самих треков» и требует тяжёлой модели.
- **Kim et al., ISMIR 2020** [статья] ([arXiv 2008.10267](https://arxiv.org/abs/2008.10267)): 1557 миксов, 20 765 переходов. Темп меняется меньше чем на 5 % у 86,1 % треков, меньше 10 % у 94,5 %. **Транспонируют только 2,5 % треков**, из них 94,3 % на 1 полутон. Длины переходов имеют пики каждые **32 доли** (8 тактов). Cue-точки разных DJ на одном треке совпадают в пределах 4 долей лишь в 40,4 % пар: «правильной» точки нет, есть хорошие.
- **Лёгкие 4-стемовые сепараторы.** [статья] Moises-Light — band-split U-Net, SDR сопоставим с моделями в 13 раз больше ([arXiv 2510.06785](https://arxiv.org/abs/2510.06785)); лицензия страницы CC BY-NC-SA 4.0, кода нет, для нас не подходит. Open-Unmix (MIT) слабее HDemucs по SDR. SCNet Large (MIT-код, 169 МБ, CPU-время 48 % от HT Demucs) — разобран в [automix-audio-upgrade.md](automix-audio-upgrade.md).

## 3. Пробелы по сравнению с лучшими системами

1. **Нет отдельных drums и bass.** [код] `separate-vocals.py` берёт из модели только `model.sources.index('vocals')`, хотя `HDEMUCS_HIGH_MUSDB_PLUS` на каждом окне уже вычисляет все четыре источника (drums, bass, other, vocals). Bass swap делается LR4-фильтром: он убирает и бочку, и низ синтов и голоса. Отсюда «дыра» в басу (средний провал −2,6 LU у ухода через фильтр по [dj-automix.md](dj-automix.md)) и запрет «двух бочек», который режет длину сведений. djay и, по названию, MixWeaver ведут партии отдельно.
2. **Петля не удлиняет трек.** [код] `withInstrumentalLoop` работает только в crossfade без изменения темпа, не дальше `audibleEnd`, только на тихом инструментальном финале. Apple iOS 27, по прессе, повторяет outro/intro, чтобы сведение стало длиннее. Короткий outro A сейчас просто сокращает переход.
3. **Ручные веса выбора.** [код] Веса цены в `chooseMusicalPlan` и десятки порогов не подбирались по оценкам. Сигнал `forced=true` (43 неоценённых события) не используется даже как слабый отдельный признак. Версия analyzer в журнал не пишется.
4. **Оценка по аналитическим кривым, а не по звуку.** [код] Цена считается по `curves.rmsDb` и `vocalActivity` в 32 точках. Офлайн-рендер через тот же `MixerCore` уже есть (`renderTransitionOffline`, `tools/eval-transitions.ts`), но в выборе плана не участвует.
5. **Стемы не всегда готовы.** [данные] По заметке сессии подготовки стемов: переходы №231, 242, 243 прошли без масок, №234 — только с маской A, у №250 стемы закончились на 34 и 78 с позже перехода; разделение следующего трека начинается только после того, как клиент назовёт его `next`; задача кандидата с приоритетом 70 не вытесняется. Без стемов все вокальные правила выключаются.
6. **Порядок очереди не знает о переходе.** [код] `mixSetScore` смотрит только BPM, Camelot и общую энергию. Он не знает, поёт ли A в конце и B в начале, есть ли у B intro без баса и что выберет planner для пары.
7. **Downbeat при неуверенности.** [код] `gridTrust` отклоняет сетку только по `periodHint`. Сдвиг первой доли на 1–2 доли при верном BPM (типичная ошибка, по руководству Mixxx) не проверяется вторым трекером.

## 4. Таблица идей

Польза — для слуха пользователя (длинные сочные сведения, один голос, слова B не теряются), 1–5. Стоимость — работа и ресурсы, 1–5. Оценки экспертные.

| № | Идея | Польза | Стоим. | Риск | Зависимости | Как измерить и прослушать | Файлы |
|---|---|:-:|:-:|---|---|---|---|
| И1 | **Надёжная подготовка стемов**: начинать разделение `next` и `next+1` сразу при изменении очереди; вытеснять задачу кандидата при приходе `next`; метки времени queued/started/done в metadata и логе | 5 | 2 | Низкий; больше CPU в фоне | Зона сессии AutoMix-фиксов (`apps/server/src/stems.ts`) | Доля переходов без масок в `transition_log.plan`; запас «стем готов до перехода», с; цель — 0 переходов без масок при игре трека ≥60 с | `apps/server/src/stems.ts`, `routes/playback.ts` |
| И2 | **Сохранять drums и bass** из уже вычисленного вывода HDemucs | 4 (сама по себе 0, открывает И3–И5) | 2 | Диск, см. раздел 5 | — | Время разделения до/после на 5 треках; размер; `original − Σstems` (остаток «other») | `tools/separate-vocals.py`, `apps/server/src/stems.ts` |
| И3 | **Bass swap по стемам**: бас A уходит маской стема, бас B входит маской; бочка и низ остальных партий остаются; LR4 только для остатка утечки. Простая замена `low` маской на 3 парах пользы не дала (раздел 8) | 2 (не доказана) | 3 | Утечка баса в drums/other; щелчки маски — нужен fade ≥20 мс | И2, расширение движка | Офлайн-рендер 10 пар: провал НЧ-полосы (LU), секунды «двух басов» > −6 дБ, совпадение со стемом B; прослушать хорошо оценённые и «резкие» | `engine/vocals.ts` → общий stem-источник, `engine/mixer.ts`, `types.ts`, `plan/planner.ts` (`phraseBassSwap`) |
| И4 | **Обмен ударными и «инструментал B под голос A»**: при beatmatch ударные B входят раньше, ударные A уходят на сильной доле; голос A допевает фразу над ритмом B; harmonic A уходит позже | 4 | 3 | Тональный конфликт harmonic A и B; только при надёжной сетке и beatmatch | И2, И3 | Рендер: `voiceOverlap`, «две бочки» (onset-флэм между деками), длина совместного звучания; прослушать пары, где сейчас голос A обрывается (№259, 266) | `plan/vocals.ts`, `plan/planner.ts`, движок |
| И5 | **Петля-удлинение outro/intro** (как Apple iOS 27): 1–2 такта ударных/инструментала A повторяются за `audibleEnd`, пока B не дойдёт до прихода; или петля intro B (без голоса), пока A допевает | 4 | 3 | Повтор слышен как «заело»; не больше 2–4 циклов; только при стабильной сетке | Есть `LoopPcmSource`; с И2 — петля только ударных | Число планов, где длина сведения выросла с <8 до ≥12 с; доля переходов, где голос A допевает фразу; прослушать 10 пар с коротким outro | `plan/loop.ts`, `engine/loop.ts`, `plan/planner.ts` |
| И6 | **Обратная связь по оценкам**: (а) писать в журнал версии planner и analyzer и наличие масок; (б) `forced=true` — отдельный слабый признак, не дизлайк; (в) инструмент парного прослушивания «вариант 1 / вариант 2» для одной пары; (г) **потом** подбор 5–6 весов `chooseMusicalPlan` (Bradley–Terry, сильная регуляризация, leave-one-track-out) | 4 | 2 | Переобучение: 60 оценок из 11 версий planner, повторяющиеся треки; веса не должны ломать гарантии «один голос» | (г) только после (а) и (в) | Replay оценённых пар (`tools/rating-report.ts`, `measure-dislikes.mts`); никаких изменений для хорошо оценённых пар | `apps/server` (журнал), `plan/planner.ts` (веса), `tools/rating-report.ts`, новый `tools/ab-listen.ts` |
| И7 | **Проверка кандидатов рендером**: для 2–3 лучших планов офлайн-рендер окна перехода в worker; метрики — провал краткосрочной громкости, «два баса», onset-флэм ударных, перекрытие голосов по стемам, работа лимитера; выбор по рендеру, при ошибке — прежний план | 4 | 3 | CPU на ПК и особенно iOS; рендер не равен слуху | Желательно И6 для весов метрик | Время рендера одного окна 20 с; совпадение рендер-оценки с оценками пользователя (AUC на 60 оценках, с учётом разных версий planner) | `plan/planner.ts`, `engine/mixer.ts` (offline), `tools/eval-transitions.ts` |
| И8 | **Порядок очереди под сведение**: в `mixSetScore` добавить «A кончается без голоса / B начинается без голоса», наличие intro без баса, и цену уже рассчитанного плана пары | 3 | 2 | Пользователь не всегда хочет переставлять; только в режиме микса | Кэш планов на сервере | Доля пар beatmatch и средняя длина сведения в упорядоченном плейлисте до/после на медиатеке | `rec/mix-set.ts`, `apps/web/src/lib/mix-set.worker.ts` |
| И9 | **Фразы 8/16/32 тактов**: предпочитать `swapAt` и конец наложения на границе 32 долей B и конце фразы A (как пики у Kim 2020) | 3 | 1 | Низкий; уже частично (`closureAt`, `phraseAligned`) | — | Доля планов со сменой баса на границе 16/32 долей; replay оценённых пар | `plan/planner.ts`, `plan/dj-phrasing.ts` |
| И10 | **Второе мнение о downbeat** (Beat This! `small0`, MIT, 0,34 с/трек, 187 МиБ по прошлому замеру) для треков с низким `downbeatConfidence` или спорным `gridCheck`; при расхождении — без lock | 3 | 3 | Дополнительная зависимость Python; ошибается на редких жанрах | Окружение `STEMS_PYTHON` | Доля «сбился ритм» среди оценок; совпадение сеток на 30 треках | `mir/tempo.ts`, `tools/beat-this-run.py`, `apps/server` |
| И11 | **Не сводить**: распознавать живую/классическую/акустическую музыку (слабый ритм, длинные естественные затухания, широкий динамический диапазон) и выбирать gapless или естественное затухание | 2 | 1 | Ложные срабатывания на lo-fi | — | Список пар, где выбран gapless; прослушать 5 треков классики/акустики | `plan/planner.ts` (`buildTransition`) |
| И12 | **Реверб только на вокале** вместо эха на последнем слове, если есть место (есть `dsp/reverb.ts`) | 2 | 2 | Пользователь плохо оценил эхо поверх чужого ритма; реверб только по голосу и только в паузе | Стем голоса | Хвост голоса A ниже −40 дБ до голоса B (тест как у `voiceEcho`) | `plan/answer.ts`, `engine/mixer.ts` |
| И13 | **Сдвиг тональности ±1 полутон** во время наложения | 1 | 4 | Высокий: слышимый сдвиг голоса и возврат тона; DJ делают это редко (2,5 % треков) | Per-deck resampler после WSOLA (есть только в общем `dsp/playback.ts`) | Доля пар с конфликтом Camelot и уверенными ключами; прослушивание | `engine/mixer.ts`, `dsp/playback.ts`, `plan/harmonic.ts` |
| И14 | **Партия harmonic (`other`) при тональном конфликте**: приглушать harmonic A маской стема, а не середину EQ на −1 дБ | 3 | 2 | Утечка гармонии в другие стемы | И2, И3 | Тот же рендер, что для `harmonicHandoff` | `plan/harmonic.ts`, движок |
| И15 | **Лучший сепаратор** (Mel-Band RoFormer Kim для голоса, SCNet для 4 партий) | 3 | 4 | 913 МБ весов, VRAM, время на CPU | Разрешение пользователя на загрузку | План A/B из [automix-audio-upgrade.md](automix-audio-upgrade.md) | `tools/separate-vocals.py` |

Не рекомендуется (по оценкам и источникам): мост темпа на 1–4 такта, drop между разными грувами, эхо всего микса поверх чужого ритма, генерация нового звука (MusicGen, как в DJ-AI) — тяжёлая модель и чужой материал в переходе.

## 5. Сохранённые drums и bass: польза и цена

### Что даст

- **Честный bass swap.** Сейчас LR4-полоса `low` режет всё ниже частоты разделения: бас, бочку, низ синтов и голоса. Маска стема баса убирает только бас. Бочка A может доиграть до сильной доли, бас B входит без провала НЧ.
- **Обмен ударными.** Ударные B входят на такт раньше или позже баса. Это «две бочки» только там, где сетки стыкованы, и короткая подготовка ритма B.
- **Инструментал B под голос A.** Голос A допевает фразу, а под ним уже ритм и бас B. Это решает компромисс из [automix-abrupt-entries-2026-10-22.md](automix-abrupt-entries-2026-10-22.md): голос A обрывается при первом слове B, если у A нет паузы.
- **Петля только ударных.** Повтор такта ударных A без голоса и гармонии звучит как DJ-петля, а не как «заело».

### Как встроить в движок без потери фазы

Сейчас: `out = original + (m_v − 1)·vocals`, затем один WSOLA. Общая форма для четырёх партий, где `other` не хранится:

`out = m_o·original + (m_v − m_o)·vocals + (m_d − m_o)·drums + (m_b − m_o)·bass`

При всех масках 1 выход точно равен оригиналу, как сейчас: схема «оригинал минус стем» не может испортить немаскированный трек. Все партии проходят один WSOLA, поэтому партии не сдвигаются друг относительно друга. Но ошибки разделения остаются: утечка бочки в стем баса, баса в `other`, голоса в ударные. Маска стема снимает то, что модель отнесла к партии, а не саму партию. Нужны: две новых `ChunkStore` на деку, запросы чанков с `part: 'drums' | 'bass'`, маски `drumsA/B`, `bassA/B` в `TransitionPlan`, порт в iOS `NativePlayer` (там сейчас нет даже вокальных масок).

### Цена

Повторный проход модели не нужен: модель уже выдаёт 4 источника на каждом окне. Но добавляются RAM на накопители, сборка окон, конвертация в s16, запись, при необходимости ресэмплирование и чтение в плеере. Первая версия этого раздела называла CPU «почти бесплатным» без замера; это было не доказано. Замер на 5 треках — в разделе 8.

| Ресурс | Сейчас (только vocals) | + drums + bass |
|---|---|---|
| Инференс | Модель уже считает 4 источника на каждом окне | Тот же проход |
| Сборка, конвертация, запись | 1 источник | 3 источника; замер в разделе 8 |
| RAM Python | 1 стерео float32 ≈ 54 МБ на трек 154 с | +2 массива ≈ +110 МБ (оценка); замер пика в разделе 8 |
| Диск | ≈26 МиБ s16 на трек | ≈78 МиБ на трек |
| Кэш 2048 МБ | ≈78 треков | ≈26 треков, если хранить всё |
| Чтение в плеере | 1 доп. поток чанков в переходе | 3 доп. потока, только во время перехода; не замерено |

Вывод: дороже всего диск, остальное нужно мерить на целевом железе. Предложение: drums и bass хранить **отдельным LRU** только для треков очереди (current, next, next+1, кандидаты) и закреплённых; vocals хранить как сейчас. Тогда drums/bass занимают ≈5×52 МиБ ≈ 260 МиБ. Метаданные должны позволять частичный стем: нет drums/bass — прежний EQ-swap.

## 6. Топ-5 рекомендаций по порядку

### 1. И1 — стемы всегда готовы к переходу

**Почему первым.** Все вокальные правила, поднятая маска голоса и любые будущие стем-переходы бесполезны без стемов. 4 из 10 плохих оценок установленного профиля (№231, 242, 243, 250) прошли без масок, ещё одна (№234) — только с маской A. Это дешевле любой новой техники.

**Первый шаг.** Записывать в `metadata.json` и лог время постановки в очередь, начала и конца разделения. Потом одна неделя данных показывает реальную долю поздних стемов. Зона `stems.ts` принадлежит сессии AutoMix-фиксов: передать ей.

### 2. ~~И2 + И3 — drums/bass из HDemucs и bass swap по стему~~ — отклонено

**Решение пользователя, 22.10.2026:** оставить текущую схему — только вокальный стем, обмен баса полосой EQ (LR4). Основание — эксперимент из раздела 8: замена EQ-обмена маской стема на 3 парах почти не изменила звук, провалы НЧ не исправила и добавила до 1,25 с «двух бочек», а цена — +234–394 МБ пика RAM и около 0,68 МБ диска на секунду трека. И2, И3 и зависящие от них И4 и И14 не делаются. Идею можно вернуть, только если появится новая логика ударных и её польза будет подтверждена на слух.

Освободившееся место в топе занимают И5 и И7.

### 3. И6 — обратная связь по оценкам

**Почему.** Сейчас каждая правка проверяется вручную на нескольких парах. Нужна автоматическая проверка «не испортили хорошие, исправили плохие» и способ получать оценки быстрее. Парное сравнение двух вариантов одной пары даёт больше информации на минуту прослушивания, чем оценка одного перехода.

**Первый шаг.** Записывать в `transition_log` версии planner и analyzer и готовность масок A/B (сейчас версия analyzer восстанавливается только приблизительно). Затем инструмент парного прослушивания: два варианта одной пары, ответ «первый / второй / одинаково». Подбор весов — только после этого, с учётом повторяющихся треков. Пересчёт 60 старых оценок текущим кодом полезен как регрессия, но не как обучающая выборка.

### 4. И5 — петля-удлинение outro/intro

**Почему.** Пользователь любит длинные сочные сведения. Короткий outro A сейчас делает переход коротким. Apple в iOS 27, по прессе, повторяет части outro/intro как мост. `LoopPcmSource` уже есть и проверен на шве.

**Первый шаг.** В `tools/check-loop-candidates.ts`-подобном отчёте посчитать по медиатеке, сколько beatmatch-планов ограничены концом A (`until ≈ audibleEnd`) и сколько стали бы ≥12 с при 1–2 повторах последнего инструментального такта. Если таких пар мало — идея ниже в списке.

### 5. И7 — выбор кандидата по рендеру

**Почему.** Аналитическая цена ошибается там, где важны фактические кривые после маски, лимитера и WSOLA (как в №266: план «длинный», рендер — Next). Рендер-проверка ловит такие случаи до того, как их услышит пользователь.

**Первый шаг.** Замерить время `renderTransitionOffline` одного окна 20 с на ПК. Если ≤200 мс — включить рендер как «вето»: кандидат с провалом громкости >3 LU или совместным звучанием <1 с при beatmatch отклоняется. Для iOS — отдельный замер на iPhone 12 (раздел 7).

## 7. iOS

- **Новые техники не должны зависеть от ПК.** iPhone играет офлайн, без сервера. Технику, которая работает только при плане или стемах с ПК, на телефоне пользователь не услышит, и поведение двух платформ разойдётся.
- **Порядок.** Сначала перенести в Swift текущий проверенный движок: маски голоса (их в `NativePlayer` сейчас нет), петлю, полосы и лимитер. Только затем добавлять новое.
- **Дополнительные стемы и выбор по рендеру** — отдельный этап с замером на iPhone 12: время разделения на устройстве (или решение не делить на устройстве), RAM, диск, время рендера одного окна, нагрев. До замера эти техники на iOS выключены, и прежний план остаётся рабочим.

## 8. Офлайн-эксперимент: bass swap по стему (И2 + И3)

22.10.2026. Production-код, кэш стемов и базы не менялись. Скрипты: `tools/.cache/stems4/` (`separate4.py`, `run.py`, `experiment.mts`). Результаты и WAV: `data-dev/reports/stems4/` (`separation.jsonl`, `results.json`, `<№>-eq.wav`, `<№>-stem.wav`).

### Метод

- **Разделение.** Та же модель `HDEMUCS_HIGH_MUSDB_PLUS`, те же окна 8 с, контекст 0,35 с, перекрытие 25 %, `shifts=1`, CPU, 4 потока — как в установленном CPU-runtime. Каждый трек дважды, отдельными процессами: `vocals` (как production) и `four` (все 4 партии из того же вызова модели на каждом окне). Пик RAM — `PeakWorkingSetSize` процесса Python.
- **Пары.** Текущий planner `am-planner-v11-dj-7` на analyzer-11 из баз:
  - №215 (dev, **хорошо**, «Бандана → КАРТА В БЛОКЕ», beatmatch 27,4 с, без масок голоса);
  - №216 (dev, плохо, «КАРТА В БЛОКЕ → 4 am in London», crossfade 9 с, без масок);
  - №266 (установленный, плохо, «LUV → 8 миля», beatmatch 25,6 с, с масками голоса).
- **Два варианта на одном плане.** `eq` — план как есть: bass swap полосой `low` LR4 (<180 Гц). `stem` — та же кривая `low` становится маской стема баса: `исходник + (m − 1)·bass` в исходном времени до движка, а полосы `low` = 1. Это та же формула, что предложена для движка (раздел 5), и тот же `renderTransitionOffline`. Всё остальное в плане одинаково.
- **Метрики.** Провал НЧ: максимум за окно 0,5 с во время перехода (НЧ <120 Гц, полного рендера) ниже меньшего из уровней «до» и «после». «Два баса» / «две бочки»: секунды, когда НЧ стема баса (или ударных) каждой деки, отрендеренного отдельно по тому же плану, не ниже своего опорного уровня −6 дБ.

### Цена разделения (5 треков, 115–195 с)

| Трек, с | infer `vocals` / `four`, с | Сборка окон, с | Конвертация и запись, с | Пик RAM `vocals` → `four`, МБ | Диск drums+bass, МБ |
|---|---|---|---|---|---|
| 122 | 12,1 / 11,7 | 0,05 → 0,23 | 0,28 → 0,95 | 1452 → 1698 (+246) | 41 |
| 124 | 12,5 / 13,2 | 0,12 → 0,19 | 0,23 → 1,12 | 1455 → 1706 (+251) | 42 |
| 181 | 19,3 / 20,9 | 0,19 → 0,38 | 0,34 → 1,53 | 1542 → 1908 (+366) | 61 |
| 195 | 24,1 / 32,7 | 0,16 → 0,56 | 0,56 → 2,58 | 1563 → 1957 (+394) | 66 |
| 115 | 16,3 / 12,4 | 0,12 → 0,25 | 0,20 → 0,88 | 1442 → 1676 (+234) | 39 |

- **Инференс** тот же, разброс ±30 % — шум: параллельно работали другие сессии. Второго прохода модели нет.
- **Сборка и запись** добавляют 0,8–2,4 с на трек (вместе), то есть около 5–10 % ко времени разделения.
- **Пик RAM** растёт на 234–394 МБ, в 2–3 раза больше оценки из раздела 5 (+110 МБ). Для ПК терпимо, для iPhone 12 это отдельный вопрос.
- **Диск:** около 0,34 МБ/с на один стем s16; drums+bass — около 0,68 МБ/с трека.
- Ресэмплирование не понадобилось: всё в 44,1 кГц. Чтение стемов плеером не измерялось.

### Звук: EQ-swap против swap по стему

| № | Оценка | Метод | Провал НЧ, дБ (eq / stem) | «Два баса», с | «Две бочки», с | Лимитер |
|---|---|---|---|---|---|---|
| 215 | хорошо | beatmatch 27,4 с | 38,8 / 37,2 | 0 / 0 | 0 / 0 | 0 / 0 |
| 216 | плохо | crossfade 9 с | 9,1 / 9,1 | 0 / 0 | 0 / **0,25** | 0 / 0 |
| 266 | плохо | beatmatch 25,6 с | 16,0 / 16,4 | 0,10 / 0,05 | 0,45 / **1,70** | 0 / 0 |

Что видно по профилям НЧ (шаг 0,5 с, `results.json` → `eqProfile`/`stemProfile`):

1. **Swap по стему почти не меняет звук этих планов.** Сам обмен баса в планах короткий: 0,4 с (№215), 2 с (№216), 1,6 с (№266). Примерно в тот же момент уходит громкость всей деки A. Поэтому неважно, чем срезан бас A.
2. **Провалы НЧ не от EQ.** В №215 «хорошей» пары провал −62 дБ длится около 1,5 с в обоих вариантах: НЧ A закончились раньше, чем в B вошли ударные и бас. Это свойство плана и музыки (B входит без ритма), а не способа обмена. Стем его не лечит.
3. **Цена стема видна сразу.** Маска баса не трогает бочку B, а полоса `low` её глушила. В №216 бочка B звучит с бочкой A на 0,25 с дольше, в №266 — на 1,25 с. До обмена стем убирает бас B чище, чем LR4 (−120 против −56…−90 дБ стема баса в №216).
4. **Решение (22.10.2026):** пользователь оставил текущую схему — вокальный стем + EQ для обмена баса. И2/И3/И4/И14 не делаются.
5. **Вывод.** Простая замена `low` маской стема без изменения плана пользы не даёт и добавляет «две бочки». Польза стемов возможна только с новой логикой плана: отдельная кривая для ударных (бочка B ждёт такт обмена), более долгое звучание инструментала A под B, петля ударных. Это нужно проектировать и проверять отдельно. Приоритет И3 в таблице снижается: польза не доказана.

### Порядок прослушивания

Файлы `data-dev/reports/stems4/<№>-eq.wav` и `<№>-stem.wav`: 4 с до перехода, переход, 6 с после. Слушать парами, сначала `eq`, потом `stem`:

1. **№216** (плохо, 9 с): первые 2–4 с перехода. Вопрос: слышна ли раньше бочка «4 am in London» в `stem`, и мешает ли она.
2. **№266** (плохо, 25,6 с): участок 0–13 с перехода, до обмена баса. Вопрос: две бочки в `stem` — «плотнее» или «каша».
3. **№215** (хорошо, контроль): около 13–16 с перехода. Вопрос: оба варианта звучат одинаково (ожидается да); слышна ли дыра в низах перед входом бита «КАРТА В БЛОКЕ».

Ограничения: 3 пары; ни одна не прослушана человеком; метрики «две бочки» и «два баса» опираются на стемы той же модели и наследуют её утечки; эффект параллельных процессов на время инференса не устранён.

## 9. Ограничения этого исследования

- Ничего не прослушано и не отрендерено. Все оценки пользы и цены экспертные.
- MixWeaver: доступны только название и авторы; рецензия не открылась.
- Время разделения на CPU (~17 с) взято из задачи и заметки сессии подготовки стемов (медиана 19,2 с на 39 стемах), прирост от сохранения drums/bass не замерялся.
- Сведения о Apple iOS 27 — из одного личного теста журналиста, не из документации Apple.

## Приложение А. Все 60 оценок

Версия analyzer — последняя готовая к моменту перехода (верхняя граница). Маски A/B — есть ли `vocalA`/`vocalB` в сохранённом плане. `forced` у всех оценённых — `false`.

| База | № | Пара | Метод | Оценка | Причина | planner | analyzer A / B | Маски A/B |
|---|---|---|---|---|---|---|---|---|
| dev | 202 | Платина feat. OG Buda MAYOT — Abu Dhabi Ba6y (1) → TAKETAKE — baby my type | tempo_bridge | bad | резко | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 204 | Madk1d feat. Greyrock & Tewiq — Martine Rose → ЦУЕФА, Вирсавия, Милана Некрасова, LIZOGUB, Давид Туров — Я ТЕБЯ МОГНУ | drop_mix | bad | сбился ритм | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 215 | Платина — Бандана → главный герой — КАРТА В БЛОКЕ | beatmatch_blend | good |  | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 216 | главный герой — КАРТА В БЛОКЕ → T-Fest — 4 am in London | tempo_bridge | bad | резко | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 220 | Mashups TikTok — giving girls → ЛСП — Бейби | echo_out | bad | сбился ритм | am-planner-16 | am-analyzer-8 / am-analyzer-8 | −/− |
| dev | 222 | Voskresenskii — Стиралка → kizaru — На работе | tempo_bridge | bad | сбился ритм | am-planner-16 | am-analyzer-8 / am-analyzer-8 | −/− |
| dev | 225 | Элджей — 1love → k1n1ch, itzice — Lin Ansty | tempo_bridge | bad | сбился ритм | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 226 | k1n1ch, itzice — Lin Ansty → Heronwater — 1ST DAY SMOKE | drop_mix | bad | резко | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 228 | Heronwater — 1ST DAY SMOKE → SODA LUV — Flatout | tempo_bridge | bad |  | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 229 | SODA LUV — Flatout → MAYOT — будешь моей | beatmatch_blend | bad |  | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 235 | Heronwater — ВЫПЕЙ ЗА МЕНЯ (Prod. by vlonekrystalll, Yugoki, Badyusya, Heronwater) → BLONDE SUPPERMACY — ANGELWITHNOWINGS | drop_mix | bad |  | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 236 | BLONDE SUPPERMACY — ANGELWITHNOWINGS → ROCKET — More | tempo_bridge | bad | голоса наложились | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 246 | Sundazer — Closer → GONE.Fludd — ПАЦАНЫ II | crossfade | good |  | am-planner-16 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 248 | Heronwater — Тайны → GONE.Fludd — HUMANSUIT | drop_mix | bad | резко | am-planner-17 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 249 | GONE.Fludd — HUMANSUIT → STOPBAN — Рано | crossfade | bad | резко | am-planner-17 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 252 | OG Buda — Вечно в Дороге → GONE.Fludd — Плохая Сука | tempo_bridge | bad |  | am-planner-17 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 253 | GONE.Fludd — Плохая Сука → Metric — Help I'm Alive | drop_mix | bad | резко | am-planner-17 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 255 | $undown — Stray (Slowed) → PHARAOH — В Прошлых Жизнях | tempo_bridge | good |  | am-planner-17 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 283 | королевский XVII — sadisfaction → Элджей — Антидепрессанты | crossfade | bad | резко | am-planner-v2-2 | am-analyzer-8 / am-analyzer-8 | −/− |
| dev | 313 | Yanix — Не говори им → OG Buda — Строчки о Бывших (prod. by rawrboooy) | beatmatch_blend | bad | голоса наложились | am-planner-v2-2 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 325 | 9mice — Anora → ayme.mp3 — RIDER | crossfade | bad | резко | am-planner-v2-4 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 332 | Soulzpurity — i dont need u → Clams Casino — All I Need | crossfade | good |  | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 333 | Clams Casino — All I Need → Элджей — 1094й | beatmatch_blend | good |  | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 336 | MAYOT — Чё я за тип? → Lil Peep — ghost boy | crossfade | bad | голоса наложились | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 353 | ROCKET — More → T-Fest — Браво | beatmatch_blend | bad | голоса наложились | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 364 | Yanix — Благословлён → New21plugg, Koshamind — Beautiful Dayy | beatmatch_blend | bad | резко | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 374 | Mellina Tey — Obsession (Sped Up) → Balu Brigada — Politix | beatmatch_blend | good |  | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 378 | Nextime, We Are Not Friends — stay → Heronwater — Блики | beatmatch_blend | good |  | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 389 | PHARAOH — В Прошлых Жизнях → ROCKET — She Wants | crossfade | bad | резко | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 393 | Heronwater — Тайны → madk1d — так похуй (ATMQ edit) | beatmatch_blend | bad | сбился ритм | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 396 | T-Fest — Иногда → Enzzy Beatz, segga — Ackelettah | beatmatch_blend | bad | сбился ритм | am-planner-v2-5 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 438 | Платина feat. Voskresenskii — Бассок → ROCKET — BOMB | beatmatch_blend | bad | сбился ритм | am-planner-v3-phrases-2 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 443 | Heronwater — 1ST DAY SMOKE → ROCKET — Panic Attacks | beatmatch_blend | bad | сбился ритм | am-planner-v3-phrases-2 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 449 | Voskresenskii — Стиралка → Lil Skies, Landon Cube — Red Roses (feat. Landon Cube) | beatmatch_blend | bad |  | am-planner-v3-phrases-2 | am-analyzer-8 / am-analyzer-8 | −/− |
| dev | 450 | Lil Skies, Landon Cube — Red Roses (feat. Landon Cube) → STOPBAN — Рано | crossfade | bad |  | am-planner-v3-phrases-2 | am-analyzer-8 / am-analyzer-8 | +/+ |
| dev | 485 | Darcy Gears — Savior → Metric — Help I'm Alive | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 486 | Brennan Savage — Reflection → Young Stoner Life, Karlae, Yung Bleu — Trance (feat. Karlae & Yung Bleu) | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 505 | Heronwater — Тайны → Lil Peep — Save That Shit | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 507 | Земфира — СОЗРЕЛА → Royal Blood — Figure It Out | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-10 | +/+ |
| dev | 508 | Royal Blood — Figure It Out → yaego, Kučka — ketamina - slowed | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-10 / am-analyzer-9 | +/+ |
| dev | 509 | yaego, Kučka — ketamina - slowed → Платина — Иней! | beatmatch_blend | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 510 | Платина — Иней! → Soulzpurity — i dont need u | crossfade | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 528 | ЛСП, Oxxxymiron — Мне скучно жить → Lil Peep, Lil Tracy — your favorite dress | beatmatch_blend | bad | голоса наложились | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 540 | Lil Peep, Lil Tracy — Awful Things → Дора — Младшая сестра | crossfade | bad |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 542 | ROCKET — Infinite Tsukuyomi → kizaru — PROBLEM CHILD | beatmatch_blend | good |  | am-planner-v5-drums-1 | am-analyzer-9 / am-analyzer-9 | +/+ |
| dev | 545 | T-Fest, Скриптонит — К чему это, не помню → August — Wake Up (Intro) | crossfade | bad |  | am-planner-v7-entry-grid-1 | am-analyzer-10 / am-analyzer-10 | +/+ |
| dev | 546 | Платина, BUSHIDO ZHO — В темноте → Juice WRLD, Lil Uzi Vert — Wasted | beatmatch_blend | bad |  | am-planner-v7-entry-grid-1 | am-analyzer-10 / am-analyzer-10 | +/+ |
| dev | 547 | Juice WRLD, Lil Uzi Vert — Wasted → True Widow — Theurgist | crossfade | bad |  | am-planner-v7-entry-grid-1 | am-analyzer-10 / am-analyzer-10 | −/− |
| dev | 549 | Playboi Carti, The Weeknd — RATHER LIE → PHARAOH — Белые Нити (Незабываема) | crossfade | bad |  | am-planner-v7-entry-grid-1 | am-analyzer-10 / am-analyzer-10 | −/− |
| dev | 550 | PHARAOH — Белые Нити (Незабываема) → Lil Skies — Dead Broke | beatmatch_blend | good |  | am-planner-v7-entry-grid-1 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 230 | Платина — Бандана → OG Buda — Крит (feat. Toxi$) | beatmatch_blend | bad | резко | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 231 | BUSHIDO ZHO — Rock → Платина — Гикаю | beatmatch_blend | bad | голоса наложились | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 234 | madk1d — заправка → Scally Milano, uglystephan — Туда Сюда Миллионер | crossfade | bad |  | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | +/− |
| installed | 242 | OG Buda — Для Тебя (Пусто) (prod. by rawrboooy, holdupnelly & sxber) → LIL KRYSTALLL — BB | beatmatch_blend | bad | голоса наложились | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 243 | LIL KRYSTALLL — BB → PHARAOH — На Крышах | crossfade | bad | голоса наложились | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 250 | Heronwater — 1ST DAY SMOKE → SODA LUV — Бехелит | beatmatch_blend | bad |  | am-planner-v11-dj-4 | am-analyzer-10 / am-analyzer-10 | −/− |
| installed | 256 | Voskresenskii, Платина — Быть богатым → ROCKET — Money | crossfade | bad |  | am-planner-v11-dj-5 | am-analyzer-11 / am-analyzer-11 | +/− |
| installed | 259 | TAKETAKE — baby my type (feat. GATASKI) → Heronwater, BUSHIDO ZHO — Дай мне посмотреть | crossfade | bad | резко | am-planner-v11-dj-5 | am-analyzer-11 / am-analyzer-11 | +/− |
| installed | 266 | ROCKET — LUV → madk1d, VILLIAN — 8 миля | beatmatch_blend | bad | резко | am-planner-v11-dj-6 | am-analyzer-11 / am-analyzer-11 | −/+ |
| installed | 269 | Платина — Бетховен (feat. Scally Milano) → PHARAOH — Caramel | beatmatch_blend | bad | резко | am-planner-v11-dj-6 | am-analyzer-11 / am-analyzer-11 | +/− |
