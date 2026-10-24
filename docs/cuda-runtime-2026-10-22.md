# CUDA runtime for vocal separation in MORA desktop (2026-10-22)

## Current state

- Installed MORA 0.3.11 ships `resources/vocal`: embeddable Python 3.12.10 + `torch==2.7.1+cpu`,
  `torchaudio==2.7.1+cpu`, model `HDEMUCS_HIGH_MUSDB_PLUS` (334 MB). Built by
  `apps/desktop/scripts/fetch-vocals.mjs` (pip `--target` from `download.pytorch.org/whl/cpu`),
  manifest `pack.json` version `mora-vocal-cpu-1`, checked by `bundledVocals()` in
  `apps/server/src/config.ts` and `apps/desktop/scripts/check-backend.mjs` (`vocalRuntime === 'bundled-cpu'`).
- Pack size on disk: 1.6 GB (torch alone 1.2 GB). Installer `MORA-Setup-0.3.11.exe`: 480 MB.
- `tools/separate-vocals.py` picks `cuda` when `--device auto` and `torch.cuda.is_available()`,
  and then defaults to `shifts=2`; on CPU it defaults to `shifts=1`.
- Dev uses system Python 3.12 with `torch 2.7.1+cu118` (RTX 3070, driver 617.42, 8 GB).

## Measurements (RTX 3070, same script, same model file, end-to-end incl. ffmpeg decode and model load)

| Track (hash prefix) | Length | CPU bundled, shifts=1 | CUDA, shifts=1 | CUDA, shifts=2 | Speed-up (shifts=1) |
|---|---|---|---|---|---|
| 0a0f97d6 | 148.7 s | 33.58 s | 8.61 s | 13.53 s | 3.9× |
| 98d84e26 | 181.0 s | 30.41 s | 8.72 s | 13.14 s | 3.5× |
| dde08998 | 216.0 s | 26.22 s | 9.48 s | 15.95 s | 2.8× |

CPU per second of audio: 0.12–0.23 s (first run includes a cold model read). CUDA shifts=1: 0.044–0.058 s.
Peak VRAM for one 8 s window: 689 MiB allocated, 902 MiB reserved.

### Quality: CUDA vs CPU

Vocal output compared sample by sample against the CPU result (SDR of the difference):

| Track | CUDA shifts=1 vs CPU | CUDA shifts=2 vs CPU | Max activity difference s1 / s2 |
|---|---|---|---|
| 0a0f97d6 | 62.8 dB | 32.0 dB | 0.001 / 0.549 |
| 98d84e26 | 61.0 dB | 32.4 dB | 0.001 / 0.033 |
| dde08998 | 50.7 dB | 32.8 dB | 0.001 / 0.182 |

CUDA with `shifts=1` is the same result as CPU up to float rounding (phrase lists identical, activity
differs by ≤ 0.001). `shifts=2` is a different mode: activity values change by up to 0.55, so plans would differ
by device. **Decision: the desktop runtime passes `--shifts 1` on every device.** The dev default (`shifts=2` on CUDA)
is unchanged.

## Options

### A. CUDA torch inside the installer

- `torch-2.7.1+cu118` wheel is 2.82 GB (cu126: 2.72 GB, cu128: 3.27 GB); installed torch is 5.2 GB instead of 1.2 GB.
- Installer would grow from 480 MB to roughly 2.5–3 GB, resources on disk from 1.6 GB to about 5.6 GB, for every user,
  including users without an NVIDIA GPU (they get nothing for it).
- NSIS installers above 2 GB are fragile (single-file and archive limits in NSIS / electron-builder); updates would
  re-download the whole thing.

### B. Optional CUDA pack, downloaded on request (chosen)

- Installer stays as now (CPU pack included, works offline, always the fallback).
- Settings shows "GPU acceleration" only when an NVIDIA GPU is detected, with the download size (2.82 GB) and disk cost
  (about 5.5 GB) and an explicit confirm. Nothing is downloaded without that click. A delete button frees the space.
- Download: `torch-2.7.1+cu118` and `torchaudio-2.7.1+cu118` cp312 win_amd64 wheels from `download.pytorch.org`,
  pinned SHA-256 (torch `80855ec840b7b06372ff43535d01393a8ec101842618d1f9ed629572b52aed71`,
  torchaudio `e214b04cd40be5e733f5915879f8cbe2de889661ca179fd86998bbadf3740f44`). Extracted with the bundled
  Python's `zipfile` into `<dataDir>/runtime/vocal-cuda`, wheels deleted after extraction. A small copy of the bundled
  `python.exe`/`python312.dll`/`python312.zip` with its own `._pth` puts the CUDA site-packages first and the bundled
  site-packages (numpy etc.) second, so only torch/torchaudio are duplicated. Self-test: `torch.cuda.is_available()` and one
  inference window.
- Why cu118: it is the exact build measured above, needs the oldest driver (≥ 452.39) and covers sm_50–sm_90
  (GTX 900 to RTX 40). RTX 50 (sm_120) is not covered and falls back to CPU; switching to cu128 (3.27 GB, driver ≥ 570)
  is the upgrade path if that matters.

### Fallback rules (both options)

1. No NVIDIA GPU, or `nvidia-smi` missing: the CUDA option is not offered; CPU pack is used.
2. Old driver: `torch.cuda.is_available()` is false; the CUDA pack runs on CPU (same result).
3. CUDA error during a job (out of memory, "no kernel image", driver reset): the script retries that track on CPU in
   the same process and records `device: cpu`.
4. CUDA runtime fails to start (missing or broken files, DLL load error): the server marks it broken for the session and
   uses the bundled CPU Python.

## Disk cost summary

| | Download | On disk |
|---|---|---|
| Today (CPU pack in installer) | 480 MB installer | 1.6 GB |
| Option A | ~2.5–3 GB installer | ~5.6 GB |
| Option B, without GPU pack | 480 MB installer | 1.6 GB |
| Option B, GPU pack added | +2.82 GB (once) | +5.49 GB (in data folder, removable) |

## Implementation (done, user consented on 2026-10-22)

- `apps/server/src/vocal-cuda.ts`: `VocalCuda` detects the GPU with `nvidia-smi`, downloads both wheels with pinned
  SHA-256, extracts them with the bundled Python into `<dataDir>/runtime/vocal-cuda/site`, copies the interpreter files,
  writes `python312._pth` (CUDA site first, bundled site-packages second; rewritten on every start so a reinstall to
  another folder keeps working), runs a GPU self-test and only then writes `ready.json`. Any failure removes the folder.
- `apps/server/src/stems.ts`: separation uses the CUDA Python when ready; the desktop packs always get `--shifts 1`;
  activity-only jobs stay on the CPU pack. If the CUDA Python exits before the `model` stage (cannot import torch), the
  runtime is marked broken for the session and the same job is queued again on the CPU pack. `/api/health` reports
  `stems.gpu`.
- `tools/separate-vocals.py`: `with_cpu_fallback` repeats a track on CPU after a CUDA `RuntimeError`
  (out of memory, no kernel image, driver reset) and records `device: cpu`.
- `POST /api/stems/gpu` starts the download only with `acceptBytes` equal to the shown size; `DELETE /api/stems/gpu` removes it.
- Settings → "DJ-приёмы и вокал": block "Ускорение на видеокарте", shown only when an NVIDIA GPU is found, with size,
  confirm dialog, progress, delete button and the CPU-fallback reason.
- Tests: `apps/server/test/stems.test.ts` (CUDA start failure goes to CPU, shifts=1 on both),
  `tools/test-separate-vocals.py` (CUDA error retried on CPU, other errors not).

## Verification

- Real install through `VocalCuda.install()` on this PC: download about 60 s, extraction and self-test about 120 s,
  180 s total; 5,493,979,556 bytes on disk.
- The installed pack gives the same vocals as the bundled CPU pack: 62.8 / 61.0 / 50.7 dB on the three tracks
  (identical to the system cu118 numbers above). With `CUDA_VISIBLE_DEVICES=-1` it runs on CPU.
- Packaged `win-unpacked` with an isolated profile: settings show the offer and the confirm dialog without the pack;
  with the pack, a real separation finished with `device: cuda`, `shifts: 1`.
- During the in-app runs another process held the GPU at 97 % load, so those runs took 14–18 s instead of 8.6–9.5 s; the
  downloaded pack and the system cu118 Python were equally fast under the same load (15.1–15.6 s vs 15.3–17.6 s).

## Limits

- RTX 50 series (sm_120) is not in cu118: such GPUs run the pack on CPU. Upgrade path: cu128 wheels (3.27 GB, driver ≥ 570).
- The download cannot be paused or resumed; closing the app mid-download leaves a partial folder that the next install
  attempt deletes first.
- Not verified: a real out-of-memory on a small GPU and a corrupted pack in the packaged app (both covered by unit tests only).
