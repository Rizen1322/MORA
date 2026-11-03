use crate::vocal::Voice;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::{cell::RefCell, rc::Rc};

pub const CHUNK: usize = 32768;

pub(crate) fn read_pcm_file(
    path: &str,
    format: &str,
    chunk: usize,
    frames: usize,
) -> Result<(Vec<f32>, Vec<f32>), String> {
    if path.is_empty() || path.len() > 32768 || frames == 0 || frames > CHUNK {
        return Err("Invalid PCM file request".into());
    }
    let width = match format {
        "f32le" => 8,
        "s16h" => 4,
        _ => return Err("Invalid PCM file format".into()),
    };
    let offset = chunk
        .checked_mul(CHUNK)
        .and_then(|n| n.checked_mul(width))
        .ok_or("Invalid PCM offset")?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; frames * width];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let (mut left, mut right) = (Vec::with_capacity(frames), Vec::with_capacity(frames));
    for frame in bytes.chunks_exact(width) {
        let (l, r) = if width == 8 {
            (
                f32::from_le_bytes(frame[0..4].try_into().unwrap()),
                f32::from_le_bytes(frame[4..8].try_into().unwrap()),
            )
        } else {
            (
                i16::from_le_bytes(frame[0..2].try_into().unwrap()) as f32 / 16384.,
                i16::from_le_bytes(frame[2..4].try_into().unwrap()) as f32 / 16384.,
            )
        };
        if !l.is_finite() || !r.is_finite() {
            return Err("Non-finite PCM".into());
        }
        left.push(l);
        right.push(r);
    }
    Ok((left, right))
}

#[cfg(test)]
mod file_tests {
    use super::*;
    #[test]
    fn reads_both_cache_formats_and_rejects_incomplete_data() {
        let path = std::env::temp_dir().join(format!("mora-pcm-test-{}", std::process::id()));
        std::fs::write(
            &path,
            [16384i16.to_le_bytes(), (-8192i16).to_le_bytes()].concat(),
        )
        .unwrap();
        let name = path.to_str().unwrap();
        assert_eq!(
            read_pcm_file(name, "s16h", 0, 1).unwrap(),
            (vec![1.], vec![-0.5])
        );
        assert!(read_pcm_file(name, "s16h", 0, 2).is_err());
        std::fs::write(
            &path,
            [1.25f32.to_le_bytes(), (-0.25f32).to_le_bytes()].concat(),
        )
        .unwrap();
        assert_eq!(
            read_pcm_file(name, "f32le", 0, 1).unwrap(),
            (vec![1.25], vec![-0.25])
        );
        assert!(read_pcm_file(name, "f32le", 1, 1).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
pub trait Source {
    fn read(&mut self, start: i64, l: &mut [f32], r: &mut [f32]) -> bool;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Roll {
    pub at: i64,
    pub length: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Loop {
    pub start: i64,
    pub end: i64,
    pub until: i64,
    pub fade: i64,
    #[serde(default)]
    pub roll: Vec<Roll>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Tape {
    pub start: i64,
    pub end: i64,
    pub fade: i64,
}

pub struct Store {
    pub total: i64,
    pub voice: Rc<RefCell<Voice>>,
    pub chunks: BTreeMap<usize, (Vec<f32>, Vec<f32>)>,
    pub loop_: Option<Loop>,
    pub tape: Option<Tape>,
    sr: f64,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
}
impl Store {
    pub fn new(sr: f64) -> Self {
        Self {
            total: 0,
            voice: Rc::new(RefCell::new(Voice::new(sr))),
            chunks: BTreeMap::new(),
            loop_: None,
            tape: None,
            sr,
            scratch_l: vec![0.; (sr * 0.02).ceil() as usize],
            scratch_r: vec![0.; (sr * 0.02).ceil() as usize],
        }
    }
    pub fn clear_effects(&mut self) {
        self.loop_ = None;
        self.tape = None;
    }
    pub fn resize(&mut self, total: i64) -> Option<usize> {
        let edge = (self.total - 1).div_euclid(CHUNK as i64);
        let grew = total > self.total;
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
    pub fn missing(&self, from: i64, to: i64) -> Vec<usize> {
        let a = from.max(0) as usize / CHUNK;
        let b = to.max(from).min(self.total).max(0) as usize;
        (a..b.div_ceil(CHUNK))
            .filter(|k| !self.chunks.contains_key(k))
            .collect()
    }
    pub fn covers(&self, from: i64, to: i64) -> bool {
        self.missing(from, to).is_empty()
    }
    pub fn set_loop(&mut self, value: Option<Loop>) -> bool {
        self.clear_effects();
        if let Some(ref p) = value {
            if [p.start, p.end, p.until, p.fade]
                .iter()
                .any(|v| *v < 0 || *v > 9_007_199_254_740_991)
                || p.roll.iter().any(|r| {
                    r.at < 0
                        || r.length < 0
                        || r.at > 9_007_199_254_740_991
                        || r.length > 9_007_199_254_740_991
                })
            {
                return false;
            }
            let n = p.end - p.start;
            if p.fade < 1
                || p.fade > self.scratch_l.len() as i64
                || p.start < p.fade
                || p.end > self.total
                || (n as f64) < self.sr * 0.25
                || n as f64 > self.sr * 8.
                || p.fade > n / 8
                || p.until <= p.end
                || p.until - p.start > n * 4
                || p.roll.len() > 3
            {
                return false;
            }
            let (mut at, mut length) = (p.start, n);
            for step in &p.roll {
                let cycles = (step.at - at) as f64 / length as f64;
                if step.at < at + length - 1
                    || step.at >= p.until
                    || (step.length as f64) < self.sr * 0.1
                    || (step.length as f64 - length as f64 / 2.).abs() > 1.
                    || step.length < p.fade * 8
                    || (cycles - cycles.round()).abs() * length as f64 > 1.
                {
                    return false;
                }
                at = step.at;
                length = step.length;
            }
        }
        self.loop_ = value;
        true
    }
    pub fn set_tape(&mut self, value: Option<Tape>) -> bool {
        self.tape = None;
        if let Some(ref p) = value {
            if [p.start, p.end, p.fade]
                .iter()
                .any(|v| *v < 0 || *v > 9_007_199_254_740_991)
            {
                return false;
            }
            let n = (p.end - p.start) as f64;
            if self.loop_.is_some()
                || p.start < 0
                || p.end > self.total
                || n < self.sr * 0.15
                || n > self.sr * 1.5
                || p.fade < 1
                || p.fade as f64 > n / 2.
            {
                return false;
            }
        }
        self.tape = value;
        true
    }
    pub(crate) fn raw_pcm(
        chunks: &BTreeMap<usize, (Vec<f32>, Vec<f32>)>,
        total: i64,
        start: i64,
        l: &mut [f32],
        r: &mut [f32],
    ) -> bool {
        let mut i = 0;
        while i < l.len() {
            let p = start + i as i64;
            if p < 0 {
                l[i] = 0.;
                r[i] = 0.;
                i += 1;
                continue;
            }
            if p >= total {
                l[i..].fill(0.);
                r[i..].fill(0.);
                return true;
            }
            let Some((cl, cr)) = chunks.get(&(p as usize / CHUNK)) else {
                return false;
            };
            let within = p as usize % CHUNK;
            if within >= cl.len() {
                return false;
            }
            let n = (l.len() - i)
                .min(cl.len() - within)
                .min((total - p) as usize);
            l[i..i + n].copy_from_slice(&cl[within..within + n]);
            r[i..i + n].copy_from_slice(&cr[within..within + n]);
            i += n;
        }
        true
    }
}
impl Store {
    fn masked(
        voice: &Rc<RefCell<Voice>>,
        chunks: &BTreeMap<usize, (Vec<f32>, Vec<f32>)>,
        total: i64,
        start: i64,
        l: &mut [f32],
        r: &mut [f32],
    ) -> bool {
        Self::raw_pcm(chunks, total, start, l, r) && voice.borrow_mut().apply(start, l, r)
    }
}
impl Source for Store {
    fn read(&mut self, start: i64, l: &mut [f32], r: &mut [f32]) -> bool {
        if self.loop_.is_none() && self.tape.is_none() {
            return Self::masked(&self.voice, &self.chunks, self.total, start, l, r);
        }
        let mut i = 0;
        while i < l.len() {
            let p = start + i as i64;
            if let Some(t) = &self.tape {
                if p < t.start {
                    let n = (l.len() - i).min((t.start - p) as usize);
                    if !Self::masked(
                        &self.voice,
                        &self.chunks,
                        self.total,
                        p,
                        &mut l[i..i + n],
                        &mut r[i..i + n],
                    ) {
                        return false;
                    }
                    i += n;
                    continue;
                }
                if p >= t.end {
                    l[i..].fill(0.);
                    r[i..].fill(0.);
                    return true;
                }
                let n = (l.len() - i)
                    .min((t.end - p) as usize)
                    .min(self.scratch_l.len() - 3);
                let duration = (t.end - t.start) as f64;
                let u = (p - t.start) as f64;
                let from = (t.start as f64 + u - u * u / (2. * duration)).floor() as i64;
                let last = u + n as f64 - 1.;
                let to = (t.start as f64 + last - last * last / (2. * duration)).ceil() as i64 + 1;
                let len = (to - from + 1) as usize;
                if !Self::masked(
                    &self.voice,
                    &self.chunks,
                    self.total,
                    from,
                    &mut self.scratch_l[..len],
                    &mut self.scratch_r[..len],
                ) {
                    return false;
                }
                for j in 0..n {
                    let input = u + j as f64;
                    let x = t.start as f64 + input - input * input / (2. * duration) - from as f64;
                    let k = x.floor() as usize;
                    let f = x - k as f64;
                    let gain = (1f64).min((t.end - p - j as i64) as f64 / t.fade as f64);
                    l[i + j] = ((self.scratch_l[k] as f64 * (1. - f)
                        + self.scratch_l[k + 1] as f64 * f)
                        * gain) as f32;
                    r[i + j] = ((self.scratch_r[k] as f64 * (1. - f)
                        + self.scratch_r[k + 1] as f64 * f)
                        * gain) as f32;
                }
                i += n;
                continue;
            }
            let t = self.loop_.as_ref().unwrap();
            if p < t.start {
                let n = (l.len() - i).min((t.start - p) as usize);
                if !Self::masked(
                    &self.voice,
                    &self.chunks,
                    self.total,
                    p,
                    &mut l[i..i + n],
                    &mut r[i..i + n],
                ) {
                    return false;
                }
                i += n;
                continue;
            }
            if p >= t.until {
                l[i..].fill(0.);
                r[i..].fill(0.);
                return true;
            }
            let (mut length, mut origin, mut next) = (t.end - t.start, t.start, t.until);
            for step in &t.roll {
                if step.at > p {
                    next = next.min(step.at);
                    break;
                }
                origin = step.at;
                length = step.length;
            }
            let phase = (p - origin) % length;
            let seam = phase >= length - t.fade;
            let n = (l.len() - i)
                .min((next - p) as usize)
                .min((if seam { length } else { length - t.fade } - phase) as usize);
            if !Self::masked(
                &self.voice,
                &self.chunks,
                self.total,
                t.start + phase,
                &mut l[i..i + n],
                &mut r[i..i + n],
            ) {
                return false;
            }
            if seam {
                let at = phase - (length - t.fade);
                if !Self::masked(
                    &self.voice,
                    &self.chunks,
                    self.total,
                    t.start - t.fade + at,
                    &mut self.scratch_l[..n],
                    &mut self.scratch_r[..n],
                ) {
                    return false;
                }
                for j in 0..n {
                    let x = (at + j as i64 + 1) as f64 / t.fade as f64;
                    let wet = x * x * (3. - 2. * x);
                    l[i + j] = (l[i + j] as f64
                        + (self.scratch_l[j] as f64 - l[i + j] as f64) * wet)
                        as f32;
                    r[i + j] = (r[i + j] as f64
                        + (self.scratch_r[j] as f64 - r[i + j] as f64) * wet)
                        as f32;
                }
            }
            i += n;
        }
        true
    }
}
