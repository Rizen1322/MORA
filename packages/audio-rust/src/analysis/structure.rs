use super::common::*;
use serde_json::{Value, json};
pub struct Curves {
    pub rms: Vec<f64>,
    pub low: Vec<f64>,
    pub mid: Vec<f64>,
    pub high: Vec<f64>,
    pub density: Vec<f64>,
}
pub fn sections(
    c: &Curves,
    start: f64,
    end: f64,
    beat: Option<&Beat>,
    harmonic: &[f64],
) -> Vec<Value> {
    let arrays = [&c.rms, &c.low, &c.mid, &c.high, &c.density];
    let prefix: Vec<Vec<f64>> = arrays
        .iter()
        .map(|a| {
            let mut p = vec![0.; a.len() + 1];
            for i in 0..a.len() {
                p[i + 1] = p[i] + a[i];
            }
            p
        })
        .collect();
    let mean = |k: usize, a: f64, b: f64| {
        let p = &prefix[k];
        let from = ((a * RATE).floor().max(0.) as usize).min(p.len() - 1);
        let to = ((b * RATE).ceil().max(from as f64) as usize).min(p.len() - 1);
        if to > from {
            (p[to] - p[from]) / (to - from) as f64
        } else if k == 4 {
            0.
        } else {
            -90.
        }
    };
    let mut samples = vec![];
    let mut t = start + 3.;
    while t <= end - 3. {
        let change: Vec<f64> = (0..5)
            .map(|k| (mean(k, t - 2., t) - mean(k, t, t + 2.)).abs())
            .collect();
        let value = 0.35 * change[0] / 6.
            + 0.65 * (change[1] + change[2] + change[3]) / 18.
            + change[4] * 1.5;
        samples.push((t, value));
        t += 0.25;
    }
    let med = median(&samples.iter().map(|s| s.1).collect::<Vec<_>>());
    let mad = median(
        &samples
            .iter()
            .map(|s| (s.1 - med).abs())
            .collect::<Vec<_>>(),
    );
    let threshold = (med + 2.5 * mad).max(0.55);
    let mut candidates: Vec<_> = samples
        .iter()
        .enumerate()
        .filter(|(i, s)| {
            s.1 >= threshold
                && s.1 >= if *i > 0 { samples[*i - 1].1 } else { 0. }
                && s.1 > samples.get(*i + 1).map_or(0., |s| s.1)
        })
        .map(|(_, s)| (s.0, clamp(s.1 / 1.5)))
        .collect();
    for &time in harmonic {
        if time > start + 3. && time < end - 3. {
            candidates.push((time, 0.45));
        }
    }
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut accepted: Vec<(f64, f64)> = vec![];
    for (mut time, value) in candidates {
        if let Some(b) =
            beat.filter(|b| b.stable && b.downbeat_confidence >= 0.25 && !b.downbeats.is_empty())
        {
            let nearest = *b
                .downbeats
                .iter()
                .min_by(|a, b| (*a - time).abs().total_cmp(&(*b - time).abs()))
                .unwrap();
            if (nearest - time).abs() <= 1.2f64.min(b.period * 2.) {
                time = nearest;
            }
        }
        if time <= start + 2.
            || time >= end - 2.
            || accepted.iter().any(|s| (s.0 - time).abs() < 6.)
        {
            continue;
        }
        accepted.push((time, value));
    }
    accepted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut bounds = vec![(start, 0.)];
    bounds.extend(accepted);
    bounds.push((end, 0.));
    bounds.windows(2).map(|b|json!({"start":rounded(b[0].0,1000.),"end":rounded(b[1].0,1000.),"rmsDb":rounded(mean(0,b[0].0,b[1].0),10.),"midDensity":rounded(mean(4,b[0].0,b[1].0),1000.),"novelty":rounded(b[0].1,1000.)})).collect()
}
