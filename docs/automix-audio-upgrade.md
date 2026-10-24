# Фактические границы вокальных fade — 20 октября 2026

Продолжение существующего тракта, включая lyrics/bleed guard. Исправление
находится в `packages/core/src/plan/vocals.ts`; регрессии — в
`packages/core/test/DJplanning.test.ts`.

## Подтверждённый дефект

При выборе кандидата открытие B оценивалось как 120 мс, а применённый мягкий
fade мог длиться 300 мс. Поэтому найденная короткая пауза не гарантировала,
что первая атака после неё будет полностью открыта. Аналогично проверка
короткого окна ухода A могла затем превратиться в fade до 450 мс и затронуть
предыдущее слово.

`fitFadeInBreath` ограничивает фактическую длительность fade известной паузой
возле уже выбранной точки передачи. Используются проверенные word timestamps,
а при их отсутствии — акустические фразы с confidence не ниже 0,35.
Границы переводятся между исходными и выходными секундами через интеграл
tempo map и его обратное отображение, включая ненулевые cues.

Для A оставлен запас 15 мс после предыдущего слова/фразы, для B — 35 мс
до следующей атаки. Когда доступно менее 20 мс либо точка находится внутри
слова/фразы, остаётся прежний мягкий fallback. Это исправление не обещает
сохранить каждое слово при непрерывном одновременном пении двух треков.
Диагностика `debug.stems.fadeA/fadeB` показывает применённые длительности.

Также проверяется допустимость lyrics: конечная confidence в диапазоне
0,6–1, упорядоченные неперекрывающиеся слова и строки внутри трека.
Недопустимые timestamps не участвуют в выборе границ.

## Проверки текущего рабочего дерева

20 октября, повтор после передачи работы между агентами:

```powershell
npx vitest run packages/core/test/DJplanning.test.ts packages/core/test/lyrics-handoff.test.ts packages/core/test/vocal-handoff.test.ts packages/core/test/vocal-dsp.test.ts packages/core/test/realtime-dsp.test.ts
npm run typecheck
```

Результат: **79/79**, пять файлов; typecheck core/server/web — exit 0.
Численная регрессия рендерит первый слог B при 44,1 и 48 kHz с маской
и без неё: максимальная абсолютная разница PCM менее `1e-6`.
Контрольный старый fade 300 мс даёт разницу более `0.02`.
В исправленном рендере нет underruns. Отдельная регрессия проверяет границы
обеих дек при tempo glide и ненулевых входах.

Существующий локальный отчёт
`data-dev/reports/vocal-fade-boundaries-review.json` сравнивает повторное
декорирование 552 сохранённых планов baseline-v10: маски изменились в 161 паре.
Это оценка распространённости изменения, не 552 аудиорендера и не чистый
контроль одной функции: повторное декорирование может менять диагностику.

## Сохранённые контракты и ограничения

В этом исправлении не менялись DSP, Demucs, зависимости, ceiling лимитера,
сервер и пользовательская медиатека. Сохраняются вычитание original-minus-voice
до одного WSOLA, точная калибровка маски и отдельные chunk cursors,
sample-clock deadline эха, generation pin/reset ACK и float PCM original
server-to-worklet. Их предыдущие проверки описаны в `vocal-dsp-v4.md`,
`vocal-handoff-v3.md` и `pcm-headroom-fix.md`.

Численный тест изолирует маску на синтетическом слоге. Реальные утечки
разделителя, ошибки ASR, backing vocals и восприятие короткого fade этим
не измеряются. В этом этапе аудио не прослушивалось. Перед окончательной
оценкой качества нужны одинаковые реальные пары baseline/fixed с короткими
паузами, особенно при tempo glide; сравнивать следует и первый слог B,
и последний слог A, и побочный эффект bleed guard на инструменты.
Интеграция должна обновить общую версию планировщика, чтобы кэш не сохранял
старые длительности fade.

## Продолжение Sol: короткие паузы при непрерывной фразе

Подтверждён ещё один дефект: сетка поиска 50 мс может целиком пройти мимо
42-миллисекундной паузы между словами. Даже достоверные ASR timestamps тогда
не помогали: A получал мягкий fade через хвост слова, B — fade через атаку.
Теперь к прежней сетке добавлены точные кандидаты внутри проверенных пауз
между словами/акустическими фразами. Они рассчитаны в выходном времени через
интеграл tempo map, с прежними запасами 15/35 мс и минимумом fade 20 мс.
Скоринг проверяет фактический короткий fade, который помещается в эту паузу.
Для A проверка пересечения слова допускает только 1 мс численной погрешности.
Для B чистая граница получает небольшой бонус 0,1, меньше цены одного
потерянного слова 0,12; прежний компромисс при действительно непрерывном пении
сохранён. Маски не пересекаются, DSP/WSOLA/лимитер/формат PCM не менялись.

В `lyrics-handoff.test.ts` четыре новые регрессии: 44,1/48 kHz, обычный темп
и glide с ненулевыми cues. Синтетические хвост A и атака B совпадают с PCM
без маски с максимальной ошибкой `<1e-6`, underruns 0. При запуске того же
нового теста против сохранённой копии функции до Sol обе проверки без glide
падают: fade A начинается в 0,223 с вместо паузы после 0,401 с.
Пять целевых файлов — **83/83**, `npm run typecheck` — exit 0.

Изолированный реальный AB:
`data-dev/reports/sol-vocal-real-ab.json`, WAV в
`data-dev/reports/previews/sol-vocal-ab/`.
Пара **FATHER → Благословлён**, один сохранённый план, одинаковые settings,
original float PCM и текущие закреплённые stem revisions; content hash и
revision сверены со snapshot. Меняется только декоратор вокала.
Открытие B: baseline **7,400–7,520 с**, fixed **7,350–7,402 с**.
Пересечение fade с первым ASR-словом: **79 мс → 0**. Оба рендера конечны,
без underruns; peak 0,8324, limiter reduction 0 dB. Это численная и
воспроизводимая аудиопроверка, **прослушивание не выполнялось**.

Повторная декорация одинаковых 552 сохранённых планов:
`data-dev/reports/sol-vocal-boundaries-review.json`. Меняются 183 маски;
суммарное пересечение fade/ASR words уменьшается в 33 парах для A и 58 для B.
Для B оно не увеличивается, для A увеличивается в одной паре
«Иногда → Я ТЕБЯ МОГНУ»: 0 → 448 мс, зато B открывается раньше и сохраняет
два слова. В семи парах счётчик потерянных слов B растёт, в двух уменьшается.
Это сохраняющийся компромисс ранней передачи/целой фразы, **не доказательство
глобального улучшения на слух**. Один проход сравнения декораторов занимает
примерно 0,86–0,99 с baseline и 1,68–1,71 с fixed для 552 пар; это настольный замер,
не бюджет AudioWorklet. В worklet новая логика не выполняется.

В snapshot обнаружены подозрительно длинные ASR-«слова»: 27,28 с у
«На Крышах», 15,42 с у «Зависима», 12,74 с у STORM II. Одна track-level
confidence не доказывает точность каждой границы. Эти данные не переписаны
и новый inference не запускался; следующему этапу нужны локальная оценка
надёжности word timings и прослушивание нескольких спорных handoffs.
При паузах меньше 20 мс после запасов или отсутствии пауз сохраняется
мягкий fallback; сохранить каждое слово двух непрерывных партий невозможно.

Музыкальный принцип независимой передачи stems подтверждён
[руководством Native Instruments](https://blog.native-instruments.com/how-to-mix-stems/),
а отдельный вокальный echo-out описан в
[официальном Serato Using Stems](https://support.serato.com/hc/en-us/articles/5700921209615-Using-Stems).
Это источники приёмов, а численные пороги и реализация — решения проекта.
Добавлять новые эффекты в DSP ради разнообразия без подтверждённой проблемы
в этом продолжении не потребовалось.


## Агент 1, 20 октября: надёжность ASR-границ и слияние с измеренным голосом

### Найденная регрессия предыдущего этапа

Независимая проверка по огибающей выделенного голоса (20 мс RMS с шагом 10 мс,
24 трека с `lyrics.json`, CPU, без inference) показала, что Whisper-границы на пении
не годятся для правок с точностью до десятков миллисекунд:

| Интервал | n | медиана, dB от p95 | тише −25 dB |
|---|---|---|---|
| ASR-«пауза» 60–250 мс | 561 | −5,8 | 7% |
| ASR-«пауза» 0,25–0,7 с | 167 | −10,2 | 20% |
| ASR-«пауза» ≥ 0,7 с | 169 | −16,8 | 35% |
| пауза акустических фраз ≥ 0,3 с | 346 | −32,6 | 67% |

В 77% коротких ASR-пауз нет тихого участка ≥ 30 мс даже в ±150 мс. Начала слов
Whisper относительно энергетических атак: IQR −90…+130 мс, в ±40 мс лишь 21%.
Поэтому точные кандидаты коротких пауз и допуск 1 мс опирались на ненадёжные
данные, а результат «79 мс → 0» измерен против тех же ASR-слов, то есть по кругу.
Длинные «слова» (27,28 / 15,42 / 12,74 с) — это непрерывное пение без выданных слов
(покрытие активностью 0,87–0,98) либо, наоборот, слово поверх тишины (6,76 с при
покрытии 4%).

### Изменения

- `packages/core/src/plan/vocals.ts`: `LyricTiming` получил `edit` (интервалы,
  которых не должна касаться правка) и `verified`. Без измерения по stem пауза
  требует согласия ASR и измеренных фраз (`edit` = объединение слов и фраз
  с confidence ≥ 0,35). ASR больше не поднимает `aGap/bGap` и не даёт бонус
  чистой границы там, где измерение показывает пение. «Слова» длиннее 1 с
  ограничиваются измеренной активностью внутри них. Слова по-прежнему используются
  для счёта потерянных слов и строк. Диагностика: `debug.stems.cleanA/cleanB`
  (окно fade вне пения), `lyrics.verifiedA/verifiedB`.
- `tools/transcribe-vocals.py`: `voice_envelope` + `voiced_spans` — интервалы
  звучащего голоса по stem с шагом 10 мс. Тишина — ниже −24 dB от локального
  максимума ±1 с либо ниже −28 dB от p95 трека (утечка в инструментальных
  проигрышах: измеренный p90 около −30 dB). Тихий участок ≥ 30 мс делит голос, если
  он ≥ 0,2 с или лежит в пределах 150 мс от границы слова Whisper. Короткие закрытия
  взрывных внутри слова остаются голосом. Новые транскрипции пишут
  `timing: 'stem-verified-1'` и `voiced`. Режим `--verify-only LYRICS.json` дополняет
  существующую транскрипцию без модели (~0,1 с на трек, CPU). LYRICS_VERSION не менялся,
  поэтому повторного Whisper по библиотеке не будет.
- `packages/core/src/types.ts`, `apps/server/src/stems.ts` (согласовано с Агентом 2):
  опциональные `lyrics.timing`/`lyrics.voiced` и их проброс. Старые файлы валидны.
- Тесты: в `lyrics-handoff.test.ts` прежние синтетические точные паузы помечены как
  измеренные. Новая регрессия проверяет, что пауза только по Whisper поверх
  измеренного пения не используется, и обрезку 27-секундного «слова».
  `tools/test-separate-vocals.py` проверяет `voiced_spans`: реальная пауза 80 мс при
  смещённой ASR-границе, закрытие 40 мс внутри слова, проигрыш с утечкой −32 dB.

Существующие lyrics.json в кэше НЕ переписывались. Проверенные копии для эксперимента:
`data-dev/reports/agent1-lyrics-verified/<hash>.json`.

### A/B: 552 сохранённых плана v10, меняется только декоратор вокала

`data-dev/reports/agent1-vocal-matrix.json`. «Пение» — огибающая stem ≥ −24 dB.
Оговорка: verified-вариант использует ту же огибающую, что и метрика, поэтому
приведены и метрики по 10-Гц активности Demucs, которые от неё не зависят.

| Метрика (552 пары) | baseline | current, сырые ASR | current, verified |
|---|---|---|---|
| A: короткий fade (<0,1 с) по звучащему голосу | 347 | 158 | 2 |
| то же по активности Demucs ≥ 0,5 (независимая) | 202 | 1 | 2 |
| B: короткий fade по звучащему голосу | 59 | 25 | 0 |
| оба окна fade в тишине голоса | 53 | 86 | 207 |
| мягкий fade ≥ 0,1 с по голосу A (честный fallback) | 69 | 227 | 228 |
| потерянный голос B до открытия, с (активность Demucs) | 333,9 | 309,6 | 308,7 |
| потерянные слова B (ASR-счёт) | 940 | 927 | 906 |
| потерянные слова A (ASR-счёт) | 928 | 889 | 975 |

Улучшилось не всё: потерянный голос B уменьшился в 147/154 парах, но вырос в
90/106. Для verified в 57 парах больше потерянных слов A, потому что A чаще
заканчивается раньше, в реальной паузе. Мягкий fade по пению вместо резкого обрыва
выбран осознанно, но звучание не прослушивалось. Время декоратора на 552 пары: 3,2 с
baseline, 2,7 с raw, 2,9 с verified (настольный замер; в worklet не выполняется).

### Реальные PCM-рендеры (не прослушаны)

`data-dev/reports/agent1-vocal-real-ab.json`, WAV в
`data-dev/reports/previews/agent1-vocal-ab/`. Одинаковые план, settings, original f32
и закреплённые stem revisions. Дополнительно каждая дека отрисована только голосом
(original заменён stem), чтобы измерить одновременное звучание двух голосов.

| Пара | baseline / verified | голос A → 0, с | голос B открыт, с | голос B в рендере, с | оба голоса > −30 dB, с |
|---|---|---|---|---|---|
| FATHER → Благословлён | | 7,315 / 6,165 | 7,402 / 7,52 | 2,13 / 2,14 | 0 / 0 |
| angel's tears → Благословлён | | 11,10 / 9,70 | 13,97 / 9,82 | 0,02 / 2,06 | 0 / 0 |
| Валентина → Грустно+весело | | 0,771 / 0,771 | 2,069 / 1,15 | 7,87 / 8,97 | 0 / 0 |

Во всех девяти рендерах (включая raw) значения конечны, underruns 0, limiter 0 dB,
пики практически не изменились (0,8324; 0,7246→0,7236; 0,6066). Во второй паре B
сохраняет два слова, но A уводится мягким fade 0,45 с по пению.

### Разделение: окружение и альтернативы

RTX 3070 8 ГБ, torch 2.7.1+cu118. Production — torchaudio `HDEMUCS_HIGH_MUSDB_PLUS`,
медиана 14,8 с на трек ~162 с (CUDA, 2 shifts). Локально нет весов RoFormer/SCNet;
в `data-dev/cache/models/melband` есть только код Mel-Band RoFormer без checkpoint.
По таблице ZFTurbo Music-Source-Separation-Training (`docs/pretrained_models.md`,
Multisong, vocals SDR): Mel-Band RoFormer (Kim) 10,98, BS-RoFormer (viperx) 10,87,
HTDemucs4 8,4–8,8, то есть около +2 dB для голоса. Лицензии весов в таблице не указаны,
их нужно проверить по карточкам моделей. Скачивание весов (сотни МБ) требует разрешения
пользователя, поэтому сравнение моделей на треках не проводилось, production-модель
не менялась. Следующий шаг после разрешения: 3–4 трека (рэп, тихое пение,
реверберация, плотный микс), одинаковые метрики утечки в проигрышах и `voiced_spans`,
время/VRAM, fallback на HDemucs.

### Непрерывное пение

Без измеренной паузы правки не изобретаются: остаются мягкий fade и bleed guard.
`cleanA=false && cleanB=false` отмечает такие планы. Предложение для планировщика
(Агент 2): если оба флага false в длинном beatmatch, повторить поиск момента передачи
на ближайших измеренных паузах A (конец фразы ±8 тактов), сохраняя вход B, как в
существующем `vocalBudget`. Это не реализовано.

### Воспроизведение

```powershell
npx vitest run packages/core/test/DJplanning.test.ts packages/core/test/lyrics-handoff.test.ts packages/core/test/vocal-handoff.test.ts packages/core/test/vocal-dsp.test.ts packages/core/test/realtime-dsp.test.ts
python -I tools/test-separate-vocals.py
npm run typecheck
# проверенная копия (кэш не меняется):
python -I tools/transcribe-vocals.py --stem-dir data-dev/cache/stems/<hash>/hdemucs-v1 --verify-only data-dev/cache/stems/<hash>/hdemucs-v1/lyrics.json --output data-dev/reports/agent1-lyrics-verified/<hash>.json
npx tsx tools/.cache/agent1/vocal-matrix.ts <env.json> data-dev/reports/agent1-vocal-matrix.json
node tools/.cache/agent1/matrix-summary.mjs
npx tsx tools/.cache/agent1/vocal-real-ab.ts
```
`env.json` содержит огибающие `voice_envelope` 24 stem (временный скрипт в scratchpad,
не в репозитории). Baseline-декоратор — `tools/.cache/agent1/vocals-baseline.ts`
(копия до этого этапа).


### Разделение: первичные источники (повтор веб-исследования, 20 октября)

Веса не скачивались. Числа SDR — из опубликованных таблиц, не наши измерения.
Основной источник сравнения — `docs/pretrained_models.md` репозитория
[ZFTurbo/Music-Source-Separation-Training](https://raw.githubusercontent.com/ZFTurbo/Music-Source-Separation-Training/main/docs/pretrained_models.md)
(код MIT). Multisong — его собственный набор для оценки; MUSDB18-HQ test — стандартный.

| Модель | vocals SDR | Checkpoint (URL) | Размер | Лицензия кода / весов |
|---|---|---|---|---|
| **текущая** torchaudio `HDEMUCS_HIGH_MUSDB_PLUS` | нет честного числа: по [документации torchaudio](https://docs.pytorch.org/audio/2.7.0/generated/torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.html) модель обучена на train **и test** MUSDB-HQ + ~150 внутренних песен | уже есть: `data-dev/cache/models/hub/torchaudio/models/hdemucs_high_trained.pt` | ~320 МБ | Demucs MIT; отдельная лицензия весов не указана |
| HTDemucs4 FT vocals (официальная) | 8,38 | https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/04573f0d-f3cf25b2.th | не проверен | код MIT ([README Demucs](https://raw.githubusercontent.com/facebookresearch/demucs/main/README.md)); веса без отдельной лицензии |
| HTDemucs4 (MVSep fine-tune) | 8,78 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.0/model_vocals_htdemucs_sdr_8.78.ckpt | не проверен | MIT (репозиторий); веса не указаны |
| MDX23C vocals | 10,17 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.0/model_vocals_mdx23c_sdr_10.17.ckpt | не проверен | MIT (репозиторий); веса не указаны |
| SCNet Large (starrytong), 4 stem | 10,94 MUSDB / 9,05 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.9/SCNet-large_starrytong_fixed.ckpt | 168 852 258 Б | код [SCNet](https://raw.githubusercontent.com/starrytong/SCNet/main/README.md) MIT; веса не указаны. [arXiv:2401.13276](https://arxiv.org/abs/2401.13276): CPU-время 48% от HT Demucs |
| SCNet XL IHF, 4 stem | 11,42 MUSDB / 9,68 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.15/model_scnet_ep_36_sdr_10.0891.ckpt | не проверен | MIT (репозиторий) |
| BS-RoFormer, 4 stem (MUSDB only) | 11,08 MUSDB / 9,19 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.12/model_bs_roformer_ep_17_sdr_9.6568.ckpt | не проверен | MIT (репозиторий) |
| BS-RoFormer (viperx 1297) | 10,87 Multisong | https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt | 639 331 213 Б | код [lucidrains/BS-RoFormer](https://github.com/lucidrains/BS-RoFormer) MIT; у репозитория весов лицензия **не найдена** (API: 404) |
| Mel-Band RoFormer (viperx) | 9,67 Multisong | https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt | 1 007 816 988 Б | веса без лицензии |
| **Mel-Band RoFormer (Kimberley Jensen)** | **10,98 Multisong** | https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt | **913 МБ** | карточка модели: **MIT** |
| BS PolarFormer (fp16) | 11,00 Multisong | https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.20/model_bs_polarformer_float16.ckpt | не проверен | MIT (репозиторий) |

Статьи-первоисточники: BS-RoFormer — [arXiv:2309.02612](https://arxiv.org/abs/2309.02612): 9,80 dB в среднем
без дополнительных данных (малая версия), первое место SDX23 с дополнительными данными.
Mel-Band RoFormer — [arXiv:2310.01809](https://arxiv.org/abs/2310.01809): по аннотации превосходит
BS-RoFormer на вокале, барабанах и «other». Числа SDR по вокалу на странице аннотаций не приведены.

**Совместимость с `data-dev/cache/models/melband/`.** Там лежит `mel_band_roformer.py` из
репозитория ZFTurbo и `pylib` (beartype 0.23.1, rotary_embedding_torch 0.9.1). Параметры конструктора
(`stereo`, `num_stems=1`, `num_bands=60`, `dim_head=64`, `flash_attn`, `stft_n_fft=2048`) совпадают
с конфигом `configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml`: dim 384, depth 6,
heads 8, hop 441, chunk 352 800 (8 с), inference overlap 2, batch 4. Не хватает:
`models/bs_roformer/attend.py` (импорт падает), самого yaml и checkpoint. `pylib` нужно добавлять в
`sys.path`. einops, librosa и yaml в Python окружения есть; beartype и rotary_embedding_torch
системно не установлены, они только в `pylib`. Загрузка state dict Kim-checkpoint этим кодом **не проверена**.

**VRAM/скорость на RTX 3070 8 ГБ не измерены:** без весов это невозможно, а опубликованных цифр
для этой карты в первоисточниках нет. Ориентиры: README Demucs называет ~7 ГБ при аргументах по
умолчанию и ≥3 ГБ при `--segment 8`. Наш HDemucs: медиана 14,8 с на трек ~162 с (CUDA, 2 shifts).
RoFormer считаются заметно тяжелее HDemucs. Для 8 ГБ стоит начать с batch 1, fp16, chunk 8 с;
это гипотеза, её проверяет первый же запуск.

**Рекомендация.** Первый кандидат — Mel-Band RoFormer (Kim): лучший вокальный SDR в таблице
среди моделей с явной лицензией весов (MIT), код уже частично на месте, вывод один stem
(vocals), то есть ложится в существующий формат `vocals.s16`. Запасные варианты: SCNet Large
(169 МБ, MIT-код, заявлен быстрый CPU-вывод) и BS-RoFormer viperx (лицензия весов не найдена,
для production не брать до выяснения). Production HDemucs не трогать, пока нет измеренного выигрыша.

**Что нужно для ограниченного A/B на 3–5 треках:**
1. Разрешение пользователя на загрузку `MelBandRoformer.ckpt` (913 МБ, MIT) и конфига
   KimberleyJensen (yaml, единицы КБ) плюс недостающего `attend.py` из того же MIT-репозитория.
   Положить в `data-dev/cache/models/melband/`, а не в кэш stems.
2. Отдельный скрипт вывода в `data-dev/reports/sep-ab/<hash>/` (кэш stems не менять), объявленный в
   координационном файле, без параллельных GPU-задач. 3–5 треков: рэп (Кровосток / «Чё я за тип?»),
   тихое пение, реверберация (angel's tears), плотный микс (STORM II), непрерывный вокал (На Крышах).
3. Метрики одинаковые для HDemucs и RoFormer: время и пиковая VRAM
   (`torch.cuda.max_memory_allocated`); утечка голоса в проигрышах (p90 огибающей stem в паузах
   фраз ≥2 с; сейчас медиана −30 dB, у 10% пауз выше −15 dB); число и тишина `voiced_spans`;
   остаток голоса в `original − vocals` на участках пения (через `tools/voice-leak.ts`);
   офлайн PCM-рендер двух-трёх переходов из матрицы с обоими stems.
4. Fallback: при ошибке, нехватке VRAM или худших метриках остаётся HDemucs. Замена в production
   — только отдельным решением со сменой `version` stem и согласованием с Агентом 2.
