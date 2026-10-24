"""Word timing of a separated vocal with local Whisper (openai-whisper, MIT).

Reads an existing stem cache (never changes it) and writes lyric timing JSON:
{version, model, language, words:[{start,end,word,p}], lines:[{start,end,text,words}]}.
Words are kept only where the measured stem activity says the voice really sings,
which removes Whisper's typical hallucinations on silence and instrumental bleed.
Lines are Whisper segments split again at gaps >= 0.6 s.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

import numpy as np

LYRICS_VERSION = 'whisper-words-1'
# Whisper word edges on singing are not edit-accurate: on the user library only 7% of its
# 60-250 ms "pauses" were quiet in the separated voice. Pauses are measured on the stem.
TIMING = 'stem-verified-1'
HOP, QUIET_DB, MIN_PAUSE, SEARCH = 0.01, -24.0, 0.03, 0.15


def emit(**message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def load_separator():
    spec = importlib.util.spec_from_file_location('separate_vocals', Path(__file__).with_name('separate-vocals.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def to_16k_mono(vocal, sr):
    import torch
    import torchaudio
    mono = torch.from_numpy(vocal.mean(axis=0).astype(np.float32))[None]
    return torchaudio.functional.resample(mono, sr, 16000)[0].numpy()


def active(activity, start, end, threshold=0.3):
    rate, values = activity['rate'], activity['values']
    lo, hi = max(0, int(start*rate)), min(len(values), int(np.ceil(end*rate)))
    return hi > lo and max(values[lo:hi]) >= threshold


def voice_envelope(vocal, sr):
    """dB of a 20 ms RMS every 10 ms, relative to the loudest singing within +-1 s.

    A local reference keeps quiet verses sung instead of calling them pauses."""
    hop = int(round(sr*HOP))
    mono = vocal.mean(axis=0, dtype=np.float64)
    n = len(mono)//hop
    power = (mono[:n*hop].reshape(n, hop)**2).mean(axis=1)
    power = np.convolve(power, [.5, .5], mode='same')
    db = 10*np.log10(power+1e-12)
    pad = int(1/HOP)
    padded = np.pad(db, pad, mode='edge')
    local = np.lib.stride_tricks.sliding_window_view(padded, 2*pad+1).max(axis=1)
    # Also quiet below -28 dB of the track's loud singing: in an instrumental break the
    # local maximum is only separation bleed (measured p90 about -30 dB on the library).
    sung = db[db > -70]
    loud = float(np.percentile(sung, 95)) if sung.size else 0.0
    return np.where(db < -70, -120.0, db-np.maximum(local, loud-4))


def quiet_runs(db):
    quiet = np.concatenate([[False], db < QUIET_DB, [False]])
    edges = np.flatnonzero(np.diff(quiet.astype(np.int8)))
    return [(a*HOP, b*HOP) for a, b in zip(edges[::2], edges[1::2]) if (b-a)*HOP >= MIN_PAUSE-1e-9]


def voiced_spans(words, db):
    """Where the separated voice really sounds, at 10 ms: the planner's edit-safety spans.

    A measured quiet run splits the voice when it is a phrase-length pause (>= 0.2 s) or
    lies within 150 ms of a recognised word boundary; shorter quiet runs elsewhere are
    stop consonants inside a word and stay voiced. Whisper's own edges never create a
    pause. Words keep their recognised timing for counting and line structure."""
    edges = [w['start'] for w in words]+[w['end'] for w in words]
    edges.sort()
    def is_pause(a, b):
        if b-a >= 0.2-1e-9:
            return True
        i = int(np.searchsorted(edges, a-SEARCH))
        return i < len(edges) and edges[i] <= b+SEARCH
    pauses = [(a, b) for a, b in quiet_runs(db) if is_pause(a, b)]
    end = len(db)*HOP
    spans, at = [], 0.0
    for a, b in pauses+[(end, end)]:
        if a-at >= MIN_PAUSE-1e-9:
            spans.append([round(at, 3), round(a, 3)])
        at = b
    return spans


def build_lines(words, gap=0.6):
    lines, current = [], []
    for w in words:
        if current and (w['start']-current[-1]['end'] >= gap or w.get('segment') != current[-1].get('segment')):
            lines.append(current)
            current = []
        current.append(w)
    if current:
        lines.append(current)
    return [{'start': l[0]['start'], 'end': l[-1]['end'], 'text': ''.join(w['word'] for w in l).strip(), 'words': len(l)} for l in lines]


def write_atomic(output, data):
    part = Path(output + '.%d.part' % os.getpid())
    try:
        part.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(part, output)
    finally:
        part.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stem-dir', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default='large-v3-turbo')
    parser.add_argument('--device', default='auto')
    parser.add_argument('--verify-only', metavar='LYRICS_JSON',
                        help='re-measure word edges of an existing transcription on the stem; no model is loaded')
    args = parser.parse_args()
    started = time.monotonic()
    sep = load_separator()
    stem_dir = Path(args.stem_dir)
    meta = json.loads((stem_dir/'metadata.json').read_text(encoding='utf-8'))
    vocal = sep.read_cached_vocal(stem_dir, meta)
    activity = meta['activity']
    if args.verify_only:
        old = json.loads(Path(args.verify_only).read_text(encoding='utf-8'))
        if old.get('version') != LYRICS_VERSION:
            raise ValueError('unsupported lyrics version')
        voiced = voiced_spans(old['words'], voice_envelope(vocal, meta['sampleRate']))
        write_atomic(args.output, dict(old, timing=TIMING, voiced=voiced))
        emit(type='done', words=len(old['words']), voiced=len(voiced), language=old.get('language'), seconds=round(time.monotonic()-started, 2))
        return
    import torch
    import whisper
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    device = 'cuda' if args.device == 'auto' and torch.cuda.is_available() else 'cpu' if args.device == 'auto' else args.device
    emit(type='progress', progress=.05, stage='model', device=device)
    # Never download weights implicitly: use only an existing local checkpoint.
    root = os.path.join(os.path.expanduser('~'), '.cache', 'whisper')
    checkpoint = os.path.join(root, args.model + '.pt')
    if not os.path.isfile(checkpoint):
        raise FileNotFoundError('whisper model missing: ' + checkpoint)
    model = whisper.load_model(checkpoint, device=device)
    audio = to_16k_mono(vocal, meta['sampleRate'])
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = (audio/peak*0.9).astype(np.float32)
    # Whisper detects the language on the first 30 s, often an instrumental intro: use the
    # 30 s window where the stem sings most instead.
    values = np.asarray(activity['values'], dtype=np.float32)
    span = int(30*activity['rate'])
    sums = np.convolve(values, np.ones(min(span, len(values))), mode='valid')
    first = int(np.argmax(sums))/activity['rate']
    window = whisper.pad_or_trim(audio[int(first*16000):int(first*16000)+30*16000])
    mel = whisper.log_mel_spectrogram(window, n_mels=model.dims.n_mels).to(device)
    _, probs = model.detect_language(mel)
    language = max(probs, key=probs.get)
    emit(type='progress', progress=.2, stage='transcribe', device=device, language=language, languageP=round(float(probs[language]), 3))
    result = model.transcribe(audio, language=language, word_timestamps=True, condition_on_previous_text=False,
                              fp16=device == 'cuda', temperature=0.0, no_speech_threshold=0.6)
    result['language'] = language
    probabilities = []
    words = []
    for index, segment in enumerate(result.get('segments', [])):
        for w in segment.get('words', []):
            start, end = float(w['start']), float(w['end'])
            if end <= start or not active(activity, start, end):
                continue
            probabilities.append(float(w.get('probability', 0)))
            words.append({'start': round(start, 3), 'end': round(end, 3), 'word': w['word'], 'p': round(float(w.get('probability', 0)), 3), 'segment': index})
    lines = build_lines(words)
    for w in words:
        w.pop('segment', None)
    # median word probability: low for mumbled, foreign-script or misdetected singing
    confidence = round(float(np.median(probabilities)), 3) if probabilities else 0.0
    out = {'version': LYRICS_VERSION, 'model': args.model, 'language': result.get('language'), 'confidence': confidence,
           'seconds': round(time.monotonic()-started, 2), 'device': device, 'words': words, 'lines': lines,
           'timing': TIMING, 'voiced': voiced_spans(words, voice_envelope(vocal, meta['sampleRate']))}
    write_atomic(args.output, out)
    emit(type='done', words=len(words), lines=len(lines), language=out['language'], seconds=out['seconds'])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(type='error', message=str(error))
        sys.exit(1)
