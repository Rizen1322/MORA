use super::common::*;
use serde_json::{Value, json};
use std::f64::consts::PI;
fn weighting(fs: f64) -> [Coefs; 2] {
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (PI * f0 / fs).tan();
    let vh = 10f64.powf(g / 20.);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1. + k / q + k * k;
    let shelf = Coefs {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2. * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2. * (k * k - 1.) / a0,
        a2: (1. - k / q + k * k) / a0,
    };
    let q = 0.5003270373238773;
    let k = (PI * 38.13547087602444 / fs).tan();
    let a0 = 1. + k / q + k * k;
    let hp = Coefs {
        b0: 1.,
        b1: -2.,
        b2: 1.,
        a1: 2. * (k * k - 1.) / a0,
        a2: (1. - k / q + k * k) / a0,
    };
    [shelf, hp]
}
fn bessel(x: f64) -> f64 {
    let (mut sum, mut term) = (1., 1.);
    for k in 1..30 {
        term *= (x / (2. * k as f64)).powi(2);
        sum += term;
    }
    sum
}
pub struct Meter {
    filters: [[Biquad; 2]; 2],
    ring: [Vec<f64>; 2],
    sums: [f64; 2],
    ring_pos: usize,
    filled: usize,
    since: usize,
    blocks: Vec<f64>,
    peak: f64,
    tp: f64,
    hist: [[f64; 24]; 2],
    hist_pos: usize,
    kernel: [[f64; 24]; 3],
}
impl Meter {
    pub fn new() -> Self {
        let c = weighting(44100.);
        let kernel = std::array::from_fn(|phase| {
            let mut h = std::array::from_fn(|j| {
                let d = 12. - j as f64 - (phase + 1) as f64 / 4.;
                let u = d / 12.25;
                let sinc = if d == 0. {
                    1.
                } else {
                    (PI * d).sin() / (PI * d)
                };
                sinc * bessel(6. * (1. - u * u).sqrt())
            });
            let sum = h.iter().sum::<f64>();
            for v in &mut h {
                *v /= sum;
            }
            h
        });
        Self {
            filters: std::array::from_fn(|_| [Biquad::new(c[0]), Biquad::new(c[1])]),
            ring: std::array::from_fn(|_| vec![0.; 17640]),
            sums: [0.; 2],
            ring_pos: 0,
            filled: 0,
            since: 0,
            blocks: vec![],
            peak: 0.,
            tp: 0.,
            hist: [[0.; 24]; 2],
            hist_pos: 0,
            kernel,
        }
    }
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        for i in 0..l.len() {
            for (c, chan) in [l, r].iter().enumerate() {
                let x = chan[i] as f64;
                self.peak = self.peak.max(x.abs());
                self.hist[c][self.hist_pos] = x;
                let near = self.hist[c][(self.hist_pos + 12) % 24]
                    .abs()
                    .max(self.hist[c][(self.hist_pos + 13) % 24].abs());
                if near > self.tp * 0.5 {
                    for kernel in &self.kernel {
                        let mut acc = 0.;
                        for j in 0..24 {
                            acc += kernel[j] * self.hist[c][(self.hist_pos + 24 - j) % 24];
                        }
                        self.tp = self.tp.max(acc.abs());
                    }
                }
                let y = self.filters[c][0].step(x);
                let y = self.filters[c][1].step(y);
                let sq = y * y;
                self.sums[c] += sq - self.ring[c][self.ring_pos];
                self.ring[c][self.ring_pos] = sq;
            }
            self.hist_pos = (self.hist_pos + 1) % 24;
            self.ring_pos = (self.ring_pos + 1) % 17640;
            self.filled = (self.filled + 1).min(17640);
            self.since += 1;
            if self.filled == 17640 && self.since >= 4410 {
                self.since = 0;
                self.blocks
                    .push(self.sums.iter().map(|s| s.max(0.) / 17640.).sum());
            }
        }
    }
    pub fn result(&self) -> Value {
        let to_l = |z: f64| -0.691 + 10. * z.max(1e-12).log10();
        let abs: Vec<_> = self
            .blocks
            .iter()
            .copied()
            .filter(|z| to_l(*z) > -70.)
            .collect();
        let mut lufs = -70.;
        if !abs.is_empty() {
            let mean = abs.iter().sum::<f64>() / abs.len() as f64;
            let rel = to_l(mean) - 10.;
            let gated: Vec<_> = abs.iter().copied().filter(|z| to_l(*z) > rel).collect();
            if !gated.is_empty() {
                lufs = to_l(gated.iter().sum::<f64>() / gated.len() as f64);
            }
        }
        json!({"integratedLufs":lufs,"samplePeakDb":20.*self.peak.max(1e-9).log10(),"truePeakDb":20.*self.tp.max(self.peak).max(1e-9).log10()})
    }
}
pub struct Decimator {
    h: [f64; 31],
    buf: [f64; 62],
    pos: usize,
    phase: usize,
}
impl Decimator {
    pub fn new() -> Self {
        let mut h = std::array::from_fn(|i| {
            let x = (i as f64 - 15.) / 2.;
            let s = if x == 0. {
                1.
            } else {
                (PI * x).sin() / (PI * x)
            };
            s * (0.54 - 0.46 * (2. * PI * i as f64 / 30.).cos())
        });
        let sum = h.iter().sum::<f64>();
        for v in &mut h {
            *v /= sum;
        }
        Self {
            h,
            buf: [0.; 62],
            pos: 0,
            phase: 0,
        }
    }
    pub fn push(&mut self, x: &[f32], mut out: impl FnMut(f64)) {
        for &v in x {
            self.buf[self.pos] = v as f64;
            self.buf[self.pos + 31] = v as f64;
            self.pos = (self.pos + 1) % 31;
            self.phase ^= 1;
            if self.phase == 0 {
                let mut acc = 0.;
                for k in 0..31 {
                    acc += self.h[k] * self.buf[self.pos + k];
                }
                out(acc);
            }
        }
    }
}
pub struct AnalysisAccumulator {
    meter: Meter,
    dec: Decimator,
    side_dec: Decimator,
    side_lp: [Biquad; 2],
    mono: Vec<f32>,
    l: Vec<f32>,
    r: Vec<f32>,
    tmp: Vec<f32>,
    side: Vec<f32>,
    side_len: usize,
    power: Vec<f64>,
    low: Vec<f64>,
    frames: usize,
    guard: bool,
}
impl AnalysisAccumulator {
    pub fn new(expected_seconds: f64) -> Self {
        let c = filter(SR, 150., false);
        Self {
            meter: Meter::new(),
            dec: Decimator::new(),
            side_dec: Decimator::new(),
            side_lp: [Biquad::new(c), Biquad::new(c)],
            mono: Vec::with_capacity(
                (expected_seconds.clamp(0., 600.) * SR).ceil() as usize + 1024,
            ),
            l: Vec::with_capacity(65536),
            r: Vec::with_capacity(65536),
            tmp: vec![0.; 65536],
            side: vec![0.; 65536],
            side_len: 0,
            power: vec![],
            low: vec![],
            frames: 0,
            guard: false,
        }
    }
    pub fn push(&mut self, l: &[f32], r: &[f32]) -> Result<(), String> {
        if l.len() != r.len() {
            return Err("PCM channel lengths do not match the block size".into());
        }
        if l.iter().chain(r).any(|v| !v.is_finite()) {
            return Err("PCM contains non-finite samples".into());
        }
        let mut i = 0;
        while i < l.len() {
            let n = (l.len() - i).min(65536 - self.l.len());
            self.l.extend_from_slice(&l[i..i + n]);
            self.r.extend_from_slice(&r[i..i + n]);
            i += n;
            if self.l.len() == 65536 {
                self.flush();
            }
        }
        self.frames += l.len();
        Ok(())
    }
    fn flush(&mut self) {
        let n = self.l.len();
        if n == 0 {
            return;
        }
        let (mut mp, mut lp, mut rp) = (0., 0., 0.);
        for i in 0..n {
            let l = self.l[i] as f64;
            let r = self.r[i] as f64;
            let mid = (l + r) * 0.5;
            self.tmp[i] = mid as f32;
            self.side[i] = ((l - r) * 0.5) as f32;
            mp += mid * mid;
            lp += l * l;
            rp += r * r;
        }
        if mp < lp.max(rp) * 0.05 && lp.max(rp) > 1e-12 {
            self.tmp[..n].copy_from_slice(if lp >= rp { &self.l } else { &self.r });
            self.guard = true;
            self.side[..n].fill(0.);
        }
        let side_len = &mut self.side_len;
        let power = &mut self.power;
        let low = &mut self.low;
        let filters = &mut self.side_lp;
        self.side_dec.push(&self.side[..n], |v| {
            let l = filters[0].step(v);
            let l = filters[1].step(l);
            let c = (*side_len as f64 * RATE / SR).floor() as usize;
            *side_len += 1;
            if power.len() <= c {
                power.resize(c + 1, 0.);
                low.resize(c + 1, 0.);
            }
            power[c] += v * v;
            low[c] += l * l;
        });
        self.meter.push(&self.l, &self.r);
        self.dec.push(&self.tmp[..n], |v| self.mono.push(v as f32));
        self.l.clear();
        self.r.clear();
    }
    pub fn finish(mut self) -> Result<Value, String> {
        self.flush();
        if self.frames == 0 {
            return Err("PCM contains no frames".into());
        }
        let per = |sums: &[f64]| {
            sums.iter()
                .enumerate()
                .map(|(c, s)| {
                    (s / ((((c + 1) as f64 * SR / RATE).floor() - (c as f64 * SR / RATE).floor())
                        .max(1.))) as f32
                })
                .collect::<Vec<_>>()
        };
        let side = super::Side {
            power: per(&self.power),
            low: per(&self.low),
        };
        let mut result = super::analyze_mono(
            &self.mono,
            self.meter.result(),
            self.frames as f64 / 44100.,
            Some(&side),
        );
        if self.guard {
            result["warnings"]
                .as_array_mut()
                .unwrap()
                .push(json!("stereo-cancellation-guard"));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_preserves_fixed_stereo_guard_windows() {
        let l: Vec<f32> = (0..70013)
            .map(|i| (i as f64 * 0.031).sin() as f32 * 0.2)
            .collect();
        let r: Vec<f32> = l
            .iter()
            .enumerate()
            .map(|(i, x)| if i < 65536 { -*x } else { *x * 0.8 })
            .collect();
        let mut whole = AnalysisAccumulator::new(2.);
        whole.push(&l, &r).unwrap();
        let mut expected = whole.finish().unwrap();
        expected.as_object_mut().unwrap().remove("elapsedMs");
        assert!(
            expected["warnings"]
                .as_array()
                .unwrap()
                .contains(&json!("stereo-cancellation-guard"))
        );
        for block in [1, 8192, 65536] {
            let mut streamed = AnalysisAccumulator::new(0.);
            for (left, right) in l.chunks(block).zip(r.chunks(block)) {
                streamed.push(left, right).unwrap();
            }
            let mut actual = streamed.finish().unwrap();
            actual.as_object_mut().unwrap().remove("elapsedMs");
            assert_eq!(actual, expected, "block size {block}");
        }
    }

    #[test]
    fn invalid_blocks_do_not_mutate_the_accumulator() {
        let mut a = AnalysisAccumulator::new(0.);
        assert!(a.push(&[0.], &[]).is_err());
        assert!(a.push(&[f32::NAN], &[0.]).is_err());
        assert!(a.push(&[0.], &[f32::INFINITY]).is_err());
        assert!(a.finish().is_err());
    }
}
