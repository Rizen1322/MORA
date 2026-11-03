use super::common::*;
use serde_json::{Value, json};

const LOW: [f64; 3] = [50., 80., 120.];
const MID: [f64; 3] = [250., 700., 1800.];
const HIGH: [f64; 3] = [3500., 6000., 9000.];
pub fn voice_unknown(an: &Value, s: &Value) -> bool {
    s["stemMixing"] == false || an["vocalActivity"].is_null()
}
pub fn full_mix_pair(a: &Value, b: &Value, s: &Value) -> bool {
    voice_unknown(a, s) || voice_unknown(b, s)
}
pub fn lane_value(p: &Value, deck: &str, name: &str, t: f64) -> f64 {
    arr(&p["automation"])
        .iter()
        .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
        .map_or(
            if ["filter", "echo"].contains(&name) {
                0.
            } else {
                1.
            },
            |l| point_value(&points(&l["points"]), t),
        )
}
fn bands(an: &Value, src: f64) -> Option<[f64; 3]> {
    let c = &an["curves"];
    let rate = n(c, "rate");
    if rate <= 0. || !rate.is_finite() {
        return None;
    }
    let curves = [arr(&c["lowDb"]), arr(&c["midDb"]), arr(&c["highDb"])];
    let lo = ((src - 0.5) * rate).floor().max(0.) as usize;
    let hi = (((src + 0.5) * rate).ceil().max(0.) as usize).min(curves[0].len());
    if hi <= lo || curves.iter().any(|v| v.len() < hi) {
        return None;
    }
    let mut out = [0.; 3];
    for i in lo..hi {
        for k in 0..3 {
            let x = num(&curves[k][i]);
            if !x.is_finite() {
                return None;
            }
            out[k] += 10f64.powf(x / 10.);
        }
    }
    for v in &mut out {
        *v /= (hi - lo) as f64;
    }
    Some(out)
}
pub fn sweep_power(v: f64, hz: &[f64]) -> f64 {
    let a = clamp(v.abs(), 0., 1.);
    if a < 1e-6 {
        return 1.;
    }
    let upper = 48000f64 * 0.45;
    let fc = if v > 0. {
        20. * (300f64.ln() * a).exp()
    } else {
        upper * ((180. / upper).ln() * a).exp()
    };
    let wet = (a / 0.08).min(1.);
    hz.iter()
        .map(|f| {
            let r = (f / fc).powi(4);
            let h = (if v > 0. { r / (1. + r) } else { 1. / (1. + r) }).sqrt();
            (1. - wet + wet * h).powi(2)
        })
        .sum::<f64>()
        / hz.len() as f64
}
pub fn lead_band_retention(p: &Value, deck: &str, t: f64) -> f64 {
    let f = lane_value(p, deck, "filter", t);
    (0.1 * lane_value(p, deck, "low", t).powi(2) * sweep_power(f, &LOW)
        + 0.65 * lane_value(p, deck, "mid", t).powi(2) * sweep_power(f, &MID)
        + 0.25 * lane_value(p, deck, "high", t).powi(2) * sweep_power(f, &HIGH))
    .max(0.)
    .sqrt()
}
#[derive(Clone, Copy)]
struct Power {
    total: f64,
    low: f64,
    mid: f64,
}
fn deck_power(p: &Value, an: &Value, deck: &str, t: f64) -> Option<Power> {
    let delay = if deck == "B" {
        opt(p, "bDelay", 0.)
    } else {
        0.
    };
    let tt = t - delay;
    if tt < 0. {
        return Some(Power {
            total: 0.,
            low: 0.,
            mid: 0.,
        });
    }
    let src = if deck == "A" {
        n(p, "aExit") + integrate_tempo(&points(&p["tempoA"]), tt)
    } else {
        n(p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), tt)
    };
    if src > n(an, "audibleEnd") {
        return Some(Power {
            total: 0.,
            low: 0.,
            mid: 0.,
        });
    }
    let b = bands(an, src)?;
    let g = lane_value(p, deck, "gain", tt).powi(2)
        * 10f64.powf(n(p, if deck == "A" { "gainA" } else { "gainB" }) / 10.);
    let f = lane_value(p, deck, "filter", tt);
    let low = b[0] * lane_value(p, deck, "low", tt).powi(2) * g * sweep_power(f, &LOW);
    let mid = b[1] * lane_value(p, deck, "mid", tt).powi(2) * g * sweep_power(f, &MID);
    let high = b[2] * lane_value(p, deck, "high", tt).powi(2) * g * sweep_power(f, &HIGH);
    Some(Power {
        total: low + mid + high,
        low,
        mid,
    })
}
pub fn effective_exit(p: &Value, a: &Value) -> (f64, f64) {
    let mut t = n(p, "duration");
    while t >= 0. {
        let src = n(p, "aExit") + integrate_tempo(&points(&p["tempoA"]), t);
        if let (Some(b), Some(q)) = (bands(a, src), deck_power(p, a, "A", t)) {
            if q.total >= 0.1 * (b[0] + b[1] + b[2]) * 10f64.powf(n(p, "gainA") / 10.) {
                return (r3(t), r3(src));
            }
        }
        t -= 0.1;
    }
    (0., n(p, "aExit"))
}
pub fn pickup_lost(b: &Value, entry: f64) -> f64 {
    if b["beat"].is_null() || entry < n(b, "audibleStart") + 0.05 {
        return 0.;
    }
    let beat = n(&b["beat"], "period");
    let last = power_level(b, entry - beat, entry - 0.02, "rmsDb");
    let before = power_level(b, entry - 2. * beat, entry - beat, "rmsDb");
    if last >= n(b, "bodyRmsDb") - 12. && last >= before + 3. {
        1.
    } else {
        0.
    }
}
fn local_key(an: &Value, t: f64) -> &str {
    let l = &an["local"];
    let rate = n(l, "rate");
    if rate <= 0. || !rate.is_finite() {
        return "";
    }
    let i = (t * rate).floor();
    if i < 0. {
        return "";
    }
    let i = i as usize;
    if opt(&l["keyConfidence"], &i.to_string(), 0.) >= 0.3 {
        return l["camelot"][i].as_str().unwrap_or("");
    }
    if l["keyConfidence"][i].as_f64().unwrap_or(0.) >= 0.3 {
        l["camelot"][i].as_str().unwrap_or("")
    } else {
        ""
    }
}
pub fn local_clash_fraction(
    a: &Value,
    a_start: f64,
    a_len: f64,
    b: &Value,
    b_start: f64,
    b_len: f64,
) -> f64 {
    if a["local"].is_null() || b["local"].is_null() {
        return 0.;
    }
    let mut clash = 0.;
    for i in 0..8 {
        let x = (i as f64 + 0.5) / 8.;
        let ka = local_key(a, a_start + x * a_len);
        let kb = local_key(b, b_start + x * b_len);
        if !ka.is_empty() && !kb.is_empty() && n(&camelot_compatibility(ka, kb), "score") < 0.5 {
            clash += 1.;
        }
    }
    clash / 8.
}
pub fn tonal_clash_seconds(p: &Value, a: &Value, b: &Value) -> f64 {
    if a["local"].is_null() || b["local"].is_null() {
        return 0.;
    }
    let mut seconds = 0.;
    let mut t = 0.25;
    while t < n(p, "duration") {
        let tb = t - opt(p, "bDelay", 0.);
        if tb >= 0. {
            let ka = local_key(a, n(p, "aExit") + integrate_tempo(&points(&p["tempoA"]), t));
            let kb = local_key(
                b,
                n(p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), tb),
            );
            if !ka.is_empty()
                && !kb.is_empty()
                && n(&camelot_compatibility(ka, kb), "score") < 0.5
                && lane_value(p, "A", "gain", t) * lane_value(p, "A", "mid", t) >= 0.5
                && lane_value(p, "B", "gain", tb) * lane_value(p, "B", "mid", tb) >= 0.5
            {
                seconds += 0.5;
            }
        }
        t += 0.5;
    }
    seconds
}
pub fn body_density(an: &Value) -> f64 {
    let c = &an["curves"];
    let values = nums(&c["midDensity"]);
    let rate = n(c, "rate");
    let lo = ((n(an, "audibleStart") * rate).floor().max(0.) as usize).min(values.len());
    let hi = ((n(an, "audibleEnd") * rate).ceil().max(0.) as usize).min(values.len());
    let mut x = if hi >= lo {
        values[lo..hi].to_vec()
    } else {
        vec![]
    };
    x.sort_by(f64::total_cmp);
    if x.is_empty() { 1. } else { x[x.len() / 2] }
}
fn mean_density(an: &Value, a: f64, b: f64) -> f64 {
    let c = &an["curves"];
    let x = nums(&c["midDensity"]);
    let rate = n(c, "rate");
    let lo = (a * rate).floor().max(0.) as usize;
    let hi = ((b * rate).ceil().max(0.) as usize).min(x.len());
    if hi > lo {
        x[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
    } else {
        0.
    }
}
fn density(an: &Value, src: f64) -> f64 {
    let i = round(src * n(&an["curves"], "rate"));
    if i < 0. {
        0.
    } else {
        an["curves"]["midDensity"][i as usize]
            .as_f64()
            .unwrap_or(0.)
    }
}
pub fn lead_exposure(p: &Value, a: &Value, b: &Value) -> Value {
    let (mut seconds, mut run, mut longest) = (0., 0., 0f64);
    let mut t = 0.25;
    let audible = |an: &Value, deck: &str, tt: f64| {
        if tt < 0. {
            return 0.;
        }
        let src = n(p, if deck == "A" { "aExit" } else { "bEntry" })
            + integrate_tempo(
                &points(&p[if deck == "A" { "tempoA" } else { "tempoB" }]),
                tt,
            );
        if src < n(an, "audibleStart") || src >= n(an, "audibleEnd") {
            return 0.;
        }
        clamp(
            lane_value(p, deck, "gain", tt) * lead_band_retention(p, deck, tt),
            0.,
            1.,
        ) * clamp(density(an, src) / body_density(an).max(0.05), 0., 1.)
    };
    while t < n(p, "duration") {
        let overlap = audible(a, "A", t).min(audible(b, "B", t - opt(p, "bDelay", 0.)));
        let dt = 0.5f64.min(n(p, "duration") - (t - 0.25));
        seconds += overlap * dt;
        run = if overlap > 0.1 {
            run + overlap * dt
        } else {
            0.
        };
        longest = longest.max(run);
        t += 0.5;
    }
    json!({"seconds":r3(seconds),"run":r3(longest)})
}
pub fn has_material_mix_regression(base: &Value, candidate: &Value) -> bool {
    if base.is_null() || candidate.is_null() {
        return false;
    }
    [
        ("leadRisk", 1., 0.2),
        ("leadRun", 1., 0.2),
        ("doubleBass", 1., 0.),
        ("tonalClash", 1., 0.),
        ("spectralDamage", 1., 0.),
    ]
    .iter()
    .any(|(k, margin, ratio)| {
        let x = n(base, k);
        let y = n(candidate, k);
        x.is_finite() && y.is_finite() && y > x + f64::max(*margin, x * ratio)
    })
}
pub fn full_mix_cost(p: &Value, a: &Value, b: &Value, settings: &Value) -> Option<Value> {
    let duration = n(p, "duration");
    if duration <= 0.5 || !duration.is_finite() {
        return None;
    }
    let before = power_level(
        a,
        n(a, "audibleStart").max(n(p, "aExit") - 6.),
        (n(a, "audibleStart") + 0.1).max(n(p, "aExit") - 1.),
        "rmsDb",
    )
    .max(n(a, "bodyRmsDb") - 2.)
        + n(p, "gainA");
    let end_b =
        n(p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), duration - opt(p, "bDelay", 0.));
    let after = power_level(b, end_b, n(b, "audibleEnd").min(end_b + 4.), "rmsDb") + n(p, "gainB");
    let body_low_a = power_level(a, n(a, "audibleStart"), n(a, "audibleEnd"), "lowDb");
    let body_low_b = power_level(b, n(b, "audibleStart"), n(b, "audibleEnd"), "lowDb");
    let (mut hole, mut unsupported, mut jump, mut double_bass, mut opening, mut damage) =
        (0f64, 0., 0f64, 0., 0., 0.);
    let mut previous: Option<f64> = None;
    let mut t = 0.25;
    while t < duration {
        let pa = deck_power(p, a, "A", t)?;
        let pb = deck_power(p, b, "B", t)?;
        let level = 10. * (pa.total + pb.total).max(1e-12).log10();
        let target = before + (after - before) * (t / duration);
        hole = hole.max(target - level - 3.);
        if let Some(prev) = previous {
            jump = jump.max((level - prev).abs() - 4.);
        }
        previous = Some(level);
        let src_a = n(p, "aExit") + integrate_tempo(&points(&p["tempoA"]), t);
        let tb = t - opt(p, "bDelay", 0.);
        let src_b = if tb < 0. {
            -1.
        } else {
            n(p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), tb)
        };
        let dt = 0.5f64.min(duration - (t - 0.25));
        if tb >= 0.
            && tb < 12.
            && src_b < n(b, "audibleEnd")
            && power_level(b, src_b - 0.25, src_b + 0.25, "rmsDb") > n(b, "bodyRmsDb") - 12.
        {
            let content = clamp(density(b, src_b) / body_density(b).max(0.05), 0., 1.);
            let delivery = lane_value(p, "B", "gain", tb) * lead_band_retention(p, "B", tb);
            opening += dt * content * clamp(1. - delivery / 0.5, 0., 1.);
        }
        for (deck, tt, contribution, other) in [("A", t, pa, pb), ("B", tb, pb, pa)] {
            if tt >= 0.
                && contribution.total > other.total
                && lane_value(p, deck, "gain", tt) >= 0.5
            {
                damage += dt * clamp((0.6 - lane_value(p, deck, "mid", tt)) / 0.6, 0., 1.);
            }
        }
        if power_level(a, src_a - 0.5, src_a + 0.5, "rmsDb") < before - n(p, "gainA") - 12.
            && (src_b < 0.
                || power_level(b, src_b - 0.5, src_b + 0.5, "rmsDb") < after - n(p, "gainB") - 8.)
        {
            unsupported += 0.5;
        }
        let low_a = 10. * pa.low.max(1e-12).log10() - n(p, "gainA");
        let low_b = 10. * pb.low.max(1e-12).log10() - n(p, "gainB");
        if low_a >= body_low_a - 4. && low_b >= body_low_b - 4. {
            double_bass += 0.5;
        }
        t += 0.5;
    }
    let (_, exit) = effective_exit(p, a);
    let closure = if a["structure"].is_null() {
        0.5
    } else {
        1. - closure_at(&a["structure"], exit, 1.5)
    };
    let rest = (n(a, "audibleEnd") - exit).max(0.);
    let rest_density = if rest > 0. {
        mean_density(a, exit, n(a, "audibleEnd"))
    } else {
        0.
    };
    let scale = rest / if rest_density < 0.18 { 45. } else { 14. };
    let cut = if rest <= 2. {
        0.
    } else {
        scale + 0.25 * (scale - 1.).max(0.).powf(1.3)
    };
    let skipped = (n(p, "bEntry") - n(b, "audibleStart")).max(0.);
    let skipped_density = if skipped > 5. {
        mean_density(b, n(b, "audibleStart"), n(p, "bEntry")) / body_density(b)
    } else {
        0.
    };
    let skipped_unknown = if voice_unknown(b, settings) && skipped > 5. {
        (skipped - 5.) * clamp((skipped_density - 0.7) / 0.3, 0., 1.)
    } else {
        0.
    };
    let exposure = lead_exposure(p, a, b);
    let pickup = pickup_lost(b, n(p, "bEntry"));
    let lead_risk = n(&exposure, "seconds");
    let lead_run = n(&exposure, "run");
    let tonal = tonal_clash_seconds(p, a, b);
    let total = 0.25 * closure
        + 0.2 * cut
        + 0.15 * pickup
        + 0.05 * hole.max(0.)
        + 0.1 * unsupported
        + 0.03 * jump.max(0.)
        + 0.3 * double_bass / duration
        + 0.2 * lead_risk / duration
        + 0.025 * lead_risk
        + 0.02 * lead_run
        + 0.2 * tonal / duration
        + 0.005 * skipped_unknown
        + 0.06 * (opening - 1.).max(0.)
        + 0.05 * damage
        + 0.15 * clamp((10. - duration) / 10., 0., 1.);
    if !total.is_finite() {
        return None;
    }
    Some(
        json!({"total":r3(total),"closureMiss":r3(closure),"cutA":r3(cut),"pickup":pickup,"holeDb":r3(hole.max(0.)),"unsupported":unsupported,"jumpDb":r3(jump.max(0.)),"doubleBass":double_bass,"leadRisk":lead_risk,"leadRun":lead_run,"tonalClash":tonal,"skippedUnknownB":r3(skipped_unknown),"openingSuppression":r3(opening),"spectralDamage":r3(damage)}),
    )
}
pub fn with_bass_shift(p: &Value, dt: f64) -> Option<Value> {
    let duration = n(p, "duration");
    let lows: Vec<_> = arr(&p["automation"])
        .iter()
        .filter(|l| s(l, "lane") == "low")
        .collect();
    if lows.len() != 2 {
        return None;
    }
    let moving: Vec<_> = lows
        .iter()
        .flat_map(|l| points(&l["points"]))
        .filter(|p| p[0] > 0. && p[0] < duration)
        .map(|p| p[0])
        .collect();
    if moving.is_empty()
        || moving.iter().copied().fold(f64::INFINITY, f64::min) + dt <= 0.05
        || moving.iter().copied().fold(f64::NEG_INFINITY, f64::max) + dt >= duration - 0.05
    {
        return None;
    }
    let mut q = p.clone();
    q["id"] = json!(format!("{}_bass{}", s(p, "id"), round(dt * 1000.)));
    for l in q["automation"].as_array_mut().unwrap() {
        if s(l, "lane") == "low" {
            l["points"] = json!(
                points(&l["points"])
                    .iter()
                    .map(|[t, v]| [
                        if *t > 0. && *t < duration {
                            r3(t + dt)
                        } else {
                            *t
                        },
                        *v
                    ])
                    .collect::<Points>()
            );
        }
    }
    q["debug"]["bassShift"] = json!(r3(dt));
    Some(q)
}
