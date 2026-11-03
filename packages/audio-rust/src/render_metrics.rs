use crate::dsp::{Biquad, Coefs};
use serde_json::{Value, json};
use std::f64::consts::{FRAC_1_SQRT_2, PI};

fn filter(c: Coefs) -> Biquad {
    let mut b = Biquad::default();
    b.c = c;
    b
}
fn weighting(sr: f64) -> [Coefs; 2] {
    let k = (PI * 1681.974450955533 / sr).tan();
    let q = 0.7071752369554196;
    let vh = 10f64.powf(3.999843853973347 / 20.);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1. + k / q + k * k;
    let shelf = Coefs {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2. * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2. * (k * k - 1.) / a0,
        a2: (1. - k / q + k * k) / a0,
    };
    let k = (PI * 38.13547087602444 / sr).tan();
    let a0 = 1. + k / 0.5003270373238773 + k * k;
    [
        shelf,
        Coefs {
            b0: 1.,
            b1: -2.,
            b2: 1.,
            a1: 2. * (k * k - 1.) / a0,
            a2: (1. - k / 0.5003270373238773 + k * k) / a0,
        },
    ]
}
fn lowpass(sr: f64) -> Coefs {
    let w = 2. * PI * 150. / sr;
    let c = w.cos();
    let a = w.sin() / (2. * FRAC_1_SQRT_2);
    Coefs {
        b0: (1. - c) / 2. / (1. + a),
        b1: (1. - c) / (1. + a),
        b2: (1. - c) / 2. / (1. + a),
        a1: -2. * c / (1. + a),
        a2: (1. - a) / (1. + a),
    }
}
fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() >> 1).copied().unwrap_or(-90.)
}
fn power_mean(values: &[f64]) -> f64 {
    10. * (values.iter().map(|v| 10f64.powf(v / 10.)).sum::<f64>() / values.len() as f64).log10()
}
fn short(level: &[f64], i: usize, lo: usize, hi: usize) -> f64 {
    power_mean(&level[lo.max(i.saturating_sub(15))..hi.min(i + 15)])
}
fn flams_in(env: &[f32], a: usize, b: usize) -> usize {
    let flux = |j: usize| (env[j] as f64 - env[j.saturating_sub(10)] as f64).max(0.);
    let flux_max = (a..b).map(flux).fold(0f64, f64::max);
    let mut attacks = Vec::new();
    for j in a + 1..b.saturating_sub(1) {
        if flux_max > 0.
            && flux(j) >= 0.5 * flux_max
            && flux(j) > flux(j - 1)
            && flux(j) >= flux(j + 1)
            && attacks.last().is_none_or(|last| j - last >= 25)
        {
            attacks.push(j);
        }
    }
    attacks.windows(2).filter(|p| p[1] - p[0] <= 90).count()
}

/// The same 100 ms, 3 s loudness and low-band attack measurements as the planner oracle.
pub fn metrics(
    plan: &Value,
    sample_rate: u32,
    left: &[f32],
    right: &[f32],
    transition_start: i64,
    limiter_reduction: f64,
    underruns: usize,
) -> Value {
    let n = left.len();
    if n == 0
        || right.len() != n
        || sample_rate < 10
        || transition_start < 0
        || transition_start as usize >= n
    {
        return Value::Null;
    }
    let sr = sample_rate as f64;
    let duration = plan["duration"].as_f64().unwrap_or(f64::NAN);
    let gap = plan["gap"].as_f64().unwrap_or(0.);
    if !duration.is_finite() || !gap.is_finite() || duration < 0. || gap < 0. {
        return Value::Null;
    }
    let [k1, k2] = weighting(sr);
    let (mut kl, mut kr) = ([filter(k1), filter(k2)], [filter(k1), filter(k2)]);
    let mut weighted = vec![0f32; n];
    for i in 0..n {
        let l = kl[0].step(left[i] as f64);
        let l = kl[1].step(l);
        let r = kr[0].step(right[i] as f64);
        let r = kr[1].step(r);
        weighted[i] = ((l * l + r * r) / 2.).sqrt() as f32;
    }
    let mut low = left.to_vec();
    let mut low_r = right.to_vec();
    for x in [&mut low, &mut low_r] {
        for _ in 0..2 {
            let mut b = filter(lowpass(sr));
            for v in x.iter_mut() {
                *v = b.step(*v as f64) as f32;
            }
        }
    }
    for i in 0..n {
        low[i] = (((low[i] as f64).powi(2) + (low_r[i] as f64).powi(2)) / 2.).sqrt() as f32;
    }
    let hop = (sr / 10. + 0.5).floor() as usize;
    let db = |x: &[f32]| {
        10. * (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / hop as f64)
            .max(1e-12)
            .log10()
    };
    let level: Vec<f64> = weighted.chunks_exact(hop).map(db).collect();
    let low_level: Vec<f64> = low.chunks_exact(hop).map(db).collect();
    let t0 = transition_start as usize / hop;
    if t0 > level.len() {
        return Value::Null;
    }
    let t1 = level
        .len()
        .min(t0.saturating_add(((duration + gap) * 10.).ceil() as usize));
    let before = median(&(0..t0).map(|i| short(&level, i, 0, t0)).collect::<Vec<_>>());
    let after = median(
        &(t1..level.len())
            .map(|i| short(&level, i, t1, level.len()))
            .collect::<Vec<_>>(),
    );
    let low_before = median(&low_level[..t0]);
    let low_after = median(&low_level[t1..]);
    let (mut dip, mut bump, mut hole) = (0f64, 0f64, 0f64);
    for i in t0..t1 {
        let m = short(&level, i, 0, level.len());
        dip = dip.min(m - before.min(after));
        bump = bump.max(m - before.max(after));
        let lm = power_mean(&low_level[t0.max(i.saturating_sub(5))..t1.min(i + 5)]);
        if low_before > -45. && low_after > -45. && lm < low_before.min(low_after) - 10. {
            hole += 0.1;
        }
    }
    let ms = sr / 1000.;
    let mut env = vec![0f32; (n as f64 / ms).ceil() as usize];
    let (mut e, mut in0, mut in1) = (0f64, 0usize, 0usize);
    for (j, v) in env.iter_mut().enumerate() {
        let a0 = (((j as f64 - 15.) * ms + 0.5).floor().max(0.)) as usize;
        let a1 = n.min((j as f64 * ms + 0.5).floor() as usize);
        while in1 < a1 {
            e += (low[in1] as f64).powi(2);
            in1 += 1;
        }
        while in0 < a0 {
            e -= (low[in0] as f64).powi(2);
            in0 += 1;
        }
        *v = (e.max(0.) / (a1 - a0).max(1) as f64).sqrt() as f32;
    }
    let from = (transition_start as f64 / ms).floor() as usize;
    let to = (env.len() - 1).min(from.saturating_add(((duration + gap) * 1000.).ceil() as usize));
    let own_rate = (if from > 1000 {
        flams_in(&env, 0, from) as f64 / from as f64
    } else {
        0.
    })
    .max(if env.len() - to > 1000 {
        flams_in(&env, to, env.len()) as f64 / (env.len() - to) as f64
    } else {
        0.
    });
    let flams = ((flams_in(&env, from, to) as f64 - own_rate * (to - from) as f64) + 0.5)
        .floor()
        .max(0.);
    let cost = 0.3 * (-dip - 1.5).max(0.)
        + 0.3 * (bump - 1.).max(0.)
        + 0.2 * (limiter_reduction - 2.).max(0.)
        + 0.3 * hole
        + 0.025 * flams
        + 0.25 * flams / duration.max(1.)
        + if underruns > 0 { 10. } else { 0. };
    let r2 = |x: f64| (x * 100. + 0.5).floor() / 100.;
    json!({"dipLU":r2(dip),"bumpLU":r2(bump),"limiterDb":r2(limiter_reduction),"lowHoleSeconds":r2(hole),"flams":flams,"underruns":underruns,"cost":r2(cost)})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_render_windows() {
        let plan = json!({"duration": 1., "gap": 0.});
        for (l, r, start) in [
            (&[][..], &[][..], 0),
            (&[0.][..], &[][..], 0),
            (&[0.][..], &[0.][..], -1),
            (&[0.][..], &[0.][..], 1),
        ] {
            assert!(metrics(&plan, 48000, l, r, start, 0., 0).is_null());
        }
    }

    #[test]
    fn measurement_window_is_bounded_by_rendered_frames() {
        let pcm = vec![0.; 4800];
        let result = metrics(
            &json!({"duration": 1e308, "gap": 1e308}),
            48000,
            &pcm,
            &pcm,
            1,
            0.,
            0,
        );
        assert!(result["cost"].as_f64().is_some_and(f64::is_finite));
    }
}
