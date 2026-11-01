use super::common::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn normalization_gain(an: &Value, target: Option<f64>) -> f64 {
    let Some(target) = target.filter(|_| !an.is_null()) else {
        return 0.;
    };
    let l = &an["loudness"];
    let integrated = n(l, "integratedLufs");
    if !integrated.is_finite() || integrated <= -69. {
        return 0.;
    }
    r3(clamp(
        (target - integrated).min(-1. - n(l, "truePeakDb") + 3.),
        -18.,
        12.,
    ))
}
pub fn tempo_relation(a: f64, b: f64) -> Value {
    let stretch = |r: f64| (r - 1.).abs().max((1. / r - 1.).abs()) * 100.;
    let mut ratio = a / b;
    let mut m = 1.;
    let mut cost = stretch(ratio);
    for candidate in [0.5, 1., 2.] {
        let r = a / (b * candidate);
        let sp = stretch(r);
        if sp < cost - 1e-9 {
            ratio = r;
            m = candidate;
            cost = sp;
        }
    }
    json!({"ratio":ratio,"m":m,"stretchPercent":cost})
}
pub fn grid_trust(an: &Value) -> Value {
    let hint = &an["structure"]["gridCheck"]["periodHint"];
    if hint.is_null() || an["beat"].is_null() {
        json!({"trusted":true})
    } else {
        json!({"trusted":false,"reason":"period-hint","hintBpm":hint["bpm"]})
    }
}
pub fn natural_fade(an: &Value) -> Value {
    let rate = n(&an["curves"], "rate");
    let rms = nums(&an["curves"]["rmsDb"]);
    let end = n(an, "audibleEnd");
    let body = n(an, "bodyRmsDb");
    let last = (rms.len() as f64 - 1.).min((end * rate).floor()) as i64;
    let width = (rate * 2.) as i64;
    let mut start = end;
    for i in (width + 1..=last).rev() {
        let sum: f64 = ((i - width)..i).map(|k| rms[k as usize]).sum();
        if sum / width as f64 >= body - 3. {
            start = i as f64 / rate;
            break;
        }
    }
    let length = (end - start).max(0.);
    let tail = level_mean(an, end - 2f64.min(length / 2.), end);
    let stop = level_mean(an, start + 0.5, start + 1.5) < level_mean(an, start - 1.5, start) - 12.;
    if tail < body - 8. && length >= 3. && !stop {
        json!({"start":start,"length":length})
    } else {
        json!({"start":end,"length":0})
    }
}
pub fn bar_pattern(g: &Value, from: f64, to: f64) -> Option<Vec<Vec<f64>>> {
    let beats = nums(&g["beats"]);
    let kick = nums(&g["accents"]["kick"]);
    let snare = nums(&g["accents"]["snare"]);
    if g["accents"].is_null() || kick.len() != beats.len() || snare.len() != beats.len() {
        return None;
    }
    let down: BTreeSet<i64> = nums(&g["downbeats"])
        .iter()
        .map(|t| round(t * 1000.) as i64)
        .collect();
    let mut sum = vec![vec![0.; 4]; 2];
    let mut count = [0usize; 4];
    let mut pos = None;
    for (i, t) in beats.iter().enumerate() {
        if down.contains(&(round(t * 1000.) as i64)) {
            pos = Some(0);
        } else if let Some(p) = pos {
            pos = Some((p + 1) % 4);
        }
        let Some(p) = pos else {
            continue;
        };
        if *t < from || *t >= to {
            continue;
        }
        sum[0][p] += kick[i];
        sum[1][p] += snare[i];
        count[p] += 1;
    }
    if count.iter().any(|c| *c < 3) || sum.iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    for band in &mut sum {
        for i in 0..4 {
            band[i] /= count[i] as f64;
        }
    }
    Some(sum)
}
pub fn drum_alignment(a: &[Vec<f64>], b: &[Vec<f64>]) -> Option<Vec<f64>> {
    if a.len() != 2 || b.len() != 2 || a.iter().chain(b).any(|v| v.len() != 4) {
        return None;
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let sd = |v: &[f64]| {
        let m = mean(v);
        (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
    };
    let bands: Vec<usize> = (0..2)
        .filter(|f| sd(&a[*f]) >= 0.3 * mean(&a[*f]) && sd(&b[*f]) >= 0.3 * mean(&b[*f]))
        .collect();
    if bands.is_empty() {
        return None;
    }
    Some(
        (0..4)
            .map(|k| {
                bands
                    .iter()
                    .map(|f| {
                        let ma = mean(&a[*f]);
                        let mb = mean(&b[*f]);
                        let c = (0..4)
                            .map(|i| (a[*f][i] - ma) * (b[*f][(i + k) % 4] - mb))
                            .sum::<f64>();
                        c / (4. * sd(&a[*f]) * sd(&b[*f]))
                    })
                    .sum::<f64>()
                    / bands.len() as f64
            })
            .collect(),
    )
}
pub fn verified_drum_shift(
    a: &[Vec<f64>],
    b: &Value,
    entry: f64,
    span: f64,
    rotation: usize,
    original: f64,
) -> Option<f64> {
    let pattern = bar_pattern(b, entry, entry + span)?;
    let align = drum_alignment(a, &pattern)?;
    let m = *align.get(rotation)?;
    if m.is_finite() && original.is_finite() && m >= 0.3 && m - original >= 0.5 {
        Some(m)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timing_retains_piecewise_linear_area() {
        let p = [[0., 1.], [2., 2.], [4., 1.]];
        assert_eq!(integrate_tempo(&p, 4.), 6.);
        assert!((output_time_at(&p, 6., 4.) - 4.).abs() < 1e-8);
    }
    #[test]
    fn half_double_and_loudness_limits_match_reference() {
        assert_eq!(tempo_relation(120., 60.)["ratio"], json!(1.));
        assert_eq!(tempo_relation(120., 60.)["m"], json!(2.));
        assert_eq!(
            normalization_gain(
                &json!({"loudness":{"integratedLufs":-24.,"truePeakDb":-2.}}),
                Some(-16.)
            ),
            4.
        );
    }
}
