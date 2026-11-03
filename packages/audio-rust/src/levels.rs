use crate::analysis::Fft;
use std::f64::consts::PI;

pub const BLOCK: usize = 2048;

/// RMS and 16 half-octave mean-dB bands of one mono block; mirrors `bandLevels` in apps/web/src/audio/desktop-engine.ts.
pub fn band_levels(fft: &Fft, block: &[f64], sr: u32) -> (f64, [f64; 16]) {
    let n = BLOCK;
    let (mut re, mut im, mut sq) = (vec![0.; n], vec![0.; n], 0.);
    for i in 0..n {
        let x = block.get(i).copied().unwrap_or(0.);
        sq += x * x;
        let t = i as f64 / n as f64;
        re[i] = x * (0.42 - 0.5 * (2. * PI * t).cos() + 0.08 * (4. * PI * t).cos());
    }
    fft.forward(&mut re, &mut im);
    let mut bands = [-120.; 16];
    for (b, out) in bands.iter_mut().enumerate() {
        let lo = ((40. * 2f64.powf(b as f64 / 2.) * n as f64 / sr as f64).ceil() as usize).max(1);
        let hi = ((40. * 2f64.powf((b + 1) as f64 / 2.) * n as f64 / sr as f64).floor() as usize).min(n / 2 - 1);
        if lo <= hi {
            let sum: f64 = (lo..=hi).map(|i| 20. * (re[i].hypot(im[i]) / n as f64).max(1e-12).log10()).sum();
            *out = sum / (hi - lo + 1) as f64;
        }
    }
    ((sq / n as f64).sqrt(), bands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sine_on_bin_128() {
        let sr = 44100;
        let f = 128. * sr as f64 / BLOCK as f64; // exactly bin 128 (~2756 Hz)
        let block: Vec<f64> = (0..BLOCK).map(|i| (2. * PI * f * i as f64 / sr as f64).sin()).collect();
        let (rms, bands) = band_levels(&Fft::new(BLOCK), &block, sr);
        assert!((rms - 0.5f64.sqrt()).abs() < 1e-9);
        // Tone lands in band 12 (bins 108..=152): 5 mainlobe bins (-13.6 dB peak) plus ~40 bins at the -240 dB floor.
        assert!((bands[12] + 218.4).abs() < 1., "{}", bands[12]);
        assert!(bands[2] < -239.9, "{}", bands[2]);
        assert_eq!(bands.len(), 16);
    }
}
