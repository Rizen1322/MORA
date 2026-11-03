# MORA 0.3.22 — Windows

28 октября 2026. Стабильный Windows x64 релиз опубликован: https://github.com/Rizen1322/MORA/releases/tag/v0.3.22. Проверено, что это GitHub latest, не draft и не prerelease. PublishedAt: 2026-10-28T13:53:50Z.

Выпуск включает поддержку локально сохранённых оценённых переходов с привязкой к двум записям и настройкам, отмену конкретного сохранённого варианта новым дизлайком, перепроверку фактического участка после drum-shift, защиту альтернатив от новых конфликтов и исправление диагностики петлевых планов.

Разделение вокала не включено. Stable packaging задаёт VITE_TRANSITION_EDITOR=0; отсутствие пункта экспериментального редактора проверено в упакованном web JS. Новые экспериментальные петли не включены общим автоматическим правилом. Личный каталог не вошёл в ресурсы/установщик: он остаётся в пользовательском dataDir. Упакованный backend содержит только универсальный загрузчик и не содержит хешей личных аудиозаписей. В resources нет vocal, tools или reviewed-transitions.json.

## Артефакты

- MORA-Setup-0.3.22.exe — 169011855 байт.
- SHA-256: `91ff17403549c4f72db5c8e214b904106f7aa69e8070e800f3059687ce969ae5`.
- SHA-512: `0SsSVFcclmMIJz6ErkEBXW+19M/rzvogr92ZRx36RtSa8a5nRPr1MIMlxG4PopClPJAsYzoostY3azK7agCouQ==`.
- Дополнительные файлы: installer.blockmap, installer.sha256, latest.yml.

verify-release подтвердил версию0.3.22 приложения в app.asar, electron-updater6.8.9, каналRizen1322/MORA, размер и обе SHA-512 ссылки в latest.yml. Перед публикацией все четыре загруженных GitHub asset digest/размера совпали с локальными. Снимок: data-bench-results/release-0.3.22/upload-verified.json. Версии desktop/package.json и package-lock.json согласованы.

## Проверки

Последний полный прогон разработки: 141 файл,1125 тестов. Перед упаковкой дополнительно прошли36 release-related тестов в10 файлах (desktop, reviewed transitions, rhythm diagnostics). Общий TypeScript и сборки ранее прошли; packaging заново собрал web и desktop backend.

Обычная проверка упакованного сервера выполнена внутри Electron44.9.2 в отдельном профиле, без системных Node/Python/FFmpeg на PATH: YouTube Music/SoundCloud поиск, каталог, warmup без изменения медиатеки профиля, подготовка трека, обложка, полный PCM-блок65536 байт. health подтвердил отсутствие вокального runtime. Результат: data-bench-results/release-0.3.22/backend/report.json, ok=true.

Дополнительная packaged-проверка создала отдельную БД с восемью нужными публичными track/analysis-записями и четырьмя сохранёнными планами, без аккаунтов/credentials/рабочего кэша. По HTTP /api/automix/plan упакованный backend вернул точные аудиопараметры всех четырёх планов:185/204 с петлями,212/189 без петель; pending пуст. Результат: data-bench-results/release-0.3.22/reviewed-backend/report.json, ok=true. Скрипт: apps/desktop/scripts/check-reviewed-backend.mjs. Его запуск исправлен на async run() без блокирующего app-ready top-level await; это изменение только тестового harness, не приложения.

Рабочая медиатека не использовалась как профиль этих запусков и не менялась. Установленное приложение не запускалось/не обновлялось агентом.

## Происхождение сборки

Собрана текущая рабочая копия с сохранением существовавших незакоммиченных изменений; массового commit/reset не выполнялось. GitHub tag target — существующий ios SHA `ddb8bf8abbe06e81ef157d22d2d58e6d31b64a20`, как в предыдущем процессе ручного бинарного выпуска. Этот target не заявляется снимком всех исходников бинарной рабочей сборки. Релизные assets проверены по фактическим байтам.
