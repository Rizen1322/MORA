use crate::wsola::round;
use serde_json::Value;
use std::f64::consts::{FRAC_1_SQRT_2, PI, SQRT_2};

#[derive(Clone, Copy, Default)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}
fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefs {
    Coefs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}
fn filter(sr: f64, f: f64, mode: u8) -> Coefs {
    let w = 2. * PI * f / sr;
    let c = w.cos();
    let a = w.sin() / (2. * FRAC_1_SQRT_2);
    match mode {
        0 => norm(
            (1. - c) / 2.,
            1. - c,
            (1. - c) / 2.,
            1. + a,
            -2. * c,
            1. - a,
        ),
        1 => norm(
            (1. + c) / 2.,
            -(1. + c),
            (1. + c) / 2.,
            1. + a,
            -2. * c,
            1. - a,
        ),
        _ => norm(1. - a, -2. * c, 1. + a, 1. + a, -2. * c, 1. - a),
    }
}
fn peaking(sr: f64, f: f64, gain: f64) -> Coefs {
    let a = 10f64.powf(gain / 40.);
    let w = 2. * PI * f / sr;
    let c = w.cos();
    let alpha = w.sin() / (2. * SQRT_2);
    norm(
        1. + alpha * a,
        -2. * c,
        1. - alpha * a,
        1. + alpha / a,
        -2. * c,
        1. - alpha / a,
    )
}
fn magnitude(c: Coefs, sr: f64, f: f64) -> f64 {
    let w = 2. * PI * f / sr;
    let (cr, ci, c2r, c2i) = (w.cos(), -w.sin(), (2. * w).cos(), -(2. * w).sin());
    let (nr, ni) = (c.b0 + c.b1 * cr + c.b2 * c2r, c.b1 * ci + c.b2 * c2i);
    let (dr, di) = (1. + c.a1 * cr + c.a2 * c2r, c.a1 * ci + c.a2 * c2i);
    ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
}
#[derive(Clone, Copy, Default)]
pub struct Biquad {
    pub c: Coefs,
    z1: f64,
    z2: f64,
}
impl Biquad {
    pub fn step(&mut self, x: f64) -> f64 {
        let c = self.c;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
    fn new(c: Coefs) -> Self {
        Self {
            c,
            ..Self::default()
        }
    }
    fn reset(&mut self) {
        self.z1 = 0.;
        self.z2 = 0.;
    }
}
struct Splitter {
    b: [Biquad; 11],
}
impl Splitter {
    fn new(sr: f64) -> Self {
        let l = filter(sr, 180., 0);
        let h = filter(sr, 180., 1);
        let l2 = filter(sr, 2500., 0);
        let h2 = filter(sr, 2500., 1);
        Self {
            b: [
                l,
                l,
                h,
                h,
                l2,
                l2,
                h2,
                h2,
                filter(sr, 2500., 2),
                filter(sr, 180., 2),
                filter(sr, 2500., 2),
            ]
            .map(Biquad::new),
        }
    }
    fn full(&mut self, x: f64, g: [f64; 3]) -> f64 {
        let b = &mut self.b;
        let v = b[0].step(x);
        let v = b[1].step(v);
        let low = b[8].step(v);
        let v = b[2].step(x);
        let rest = b[3].step(v);
        let v = b[4].step(rest);
        let mid = b[5].step(v);
        let v = b[6].step(rest);
        let high = b[7].step(v);
        g[0] * low + g[1] * mid + g[2] * high
    }
    fn unity(&mut self, x: f64) -> f64 {
        let v = self.b[9].step(x);
        self.b[10].step(v)
    }
}
pub struct Isolator {
    l: Splitter,
    r: Splitter,
    warm: f64,
    full: f64,
    uni: f64,
}
impl Isolator {
    pub fn new(sr: f64) -> Self {
        Self {
            l: Splitter::new(sr),
            r: Splitter::new(sr),
            warm: round(sr * 0.05),
            full: f64::INFINITY,
            uni: f64::INFINITY,
        }
    }
    pub fn reset(&mut self) {
        for b in self.l.b.iter_mut().chain(self.r.b.iter_mut()) {
            b.reset();
        }
        self.full = f64::INFINITY;
        self.uni = f64::INFINITY;
    }
    pub fn process(
        &mut self,
        l: &mut [f32],
        r: &mut [f32],
        from: [f64; 3],
        to: [f64; 3],
        idle: bool,
    ) {
        let n = l.len() as f64;
        if n == 0. {
            return;
        }
        let unity = from == [1.; 3] && to == [1.; 3];
        let use_uni = unity && self.uni >= self.warm && (idle || self.full < self.warm);
        let run_full = !use_uni || (!idle && self.full < self.warm);
        let run_uni = use_uni || (unity && idle && self.uni < self.warm);
        self.full = if run_full { self.full + n } else { 0. };
        self.uni = if run_uni { self.uni + n } else { 0. };
        let mut g = from;
        let delta = std::array::from_fn::<_, 3, _>(|i| (to[i] - from[i]) / n);
        for i in 0..l.len() {
            let (xl, xr) = (l[i] as f64, r[i] as f64);
            let (ul, ur) = if run_uni {
                (self.l.unity(xl), self.r.unity(xr))
            } else {
                (0., 0.)
            };
            let (fl, fr) = if run_full {
                (self.l.full(xl, g), self.r.full(xr, g))
            } else {
                (0., 0.)
            };
            l[i] = if use_uni { ul } else { fl } as f32;
            r[i] = if use_uni { ur } else { fr } as f32;
            for k in 0..3 {
                g[k] += delta[k];
            }
        }
    }
}

pub struct Sweep {
    sr: f64,
    smoothing: f64,
    value: f64,
    l1: f64,
    l2: f64,
    r1: f64,
    r2: f64,
    mode: i32,
    control: i32,
    a1: f64,
    a2: f64,
    a3: f64,
}
impl Sweep {
    pub fn new(sr: f64) -> Self {
        Self {
            sr,
            smoothing: 1. - (-1. / (sr * 0.02)).exp(),
            value: 0.,
            l1: 0.,
            l2: 0.,
            r1: 0.,
            r2: 0.,
            mode: 1,
            control: 0,
            a1: 1.,
            a2: 0.,
            a3: 0.,
        }
    }
    pub fn reset(&mut self) {
        self.value = 0.;
        self.l1 = 0.;
        self.l2 = 0.;
        self.r1 = 0.;
        self.r2 = 0.;
        self.control = 0;
        self.mode = 1;
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], from: f64, to: f64) {
        let from = from.clamp(-1., 1.);
        let to = to.clamp(-1., 1.);
        if from == 0. && to == 0. && self.value.abs() < 1e-6 {
            self.reset();
            return;
        }
        let step = (to - from) / l.len().max(1) as f64;
        let mut target = from;
        for i in 0..l.len() {
            self.value += (target - self.value) * self.smoothing;
            target += step;
            let amount = self.value.abs();
            let mode = if self.value < 0. { -1 } else { 1 };
            if mode != self.mode {
                self.mode = mode;
                self.l1 = 0.;
                self.l2 = 0.;
                self.r1 = 0.;
                self.r2 = 0.;
                self.control = 0;
            }
            self.control -= 1;
            if self.control < 0 {
                let upper = self.sr * 0.45;
                let cutoff = if mode > 0 {
                    20. * ((6000f64.min(upper) / 20.).ln() * amount).exp()
                } else {
                    upper * ((180. / upper).ln() * amount).exp()
                };
                let g = (PI * cutoff / self.sr).tan();
                self.a1 = 1. / (1. + g * (g + SQRT_2));
                self.a2 = g * self.a1;
                self.a3 = g * self.a2;
                self.control = 15;
            }
            let (xl, xr) = (l[i] as f64, r[i] as f64);
            let (vl, vr) = (xl - self.l2, xr - self.r2);
            let (bl, br) = (
                self.a1 * self.l1 + self.a2 * vl,
                self.a1 * self.r1 + self.a2 * vr,
            );
            let (ll, lr) = (
                self.l2 + self.a2 * self.l1 + self.a3 * vl,
                self.r2 + self.a2 * self.r1 + self.a3 * vr,
            );
            self.l1 = 2. * bl - self.l1;
            self.r1 = 2. * br - self.r1;
            self.l2 = 2. * ll - self.l2;
            self.r2 = 2. * lr - self.r2;
            let wet = (amount / 0.08).min(1.);
            l[i] = (xl + ((if mode > 0 { xl - SQRT_2 * bl - ll } else { ll }) - xl) * wet) as f32;
            r[i] = (xr + ((if mode > 0 { xr - SQRT_2 * br - lr } else { lr }) - xr) * wet) as f32;
        }
    }
}
pub struct Echo {
    l: Vec<f32>,
    r: Vec<f32>,
    pos: usize,
    delay: usize,
    feedback: f64,
    hp: [f64; 2],
    hx: [f64; 2],
    lp: [f64; 2],
    ha: f64,
    la: f64,
    zeros: usize,
    out: f64,
    out_step: f64,
    deadline: Option<f64>,
    deadline_fade: f64,
}
impl Echo {
    pub fn new(sr: f64) -> Self {
        let n = (sr * 2.5).ceil() as usize;
        Self {
            l: vec![0.; n],
            r: vec![0.; n],
            pos: 0,
            delay: 1,
            feedback: 0.5,
            hp: [0.; 2],
            hx: [0.; 2],
            lp: [0.; 2],
            ha: (-2. * PI * 250. / sr).exp(),
            la: 1. - (-2. * PI * 6000. / sr).exp(),
            zeros: n,
            out: 1.,
            out_step: 0.,
            deadline: None,
            deadline_fade: 1.,
        }
    }
    pub fn reset(&mut self) {
        self.l.fill(0.);
        self.r.fill(0.);
        self.pos = 0;
        self.hp = [0.; 2];
        self.hx = [0.; 2];
        self.lp = [0.; 2];
        self.zeros = self.l.len();
        self.out = 1.;
        self.out_step = 0.;
        self.deadline = None;
    }
    pub fn configure(&mut self, delay: f64, feedback: f64) {
        self.reset();
        self.delay = (round(delay) as usize).clamp(1, self.l.len() - 1);
        // 0.85 keeps runaway away: the ring is high-passed (250 Hz) and low-passed (6 kHz) on every pass
        self.feedback = feedback.clamp(0., 0.85);
    }
    pub fn process(&mut self, il: &[f32], ir: &[f32], l: &mut [f32], r: &mut [f32]) {
        self.process_at(il, ir, l, r, 0.);
    }
    pub fn fade_out(&mut self, frames: f64) {
        self.out_step = 1. / frames.max(1.);
    }
    pub fn limit_tail_at(&mut self, frame: f64, fade: f64) {
        self.deadline = Some(frame);
        self.deadline_fade = fade.max(1.);
    }
    pub fn process_at(&mut self, il: &[f32], ir: &[f32], l: &mut [f32], r: &mut [f32], clock: f64) {
        if self.zeros >= self.l.len()
            && self.out_step == 0.
            && il.iter().chain(ir).all(|v| *v == 0.)
        {
            self.hp = [0.; 2];
            self.hx = [0.; 2];
            self.lp = [0.; 2];
            return;
        }
        for i in 0..l.len() {
            let tail = self.deadline.map_or(1., |end| {
                ((end - clock - i as f64) / self.deadline_fade).clamp(0., 1.)
            });
            if tail == 0. {
                return;
            }
            let at = (self.pos + self.l.len() - self.delay) % self.l.len();
            let y = [self.l[at] as f64, self.r[at] as f64];
            if self.out_step > 0. {
                self.out = (self.out - self.out_step).max(0.);
                if self.out == 0. {
                    self.reset();
                    return;
                }
            }
            l[i] = (l[i] as f64 + y[0] * self.out * tail) as f32;
            r[i] = (r[i] as f64 + y[1] * self.out * tail) as f32;
            for (c, &sample) in y.iter().enumerate() {
                let h = self.ha * (self.hp[c] + sample - self.hx[c]);
                self.hx[c] = sample;
                self.hp[c] = h;
                self.lp[c] += self.la * (h - self.lp[c]);
            }
            self.l[self.pos] = (il[i] as f64 + self.lp[0] * self.feedback) as f32;
            self.r[self.pos] = (ir[i] as f64 + self.lp[1] * self.feedback) as f32;
            self.zeros = if self.l[self.pos] == 0. && self.r[self.pos] == 0. {
                self.zeros + 1
            } else {
                0
            };
            self.pos = (self.pos + 1) % self.l.len();
        }
    }
}
struct Comb {
    data: Vec<f32>,
    index: usize,
    low: f64,
}
impl Comb {
    fn new(n: f64) -> Self {
        Self {
            data: vec![0.; (round(n) as usize).max(1)],
            index: 0,
            low: 0.,
        }
    }
    fn step(&mut self, input: f64) -> f64 {
        let v = self.data[self.index] as f64;
        self.low += (v - self.low) * 0.32;
        self.data[self.index] = (input + self.low * 0.72) as f32;
        self.index = (self.index + 1) % self.data.len();
        v
    }
    fn reset(&mut self) {
        self.data.fill(0.);
        self.index = 0;
        self.low = 0.;
    }
}
pub struct Reverb {
    l: [Comb; 4],
    r: [Comb; 4],
    mix: f64,
    pub target: f64,
    glide: f64,
    clean: bool,
}
impl Reverb {
    pub fn new(sr: f64) -> Self {
        Self {
            l: [0.0297, 0.0371, 0.0411, 0.0437].map(|s| Comb::new(s * sr)),
            r: [0.0302, 0.0383, 0.0403, 0.0451].map(|s| Comb::new(s * sr)),
            mix: 0.,
            target: 0.,
            glide: 1. - (-1. / (0.025 * sr)).exp(),
            clean: true,
        }
    }
    pub fn reset(&mut self) {
        for c in self.l.iter_mut().chain(self.r.iter_mut()) {
            c.reset();
        }
        self.clean = true;
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.target == 0. && self.mix < 1e-5 {
            self.mix = 0.;
            if !self.clean {
                self.reset();
            }
            return;
        }
        self.clean = false;
        for i in 0..l.len() {
            self.mix += (self.target - self.mix) * self.glide;
            let (xl, xr) = (l[i] as f64, r[i] as f64);
            let (mut wl, mut wr) = (0., 0.);
            for c in 0..4 {
                wl += self.l[c].step(xl * 0.85 + xr * 0.15);
                wr += self.r[c].step(xr * 0.85 + xl * 0.15);
            }
            l[i] = (xl * (1. - self.mix) + wl * 0.07 * self.mix) as f32;
            r[i] = (xr * (1. - self.mix) + wr * 0.07 * self.mix) as f32;
        }
    }
}
const BANDS: [f64; 10] = [
    31., 62., 125., 250., 500., 1000., 2000., 4000., 8000., 16000.,
];
pub fn number(v: &Value, k: &str, default: f64) -> f64 {
    v[k].as_f64().filter(|x| x.is_finite()).unwrap_or(default)
}
pub struct Tone {
    sr: f64,
    on: bool,
    gains: [f64; 10],
    cur: [f64; 10],
    c: [Option<Coefs>; 10],
    z: [[f64; 4]; 10],
    pre: f64,
    pre_target: f64,
    bal: f64,
    mono: f64,
    bal_target: f64,
    mono_target: f64,
    idle: bool,
}
impl Tone {
    pub fn new(sr: f64) -> Self {
        Self {
            sr,
            on: false,
            gains: [0.; 10],
            cur: [0.; 10],
            c: [None; 10],
            z: [[0.; 4]; 10],
            pre: 1.,
            pre_target: 1.,
            bal: 0.,
            mono: 0.,
            bal_target: 0.,
            mono_target: 0.,
            idle: true,
        }
    }
    pub fn reset(&mut self) {
        self.z = [[0.; 4]; 10];
    }
    pub fn set(&mut self, v: &Value, pre: Option<f64>) {
        self.on = v["enabled"] == true;
        self.gains = std::array::from_fn(|i| {
            round(v["gains"][i].as_f64().unwrap_or(0.).clamp(-12., 12.) * 10.) / 10.
        });
        let headroom = if v["autoHeadroom"] != false {
            let cs: Vec<_> = BANDS
                .iter()
                .zip(self.gains)
                .filter(|(f, g)| **f < self.sr * 0.45 && g.abs() > 0.01)
                .map(|(f, g)| peaking(self.sr, *f, g))
                .collect();
            (0..=480)
                .map(|k| {
                    let f = 20. * (20000f64.min(0.45 * self.sr) / 20.).powf(k as f64 / 480.);
                    20. * cs
                        .iter()
                        .map(|c| magnitude(*c, self.sr, f))
                        .product::<f64>()
                        .log10()
                })
                .fold(0., f64::max)
        } else {
            0.
        };
        let pre = pre
            .unwrap_or(number(v, "preampDb", 0.).clamp(-12., 6.) - headroom)
            .clamp(-36., 6.);
        self.pre_target = if self.on { 10f64.powf(pre / 20.) } else { 1. };
        self.bal_target = if self.on {
            number(v, "balance", 0.).clamp(-1., 1.)
        } else {
            0.
        };
        self.mono_target = if self.on && v["mono"] == true { 1. } else { 0. };
        self.idle = false;
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.idle {
            return;
        }
        for s in (0..l.len()).step_by(64) {
            let mut moving = false;
            for b in 0..10 {
                let goal = if self.on { self.gains[b] } else { 0. };
                let d = goal - self.cur[b];
                if d.abs() < 1e-6 {
                    continue;
                }
                moving = true;
                self.cur[b] += d.clamp(-0.5, 0.5);
                let was = self.c[b].is_some();
                self.c[b] = if BANDS[b] < self.sr * 0.45 && self.cur[b].abs() > 0.01 {
                    Some(peaking(self.sr, BANDS[b], self.cur[b]))
                } else {
                    None
                };
                if !was && self.c[b].is_some() {
                    self.z[b] = [0.; 4];
                }
            }
            if !moving
                && !self.on
                && self.bal == self.bal_target
                && self.mono == self.mono_target
                && self.pre == self.pre_target
            {
                self.idle = true;
            }
            let e = (s + 64).min(l.len());
            for b in 0..10 {
                let Some(c) = self.c[b] else {
                    continue;
                };
                let z = &mut self.z[b];
                for i in s..e {
                    let xl = l[i] as f64;
                    let yl = c.b0 * xl + z[0];
                    z[0] = c.b1 * xl - c.a1 * yl + z[1];
                    z[1] = c.b2 * xl - c.a2 * yl;
                    l[i] = yl as f32;
                    let xr = r[i] as f64;
                    let yr = c.b0 * xr + z[2];
                    z[2] = c.b1 * xr - c.a1 * yr + z[3];
                    z[3] = c.b2 * xr - c.a2 * yr;
                    r[i] = yr as f32;
                }
            }
            let n = (e - s) as f64;
            let dp = (self.pre_target - self.pre) / n;
            let db = (self.bal_target - self.bal).clamp(-0.02, 0.02) / n;
            let dm = (self.mono_target - self.mono).clamp(-0.02, 0.02) / n;
            for i in s..e {
                self.pre += dp;
                self.bal += db;
                self.mono += dm;
                let xl = l[i] as f64 * self.pre;
                let xr = r[i] as f64 * self.pre;
                let m = (xl + xr) * 0.5;
                l[i] = ((xl + (m - xl) * self.mono) * (1. - self.bal).min(1.)) as f32;
                r[i] = ((xr + (m - xr) * self.mono) * (1. + self.bal).min(1.)) as f32;
            }
            if (self.pre_target - self.pre).abs() < 1e-6 {
                self.pre = self.pre_target;
            }
            if (self.bal_target - self.bal).abs() < 1e-6 {
                self.bal = self.bal_target;
            }
            if (self.mono_target - self.mono).abs() < 1e-6 {
                self.mono = self.mono_target;
            }
        }
    }
}

fn bessel(x: f64) -> f64 {
    let (mut sum, mut term) = (1., 1.);
    for k in 1..30 {
        term *= (x / (2. * k as f64)).powi(2);
        sum += term;
    }
    sum
}
fn crest(a: f64, b: f64, c: f64) -> f64 {
    let d = a - 2. * b + c;
    if b.abs() < a.abs() || b.abs() < c.abs() || b * d >= 0. {
        b.abs()
    } else {
        (b - (a - c).powi(2) / (8. * d)).abs()
    }
}
pub struct Limiter {
    pub lookahead: usize,
    win: usize,
    hl: [f32; 48],
    hr: [f32; 48],
    hp: usize,
    prev_seg: f64,
    prev_cl: f64,
    prev_cr: f64,
    dl: Vec<f32>,
    dr: Vec<f32>,
    er: Vec<f32>,
    mr: Vec<f32>,
    ep: usize,
    mp: usize,
    es: f64,
    ms: f64,
    pos: usize,
    env: f64,
    rel: f64,
    dq: Vec<i64>,
    dv: Vec<f32>,
    head: usize,
    tail: usize,
    counter: i64,
    p: [f64; 12],
    m: [f64; 12],
    h: [f64; 12],
    pub min_gain: f64,
}
impl Limiter {
    pub fn new(sr: f64) -> Self {
        let win = (round(sr * 0.005) as usize).max(2);
        let half = (win / 2).max(1);
        let kernel = |k: f64| {
            let mut h = std::array::from_fn::<_, 24, _>(|j| {
                let d = 12. - j as f64 - k / 4.;
                let u = d / 12.25;
                let sinc = if d == 0. {
                    1.
                } else {
                    (PI * d).sin() / (PI * d)
                };
                sinc * bessel(6. * (1. - u * u).sqrt())
            });
            let sum: f64 = h.iter().sum();
            for v in &mut h {
                *v /= sum;
            }
            h
        };
        let k1 = kernel(1.);
        let k2 = kernel(2.);
        Self {
            lookahead: win + 12,
            win,
            hl: [0.; 48],
            hr: [0.; 48],
            hp: 0,
            prev_seg: 0.,
            prev_cl: 0.,
            prev_cr: 0.,
            dl: vec![0.; win + 12],
            dr: vec![0.; win + 12],
            er: vec![1.; half],
            mr: vec![1.; win - half],
            ep: 0,
            mp: 0,
            es: half as f64,
            ms: (win - half) as f64,
            pos: 0,
            env: 1.,
            rel: 1. - (-1. / (sr * 0.12)).exp(),
            dq: vec![0; win + 2],
            dv: vec![0.; win + 2],
            head: 0,
            tail: 0,
            counter: 0,
            p: std::array::from_fn(|j| (k1[j] + k1[23 - j]) / 2.),
            m: std::array::from_fn(|j| (k1[j] - k1[23 - j]) / 2.),
            h: std::array::from_fn(|j| (k2[j] + k2[23 - j]) / 2.),
            min_gain: 1.,
        }
    }
    pub fn reset(&mut self) {
        self.dl.fill(0.);
        self.dr.fill(0.);
        self.hl.fill(0.);
        self.hr.fill(0.);
        self.hp = 0;
        self.prev_seg = 0.;
        self.prev_cl = 0.;
        self.prev_cr = 0.;
        self.er.fill(1.);
        self.mr.fill(1.);
        self.es = self.er.len() as f64;
        self.ms = self.mr.len() as f64;
        self.ep = 0;
        self.mp = 0;
        self.env = 1.;
        self.head = 0;
        self.tail = 0;
        self.counter = 0;
        self.pos = 0;
        self.min_gain = 1.;
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (xl, xr) = (l[i], r[i]);
            self.hp = if self.hp == 0 { 23 } else { self.hp - 1 };
            let tp = self.hp;
            self.hl[tp] = xl;
            self.hl[tp + 24] = xl;
            self.hr[tp] = xr;
            self.hr[tp + 24] = xr;
            let (mut pl, mut ml, mut bl, mut pr, mut mr, mut br) = (0., 0., 0., 0., 0., 0.);
            for j in 0..12 {
                let q = tp + 23 - j;
                let (ul, wl, ur, wr) = (
                    self.hl[tp + j] as f64,
                    self.hl[q] as f64,
                    self.hr[tp + j] as f64,
                    self.hr[q] as f64,
                );
                pl += self.p[j] * (ul + wl);
                ml += self.m[j] * (ul - wl);
                bl += self.h[j] * (ul + wl);
                pr += self.p[j] * (ur + wr);
                mr += self.m[j] * (ur - wr);
                br += self.h[j] * (ur + wr);
            }
            let (al, cl, ar, cr) = (pl + ml, pl - ml, pr + mr, pr - mr);
            let (sl, sr, nl, nr) = (
                self.hl[tp + 12] as f64,
                self.hr[tp + 12] as f64,
                self.hl[tp + 11] as f64,
                self.hr[tp + 11] as f64,
            );
            let seg = [
                crest(self.prev_cl, sl, al),
                crest(sl, al, bl),
                crest(al, bl, cl),
                crest(bl, cl, nl),
                crest(self.prev_cr, sr, ar),
                crest(sr, ar, br),
                crest(ar, br, cr),
                crest(br, cr, nr),
            ]
            .into_iter()
            .fold(0., f64::max);
            self.prev_cl = cl;
            self.prev_cr = cr;
            let peak = seg.max(self.prev_seg) * 10f64.powf(0.05 / 20.);
            self.prev_seg = seg;
            let thr = 10f64.powf(-1. / 20.);
            let req = if peak > thr { thr / peak } else { 1. };
            let c = self.counter;
            self.counter += 1;
            let n = self.dq.len();
            while self.tail != self.head {
                let last = (self.tail + n - 1) % n;
                if self.dv[last] as f64 >= req {
                    self.tail = last;
                } else {
                    break;
                }
            }
            self.dq[self.tail] = c;
            self.dv[self.tail] = req as f32;
            self.tail = (self.tail + 1) % n;
            while self.dq[self.head] < c - self.win as i64 {
                self.head = (self.head + 1) % n;
            }
            let min = self.dv[self.head] as f64;
            if min < self.env {
                self.env = min;
            } else {
                self.env += (min - self.env) * self.rel;
            }
            let e = self.env as f32;
            self.es += e as f64 - self.er[self.ep] as f64;
            self.er[self.ep] = e;
            self.ep = (self.ep + 1) % self.er.len();
            let m1 = (self.es / self.er.len() as f64).min(1.) as f32;
            self.ms += m1 as f64 - self.mr[self.mp] as f64;
            self.mr[self.mp] = m1;
            self.mp = (self.mp + 1) % self.mr.len();
            if self.pos == 0 {
                self.es = self.er.iter().map(|v| *v as f64).sum();
                self.ms = self.mr.iter().map(|v| *v as f64).sum();
            }
            let g = (self.ms / self.mr.len() as f64).min(1.);
            let (dl, dr) = (self.dl[self.pos], self.dr[self.pos]);
            self.dl[self.pos] = xl;
            self.dr[self.pos] = xr;
            self.pos = (self.pos + 1) % self.lookahead;
            self.min_gain = self.min_gain.min(g);
            l[i] = (dl as f64 * g) as f32;
            r[i] = (dr as f64 * g) as f32;
        }
    }
}
