#!/usr/bin/env python3
"""Non-production CLI benchmark for tools/separate-vocals.py.

Each run gets a fresh output directory. The first run for each input is warm-up;
--runs specifies the number of measured runs in addition to that warm-up.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

THREADS_ANCHOR = re.compile(
    r"torch\.set_num_threads\(\s*max\(\s*1\s*,\s*min\(\s*4\s*,\s*os\.cpu_count\(\)\s*(?:or\s*1\s*)?\)\s*\)\s*\)"
)
THREADS_REPLACEMENT = 'torch.set_num_threads(int(os.environ.get("STEM_THREADS", max(1, min(4, os.cpu_count() or 1)))))'


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, help="Python interpreter to benchmark")
    parser.add_argument("--script", required=True, help="Path to tools/separate-vocals.py")
    parser.add_argument("--input", required=True, action="append", help="Input audio file; repeat for a fixed track set")
    parser.add_argument("--output-root", required=True, help="Directory for isolated run outputs/logs")
    parser.add_argument("--ffmpeg", required=True, help="Path to ffmpeg executable")
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--torch-home", help="Optional TORCH_HOME path")
    parser.add_argument("--runs", type=int, default=3, help="Measured repetitions per input, excluding one warm-up (default: 3)")
    parser.add_argument("--threads", type=int, help="Diagnostic-only patch for the exact 4-thread line in a temporary script copy")
    parser.add_argument("--cprofile", action="store_true", help="Collect Python cProfile output per run (does not fully profile native Torch/CUDA kernels)")
    parser.add_argument("--cwd", help="Working directory for child process (default: current directory)")
    return parser.parse_args()


def newest_metadata(output_dir: Path) -> tuple[Path | None, dict[str, Any] | None]:
    paths = list(output_dir.rglob("metadata.json")) if output_dir.exists() else []
    if not paths:
        return None, None
    path = max(paths, key=lambda p: p.stat().st_mtime)
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        return path, obj if isinstance(obj, dict) else None
    except (OSError, json.JSONDecodeError):
        return path, None


def maybe_patch_threads(source: Path, threads: int | None) -> tuple[Path, Path | None]:
    if threads is None:
        return source, None
    if threads < 1:
        raise ValueError("--threads must be >= 1")
    text = source.read_text(encoding="utf-8")
    patched, count = THREADS_ANCHOR.subn(THREADS_REPLACEMENT, text)
    if count != 1:
        raise RuntimeError(
            "Не удалось безопасно пропатчить диагностическую копию: ожидалась ровно одна строка "
            "torch.set_num_threads(max(1, min(4, os.cpu_count()))). Production-файл не изменён."
        )
    # Keep the temporary copy beside the original so __file__-relative paths keep their directory.
    copy_path = source.with_name(f"{source.stem}.__bench_threads_{os.getpid()}{source.suffix}")
    if copy_path.exists():
        raise RuntimeError(f"Temporary script already exists: {copy_path}")
    copy_path.write_text(patched, encoding="utf-8")
    return copy_path, copy_path


def as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    args = parse_args()
    python = Path(args.python).expanduser().resolve()
    source = Path(args.script).expanduser().resolve()
    ffmpeg = Path(args.ffmpeg).expanduser().resolve()
    inputs = [Path(p).expanduser().resolve() for p in args.input]
    root = Path(args.output_root).expanduser().resolve()
    cwd = Path(args.cwd).expanduser().resolve() if args.cwd else Path.cwd().resolve()

    for path, label in ((python, "Python"), (source, "script"), (ffmpeg, "ffmpeg")):
        if not path.is_file():
            print(f"ERROR: {label} path not found: {path}", file=sys.stderr)
            return 2
    for path in inputs:
        if not path.is_file():
            print(f"ERROR: input path not found: {path}", file=sys.stderr)
            return 2
    if args.shifts < 1 or args.runs < 1:
        print("ERROR: --shifts and --runs must be >= 1", file=sys.stderr)
        return 2
    root.mkdir(parents=True, exist_ok=True)
    try:
        run_script, temporary_script = maybe_patch_threads(source, args.threads)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    rows: list[dict[str, Any]] = []
    env = os.environ.copy()
    if args.torch_home:
        env["TORCH_HOME"] = str(Path(args.torch_home).expanduser().resolve())
    if args.threads is not None:
        env["STEM_THREADS"] = str(args.threads)

    print(f"Python: {python}")
    print(f"Script used: {run_script}")
    print(f"Device={args.device} shifts={args.shifts} threads={args.threads or 'script default'}")
    print(f"Inputs={len(inputs)} measured_runs_per_input={args.runs} plus one warm-up each")

    try:
        for input_index, input_path in enumerate(inputs, start=1):
            safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", input_path.stem).strip("._") or f"track{input_index}"
            for run_index in range(0, args.runs + 1):
                warmup = run_index == 0
                run_label = "warmup" if warmup else f"run-{run_index:02d}"
                out_dir = root / f"{input_index:02d}-{safe_name}" / run_label
                out_dir.mkdir(parents=True, exist_ok=False)
                stdout_path = out_dir / "stdout.log"
                stderr_path = out_dir / "stderr.log"
                profile_path = out_dir / "python.prof"
                command = [str(python)]
                if args.cprofile:
                    command += ["-m", "cProfile", "-o", str(profile_path)]
                command += [
                    str(run_script), "--input", str(input_path), "--output", str(out_dir / "result"),
                    "--ffmpeg", str(ffmpeg), "--device", args.device, "--shifts", str(args.shifts),
                ]
                start = time.perf_counter()
                try:
                    completed = subprocess.run(
                        command, cwd=str(cwd), env=env, text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, errors="replace", check=False,
                    )
                    returncode = completed.returncode
                    stdout = completed.stdout
                    stderr = completed.stderr
                except OSError as exc:
                    returncode = 127
                    stdout = ""
                    stderr = f"Failed to launch child process: {exc}"
                wall_seconds = time.perf_counter() - start
                stdout_path.write_text(stdout, encoding="utf-8", errors="replace")
                stderr_path.write_text(stderr, encoding="utf-8", errors="replace")
                meta_path, meta = newest_metadata(out_dir)
                inference = (meta or {}).get("inference") or {}
                frames = as_float((meta or {}).get("frames"))
                row = {
                    "track": str(input_path),
                    "track_index": input_index,
                    "run": run_label,
                    "warmup": warmup,
                    "device_requested": args.device,
                    "shifts_requested": args.shifts,
                    "threads_requested": args.threads if args.threads is not None else "script-default",
                    "wall_seconds": round(wall_seconds, 4),
                    "metadata_seconds": as_float((meta or {}).get("seconds")),
                    "metadata_device": (meta or {}).get("device"),
                    "metadata_shifts": inference.get("shifts"),
                    "track_seconds_from_frames_44100": round(frames / 44100.0, 3) if frames else None,
                    "returncode": returncode,
                    "metadata_path": str(meta_path) if meta_path else "",
                    "stdout_log": str(stdout_path),
                    "stderr_log": str(stderr_path),
                    "profile_path": str(profile_path) if args.cprofile and profile_path.exists() else "",
                }
                rows.append(row)
                label = "WARMUP" if warmup else f"run {run_index}/{args.runs}"
                print(f"[{input_index}/{len(inputs)}] {input_path.name} {label}: wall={wall_seconds:.2f}s rc={returncode} metadata.seconds={row['metadata_seconds']}")
                if returncode != 0:
                    print(f"  See stderr: {stderr_path}", file=sys.stderr)

        csv_path = root / "bench-results.csv"
        fields = list(rows[0].keys()) if rows else []
        with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        print(f"CSV: {csv_path}")
        print("Reminder: wall_seconds is full child-process time; metadata_seconds is a separate field and is not assumed to equal end-to-end T_total.")
        return 0 if all(int(r["returncode"]) == 0 for r in rows) else 1
    finally:
        if temporary_script is not None:
            try:
                temporary_script.unlink(missing_ok=True)
            except OSError as exc:
                print(f"WARN: temporary diagnostic script could not be removed: {temporary_script}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
