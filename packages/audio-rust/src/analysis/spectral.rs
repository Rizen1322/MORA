use super::common::*;
pub const FRAME: usize = 2048;
pub const HOP: usize = 256;
pub const MEL_BANDS: usize = 24;
pub struct Spectral {
    pub fps: f64,
    pub frames: usize,
    pub flux_low: Vec<f32>,
    pub flux_mid: Vec<f32>,
    pub flux_high: Vec<f32>,
    pub pow_low: Vec<f32>,
    pub pow_mid: Vec<f32>,
    pub pow_high: Vec<f32>,
    pub centroid: Vec<f32>,
    pub mid_density: Vec<f32>,
    pub chroma: Vec<f32>,
    pub chroma_fps: f64,
    pub chroma_frames: usize,
    pub mel: Vec<f32>,
    pub rms_db: Vec<f32>,
    pub peaks: Vec<f32>,
}
pub fn power_db(p: f64) -> f64 {
    10. * (p + 1e-12).log10()
}
pub fn compute(x: &[f32]) -> Spectral {
    let fft = Fft::new(FRAME);
    let win = hann(FRAME);
    let bins = FRAME / 2 + 1;
    let frames = if x.len() < FRAME {
        1
    } else {
        (x.len() - FRAME) / HOP + 1
    };

    let mut sp = Spectral {
        fps: SR / HOP as f64,
        frames,
        flux_low: vec![0.; frames],
        flux_mid: vec![0.; frames],
        flux_high: vec![0.; frames],
        pow_low: vec![0.; frames],
        pow_mid: vec![0.; frames],
        pow_high: vec![0.; frames],
        centroid: vec![0.; frames],
        mid_density: vec![0.; frames],
        chroma: vec![0.; frames.div_ceil(4) * 12],
        chroma_fps: SR / HOP as f64 / 4.,
        chroma_frames: frames.div_ceil(4),
        mel: vec![0.; frames * MEL_BANDS],
        rms_db: vec![0.; (x.len() as f64 * RATE / SR).ceil() as usize],
        peaks: vec![0.; (x.len() as f64 * RATE / SR).ceil() as usize],
    };
    let (mut re, mut im, mut prev, mut cur) = (
        vec![0.; FRAME],
        vec![0.; FRAME],
        vec![0.; bins],
        vec![0.; bins],
    );
    let bh = SR / FRAME as f64;
    let bin = |hz: f64| (round(hz / bh) as usize).clamp(1, bins - 1);
    let (bl0, bl1, bm1, bh1, bd0, bd1) = (
        bin(30.),
        bin(150.),
        bin(2500.),
        bin(10000.),
        bin(250.),
        bin(4000.),
    );
    let to_mel = |hz: f64| 2595. * (1. + hz / 700.).log10();
    let mel_lo = to_mel(40.);
    let mel_step = (to_mel(8000.) - mel_lo) / 25.;
    let mut mel_band = vec![-2i32; bins];
    let mut mel_frac = vec![0f32; bins];
    for k in 1..bins {
        let pos = (to_mel(k as f64 * bh) - mel_lo) / mel_step;
        if !(0. ..25.).contains(&pos) {
            continue;
        }
        mel_band[k] = pos.floor() as i32;
        mel_frac[k] = (pos - pos.floor()) as f32;
    }
    let cf = 4096;
    let cfft = Fft::new(cf);
    let cwin = hann(cf);
    let (mut cre, mut cim) = (vec![0.; cf], vec![0.; cf]);
    let cbh = SR / cf as f64;
    let cmin = (110. / cbh).ceil() as usize;
    let cmax = (3520. / cbh).floor() as usize;
    let mut pc = vec![0usize; cmax + 1];
    let mut pcw = vec![0f32; cmax + 1];
    for k in cmin..=cmax {
        let midi = 69. + 12. * (k as f64 * cbh / 440.).log2();
        let r = round(midi);
        pc[k] = (r as i64).rem_euclid(12) as usize;
        pcw[k] = (1. - 2. * (midi - r).abs()).max(0.) as f32;
    }
    let mut cmag = vec![0.; cf / 2 + 1];
    for f in 0..frames {
        let off = f * HOP;
        for i in 0..FRAME {
            re[i] = x.get(off + i).copied().unwrap_or(0.) as f64 * win[i];
            im[i] = 0.;
        }
        fft.forward(&mut re, &mut im);
        let (
            mut pl,
            mut pm,
            mut ph,
            mut num,
            mut den,
            mut fl,
            mut fm,
            mut fh,
            mut dsum,
            mut dlog,
            mut total,
        ) = (0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.);
        for k in 1..bins {
            let mag = (re[k] * re[k] + im[k] * im[k]).sqrt() / (FRAME as f64 / 2.);
            let p = mag * mag;
            total += p;
            let c = (100. * mag).ln_1p();
            cur[k] = c;
            let d = c - prev[k];
            if k >= bl0 && k < bl1 {
                pl += p;
                if d > 0. {
                    fl += d;
                }
            } else if k >= bl1 && k < bm1 {
                pm += p;
                if d > 0. {
                    fm += d;
                }
            } else if k >= bm1 && k < bh1 {
                ph += p;
                if d > 0. {
                    fh += d;
                }
            }
            if k >= bd0 && k < bd1 {
                dsum += p;
                dlog += (p + 1e-14).ln();
            }
            num += k as f64 * bh * p;
            den += p;
            let mb = mel_band[k];
            if mb >= 1 {
                let at = f * 24 + mb as usize - 1;
                sp.mel[at] = (sp.mel[at] as f64 + p * (1. - mel_frac[k] as f64)) as f32;
            }
            if (0..24).contains(&mb) {
                let at = f * 24 + mb as usize;
                sp.mel[at] = (sp.mel[at] as f64 + p * mel_frac[k] as f64) as f32;
            }
        }
        prev.copy_from_slice(&cur);
        sp.flux_low[f] = fl as f32;
        sp.flux_mid[f] = (fm / 4.) as f32;
        sp.flux_high[f] = (fh / 8.) as f32;
        sp.pow_low[f] = pl as f32;
        sp.pow_mid[f] = pm as f32;
        sp.pow_high[f] = ph as f32;
        sp.centroid[f] = if den > 0. { (num / den) as f32 } else { 0. };
        let nd = (bd1 - bd0) as f64;
        let flat = if dsum > 0. {
            (dlog / nd).exp() / (dsum / nd)
        } else {
            1.
        };
        let share = if total > 0. { dsum / total } else { 0. };
        sp.mid_density[f] = if total > 1e-9 {
            ((1. - flat.powf(0.25)) * (share * 1.6).min(1.)).min(1.) as f32
        } else {
            0.
        };
        if f % 4 == 0 {
            let coff = off as i64 + FRAME as i64 / 2 - cf as i64 / 2;
            for i in 0..cf {
                let idx = coff + i as i64;
                cre[i] = get(x, idx) * cwin[i];
                cim[i] = 0.;
            }
            cfft.forward(&mut cre, &mut cim);
            for k in 1..=cmax {
                cmag[k] = (cre[k] * cre[k] + cim[k] * cim[k]).sqrt();
            }
            for k in cmin..=cmax {
                let mag = cmag[k];
                let k3 = round(k as f64 / 3.) as usize;
                let k5 = round(k as f64 / 5.) as usize;
                let h3 = cmag[k3].max(cmag[k3 + 1]).max(cmag[k3.saturating_sub(1)]);
                let h5 = cmag[k5].max(cmag[k5 + 1]);
                let mut w = 1.;
                if h3 > mag * 0.6 {
                    w *= 0.25;
                }
                if h5 > mag * 0.6 {
                    w *= 0.5;
                }
                let at = f / 4 * 12 + pc[k];
                sp.chroma[at] =
                    (sp.chroma[at] as f64 + (10. * mag).ln_1p() * pcw[k] as f64 * w) as f32;
            }
        }
    }
    for c in 0..sp.rms_db.len() {
        let a = (c as f64 * SR / RATE).floor() as usize;
        let b = x.len().min(((c + 1) as f64 * SR / RATE).floor() as usize);
        let (mut s, mut pk) = (0., 0f64);
        for &v in &x[a..b] {
            s += (v as f64).powi(2);
            pk = pk.max((v as f64).abs());
        }
        sp.rms_db[c] = power_db(s / (b - a).max(1) as f64) as f32;
        sp.peaks[c] = pk as f32;
    }
    sp
}
pub fn to_curve(a: &[f32], fps: f64, n: usize) -> Vec<f64> {
    let centre = FRAME as f64 / 2. / SR;
    (0..n)
        .map(|c| {
            let t0 = c as f64 / RATE;
            let t1 = (c + 1) as f64 / RATE;
            let from = ((t0 - centre) * fps).floor().max(0.) as usize;
            let to = (((t1 - centre) * fps).ceil().max((from + 1) as f64) as usize).min(a.len());
            if to > from {
                a[from..to].iter().map(|v| *v as f64).sum::<f64>() / (to - from) as f64
            } else {
                0.
            }
        })
        .collect()
}
pub fn chroma_mean(sp: &Spectral, t0: f64, a: f64, b: f64) -> Vec<f64> {
    let from = ((a - t0) * sp.chroma_fps).floor().max(0.) as usize;
    let to =
        (((b - t0) * sp.chroma_fps).ceil().max((from + 1) as f64) as usize).min(sp.chroma_frames);
    let mut out = vec![0.; 12];
    for i in from..to {
        for k in 0..12 {
            out[k] += sp.chroma[i * 12 + k] as f64;
        }
    }
    let n = to.saturating_sub(from).max(1) as f64;
    for v in &mut out {
        *v /= n;
    }
    out
}
