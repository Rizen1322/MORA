"""Numerical regression checks without downloading/loading any neural weights."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('separation', Path(__file__).with_name('separate-vocals.py'))
separation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(separation)


class VocalPipelineTests(unittest.TestCase):
    def test_phase_wide_stereo_has_finite_normalization(self):
        wave = .3*np.sin(np.arange(2400)*.1).astype(np.float32)
        for audio in (np.stack([wave, wave]), np.stack([wave, -wave])):
            mean, scale = separation.stereo_normalization(audio)
            self.assertGreater(scale, .2)
            self.assertLess(abs(mean), .01)

    def test_context_overlap_identity_has_no_gaps_delay_or_edge_discontinuity(self):
        rng = np.random.default_rng(2)
        for length in (1, 65, 730, 2101):
            audio = rng.normal(0, .1, (2, length)).astype(np.float32)
            for shifts in (1, 2):
                result = separation.contextual_separation(audio, 100, lambda chunk: chunk, shifts=shifts)
                np.testing.assert_allclose(result, audio, atol=1e-7)

    def test_context_discards_model_border_artifacts(self):
        audio = np.zeros((2, 2300), dtype=np.float32)
        def boundary_artifacts(chunk):
            out = chunk.copy()
            out[:, :20] += 100
            out[:, -20:] += 100
            return out
        out = separation.contextual_separation(audio, 100, boundary_artifacts, shifts=2)
        self.assertEqual(float(np.max(abs(out))), 0)

    def test_nonfinite_model_output_is_rejected(self):
        audio = np.zeros((2, 300), dtype=np.float32)
        with self.assertRaisesRegex(ValueError, 'Nonfinite|nonfinite'):
            separation.contextual_separation(audio, 100, lambda c: c+np.nan)

    def test_cuda_failure_repeats_on_cpu_but_other_errors_do_not(self):
        calls, moved = [], []
        def run():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError('CUDA error: out of memory')
            return 'cpu result'
        self.assertEqual(separation.with_cpu_fallback('cuda', run, moved.append), 'cpu result')
        self.assertEqual(len(moved), 1)
        with self.assertRaises(RuntimeError):
            separation.with_cpu_fallback('cpu', lambda: (_ for _ in ()).throw(RuntimeError('x')), moved.append)
        with self.assertRaises(ValueError):
            separation.with_cpu_fallback('cuda', lambda: (_ for _ in ()).throw(ValueError('bad output')), moved.append)
        self.assertEqual(len(moved), 1)

    def test_silence_is_not_a_vocal_phrase(self):
        audio = np.zeros((2, 4411), dtype=np.float32)
        activity = separation.vocal_activity(audio, audio, 44100, 'test')
        self.assertEqual(activity['values'], [0, 0])
        self.assertEqual(activity['phrases'], [])
        self.assertEqual(activity['vocalRmsDb'], [-120, -120])
        self.assertTrue(np.isfinite(activity['accompanimentRmsDb']).all())

    def test_final_partial_bin_uses_actual_duration(self):
        audio = np.full((2, 4411), .1, dtype=np.float32)
        activity = separation.vocal_activity(audio, audio, 44100, 'test')
        self.assertEqual(activity['vocalRmsDb'], [-20, -20])
        self.assertLessEqual(activity['phrases'][0]['end'], 4411/44100+.001)

    def test_blockwise_power_matches_whole_recording_power(self):
        rng = np.random.default_rng(5)
        hop = 7
        for length in (1, 7, 4199, 4200, 4201, 9000):  # around the 600-bin step
            audio = rng.normal(0, .3, (2, length)).astype(np.float32)
            vocal = rng.normal(0, .1, (2, length)).astype(np.float32)
            for x, minus in ((audio, None), (audio-vocal, vocal)):
                power = np.mean(x.astype(np.float64)**2, axis=0)
                starts = np.arange(0, length, hop)
                whole = np.add.reduceat(power, starts) / np.minimum(hop, length-starts)
                got = separation.block_power(audio if minus is not None else x, hop, minus=minus)
                np.testing.assert_array_equal(got, whole)

    def test_measured_accompaniment_and_voice_power_use_residual(self):
        t = np.arange(44100*3)/44100
        voice = np.stack([.2*np.sin(t*2*np.pi*400)]*2).astype(np.float32)
        accompaniment = np.stack([.1*np.sin(t*2*np.pi*80)]*2).astype(np.float32)
        measured = separation.vocal_activity(voice+accompaniment, voice, 44100, 'test')
        np.testing.assert_allclose(measured['vocalRmsDb'], -16.99, atol=.02)
        np.testing.assert_allclose(measured['accompanimentRmsDb'], -23.01, atol=.02)

    def test_breath_gaps_are_not_erased_by_half_second_smoothing(self):
        sr = 1000
        vocal = np.zeros((2, 5000), dtype=np.float32)
        vocal[:, 500:1500] = .2
        vocal[:, 2200:3500] = .2
        original = vocal+np.full_like(vocal, .03)
        result = separation.vocal_activity(original, vocal, sr, 'test')
        self.assertEqual(len(result['phrases']), 2)
        self.assertEqual(result['phrases'][0]['start'], .5)
        self.assertEqual(result['phrases'][1]['start'], 2.2)
        self.assertLess(result['values'][18], .1)

    def test_read_peak_scaled_cache_preserves_stereo_and_overs(self):
        with tempfile.TemporaryDirectory(prefix='automix-vocal-test-') as temporary:
            path = Path(temporary)
            samples = np.array([[20000, -20000], [-12000, 8000]], dtype='<i2')
            samples.tofile(path/'vocals.s16')
            metadata = {'frames': 2, 'storage': {'format': 's16le', 'scale': 2}}
            result = separation.read_cached_vocal(path, metadata)
            np.testing.assert_allclose(result.T, samples.astype(np.float32)/16384)
            self.assertGreater(result[0, 0], 1)



asr_spec = importlib.util.spec_from_file_location('transcribe', Path(__file__).with_name('transcribe-vocals.py'))
transcribe = importlib.util.module_from_spec(asr_spec)
asr_spec.loader.exec_module(transcribe)


class LyricTimingTests(unittest.TestCase):
    def test_voiced_spans_measure_pauses_not_whisper_edges(self):
        sr = 16000
        t = np.arange(int(sr*8))/sr
        voice = .3*np.sin(2*np.pi*220*t)
        def silence(a, b, level=0.0):
            voice[int(a*sr):int(b*sr)] *= level
        silence(1.00, 1.08)            # real 80 ms word pause, Whisper puts it 100 ms late
        silence(2.50, 2.54)            # 40 ms stop consonant inside a word: stays voiced
        silence(4.00, 6.00, 10**(-32/20))  # instrumental break: only separation bleed
        silence(7.00, 8.00)
        words = [{'start': .2, 'end': 1.12, 'word': 'a'}, {'start': 1.18, 'end': 3.6, 'word': 'b'},
                 {'start': 3.65, 'end': 3.9, 'word': 'c'}, {'start': 6.1, 'end': 6.9, 'word': 'd'}]
        db = transcribe.voice_envelope(np.stack([voice, voice]), sr)
        spans = transcribe.voiced_spans(words, db)
        self.assertEqual(len(spans), 3)
        self.assertAlmostEqual(spans[0][1], 1.0, delta=.02)
        self.assertAlmostEqual(spans[1][0], 1.08, delta=.02)
        self.assertAlmostEqual(spans[1][1], 4.0, delta=.02)   # 3.6-3.65 Whisper gap was sung
        self.assertAlmostEqual(spans[2][0], 6.0, delta=.02)
        self.assertAlmostEqual(spans[2][1], 7.0, delta=.02)


if __name__ == '__main__':
    unittest.main()
