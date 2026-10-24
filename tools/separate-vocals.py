"""Local Hybrid Demucs inference and inexpensive analysis of existing vocal caches.

The original is never changed. Playback uses original + (voiceGain-1)*vocal,
so neither normalization nor model errors can affect an unmasked track.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

ACTIVITY_VERSION = 'vocal-activity-2'


def emit(**message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def stereo_normalization(audio):
    # std(mean(L,R)) collapses on phase-wide/anti-phase audio. Use stereo power.
    mean = float(np.mean(audio, dtype=np.float64))
    scale = max(1e-6, float(np.sqrt(np.mean((audio-mean)**2, dtype=np.float64))))
    return mean, scale


def contextual_separation(audio, sr, infer, shifts=1, progress=None):
    """8s inference windows, 350ms real context, 25% useful-window overlap.

    Edge predictions receive low weights. Context is discarded before assembly,
    avoiding the hard artificial boundaries seen by independently padded chunks.
    Deterministic shifted predictions are aligned before averaging, never delayed.
    infer receives channels x samples and returns the vocal with the same shape.
    """
    if audio.ndim != 2 or audio.shape[0] != 2 or not audio.shape[1]:
        raise ValueError('Expected nonempty stereo audio')
    if shifts not in (1, 2, 3, 4):
        raise ValueError('shifts must be 1..4')
    length = audio.shape[1]
    context = max(1, round(sr * .35))
    segment = round(sr * 8)
    useful = segment - 2 * context
    stride = max(1, round(useful * .75))
    mean, scale = stereo_normalization(audio)
    output = np.zeros_like(audio)
    weights = np.zeros(length, dtype=np.float32)
    triangle = np.minimum(np.arange(1, useful+1), np.arange(useful, 0, -1)).astype(np.float32)
    triangle /= triangle.max()
    for start in range(0, length, stride):
        end = min(length, start + useful)
        count = end - start
        voice = np.zeros((2, count), dtype=np.float32)
        for shift in range(shifts):
            offset = round(sr * .137 * shift / max(1, shifts-1))
            left = context + offset
            a, b = start-left, start-left+segment
            low, high = max(0, a), min(length, b)
            # Normalized per window: the same elementwise values without a third full copy of the recording.
            chunk = (audio[:, low:high] - mean) / scale
            chunk = np.pad(chunk, ((0, 0), (max(0, -a), max(0, b-length))),
                           mode='reflect' if chunk.shape[1] > 1 else 'edge')
            predicted = np.asarray(infer(np.ascontiguousarray(chunk)), dtype=np.float32)
            if predicted.shape != chunk.shape or not np.isfinite(predicted).all():
                raise ValueError('Invalid/nonfinite separation output')
            voice += predicted[:, left:left+count] / shifts
        # Restore the model's de-normalization consistently with Torchaudio.
        voice = voice * scale + mean
        fade = triangle[:count]
        output[:, start:end] += voice * fade
        weights[start:end] += fade
        if progress:
            progress(end / length)
        if end == length:
            break
    if np.any(weights <= 0):
        raise ValueError('Uncovered separation samples')
    output /= weights[None]
    return output


def with_cpu_fallback(device, run, to_cpu):
    """A CUDA failure (out of memory, unsupported GPU, driver reset) repeats the track on CPU.

    torch's CUDA errors are RuntimeError subclasses; invalid model output (ValueError) is not retried.
    """
    try:
        return run()
    except RuntimeError as error:
        if device != 'cuda':
            raise
        to_cpu(error)
        return run()


def block_power(audio, hop, minus=None):
    """100ms stereo mean-square bins of audio (or audio-minus); the final short bin uses its real length.

    Works through whole bins a minute at a time: float64 temporaries of a
    full recording would be four times its float32 size.
    """
    length = audio.shape[1]
    step = hop * 600
    out = []
    for a in range(0, length, step):
        x = audio[:, a:a+step] if minus is None else audio[:, a:a+step] - minus[:, a:a+step]
        power = np.mean(x.astype(np.float64)**2, axis=0)
        starts = np.arange(0, power.size, hop)
        out.append(np.add.reduceat(power, starts) / np.minimum(hop, power.size-starts))
    return np.concatenate(out)


def vocal_activity(audio, vocal, sr, model):
    if audio.shape != vocal.shape or not audio.shape[1]:
        raise ValueError('Original and vocal must have matching nonempty frames')
    hop = sr // 10
    original_power = block_power(audio, hop)
    voice_power = block_power(vocal, hop)
    accompaniment_power = block_power(audio, hop, minus=vocal)
    db = lambda power: 10*np.log10(np.maximum(1e-12, power))
    voice_db, original_db = db(voice_power), db(original_power)
    body_db = float(np.percentile(original_db, 75))
    relative = np.clip((voice_db-original_db+20)/14, 0, 1)
    audible = np.clip((voice_db-max(-65, body_db-32))/12, 0, 1)
    presence = relative * audible
    # Immediate attack; one short release bin. 500ms averaging erased breaths.
    for i in range(1, len(presence)):
        presence[i] = max(presence[i], presence[i-1]*.35)
    phrases = []
    start, last_active = None, None
    for i, value in enumerate(presence):
        if value >= (.52 if start is None else .28):
            if start is None:
                start = i
            last_active = i
        if start is not None and (i-last_active > 2 or i == len(presence)-1):
            end = last_active+1
            if end-start >= 2:
                phrases.append({'start': round(start/10, 3),
                                'end': round(min(end/10, audio.shape[1]/sr), 3),
                                'confidence': round(float(np.mean(presence[start:end])), 3)})
            start, last_active = None, None
    activity = {'version': ACTIVITY_VERSION, 'rate': 10,
            'values': np.round(presence, 3).tolist(), 'source': 'demucs', 'model': model,
            'vocalRmsDb': np.round(voice_db, 2).tolist(),
            'accompanimentRmsDb': np.round(db(accompaniment_power), 2).tolist(),
            'phrases': phrases}
    activity['revision'] = hashlib.sha256(json.dumps(activity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:24]
    return activity


def read_cached_vocal(out, meta):
    storage = meta.get('storage', {})
    small = storage.get('format') == 's16le'
    filename = storage.get('file', 'vocals.s16') if small else 'vocals.f32'
    if Path(filename).name != filename or not filename.endswith('.s16' if small else '.f32'):
        raise ValueError('Invalid vocal cache filename')
    source = out / filename
    raw = np.fromfile(source, dtype='<i2' if small else '<f4')
    if raw.size != meta['frames']*2:
        raise ValueError('Truncated vocal cache')
    vocal = raw.astype(np.float32).reshape(-1, 2).T
    if small:
        scale = storage.get('scale')
        if not isinstance(scale, (int, float)) or not np.isfinite(scale) or scale < 1:
            raise ValueError('Invalid cached vocal scale')
        vocal *= scale/32768
    if not np.isfinite(vocal).all():
        raise ValueError('Nonfinite vocal cache')
    return vocal


def write_metadata(out, meta):
    # Unique temporary file: another process may be compacting this cache.
    temporary = out / ('metadata.%d.json.part' % os.getpid())
    try:
        temporary.write_text(json.dumps(meta, allow_nan=False), encoding='utf-8')
        os.replace(temporary, out / 'metadata.json')
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--device', default='auto')
    parser.add_argument('--shifts', type=int, choices=range(1, 5))
    parser.add_argument('--analyze-only', action='store_true')
    args = parser.parse_args()
    started = time.monotonic()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    sr = 44100
    raw = subprocess.run([args.ffmpeg, '-v', 'error', '-nostdin', '-i', args.input,
                          '-vn', '-ac', '2', '-ar', str(sr), '-f', 'f32le', 'pipe:1'],
                         check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).T.copy()
    del raw  # a second full copy of the decoded recording
    if audio.shape[1] < sr//10 or not np.isfinite(audio).all():
        raise ValueError('No usable finite audio')
    if args.analyze_only:
        meta = json.loads((out/'metadata.json').read_text(encoding='utf-8'))
        if meta['sampleRate'] != sr or meta['frames'] != audio.shape[1]:
            raise ValueError('Original and cached stem length do not match')
        vocal = read_cached_vocal(out, meta)
        emit(type='progress', progress=.8, stage='activity', device='cpu')
    else:
        # Activity upgrades require only NumPy and ffmpeg, not loading 334MB weights.
        import torch
        import torchaudio
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        device = 'cuda' if args.device == 'auto' and torch.cuda.is_available() else 'cpu' if args.device == 'auto' else args.device
        emit(type='progress', progress=.01, stage='model', device=device)
        bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
        model = bundle.get_model().to(device).eval()
        voice_index = model.sources.index('vocals')

        def infer(chunk):
            with torch.inference_mode():
                result = model(torch.from_numpy(chunk)[None].to(device))
                return result[0, voice_index].float().cpu().numpy()

        shifts = args.shifts or (2 if device == 'cuda' else 1)

        def to_cpu(error):
            nonlocal model, device
            emit(type='progress', progress=.05, stage='cpu-fallback', device='cpu', reason=str(error)[:300])
            model, device = model.cpu(), 'cpu'
            torch.cuda.empty_cache()

        vocal = with_cpu_fallback(device, lambda: contextual_separation(audio, sr, infer, shifts=shifts,
                    progress=lambda p: emit(type='progress', progress=round(.05+.85*p, 4), stage='separation', device=device)), to_cpu)
        meta = {'version': 'hdemucs-v1', 'model': 'HDEMUCS_HIGH_MUSDB_PLUS', 'sampleRate': sr,
                'frames': audio.shape[1], 'device': device, 'seconds': round(time.monotonic()-started, 2),
                'inference': {'version': 'context-overlap-2', 'segment': 8, 'context': .35, 'overlap': .25, 'shifts': shifts}}
        vocal.T.astype('<f4').tofile(out/'vocals.f32.part')
        os.replace(out/'vocals.f32.part', out/'vocals.f32')
    activity = vocal_activity(audio, vocal, sr, meta['model'])
    if args.analyze_only:
        # Preserve a concurrent compaction's storage selector. Never change PCM.
        current = json.loads((out/'metadata.json').read_text(encoding='utf-8'))
        if current['frames'] != meta['frames'] or current['model'] != meta['model']:
            raise ValueError('Vocal cache changed while analyzing')
        meta = current
    meta['activity'] = activity
    write_metadata(out, meta)
    emit(type='done', frames=meta['frames'], activityVersion=ACTIVITY_VERSION)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(type='error', message=str(error))
        sys.exit(1)
