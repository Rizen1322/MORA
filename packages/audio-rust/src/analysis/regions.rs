use super::{common::*, tempo::*};
use serde_json::{Value, json};
#[derive(Clone)]
struct Pulse {
    start: f64,
    end: f64,
    origin: f64,
    period: f64,
    confidence: f64,
    jitter: f64,
}
fn peak(o: &Onset, a: &[f32], time: f64, radius: i64) -> (f64, f64) {
    let c = round((time - o.t0) * o.fps) as i64;
    let (mut value, mut frame) = (0., c);
    for d in -radius..=radius {
        let v = get(a, c + d);
        if v > value {
            value = v;
            frame = c + d;
        }
    }
    let (left, right) = (get(a, frame - 1), get(a, frame + 1));
    let mut fraction = 0.;
    if value > 0. && left > 0. && right > 0. {
        let (l, m, r) = (left.ln(), value.ln(), right.ln());
        let den = l - 2. * m + r;
        if den.abs() > 1e-9 {
            fraction = ((l - r) / (2. * den)).clamp(-0.5, 0.5);
        }
    }
    (value, (frame as f64 + fraction) / o.fps + o.t0)
}
fn refine_pulse(o: &Onset, start: f64, end: f64, origin: f64, period: f64) -> (f64, f64) {
    let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0f64, 0., 0., 0., 0.);
    let radius = round(o.fps * 0.028).max(1.) as i64;
    let mut k = ((start - origin) / period).ceil();
    while origin + k * period < end - period * 0.1 {
        let p = peak(o, &o.low_mid, origin + k * period, radius);
        if p.0 >= 0.8 && (p.1 - origin - k * period).abs() <= 0.035 {
            n += 1.;
            sx += k;
            sy += p.1;
            sxx += k * k;
            sxy += k * p.1;
        }
        k += 1.;
    }
    if n < 16. {
        return (origin, period);
    }
    let refined = (n * sxy - sx * sy) / (n * sxx - sx * sx).max(1e-9);
    if (refined / period - 1.).abs() > 0.005 {
        (origin, period)
    } else {
        ((sy - refined * sx) / n, refined)
    }
}
fn validate(o: &Onset, mut start: f64, mut end: f64, origin: f64, period: f64) -> Option<Pulse> {
    if !period.is_finite() || period <= 0. || end - start < 12. {
        return None;
    }
    let mut raw = Vec::new();
    let radius = round(o.fps * 0.028).max(1.) as i64;
    let mut k = ((start - origin) / period - 1e-6).ceil();
    while origin + k * period < end - period * 0.1 {
        let time = origin + k * period;
        let p = peak(o, &o.low_mid, time, radius);
        let off = [0.25, 0.5, 0.75]
            .iter()
            .map(|f| peak(o, &o.low_mid, time + period * f, 1).0)
            .sum::<f64>()
            / 3.;
        raw.push([time, p.0, off, p.1 - time]);
        k += 1.;
    }
    if raw.len() < 16 {
        return None;
    }
    let average = raw.iter().map(|p| p[1]).sum::<f64>() / raw.len() as f64;
    let floor = (average * 0.32).max(0.7);
    let supported: Vec<bool> = raw
        .iter()
        .map(|p| p[1] > floor && p[3].abs() <= 0.028 + 1. / o.fps)
        .collect();
    let first = supported.iter().position(|v| *v)?;
    let last = supported.iter().rposition(|v| *v)?;
    if last - first < 15 {
        return None;
    }
    start = start.max(raw[first][0]);
    end = end.min(raw[last][0] + period);
    if end - start < 12. {
        return None;
    }
    let points = &raw[first..=last];
    let flags = &supported[first..=last];
    let n = points.len() as f64;
    let attacks: Vec<_> = points
        .iter()
        .zip(flags)
        .filter(|(_, f)| **f)
        .map(|(p, _)| p)
        .collect();
    let support = attacks.len() as f64 / n;
    let on = points.iter().map(|p| p[1]).sum::<f64>() / n;
    let off = points.iter().map(|p| p[2]).sum::<f64>() / n;
    let contrast = clamp((on - off) / on.max(0.01));
    let jitter = (attacks.iter().map(|p| p[3].powi(2)).sum::<f64>() / attacks.len().max(1) as f64)
        .sqrt()
        * 1000.;
    if support < 0.65 || contrast < 0.24 || on < 1. || jitter > 22. {
        return None;
    }
    let count = ((end - start) / 4.).floor().max(1.) as usize;
    let mut blocks = vec![[0f64; 4]; count];
    let mut offsets = vec![vec![]; count];
    for (i, p) in points.iter().enumerate() {
        let b = (((p[0] - start) / 4.).floor().max(0.) as usize).min(count - 1);
        blocks[b][0] += p[1];
        blocks[b][1] += p[2];
        blocks[b][2] += 1.;
        if flags[i] {
            blocks[b][3] += 1.;
            offsets[b].push(p[3]);
        }
    }
    let mut phases = vec![];
    for (i, b) in blocks.iter().enumerate() {
        if b[2] == 0.
            || b[3] / b[2] < 0.5
            || b[0] / b[2] < 0.8
            || (b[0] - b[1]) / b[0].max(0.01) < 0.16
        {
            return None;
        }
        phases.push(median(&offsets[i]));
    }
    if phases.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - phases.iter().copied().fold(f64::INFINITY, f64::min)
        > 0.026
    {
        return None;
    }
    let confidence = clamp(0.55 * support + 0.3 * contrast + 0.15 * (1. - jitter / 30.));
    Some(Pulse {
        start,
        end,
        origin,
        period,
        confidence,
        jitter,
    })
}
fn to_region(o: &Onset, p: &Pulse, global: Option<&Beat>) -> Value {
    let mut beats = vec![];
    let mut k = ((p.start - p.origin) / p.period - 1e-6).ceil();
    while p.origin + k * p.period < p.end - p.period * 0.1 {
        beats.push(p.origin + k * p.period);
        k += 1.;
    }
    let gp = global
        .filter(|g| g.stable && (p.period / g.period - 1.).abs() < 0.0005)
        .and_then(|g| {
            g.downbeats
                .iter()
                .find(|t| **t >= p.start - p.period * 0.1 && **t < p.end)
        });
    let (phase, dc) = if let Some(&gp) = gp.filter(|gp| {
        !beats.is_empty()
            && ((**gp - beats[0]) / p.period - round((**gp - beats[0]) / p.period)).abs() < 0.04
    }) {
        (
            (round((gp - beats[0]) / p.period) as i64).rem_euclid(4) as usize,
            global.unwrap().downbeat_confidence,
        )
    } else {
        let mut scores: Vec<_> = (0..4)
            .map(|phase| {
                let mut s = 0.;
                let mut n = 0;
                for i in (phase..beats.len()).step_by(4) {
                    s += peak(o, &o.low, beats[i], 1).0;
                    n += 1;
                }
                (phase, s / n.max(1) as f64)
            })
            .collect();
        scores.sort_by(|a, b| b.1.total_cmp(&a.1));
        (
            scores[0].0,
            clamp((scores[0].1 - scores[1].1) / scores[0].1.max(0.01) * 3.),
        )
    };
    json!({"start":rounded(p.start,10000.),"end":rounded(p.end,10000.),"bpm":rounded(60./p.period,100.),"period":p.period,"confidence":rounded(p.confidence,1000.),"jitterMs":rounded(p.jitter,10.),"beats":beats.iter().map(|t|rounded(*t,10000.)).collect::<Vec<_>>(),"downbeats":beats.iter().enumerate().filter(|(i,_)|i%4==phase).map(|(_,t)|rounded(*t,10000.)).collect::<Vec<_>>(),"downbeatConfidence":dc,"downbeatPhase":phase})
}
pub fn detect(o: &Onset, start: f64, end: f64, global: Option<&Beat>, hi: &Hi) -> Vec<Value> {
    if end - start < 12. {
        return vec![];
    }
    let reliable = global.filter(|g| g.stable && g.confidence >= 0.45 && !g.beats.is_empty());
    if let Some(g) = reliable {
        if let Some(whole) = validate(o, start, end, g.beats[0], g.period) {
            if whole.start - start < g.period && end - whole.end < g.period {
                return vec![to_region(o, &whole, global)];
            }
        }
    }
    let last_start = start.max(end - 24.);
    let mut starts: Vec<f64> = vec![];
    let add = |starts: &mut Vec<f64>, s: f64| {
        let s = rounded(s.clamp(start, last_start), 1000.);
        if !starts.contains(&s) {
            starts.push(s);
        }
    };
    let mut t = start;
    while t < end.min(start + 75.) - 12. {
        add(&mut starts, t);
        t += 8.;
    }
    t = start.max(end - 96.);
    while t < end - 12. {
        add(&mut starts, t);
        t += 8.;
    }
    add(&mut starts, last_start);
    let remaining = 100usize.saturating_sub(starts.len()).max(1);
    let coarse = ((last_start - start) / remaining as f64).max(16.);
    t = start;
    while t <= last_start && starts.len() < 100 {
        add(&mut starts, t);
        t += coarse;
    }
    starts.sort_by(f64::total_cmp);
    let mut pulses = vec![];
    for s in starts {
        let e = end.min(s + 24.);
        if e - s < 12. {
            continue;
        }
        let mut best = reliable.and_then(|g| validate(o, s, e, g.beats[0], g.period));
        if best.is_none() {
            let from = ((s - o.t0) * o.fps).floor().max(0.) as usize;
            let to = (((e - o.t0) * o.fps).ceil() as usize).min(o.low_mid.len());
            let est = estimate(&o.low_mid, o.fps, from, to);
            if est.strength < 0.4 {
                continue;
            }
            let mut all = vec![];
            if let Some(g) = global.filter(|g| g.stable) {
                all.push(g.bpm);
            }
            all.extend([est.bpm, est.bpm / 2., est.bpm * 2.]);
            if let Some(g) = global.filter(|g| !g.stable) {
                all.push(g.bpm);
            }
            let tempos: Vec<_> = all
                .iter()
                .enumerate()
                .filter(|(i, b)| {
                    **b >= 55.
                        && **b <= 215.
                        && all.iter().position(|x| (x - **b).abs() < 0.2) == Some(*i)
                })
                .map(|(_, b)| *b)
                .collect();
            for bpm in tempos {
                let fitted = fit_onset(o, s, e, bpm);
                if !fitted.stable {
                    continue;
                }
                let (origin, p) = refine_pulse(o, s, e, fitted.t0, fitted.period);
                let origin = refine_hi(
                    hi,
                    origin,
                    p,
                    ((s - origin) / p).ceil() as i64,
                    ((e - origin) / p).floor() as i64,
                );
                let Some(candidate) = validate(o, s, e, origin, p) else {
                    continue;
                };
                if best
                    .as_ref()
                    .is_none_or(|b: &Pulse| candidate.confidence > b.confidence + 0.015)
                {
                    best = Some(candidate.clone());
                }
                if global
                    .is_some_and(|g| g.stable && (candidate.period / g.period - 1.).abs() < 0.002)
                {
                    break;
                }
            }
        }
        if let Some(p) = best {
            pulses.push(p);
        }
    }
    pulses.sort_by(|a, b| a.start.total_cmp(&b.start).then(b.end.total_cmp(&a.end)));
    let mut merged: Vec<Pulse> = vec![];
    for p in pulses {
        if let Some(previous) = merged.last() {
            if p.start <= previous.end + previous.period * 0.15
                && (p.period / previous.period - 1.).abs() < 0.005
            {
                let phase = p.origin
                    - previous.origin
                    - round((p.origin - previous.origin) / previous.period) * previous.period;
                if phase.abs() < 0.025 {
                    if let Some(whole) = validate(
                        o,
                        previous.start,
                        previous.end.max(p.end),
                        previous.origin,
                        previous.period,
                    ) {
                        *merged.last_mut().unwrap() = whole;
                        continue;
                    }
                }
            }
        }
        if !merged.iter().any(|r| {
            p.start >= r.start && p.end <= r.end && (p.period / r.period - 1.).abs() < 0.005
        }) {
            merged.push(p);
        }
    }
    merged.iter().map(|p| to_region(o, p, global)).collect()
}
