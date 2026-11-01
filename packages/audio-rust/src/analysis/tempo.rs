use super::{
    common::*,
    spectral::{FRAME, Spectral},
};
pub struct Onset {
    pub fps: f64,
    pub t0: f64,
    pub env: Vec<f32>,
    pub low_mid: Vec<f32>,
    pub low: Vec<f32>,
}
pub struct Hi {
    pub rate: f64,
    pub env: Vec<f32>,
}
pub fn moving_average(x: &[f32], radius: usize) -> Vec<f32> {
    smooth(&x.iter().map(|v| *v as f64).collect::<Vec<_>>(), radius)
        .into_iter()
        .map(|v| v as f32)
        .collect()
}
fn normalize(x: &[f32], fps: f64) -> Vec<f32> {
    let avg = moving_average(x, round(fps * 0.25) as usize);
    let mut y: Vec<f32> = x
        .iter()
        .zip(avg)
        .map(|(v, a)| (*v as f64 - a as f64).max(0.) as f32)
        .collect();
    let s = y.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
    let std = (s / x.len().max(1) as f64).sqrt();
    let std = if std == 0. { 1. } else { std };
    for v in &mut y {
        *v = (*v as f64 / std) as f32;
    }
    y
}
pub fn envelope(sp: &Spectral) -> Onset {
    let raw: Vec<f32> = (0..sp.frames)
        .map(|i| {
            (1.5 * sp.flux_low[i] as f64 + sp.flux_mid[i] as f64 + sp.flux_high[i] as f64) as f32
        })
        .collect();
    let lm: Vec<f32> = (0..sp.frames)
        .map(|i| (1.5 * sp.flux_low[i] as f64 + sp.flux_mid[i] as f64) as f32)
        .collect();
    Onset {
        fps: sp.fps,
        t0: FRAME as f64 / 2. / SR,
        env: normalize(&raw, sp.fps),
        low_mid: normalize(&lm, sp.fps),
        low: normalize(&sp.flux_low, sp.fps),
    }
}
pub struct Tempo {
    pub bpm: f64,
    pub strength: f64,
}
pub fn estimate(env: &[f32], fps: f64, from: usize, to: usize) -> Tempo {
    let seg = &env[from.min(env.len())..to.min(env.len()).max(from.min(env.len()))];
    if seg.is_empty() {
        return Tempo {
            bpm: 120.,
            strength: 0.,
        };
    }
    let max_lag = ((60. * fps / 45.).ceil() as usize * 4 + 2).min(seg.len() - 1);
    let mut acf = autocorrelate(seg, max_lag);
    for (l, v) in acf.iter_mut().enumerate() {
        *v /= (seg.len() - l).max(1) as f64;
    }
    let a0 = if acf[0] == 0. { 1. } else { acf[0] };
    for v in &mut acf {
        *v /= a0;
    }
    let at = |x: f64| {
        let i = x.floor() as i64;
        let f = x - i as f64;
        if i < 0 || i + 1 >= acf.len() as i64 {
            0.
        } else {
            acf[i as usize] * (1. - f) + acf[i as usize + 1] * f
        }
    };
    let (mut best, mut best_bpm, mut sum) = (0., 120., 0.);
    for step in 0..=640 {
        let bpm = 55. + step as f64 * 0.25;
        let lag = 60. * fps / bpm;
        let mut s = 0.;
        for k in 1..=4 {
            let l = lag * k as f64;
            s += [1., 0.5, 0.33, 0.25][k - 1] * at(l - 0.5).max(at(l)).max(at(l + 0.5));
        }
        let prior = (-0.5 * ((bpm / 120.).log2() / 0.9).powi(2)).exp();
        let score = s * (0.35 + 0.65 * prior);
        sum += score;
        if score > best {
            best = score;
            best_bpm = bpm;
        }
    }
    let mean = sum / 641.;
    Tempo {
        bpm: best_bpm,
        strength: clamp((best / mean.max(1e-9) - 1.) / 1.5),
    }
}
pub fn track(env: &[f32], fps: f64, bpm: f64, tightness: f64, from: usize, to: usize) -> Vec<f64> {
    let period = 60. * fps / bpm;
    let n = to.saturating_sub(from);
    if (n as f64) < period * 4. {
        return vec![];
    }
    let sigma = (period / 32.).max(1.);
    let radius = (sigma * 3.).ceil() as i64;
    let kern: Vec<f64> = (-radius..=radius)
        .map(|i| (-0.5 * (i as f64 / sigma).powi(2)).exp())
        .collect();
    let mut local = vec![0.; n];
    for i in 0..n {
        let mut s = 0.;
        for k in -radius..=radius {
            let j = from as i64 + i as i64 + k;
            if j >= from as i64 && j < to as i64 {
                s += env[j as usize] as f64 * kern[(k + radius) as usize];
            }
        }
        local[i] = s;
    }
    let mut cum = vec![0.; n];
    let mut back = vec![-1i64; n];
    let lo = round(period / 2.) as usize;
    let hi = round(period * 2.) as usize;
    let mut penalty = vec![0.; hi + 1];
    for d in lo..=hi {
        penalty[d] = -tightness * (d as f64 / period).ln().powi(2);
    }
    for i in 0..n {
        let (mut best, mut arg) = (f64::NEG_INFINITY, -1i64);
        for d in lo..=hi {
            if d > i {
                break;
            }
            let j = i - d;
            let v = cum[j] + penalty[d];
            if v > best {
                best = v;
                arg = j as i64;
            }
        }
        if arg >= 0 && best > 0. {
            cum[i] = local[i] + best;
            back[i] = arg;
        } else {
            cum[i] = local[i];
        }
    }
    let mut end = n - 1;
    let mut best_end = f64::NEG_INFINITY;
    for i in n.saturating_sub(period.ceil() as usize)..n {
        if cum[i] > best_end {
            best_end = cum[i];
            end = i;
        }
    }
    let mut beats = Vec::new();
    let mut i = end as i64;
    loop {
        beats.push(i as f64 + from as f64);
        if back[i as usize] < 0 {
            break;
        }
        i = back[i as usize];
    }
    beats.reverse();
    let med = median(
        &beats
            .iter()
            .map(|b| local[*b as usize - from])
            .collect::<Vec<_>>(),
    );
    while !beats.is_empty() && local[beats[0] as usize - from] < med * 0.1 {
        beats.remove(0);
    }
    while !beats.is_empty() && local[*beats.last().unwrap() as usize - from] < med * 0.1 {
        beats.pop();
    }
    beats
}
#[derive(Clone)]
pub struct Fit {
    pub t0: f64,
    pub period: f64,
    pub jitter_ms: f64,
    pub inlier_share: f64,
}
fn fit_from(times: &[f64], ref0: f64, p0: f64) -> Fit {
    let (mut p, mut reference) = (p0, ref0);
    let mut use_: Vec<bool> = times
        .iter()
        .map(|t| (t - (reference + round((t - reference) / p) * p)).abs() < 0.035)
        .collect();
    let (mut t0, mut jit, mut share) = (reference, 999., 0.);
    for _ in 0..8 {
        let mut entries: Vec<(i64, f64, f64)> = Vec::new();
        for (i, t) in times.iter().enumerate() {
            if !use_[i] {
                continue;
            }
            let k = round((t - reference) / p) as i64;
            let r = (t - (reference + k as f64 * p)).abs();
            if let Some(v) = entries.iter_mut().find(|v| v.0 == k) {
                if r < v.2 {
                    *v = (k, *t, r);
                }
            } else {
                entries.push((k, *t, r));
            }
        }
        let (mut sx, mut sy, mut sxx, mut sxy, mut n) = (0., 0., 0., 0., 0.);
        for (k, t, _) in entries {
            let k = k as f64;
            sx += k;
            sy += t;
            sxx += k * k;
            sxy += k * t;
            n += 1.;
        }
        if n < 4. {
            break;
        }
        let next = (n * sxy - sx * sy) / (n * sxx - sx * sx).max(1e-12);
        if !(next > p0 * 0.9 && next < p0 * 1.1) {
            break;
        }
        t0 = (sy - next * sx) / n;
        p = next;
        reference = t0;
        let (mut ss, mut inl) = (0f64, 0f64);
        use_ = times
            .iter()
            .map(|t| {
                let k = round((t - reference) / p);
                let r = t - (reference + k * p);
                let ok = r.abs() < 0.035;
                if ok {
                    ss += r * r;
                    inl += 1.;
                }
                ok
            })
            .collect();
        jit = (ss / inl.max(1.)).sqrt() * 1000.;
        share = inl / times.len().max(1) as f64;
    }
    Fit {
        t0,
        period: p,
        jitter_ms: jit,
        inlier_share: share,
    }
}
pub fn fit_robust(times: &[f64], approx: f64) -> Fit {
    let mut diffs = vec![];
    for i in 8..times.len() {
        let d = (times[i] - times[i - 8]) / 8.;
        if d > approx * 0.8 && d < approx * 1.25 {
            diffs.push(d);
        }
    }
    let p0 = if diffs.is_empty() {
        approx
    } else {
        median(&diffs)
    };
    let mut best = Fit {
        t0: times.first().copied().unwrap_or(0.),
        period: p0,
        jitter_ms: 999.,
        inlier_share: 0.,
    };
    if times.len() < 4 {
        return best;
    }
    for h in 0..12 {
        let ref0 = times[((h as f64 + 0.5) / 12. * times.len() as f64).floor() as usize];
        let g = fit_from(times, ref0, p0);
        if g.inlier_share > best.inlier_share + 1e-9
            || ((g.inlier_share - best.inlier_share).abs() < 1e-9 && g.jitter_ms < best.jitter_ms)
        {
            best = g;
        }
    }
    best
}
pub struct Direct {
    pub t0: f64,
    pub period: f64,
    pub support: f64,
    pub jitter_ms: f64,
    pub confidence: f64,
    pub stable: bool,
}
pub fn fit_onset(o: &Onset, start: f64, end: f64, bpm: f64) -> Direct {
    let env = &o.low_mid;
    let from = ((start - o.t0) * o.fps).max(0.);
    let to = ((end - o.t0) * o.fps).min(env.len() as f64 - 2.);
    let at = |p: f64| {
        let i = round(p) as i64;
        get(env, i - 1).max(get(env, i)).max(get(env, i + 1))
    };
    let (mut score, mut period, mut t0, mut best_on, mut best_off) =
        (f64::NEG_INFINITY, 60. / bpm, start, 0., 0.);
    let step = (60. / (end - start).max(16.) / 100.).max(0.01);
    let mut b = bpm * 0.985;
    while b <= bpm * 1.015 + step / 2. {
        let p = 60. * o.fps / b;
        let mut phase = 0.;
        while phase < p {
            let (mut on, mut off, mut n) = (0., 0., 0f64);
            let mut q = from + phase;
            while q < to - p {
                on += at(q);
                off += (at(q + p * 0.25) + at(q + p * 0.5) + at(q + p * 0.75)) / 3.;
                n += 1.;
                q += p;
            }
            let s = (on - off * 0.6) / n.max(1.);
            if s > score {
                score = s;
                period = p / o.fps;
                t0 = (from + phase) / o.fps + o.t0;
                best_on = on / n.max(1.);
                best_off = off / n.max(1.);
            }
            phase += 1.;
        }
        b += step;
    }
    let (mut supported, mut count, mut ss) = (0f64, 0f64, 0f64);
    let mut windows = vec![[0f64; 4]; ((end - start) / 12.).ceil().max(1.) as usize];
    for f in from.ceil() as i64..to.ceil() as i64 {
        let w = ((f as f64 / o.fps + o.t0 - start) / 12.).floor() as i64;
        if w >= 0 {
            let w = (w as usize).min(windows.len() - 1);
            windows[w][2] += get(env, f);
            windows[w][3] += 1.;
        }
    }
    let radius = round(o.fps * 0.028).max(1.) as i64;
    let mut t = t0;
    while t < end - period {
        let center = round((t - o.t0) * o.fps) as i64;
        let (mut peak, mut offset) = (0., 0);
        for d in -radius..=radius {
            let v = get(env, center + d);
            if v > peak {
                peak = v;
                offset = d;
            }
        }
        count += 1.;
        let w = (((t - start) / 12.).floor().max(0.) as usize).min(windows.len() - 1);
        windows[w][1] += 1.;
        if peak > (best_on * 0.32).max(0.7) {
            supported += 1.;
            windows[w][0] += 1.;
            ss += (offset as f64 / o.fps).powi(2);
        }
        t += period;
    }
    let support = supported / count.max(1.);
    let contrast = ((best_on - best_off) / best_on.max(0.01)).max(0.);
    let jitter_ms = (ss / supported.max(1.)).sqrt() * 1000.;
    let active: Vec<_> = windows
        .iter()
        .filter(|w| w[1] >= 4. && w[2] / w[3].max(1.) > (best_on * 0.025).max(0.05))
        .collect();
    let regional = if active.is_empty() {
        0.
    } else {
        active.iter().filter(|w| w[0] / w[1] >= 0.5).count() as f64 / active.len() as f64
    };
    let tail = active.last().is_some_and(|w| w[0] / w[1] >= 0.5);
    let stable = count >= 12.
        && support >= 0.6
        && contrast >= 0.22
        && best_on >= 1.
        && jitter_ms < 22.
        && regional >= 0.75
        && tail;
    Direct {
        t0,
        period,
        support,
        confidence: clamp(support * 0.65 + contrast * 0.35),
        jitter_ms,
        stable,
    }
}
pub fn hi_res(input: &[f32], sr: f64, lowpass: f64) -> Hi {
    let mut x = input.to_vec();
    if lowpass > 0. {
        let c = filter(sr, lowpass, false);
        Biquad::new(c).buffer(&mut x);
        Biquad::new(c).buffer(&mut x);
    }
    let hop = round(sr / 1000.) as usize;
    let n = x.len() / hop;
    let mut env = vec![0f32; n];
    let a = (-1. / (sr * 0.004)).exp();
    let (mut e, mut prev_log) = (0., -12.);
    for i in 0..n {
        let mut mx = 0f64;
        for &v in &x[i * hop..(i + 1) * hop] {
            let v = (v as f64).powi(2);
            e = a * e + (1. - a) * v;
            mx = mx.max(e);
        }
        let lg = (mx + 1e-10).log10();
        env[i] = (lg - prev_log).max(0.) as f32;
        prev_log = lg;
    }
    Hi {
        rate: sr / hop as f64,
        env,
    }
}
pub fn hi_at(h: &Hi, t: f64, radius: i64) -> f64 {
    let c = round(t * h.rate) as i64;
    (-radius..=radius).map(|k| get(&h.env, c + k)).sum()
}
pub fn refine_hi(h: &Hi, t0: f64, period: f64, k_from: i64, k_to: i64) -> f64 {
    let (mut best, mut best_s) = (0., f64::NEG_INFINITY);
    let mut dt = -0.03;
    while dt <= 0.03 + 1e-9 {
        let mut s = 0.;
        for k in k_from..=k_to {
            s += hi_at(h, t0 + dt + k as f64 * period, 2);
        }
        if s > best_s {
            best_s = s;
            best = dt;
        }
        dt += 0.0005;
    }
    t0 + best
}
pub fn snap_hi(h: &Hi, beats: &[f64]) -> Vec<f64> {
    beats
        .iter()
        .map(|t| {
            let (mut best, mut score) = (*t, hi_at(h, *t, 2) * 0.9);
            let mut dt = -0.025;
            while dt <= 0.025 + 1e-9 {
                let s = hi_at(h, *t + dt, 2);
                if s > score {
                    score = s;
                    best = t + dt;
                }
                dt += 0.001;
            }
            best
        })
        .collect()
}
pub fn onset_at(o: &Onset, arr: &[f32], t: f64) -> f64 {
    interp(arr, (t - o.t0) * o.fps)
}
pub fn refine(o: &Onset, t0: f64, period: f64, k_from: i64, k_to: i64) -> (f64, f64) {
    let (mut bt, mut bp, mut bs) = (t0, period, f64::NEG_INFINITY);
    let mut dp = -0.002;
    while dp <= 0.002 + 1e-12 {
        let p = period * (1. + dp);
        let mut dt = -0.02;
        while dt <= 0.02 + 1e-12 {
            let mut s = 0.;
            for i in k_from..=k_to {
                s += onset_at(o, &o.env, t0 + dt + i as f64 * p);
            }
            if s > bs {
                bs = s;
                bt = t0 + dt;
                bp = p;
            }
            dt += 0.001;
        }
        dp += 0.0005;
    }
    (bt, bp)
}
