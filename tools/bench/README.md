# MORA vocal benchmark

Диагностический набор для Windows-ПК с репозиторием MORA. Production-код не меняет: только снимает метрики и запускает `tools/separate-vocals.py` в отдельные каталоги.

## Файлы

- `stage0-runtime.ps1` — снимок `desktop.json`, `pack.json`, bundled Python/Torch, процессов и самого свежего `metadata.json`.
- `bench-api.ps1` — задержка `POST /api/analysis/focus` → наблюдаемое `running` → `ready` для одного трека.
- `bench-vocals.py` — запускает `tools/separate-vocals.py` на фиксированном наборе файлов, пишет логи и CSV. Первый прогон на каждый трек — warm-up.

## Две поправки к методике

1. `metadata.seconds` — **не** полное время обработки. В `tools/separate-vocals.py` это `time.monotonic() - started`, зафиксированное **до** `vocal_activity` и до записи файлов/метаданных. Полное время процесса — только `wall_seconds` в `bench-vocals.py`.
2. Сначала сравнивать одинаковые режимы: **CPU shifts=1 против CUDA shifts=1**. Только потом отдельно CUDA shifts=2. Иначе разница между GPU и числом проходов смешивается.

## 0. Проверка установленного runtime

Запускать, пока новый uncached-трек реально обрабатывается:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\bench\stage0-runtime.ps1 -OutputPath "$env:TEMP\mora-bench\stage0-runtime.txt"
```

Ожидание для установленной 0.3.10: `desktop.json` → `stemsPython: null`; `pack.json` → `torch 2.7.1+cpu`; bundled Python → `cuda_available: False`; свежий `metadata.json` → `device: cpu`, `shifts: 1`. Путь живого процесса должен быть `...\Programs\MORA\resources\vocal\python.exe`, а не системный `Python312`.

## 1. Очередь и API

Стенд с bundled CPU, без токена, отдельный профиль:

```powershell
$env:AUTOMIX_DATA_DIR='data-bench'
$env:PORT='4732'
$env:STEMS_PYTHON=''          # пустая строка блокирует .env
$env:STEMS_CACHE_MB='1024'
$env:ACCESS_TOKEN=''
node --import tsx apps/server/src/index.ts
```

Для CUDA-ветки — `data-bench-cuda`, порт 4733 и `STEMS_PYTHON=C:/Users/Rizen/AppData/Local/Programs/Python/Python312/python.exe`; модель скопировать из `data-dev/cache/models`, чтобы не скачивать.

Демо-треки и импорт:

```powershell
npm run demo:tracks
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4732/api/import/folder `
  -ContentType 'application/json' `
  -Body '{"path":"E:\\вин\\ПРОЕКТЫ\\music\\examples\\library"}'
```

Тело focus — реальная схема из `apps/server/src/routes/playback.ts`:

```json
{"current":"<trackId>"}
```

или полный сценарий:

```json
{"current":"<currentId>","next":["<nextId>"],"candidates":["<id1>","<id2>"]}
```

Замер:

```powershell
.\tools\bench\bench-api.ps1 -BaseUrl 'http://127.0.0.1:4732' `
  -FocusBodyFile '.\focus-body.json' -TrackId '<REAL_TRACK_ID>' `
  -OutputPath "$env:TEMP\mora-bench\api-current.json"
```

`T_queue_ms` считается от старта клиентского замера до первого **наблюдаемого** `running`, то есть включает HTTP и polling (200 мс). Это не серверная метка.

## 2. Отдельный запуск vocal script

CPU, bundled Python:

```powershell
$py = "$env:LOCALAPPDATA\Programs\MORA\resources\vocal\python.exe"
$ff = "$env:LOCALAPPDATA\Programs\MORA\resources\ffmpeg\ffmpeg.exe"
$torchHome = "$env:LOCALAPPDATA\Programs\MORA\resources\vocal\models"

python .\tools\bench\bench-vocals.py `
  --python $py --script .\tools\separate-vocals.py `
  --input "E:\audio\track-a.flac" --input "E:\audio\track-b.flac" `
  --output-root .\data-bench-results\cpu-shifts1 `
  --ffmpeg $ff --device cpu --shifts 1 --runs 3 --torch-home $torchHome
```

CUDA shifts=1 — отдельный output-root, системный Python и `--torch-home data-dev\cache\models`; затем отдельно CUDA shifts=2.

Потоки:

```powershell
python .\tools\bench\bench-vocals.py ... --device cpu --shifts 1 --threads 6
```

`--threads` создаёт временную диагностическую копию рядом с `separate-vocals.py`, заменяет ровно строку лимита 4 потока и удаляет копию в `finally`. Если строка не найдена ровно один раз — запуск останавливается, оригинал не меняется.

## Что пока не измерено

- Разбивка `import / model load / decode / separation / activity / write`. Для неё нужна временная инструментированная копия `tools/separate-vocals.py` (исходник есть в репозитории), оригинал при этом не трогается.
- Серверные `compact()` и `prune()` — нужны отдельные trace-логи или разница между `T_job` из API и `wall_seconds` из Python-прогона.

Живой кэш MORA не очищать. Все эксперименты — в `data-bench`/`data-bench-cuda` и уникальных output-каталогах.
