use crate::source::Source;
use std::f64::consts::PI;

// Keep scalar arithmetic in f64 and PCM stores in f32, matching the reference engine.
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}
pub struct Wsola {
    pub w: usize,
    h: usize,
    tol: usize,
    c: usize,
    d: usize,
    near: usize,
    sr: f64,
    win: Vec<f64>,
    acc_l: Vec<f32>,
    acc_r: Vec<f32>,
    fifo_l: Vec<f32>,
    fifo_r: Vec<f32>,
    frame_l: Vec<f32>,
    frame_r: Vec<f32>,
    search_l: Vec<f32>,
    search_r: Vec<f32>,
    nat_l: Vec<f32>,
    nat_r: Vec<f32>,
    box_l: Vec<f32>,
    box_r: Vec<f32>,
    nb_l: Vec<f32>,
    nb_r: Vec<f32>,
    fifo_read: usize,
    fifo_len: usize,
    fifo_start: i64,
    prev: Option<i64>,
    nominal: f64,
    pub last_offset: i64,
    side: Option<Box<dyn Source>>,
    side_acc_l: Vec<f32>,
    side_acc_r: Vec<f32>,
    side_fifo_l: Vec<f32>,
    side_fifo_r: Vec<f32>,
}
impl Wsola {
    pub fn new(sr: f64) -> Self {
        let w = (round(sr * 0.04) as usize).div_ceil(4) * 4;
        let h = w / 2;
        let c = (w - h).min(h * 2);
        let tol = round(sr * 0.012) as usize;
        let d = (round(sr / 11025.) as usize).max(2);
        let len = c + 2 * tol + 2;
        Self {
            w,
            h,
            c,
            tol,
            d,
            near: round(sr * 0.006) as usize,
            sr,
            win: (0..w)
                .map(|i| 0.5 - 0.5 * (2. * PI * i as f64 / w as f64).cos())
                .collect(),
            acc_l: vec![0.; w],
            acc_r: vec![0.; w],
            fifo_l: vec![0.; h],
            fifo_r: vec![0.; h],
            frame_l: vec![0.; w],
            frame_r: vec![0.; w],
            search_l: vec![0.; len],
            search_r: vec![0.; len],
            nat_l: vec![0.; c],
            nat_r: vec![0.; c],
            box_l: vec![0.; len.div_ceil(d) + 1],
            box_r: vec![0.; len.div_ceil(d) + 1],
            nb_l: vec![0.; c.div_ceil(d) + 1],
            nb_r: vec![0.; c.div_ceil(d) + 1],
            fifo_read: 0,
            fifo_len: 0,
            fifo_start: 0,
            prev: None,
            nominal: 0.,
            last_offset: 0,
            side: None,
            side_acc_l: vec![0.; w],
            side_acc_r: vec![0.; w],
            side_fifo_l: vec![0.; h],
            side_fifo_r: vec![0.; h],
        }
    }
    pub fn reset(&mut self, position: f64) {
        self.acc_l.fill(0.);
        self.acc_r.fill(0.);
        self.fifo_read = 0;
        self.fifo_len = 0;
        self.prev = None;
        self.nominal = position;
        self.fifo_start = round(position) as i64;
        self.last_offset = 0;
        self.side_acc_l.fill(0.);
        self.side_acc_r.fill(0.);
    }
    pub fn set_side(&mut self, side: Option<Box<dyn Source>>) {
        self.side = side;
        self.side_acc_l.fill(0.);
        self.side_acc_r.fill(0.);
        self.side_fifo_l.fill(0.);
        self.side_fifo_r.fill(0.);
    }
    pub fn has_side(&self) -> bool {
        self.side.is_some()
    }
    pub fn position(&self) -> f64 {
        if self.fifo_len > self.fifo_read {
            (self.fifo_start + self.fifo_read as i64) as f64
        } else {
            self.prev
                .map_or(self.nominal, |s| (s + self.h as i64) as f64)
        }
    }
    pub fn render(
        &mut self,
        source: &mut dyn Source,
        l: &mut [f32],
        r: &mut [f32],
        ratio: impl FnMut(usize) -> f64,
    ) -> usize {
        self.render_outputs(source, l, r, ratio, None)
    }
    pub fn render_side(
        &mut self,
        source: &mut dyn Source,
        l: &mut [f32],
        r: &mut [f32],
        ratio: impl FnMut(usize) -> f64,
        sl: &mut [f32],
        sr: &mut [f32],
    ) -> usize {
        self.render_outputs(source, l, r, ratio, Some((sl, sr)))
    }
    fn render_outputs(
        &mut self,
        source: &mut dyn Source,
        l: &mut [f32],
        r: &mut [f32],
        mut ratio: impl FnMut(usize) -> f64,
        mut side_out: Option<(&mut [f32], &mut [f32])>,
    ) -> usize {
        let mut produced = 0;
        while produced < l.len() {
            if self.fifo_read >= self.fifo_len && !self.hop(source, ratio(produced)) {
                break;
            }
            let n = (l.len() - produced).min(self.fifo_len - self.fifo_read);
            l[produced..produced + n]
                .copy_from_slice(&self.fifo_l[self.fifo_read..self.fifo_read + n]);
            r[produced..produced + n]
                .copy_from_slice(&self.fifo_r[self.fifo_read..self.fifo_read + n]);
            if self.side.is_some() {
                if let Some((sl, sr)) = &mut side_out {
                    sl[produced..produced + n]
                        .copy_from_slice(&self.side_fifo_l[self.fifo_read..self.fifo_read + n]);
                    sr[produced..produced + n]
                        .copy_from_slice(&self.side_fifo_r[self.fifo_read..self.fifo_read + n]);
                }
            }
            self.fifo_read += n;
            produced += n;
        }
        produced
    }
    fn hop(&mut self, source: &mut dyn Source, ratio: f64) -> bool {
        let s = if let Some(prev) = self.prev {
            if (ratio - 1.).abs() < 1e-9 {
                let s = prev + self.h as i64;
                self.nominal = s as f64;
                s
            } else {
                let natural = prev + self.h as i64;
                let drift = natural as f64 - self.nominal;
                let Some(transient) = self.transient(source, natural) else {
                    return false;
                };
                if transient && drift.abs() < (self.tol * 2) as f64 {
                    self.last_offset = round(drift) as i64;
                    natural
                } else {
                    let Some(s) = self.search(source, round(self.nominal) as i64, natural) else {
                        return false;
                    };
                    s
                }
            }
        } else {
            round(self.nominal) as i64
        };
        if !source.read(s, &mut self.frame_l, &mut self.frame_r) {
            return false;
        }
        for i in 0..self.w {
            self.acc_l[i] = (self.acc_l[i] as f64 + self.frame_l[i] as f64 * self.win[i]) as f32;
            self.acc_r[i] = (self.acc_r[i] as f64 + self.frame_r[i] as f64 * self.win[i]) as f32;
        }
        self.fifo_l.copy_from_slice(&self.acc_l[..self.h]);
        self.fifo_r.copy_from_slice(&self.acc_r[..self.h]);
        self.acc_l.copy_within(self.h..self.w, 0);
        self.acc_r.copy_within(self.h..self.w, 0);
        self.acc_l[self.w - self.h..].fill(0.);
        self.acc_r[self.w - self.h..].fill(0.);
        if let Some(side) = &mut self.side {
            if !side.read(s, &mut self.frame_l, &mut self.frame_r) {
                self.frame_l.fill(0.);
                self.frame_r.fill(0.);
            }
            for i in 0..self.w {
                self.side_acc_l[i] =
                    (self.side_acc_l[i] as f64 + self.frame_l[i] as f64 * self.win[i]) as f32;
                self.side_acc_r[i] =
                    (self.side_acc_r[i] as f64 + self.frame_r[i] as f64 * self.win[i]) as f32;
            }
            self.side_fifo_l.copy_from_slice(&self.side_acc_l[..self.h]);
            self.side_fifo_r.copy_from_slice(&self.side_acc_r[..self.h]);
            self.side_acc_l.copy_within(self.h..self.w, 0);
            self.side_acc_r.copy_within(self.h..self.w, 0);
            self.side_acc_l[self.w - self.h..].fill(0.);
            self.side_acc_r[self.w - self.h..].fill(0.);
        }
        self.fifo_start = s;
        self.fifo_read = 0;
        self.fifo_len = self.h;
        if self.prev.is_none() {
            self.nominal = s as f64;
        }
        self.prev = Some(s);
        self.nominal += self.h as f64 * ratio;
        true
    }
    fn transient(&mut self, source: &mut dyn Source, natural: i64) -> Option<bool> {
        if !source.read(natural, &mut self.frame_l, &mut self.frame_r) {
            return None;
        }
        let b = (round(self.sr * 128. / 44100.) as usize).max(128);
        let mut prev: f64 = 0.;
        let mut running = 0.;
        for k in 0..self.w / b {
            let mut e = 0.;
            for i in k * b..(k + 1) * b {
                let l = self.frame_l[i] as f64;
                let r = self.frame_r[i] as f64;
                e += l * l + r * r;
            }
            e /= b as f64;
            if k >= 2 && e > 1e-6 && e > 6. * prev.max(running / k as f64) {
                return Some(true);
            }
            prev = e;
            running += e;
        }
        Some(false)
    }
    fn search(&mut self, source: &mut dyn Source, target: i64, natural: i64) -> Option<i64> {
        let h = self.c;
        let tol = self.tol;
        let base = target - tol as i64;
        let len = h + 2 * tol + 1;
        if !source.read(base, &mut self.search_l[..len], &mut self.search_r[..len])
            || !source.read(natural, &mut self.nat_l, &mut self.nat_r)
        {
            return None;
        }
        let mut energy = 0.;
        for i in 0..h {
            let l = self.nat_l[i] as f64;
            let r = self.nat_r[i] as f64;
            energy += l * l + r * r;
        }
        if energy < 1e-12 {
            self.last_offset = 0;
            return Some(target);
        }
        let d = self.d;
        let nb = h / d;
        let sb = 2 * tol / d + nb;
        for k in 0..sb {
            let (mut l, mut r) = (0., 0.);
            for j in k * d..k * d + d {
                l += self.search_l[j] as f64;
                r += self.search_r[j] as f64;
            }
            self.box_l[k] = l as f32;
            self.box_r[k] = r as f32;
        }
        for k in 0..nb {
            let (mut l, mut r) = (0., 0.);
            for j in k * d..k * d + d {
                l += self.nat_l[j] as f64;
                r += self.nat_r[j] as f64;
            }
            self.nb_l[k] = l as f32;
            self.nb_r[k] = r as f32;
        }
        let mut e = 1e-9;
        for k in 0..nb {
            let l = self.box_l[k] as f64;
            let r = self.box_r[k] as f64;
            e += l * l + r * r;
        }
        let (mut best, mut near) = (0usize, 0usize);
        let (mut best_score, mut near_score) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for j in 0..=sb - nb {
            if j > 0 {
                let a = j + nb - 1;
                let o = j - 1;
                e += (self.box_l[a] as f64).powi(2) + (self.box_r[a] as f64).powi(2)
                    - (self.box_l[o] as f64).powi(2)
                    - (self.box_r[o] as f64).powi(2);
            }
            let mut c = 0.;
            for k in 0..nb {
                c += self.box_l[j + k] as f64 * self.nb_l[k] as f64
                    + self.box_r[j + k] as f64 * self.nb_r[k] as f64;
            }
            let score = c / e.max(1e-9).sqrt();
            if score > best_score {
                best_score = score;
                best = j * d;
            }
            if (j * d).abs_diff(tol) <= self.near && score > near_score {
                near_score = score;
                near = j * d;
            }
        }
        let mut nat_box = 0.;
        for k in 0..nb {
            nat_box += (self.nb_l[k] as f64).powi(2) + (self.nb_r[k] as f64).powi(2);
        }
        if near_score >= best_score - 0.01 * nat_box.sqrt() {
            best = near;
        }
        best_score = f64::NEG_INFINITY;
        let mut refined = best;
        for offset in best.saturating_sub(d)..=(2 * tol).min(best + d) {
            let (mut c, mut e) = (0., 1e-9);
            for i in 0..h {
                let l = self.search_l[offset + i] as f64;
                let r = self.search_r[offset + i] as f64;
                c += l * self.nat_l[i] as f64 + r * self.nat_r[i] as f64;
                e += l * l + r * r;
            }
            let score = c / e.sqrt();
            if score > best_score {
                best_score = score;
                refined = offset;
            }
        }
        self.last_offset = refined as i64 - tol as i64;
        Some(base + refined as i64)
    }
}
