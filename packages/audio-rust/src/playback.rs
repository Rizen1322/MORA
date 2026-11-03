use crate::{
    source::Source,
    wsola::{Wsola, round},
};
use std::{
    cell::{Cell, RefCell},
    f64::consts::PI,
    rc::Rc,
};

type PullFn = Box<dyn FnMut(&mut [f32], &mut [f32])>;
struct Pull {
    l: Vec<f32>,
    r: Vec<f32>,
    end: i64,
    pull: PullFn,
}
impl Pull {
    fn new(capacity: usize, pull: PullFn) -> Self {
        Self {
            l: vec![0.; capacity],
            r: vec![0.; capacity],
            end: 0,
            pull,
        }
    }
    fn reset(&mut self) {
        self.l.fill(0.);
        self.r.fill(0.);
        self.end = 0;
    }
}
impl Source for Pull {
    fn read(&mut self, start: i64, l: &mut [f32], r: &mut [f32]) -> bool {
        let wanted = (start + l.len() as i64).max(0);
        let cap = self.l.len() as i64;
        if l.len() > cap as usize || wanted - self.end > cap || start.max(0) < self.end - cap {
            return false;
        }
        while self.end < wanted {
            let (mut tl, mut tr) = ([0f32; 128], [0f32; 128]);
            (self.pull)(&mut tl, &mut tr);
            for i in 0..128 {
                let at = (self.end as usize + i) % cap as usize;
                self.l[at] = tl[i];
                self.r[at] = tr[i];
            }
            self.end += 128;
        }
        if start.max(0) < self.end - cap {
            return false;
        }
        for i in 0..l.len() {
            let p = start + i as i64;
            let at = p.rem_euclid(cap) as usize;
            l[i] = if p < 0 { 0. } else { self.l[at] };
            r[i] = if p < 0 { 0. } else { self.r[at] };
        }
        true
    }
}
pub struct Playback {
    source: Rc<RefCell<Pull>>,
    stretched: Pull,
    wsola: Rc<RefCell<Wsola>>,
    ratio: Rc<Cell<f64>>,
    pub speed: f64,
    pub pitch: f64,
    pub target_speed: f64,
    pub semitones: f64,
    active: bool,
    position: f64,
    il: Vec<f32>,
    ir: Vec<f32>,
    wl: Vec<f32>,
    wr: Vec<f32>,
    warm_position: f64,
    warm_left: usize,
    warm_frames: usize,
    glide: f64,
    sinc: Vec<f64>,
    window: Vec<f64>,
}
impl Playback {
    pub fn new(sr: f64, pull: PullFn) -> Self {
        let cap = (sr / 128.).ceil() as usize * 128;
        let source = Rc::new(RefCell::new(Pull::new(cap, pull)));
        let wsola = Rc::new(RefCell::new(Wsola::new(sr)));
        let ratio = Rc::new(Cell::new(1.));
        let (s, w, q) = (source.clone(), wsola.clone(), ratio.clone());
        let stretched = Pull::new(
            cap,
            Box::new(move |l, r| {
                let n = w
                    .borrow_mut()
                    .render(&mut *s.borrow_mut(), l, r, |_| q.get());
                l[n..].fill(0.);
                r[n..].fill(0.);
            }),
        );
        let sinc = (0..32 * 1024 + 2)
            .map(|i| {
                if i == 0 {
                    1.
                } else {
                    let x = PI * i as f64 / 1024.;
                    x.sin() / x
                }
            })
            .collect();
        let window = (0..32 * 1024 + 2)
            .map(|i| {
                let x = (i as f64 / (32. * 1024.)).min(1.);
                0.42 + 0.5 * (PI * x).cos() + 0.08 * (2. * PI * x).cos()
            })
            .collect();
        Self {
            source,
            stretched,
            wsola,
            ratio,
            speed: 1.,
            pitch: 1.,
            target_speed: 1.,
            semitones: 0.,
            active: false,
            position: 0.,
            il: vec![0.; 4096],
            ir: vec![0.; 4096],
            wl: vec![0.; 4096],
            wr: vec![0.; 4096],
            warm_position: 0.,
            warm_left: 0,
            warm_frames: (sr * 0.03).ceil() as usize,
            glide: 1. - (-128. / (sr * 0.04)).exp(),
            sinc,
            window,
        }
    }
    pub fn set(&mut self, speed: f64, semitones: f64) {
        self.target_speed = round(speed.clamp(0.8, 1.2) * 100.) / 100.;
        self.semitones = round(semitones.clamp(-6., 6.) * 2.) / 2.;
    }
    pub fn reset(&mut self) {
        self.source.borrow_mut().reset();
        self.stretched.reset();
        self.wsola.borrow_mut().reset(0.);
        self.position = 0.;
        self.active = false;
        self.speed = self.target_speed;
        self.pitch = 2f64.powf(self.semitones / 12.);
        self.warm_left = 0;
        self.warm_position = 0.;
    }
    pub fn buffered(&self) -> f64 {
        if self.active {
            (self.source.borrow().end as f64 - self.wsola.borrow().position()
                + (self.stretched.end as f64 - self.position).max(0.) * self.speed / self.pitch)
                .max(0.)
        } else {
            0.
        }
    }
    pub fn speed_ratio(&self) -> f64 {
        if self.active {
            self.speed
        } else {
            self.target_speed
        }
    }
    pub fn engaged(&self) -> bool {
        self.active || self.target_speed != 1. || self.semitones != 0.
    }
    #[inline(always)]
    fn lookup(table: &[f64], x: f64) -> f64 {
        let at = (x.abs() * 1024.).min((table.len() - 2) as f64);
        let i = at as usize;
        table[i] + (table[i + 1] - table[i]) * (at - i as f64)
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.engaged() {
            (self.source.borrow_mut().pull)(l, r);
            return;
        }
        if !self.active {
            self.active = true;
            self.speed = self.target_speed;
            self.pitch = 2f64.powf(self.semitones / 12.);
            self.warm_left = self.warm_frames;
        }
        let n = l.len();
        let amount = 1. - (1. - self.glide).powf(n as f64 / 128.);
        self.speed += (self.target_speed - self.speed) * amount;
        let p0 = self.pitch;
        self.pitch += (2f64.powf(self.semitones / 12.) - self.pitch) * amount;
        self.ratio.set(self.speed / self.pitch);
        let start = self.position.floor() as i64 - 31;
        let length = (n as f64 * p0.max(self.pitch)).ceil() as usize + 66;
        if length > self.il.len()
            || !self
                .stretched
                .read(start, &mut self.il[..length], &mut self.ir[..length])
        {
            l.fill(0.);
            r.fill(0.);
            return;
        }
        let cutoff = 0.94 / 1f64.max(p0).max(self.pitch);
        for i in 0..n {
            let centre = self.position;
            let first = centre.floor() as i64 - 31;
            let (mut xl, mut xr, mut sum) = (0., 0., 0.);
            for j in 0..64 {
                let x = (first + j) as f64 - centre;
                let w =
                    cutoff * Self::lookup(&self.sinc, x * cutoff) * Self::lookup(&self.window, x);
                let at = (first + j - start) as usize;
                xl += self.il[at] as f64 * w;
                xr += self.ir[at] as f64 * w;
                sum += w;
            }
            l[i] = (xl / sum) as f32;
            r[i] = (xr / sum) as f32;
            self.position += p0 + (self.pitch - p0) * (i + 1) as f64 / n as f64;
        }
        if self.warm_left > 0 {
            let first = self.warm_position.floor() as i64;
            let len = (n as f64 * self.speed).ceil() as usize + 2;
            if self
                .source
                .borrow_mut()
                .read(first, &mut self.wl[..len], &mut self.wr[..len])
            {
                for i in 0..n.min(self.warm_left) {
                    let at = self.warm_position - first as f64;
                    let a = at.floor() as usize;
                    let f = at - a as f64;
                    let wet = 1. - self.warm_left as f64 / self.warm_frames as f64;
                    l[i] = (l[i] as f64 * wet
                        + (self.wl[a] as f64 + (self.wl[a + 1] as f64 - self.wl[a] as f64) * f)
                            * (1. - wet)) as f32;
                    r[i] = (r[i] as f64 * wet
                        + (self.wr[a] as f64 + (self.wr[a + 1] as f64 - self.wr[a] as f64) * f)
                            * (1. - wet)) as f32;
                    self.warm_position += self.speed;
                    self.warm_left -= 1;
                }
            } else {
                self.warm_left = 0;
            }
        }
    }
}
