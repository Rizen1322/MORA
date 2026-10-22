# Сторонние компоненты в сборке MORA для Windows

| Компонент | Лицензия | Где |
| --- | --- | --- |
| Electron 44.9.2 (Chromium, Node.js 24) | MIT; Chromium — BSD и др., см. `LICENSES.chromium.html` рядом с MORA.exe | приложение |
| FFmpeg 9.0.2, сборка BtbN `win64-lgpl-shared` | LGPL v3 (собрана с `--enable-version3`, без GPL-компонентов и без x264/x265) | `resources/ffmpeg` (`LICENSE.txt`, `SOURCE.txt` — ссылка на исходники и SHA-256) |
| yt-dlp 2026.08.19, официальная сборка `yt_dlp_win.zip` | Unlicense; встроенные компоненты PyInstaller-сборки — см. THIRD_PARTY_LICENSES.txt проекта yt-dlp | `resources/yt-dlp` (`SOURCE.txt` — ссылка и SHA-256) |
| Fastify, @fastify/static, music-metadata и их зависимости | MIT / ISC / BSD | `resources/backend/backend.mjs.LEGAL.txt` |
| React, zustand, three.js, Phosphor Icons | MIT | интерфейс |
| Шрифты Onest, Unbounded (@fontsource-variable) | SIL OFL 1.1 | интерфейс |

FFmpeg вызывается как отдельный процесс и подключает свои DLL динамически; его можно заменить своей сборкой той же версии API, положив файлы в `resources/ffmpeg`.

Начиная с 0.3.0 входит автономный CPU-комплект: CPython 3.12.10 (PSF License), PyTorch/Torchaudio 2.7.1 (BSD), NumPy 2.2.6 (BSD) и HDEMUCS_HIGH_MUSDB_PLUS из официального выпуска Torchaudio. Лицензия Python находится в `resources/vocal/LICENSE.txt`, тексты лицензий зависимостей — в `resources/vocal/Lib/site-packages/*dist-info`. Версии и SHA-256 модели/интерпретатора находятся в `resources/vocal/pack.json`. Зависимости модели и NOTICE сохранены в комплекте. Веса получены с https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt; архитектура Demucs — https://github.com/facebookresearch/demucs (MIT).

MelBand-RoFormer, Whisper, CUDA-runtime и модели распознавания речи в этот CPU-комплект не входят. Их можно использовать отдельно через внешний Python; обычная подготовка вокала от них не зависит.

## Онлайн-сервисы без аккаунта

- YouTube / YouTube Music и SoundCloud: поиск и получение публичных записей через yt-dlp и публичный веб-endpoint YouTube Music. Неофициально; условия сервисов ограничивают скачивание и переработку — для личного прослушивания.
- LRCLIB (https://lrclib.net): тексты песен, только по действию «Текст». Запросы содержат название, исполнителя, альбом и длительность.
- Spotify / Apple Music: только чтение публичных страниц плейлистов и альбомов (метаданные) при импорте. Звук из этих сервисов не берётся.

## Уведомление: идеи и форма запросов из Riff

Часть подходов (запрос поиска YouTube Music `WEB_REMIX` с фильтром песен, радио `/next`, чтение данных страниц Spotify embed и Apple Music, получение аудио через yt-dlp, LRCLIB) адаптирована по проекту Riff. Код написан заново под архитектуру MORA.

Riff — MIT License. Изучены commits add6843dc57cc86a93a1692c8c339bba4f9099c2 и 062c0f62539cda7ade077fd3e9b0eda0b1928925. https://github.com/rootscripts/riff

MIT License

Copyright (c) 2026 rootscripts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
