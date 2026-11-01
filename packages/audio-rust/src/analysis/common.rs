use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::PI;
pub const SR: f64 = 22050.;
pub const RATE: f64 = 20.;
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}
pub fn clamp(x: f64) -> f64 {
    x.clamp(0., 1.)
}
pub fn rounded(x: f64, scale: f64) -> f64 {
    round(x * scale) / scale
}
pub fn median(a: &[f64]) -> f64 {
    if a.is_empty() {
        return 0.;
    }
    let mut s = a.to_vec();
    s.sort_by(f64::total_cmp);
    let m = s.len() / 2;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.
    }
}
pub fn percentile(a: &[f64], p: f64) -> f64 {
    if a.is_empty() {
        return 0.;
    }
    let mut s = a.to_vec();
    s.sort_by(f64::total_cmp);
    s[((s.len() - 1) as f64 * p).floor().max(0.) as usize]
}
pub fn smooth(a: &[f64], radius: usize) -> Vec<f64> {
    let mut out = vec![0.; a.len()];
    let (mut s, mut lo, mut hi) = (0., 0, 0);
    for i in 0..a.len() {
        while hi < a.len().min(i + radius + 1) {
            s += a[hi];
            hi += 1;
        }
        while lo < i.saturating_sub(radius) {
            s -= a[lo];
            lo += 1;
        }
        out[i] = s / (hi - lo) as f64;
    }
    out
}
pub fn curve_mean(curve: &[f64], rate: f64, a: f64, b: f64) -> f64 {
    let from = (a * rate).floor().max(0.) as usize;
    let to = (b * rate).ceil().max((from + 1) as f64) as usize;
    let to = to.min(curve.len());
    if to > from {
        curve[from..to].iter().sum::<f64>() / (to - from) as f64
    } else {
        0.
    }
}
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut d, mut na, mut nb) = (0., 0., 0.);
    for i in 0..a.len() {
        d += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    d / (na * nb).max(1e-12).sqrt()
}
pub fn get(a: &[f32], i: i64) -> f64 {
    if i < 0 {
        0.
    } else {
        a.get(i as usize).copied().unwrap_or(0.) as f64
    }
}
pub fn interp(a: &[f32], x: f64) -> f64 {
    let i = x.floor() as i64;
    let f = x - i as f64;
    if i < 0 || i + 1 >= a.len() as i64 {
        0.
    } else {
        a[i as usize] as f64 * (1. - f) + a[i as usize + 1] as f64 * f
    }
}
pub struct Fft {
    n: usize,
    rev: Vec<usize>,
    cos: Vec<f64>,
    sin: Vec<f64>,
}
impl Fft {
    pub fn new(n: usize) -> Self {
        let bits = n.ilog2();
        Self {
            n,
            rev: (0..n)
                .map(|i| i.reverse_bits() >> (usize::BITS - bits))
                .collect(),
            cos: (0..n / 2)
                .map(|i| (-2. * PI * i as f64 / n as f64).cos())
                .collect(),
            sin: (0..n / 2)
                .map(|i| (-2. * PI * i as f64 / n as f64).sin())
                .collect(),
        }
    }
    pub fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i];
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            for start in (0..n).step_by(size) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let xr = re[b] * wr - im[b] * wi;
                    let xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
            size *= 2;
        }
    }
    pub fn inverse(&self, re: &mut [f64], im: &mut [f64]) {
        for v in im.iter_mut() {
            *v = -*v;
        }
        self.forward(re, im);
        for i in 0..self.n {
            re[i] /= self.n as f64;
            im[i] = -im[i] / self.n as f64;
        }
    }
}
pub fn autocorrelate(x: &[f32], max_lag: usize) -> Vec<f64> {
    let n = (x.len() * 2).max(2).next_power_of_two();
    let fft = Fft::new(n);
    let mut re = vec![0.; n];
    let mut im = vec![0.; n];
    for (i, v) in x.iter().enumerate() {
        re[i] = *v as f64;
    }
    fft.forward(&mut re, &mut im);
    for i in 0..n {
        re[i] = re[i] * re[i] + im[i] * im[i];
        im[i] = 0.;
    }
    fft.inverse(&mut re, &mut im);
    re[..max_lag.min(n - 1) + 1].to_vec()
}
pub fn hann(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2. * PI * i as f64 / n as f64).cos())
        .collect()
}
#[derive(Clone, Copy)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}
#[derive(Clone)]
pub struct Biquad {
    c: Coefs,
    z1: f64,
    z2: f64,
}
impl Biquad {
    pub fn new(c: Coefs) -> Self {
        Self { c, z1: 0., z2: 0. }
    }
    pub fn step(&mut self, x: f64) -> f64 {
        let c = self.c;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
    pub fn buffer(&mut self, x: &mut [f32]) {
        for v in x {
            *v = self.step(*v as f64) as f32;
        }
    }
}
pub fn filter(sr: f64, f: f64, high: bool) -> Coefs {
    let w = 2. * PI * f / sr;
    let c = w.cos();
    let a = w.sin() / (2. * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1. + a;
    let (b0, b1, b2) = if high {
        ((1. + c) / 2., -(1. + c), (1. + c) / 2.)
    } else {
        ((1. - c) / 2., 1. - c, (1. - c) / 2.)
    };
    Coefs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: -2. * c / a0,
        a2: (1. - a) / a0,
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub bpm: f64,
    pub score: f64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub bpm: f64,
    pub confidence: f64,
    pub period: f64,
    pub stable: bool,
    pub jitter_ms: f64,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub downbeat_confidence: f64,
    pub downbeat_phase: usize,
    pub alternatives: Vec<Alternative>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accents: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attacks: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Key {
    pub tonic: i32,
    pub mode: String,
    pub name: String,
    pub camelot: String,
    pub confidence: f64,
}
pub fn camelot(t: usize, minor: bool) -> String {
    let n = if minor {
        [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10][t]
    } else {
        [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1][t]
    };
    format!("{}{}", n, if minor { 'A' } else { 'B' })
}
pub fn compatibility(a: &str, b: &str) -> f64 {
    if a.len() < 2 || b.len() < 2 {
        return 0.5;
    }
    let (Ok(na), Ok(nb)) = (
        a[..a.len() - 1].parse::<i32>(),
        b[..b.len() - 1].parse::<i32>(),
    ) else {
        return 0.5;
    };
    let d = (na - nb + 12)
        .rem_euclid(12)
        .min((nb - na + 12).rem_euclid(12));
    if a.as_bytes().last() == b.as_bytes().last() {
        match d {
            0 => 1.,
            1 => 0.85,
            2 => 0.55,
            7 => 0.45,
            _ => (0.4 - d as f64 * 0.06).max(0.05),
        }
    } else {
        match d {
            0 => 0.85,
            1 => 0.55,
            _ => (0.35 - d as f64 * 0.05).max(0.05),
        }
    }
}
pub fn estimate_key(chroma: &[f64]) -> Key {
    let unknown = |confidence| Key {
        tonic: -1,
        mode: "unknown".into(),
        name: "unknown".into(),
        camelot: String::new(),
        confidence,
    };
    let total: f64 = chroma.iter().sum();
    if total <= 0. {
        return unknown(0.);
    }
    let mean = total / 12.;
    let var = chroma.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / 12.;
    let profiles = [
        [
            6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
        ],
        [
            6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
        ],
    ];
    let mut cands = Vec::new();
    for t in 0..12 {
        for (m, p) in profiles.iter().enumerate() {
            let mp = p.iter().sum::<f64>() / 12.;
            let (mut num, mut dx, mut dp) = (0., 0., 0.);
            for i in 0..12 {
                let a = chroma[(i + t) % 12] - mean;
                let b = p[i] - mp;
                num += a * b;
                dx += a * a;
                dp += b * b;
            }
            cands.push((t, m, num / (dx * dp).max(1e-12).sqrt()));
        }
    }
    cands.sort_by(|a, b| b.2.total_cmp(&a.2));
    let best = cands[0];
    let code = camelot(best.0, best.1 == 1);
    let rival = cands
        .iter()
        .find(|c| compatibility(&code, &camelot(c.0, c.1 == 1)) < 0.8);
    let margin = rival.map_or(best.2, |r| best.2 - r.2);
    let confidence =
        clamp(margin / 0.25 * clamp((best.2 - 0.3) / 0.4) * (var.sqrt() / mean / 0.25).min(1.));
    if best.2 < 0.35 || confidence < 0.08 {
        return unknown(confidence);
    }
    let mode = if best.1 == 1 { "minor" } else { "major" };
    Key {
        tonic: best.0 as i32,
        mode: mode.into(),
        name: format!(
            "{} {}",
            [
                "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
            ][best.0],
            mode
        ),
        camelot: code,
        confidence,
    }
}
