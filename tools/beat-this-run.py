"""Runs Beat This! (CPJKU, MIT) on the WAV files of a manifest written by tools/beat-this-compare.ts --prepare.

Usage: python -I tools/beat-this-run.py MANIFEST.json OUT.json --site DIR [--checkpoint small0] [--cpu]
--site is the `pip install --target` directory holding beat_this and rotary_embedding_torch
(nothing is installed into the shared Python). Prints time and peak GPU memory per track.
"""
import argparse
import json
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("out")
ap.add_argument("--site", required=True)
ap.add_argument("--checkpoint", default="small0")
ap.add_argument("--cpu", action="store_true")
args = ap.parse_args()
sys.path.insert(0, args.site)

import torch  # noqa: E402
from beat_this.inference import File2Beats  # noqa: E402

device = "cpu" if args.cpu or not torch.cuda.is_available() else "cuda"
started = time.time()
f2b = File2Beats(checkpoint_path=args.checkpoint, device=device, dbn=False)
load_seconds = time.time() - started
with open(args.manifest, encoding="utf-8") as f:
    manifest = json.load(f)
results = []
for i, item in enumerate(manifest["tracks"]):
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t = time.time()
    beats, downbeats = f2b(item["wav"])
    seconds = time.time() - t
    peak = torch.cuda.max_memory_allocated() / 2**20 if device == "cuda" else 0
    results.append({"id": item["id"], "beats": [float(x) for x in beats], "downbeats": [float(x) for x in downbeats], "seconds": seconds, "peakMiB": peak})
    print(f"{i + 1}/{len(manifest['tracks'])} {item['id'][:8]} {seconds:.2f}s {peak:.0f} MiB", flush=True)
with open(args.out, "w", encoding="utf-8") as f:
    json.dump({"checkpoint": args.checkpoint, "device": device, "loadSeconds": load_seconds, "results": results}, f)
print(args.out)
