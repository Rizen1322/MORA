use crate::source::{CHUNK, Source, Store};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

pub type Points = Vec<[f64; 2]>;
fn value(points: &[[f64; 2]], t: f64, before: f64) -> f64 {
    if points.is_empty() || t < points[0][0] {
        return before;
    }
    for i in 1..points.len() {
        let [end, gain] = points[i];
        let [start, previous] = points[i - 1];
        if t <= end {
            return previous + (gain - previous) * (t - start) / (end - start).max(1e-9);
        }
    }
    points.last().unwrap()[1]
}
#[derive(Clone, Default)]
pub struct Mask {
    pub points: Option<Points>,
    pub spans: Vec<[f64; 2]>,
}
impl Mask {
    pub fn new(points: Option<Points>) -> Self {
        let mut spans: Vec<[f64; 2]> = Vec::new();
        if let Some(p) = &points {
            for (i, point) in p.iter().enumerate() {
                let next = p.get(i + 1);
                if point[1] == 1. && next.is_none_or(|p| p[1] == 1.) {
                    continue;
                }
                let start = point[0];
                let end = next.map_or(f64::INFINITY, |p| p[0]);
                if let Some(previous) = spans.last_mut().filter(|p| p[1] == start) {
                    previous[1] = end;
                } else {
                    spans.push([start, end]);
                }
            }
        }
        Self { points, spans }
    }
    pub fn needs(&self, from: f64, to: f64, total: i64) -> bool {
        self.spans
            .iter()
            .any(|[start, end]| to > *start && from < *end && to > 0. && from < total as f64)
    }
    pub fn gain(&self, frame: f64) -> f64 {
        self.points.as_ref().map_or(1., |p| value(p, frame, 1.))
    }
    pub fn max_gain(&self, from: f64, to: f64) -> f64 {
        let mut m = self.gain(from).max(self.gain(to));
        if let Some(p) = &self.points {
            for [frame, gain] in p {
                if *frame > from && *frame < to && *gain > m {
                    m = *gain;
                }
            }
        }
        m
    }
}
pub fn source_map(cue: f64, tempo: &[[f64; 2]], gains: Option<&[[f64; 2]]>) -> Option<Points> {
    let gains = gains.filter(|g| !g.is_empty() && g.iter().any(|p| p[1] != 1.))?;
    let neutral = [[0., 1.]];
    let speed = if tempo.is_empty() {
        &neutral[..]
    } else {
        tempo
    };
    let last = gains.last().unwrap()[0];
    let mut knots = vec![0.];
    knots.extend(gains.iter().map(|p| p[0]));
    knots.extend(speed.iter().map(|p| p[0]).filter(|t| *t > 0. && *t < last));
    knots.sort_by(f64::total_cmp);
    knots.dedup();
    let (mut source, mut previous) = (cue, 0.);
    let mut result = Vec::new();
    for t in knots {
        source += (t - previous)
            * (value(speed, previous, speed[0][1]) + value(speed, t, speed[0][1]))
            / 2.;
        result.push([source, value(gains, t, 1.).clamp(0., 2.5)]);
        previous = t;
    }
    Some(result)
}
pub struct Voice {
    pub total: i64,
    pub chunks: BTreeMap<usize, (Vec<f32>, Vec<f32>)>,
    pub mask: Mask,
    pub scale: f64,
    l: Vec<f32>,
    r: Vec<f32>,
}
impl Voice {
    pub fn new(sr: f64) -> Self {
        let n = (sr * 0.064).ceil() as usize + 64;
        Self {
            total: 0,
            chunks: BTreeMap::new(),
            mask: Mask::default(),
            scale: 1.,
            l: vec![0.; n],
            r: vec![0.; n],
        }
    }
    pub fn reset(&mut self, total: i64) {
        self.total = total;
        self.chunks.clear();
        self.mask = Mask::default();
        self.scale = 1.;
    }
    pub fn resize(&mut self, total: i64) -> Option<usize> {
        let grew = total > self.total;
        let edge = (self.total - 1).div_euclid(CHUNK as i64);
        self.total = total;
        self.chunks
            .retain(|k, _| (*k as i64) * (CHUNK as i64) < total);
        if grew && edge >= 0 {
            self.chunks.remove(&(edge as usize));
            Some(edge as usize)
        } else {
            None
        }
    }
    pub fn missing(&self, from: f64, to: f64) -> Vec<usize> {
        let a = (from / (CHUNK as f64)).floor().max(0.) as usize;
        let b = ((to.max(from) - 1.) / CHUNK as f64)
            .floor()
            .min(((self.total - 1) / (CHUNK as i64)) as f64);
        if b < 0. {
            return vec![];
        }
        (a..=b as usize)
            .filter(|k| !self.chunks.contains_key(k))
            .collect()
    }
    pub fn covers(&self, from: f64, to: f64) -> bool {
        self.missing(from, to).is_empty()
    }
    pub fn apply(&mut self, start: i64, l: &mut [f32], r: &mut [f32]) -> bool {
        if self.mask.points.is_none()
            || !self
                .mask
                .needs(start as f64, (start + l.len() as i64) as f64, self.total)
        {
            return true;
        }
        if l.len() > self.l.len() {
            return false;
        }
        for j in 0..self.mask.spans.len() {
            let [from, to] = self.mask.spans[j];
            let a = (start as f64).max(0.).max(from.ceil()) as i64;
            let b = ((start + l.len() as i64) as f64)
                .min(self.total as f64)
                .min(to.ceil()) as i64;
            if a >= b {
                continue;
            }
            let local = (a - start) as usize;
            let n = (b - a) as usize;
            if !Store::raw_pcm(
                &self.chunks,
                self.total,
                a,
                &mut self.l[local..local + n],
                &mut self.r[local..local + n],
            ) {
                return false;
            }
            for i in a..b {
                let gain = (self.mask.gain(i as f64) - 1.) * self.scale;
                let at = (i - start) as usize;
                l[at] = (l[at] as f64 + gain * self.l[at] as f64) as f32;
                r[at] = (r[at] as f64 + gain * self.r[at] as f64) as f32;
            }
        }
        true
    }
}
pub struct Heard(pub Rc<RefCell<Voice>>);
impl Source for Heard {
    fn read(&mut self, start: i64, l: &mut [f32], r: &mut [f32]) -> bool {
        let v = self.0.borrow();
        if !Store::raw_pcm(&v.chunks, v.total, start, l, r) {
            return false;
        }
        if v.mask.points.is_some() {
            for i in 0..l.len() {
                let g = v.mask.gain((start + i as i64) as f64);
                l[i] = (l[i] as f64 * g) as f32;
                r[i] = (r[i] as f64 * g) as f32;
            }
        }
        true
    }
}
#[derive(Default)]
pub struct Fit {
    pub numerator: f64,
    pub denominator: f64,
    pub frames: usize,
    done: BTreeSet<usize>,
    cursors: BTreeMap<usize, usize>,
}
impl Fit {
    pub fn scale(&self, sr: f64) -> f64 {
        if (self.frames as f64) < sr * 0.5 || self.denominator <= 0. {
            1.
        } else {
            (1. + 0.6 * (self.numerator / self.denominator - 1.)).clamp(1., 1.15)
        }
    }
    pub fn advance(
        &mut self,
        original: &BTreeMap<usize, (Vec<f32>, Vec<f32>)>,
        voice: &Voice,
        mask: &Mask,
    ) {
        let mut budget = 2048usize;
        for [from, to] in &mask.spans {
            let first = (from / CHUNK as f64).floor().max(0.) as usize;
            let last = ((to.min(voice.total as f64) - 1.) / CHUNK as f64)
                .floor()
                .min(((voice.total - 1) / (CHUNK as i64)) as f64);
            if last < 0. {
                continue;
            }
            for c in first..=last as usize {
                if budget == 0 {
                    break;
                }
                if self.done.contains(&c) {
                    continue;
                }
                let (Some(o), Some(v)) = (original.get(&c), voice.chunks.get(&c)) else {
                    continue;
                };
                let n = o.0.len().min(v.0.len());
                let base = c * CHUNK;
                let start = (*self.cursors.get(&c).unwrap_or(&0) as f64)
                    .max(from.ceil() - base as f64)
                    .max(0.) as usize;
                let end = (n as f64)
                    .min(to.ceil() - base as f64)
                    .min((start + budget) as f64)
                    .max(0.) as usize;
                if end <= start {
                    continue;
                }
                let (mut cross, mut power, mut mix) = (0., 0., 0.);
                for i in start..end {
                    let (vl, vr, ol, or) =
                        (v.0[i] as f64, v.1[i] as f64, o.0[i] as f64, o.1[i] as f64);
                    cross += ol * vl + or * vr;
                    power += vl * vl + vr * vr;
                    mix += ol * ol + or * or;
                }
                if power >= 0.1 * mix && power > 1e-6 * (end - start) as f64 {
                    self.numerator += cross;
                    self.denominator += power;
                    self.frames += end - start;
                }
                budget -= end - start;
                self.cursors.insert(c, end);
                if end >= n || !mask.needs((base + end) as f64, (base + n) as f64, voice.total) {
                    self.done.insert(c);
                }
            }
            if budget == 0 {
                break;
            }
        }
    }
}
