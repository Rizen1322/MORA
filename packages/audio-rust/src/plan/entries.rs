use super::{
    common::*,
    context::Ctx,
    fullmix::{body_density, pickup_lost, voice_unknown},
    voice_measure::*,
};
use serde_json::{Value, json};

pub fn density(an: &Value, from: f64, to: f64) -> f64 {
    curve_mean_values(
        &an["curves"]["midDensity"],
        n(&an["curves"], "rate"),
        from,
        to,
    )
}
pub fn level_before(a: &Value, exit: f64) -> f64 {
    power_level(
        a,
        n(a, "audibleStart").max(exit - 6.),
        (n(a, "audibleStart") + 0.1).max(exit - 1.),
        "rmsDb",
    )
    .max(n(a, "bodyRmsDb") - 2.)
}
pub fn filtered_power(
    an: &Value,
    time: f64,
    gain: f64,
    low: f64,
    mid: f64,
    high: f64,
    voice_gain: f64,
) -> f64 {
    let t0 = n(an, "audibleStart").max(time - 0.6);
    let t1 = n(an, "audibleEnd").min(time + 0.9);
    let rate = n(&an["curves"], "rate");
    let bands: [f64; 3] = ["lowDb", "midDb", "highDb"]
        .map(|k| 10f64.powf(curve_mean_values(&an["curves"][k], rate, t0, t1) / 10.));
    let filtered = (bands[0] * low * low + bands[1] * mid * mid + bands[2] * high * high)
        / (bands.iter().sum::<f64>()).max(1e-12);
    10f64.powf((power_level(an, t0, t1, "rmsDb") + gain) / 10.)
        * filtered
        * vocal_power_retained(an, t0, t1, voice_gain)
}
pub fn cut_score(a: &Value, end: f64) -> f64 {
    let cut = n(a, "audibleEnd") - end;
    if cut <= 2. {
        return 1.;
    }
    let fraction = cut
        / if density(a, end, n(a, "audibleEnd")) < 0.18 {
            45.
        } else {
            14.
        };
    1. - fraction - 0.25 * (fraction - 1.).max(0.).powf(1.3)
}
pub fn sung_seconds(an: &Value, from: f64, to: f64) -> f64 {
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    if v.is_null() || !(rate > 0.) {
        return 0.;
    }
    let values = nums(&v["values"]);
    let lo = (from * rate).floor().max(0.) as usize;
    let hi = ((to * rate).ceil().max(0.) as usize).min(values.len());
    values
        .get(lo..hi)
        .unwrap_or(&[])
        .iter()
        .filter(|x| x.is_finite())
        .map(|x| clamp((x - 0.15) / 0.7, 0., 1.))
        .sum::<f64>()
        / rate
}
pub fn entry_skip_cost(b: &Value, time: f64, sung: bool, unknown: bool) -> f64 {
    let skipped = time - n(b, "audibleStart");
    if skipped < 1. {
        return 0.;
    }
    let level = level_mean(b, n(b, "audibleStart"), time);
    let dens = density(b, n(b, "audibleStart"), time);
    let fullness = clamp((level - n(b, "bodyRmsDb") + 12.) / 12., 0., 1.);
    clamp(skipped / 60., 0., 1.) * (0.08 + 0.2 * fullness + 0.12 * clamp(dens / 0.4, 0., 1.))
        + if sung {
            0.03 * (sung_seconds(b, n(b, "audibleStart"), time) - 5.).max(0.)
        } else {
            0.
        }
        + if unknown {
            0.005 * (skipped - 5.).max(0.) * clamp((dens / body_density(b) - 0.7) / 0.3, 0., 1.)
        } else {
            0.
        }
}
pub fn voice_too_soon(b: &Value, time: f64, outgoing_unknown: bool) -> bool {
    if time < n(b, "audibleStart") + 1. {
        return false;
    }
    let bar = opt(&b["beat"], "period", 0.) * 4.;
    let lead = if outgoing_unknown {
        clamp(bar * 2., 4., 6.)
    } else {
        clamp(bar, 1.5, 3.)
    } - 0.1;
    first_voice(b, time, n(b, "duration").min(time + lead)).is_some_and(f64::is_finite)
}
fn cue(time: f64, score: f64, kind: &str, tags: Vec<String>) -> Value {
    json!({"time":time,"score":score,"kind":kind,"tags":tags})
}
fn tags(c: &Value, name: &str) -> bool {
    arr(&c["tags"]).iter().any(|v| v == name)
}
pub fn entry_candidates(
    b: &Value,
    s: &Value,
    before: f64,
    total: f64,
    allow_lead: bool,
    outgoing_unknown: bool,
) -> Vec<Value> {
    let start = n(b, "audibleStart");
    let len = n(b, "audibleEnd") - start;
    if super::common::s(s, "entryMode") == "preserve" || s["maxEntrySkipSeconds"] == 0 {
        return vec![cue(start, 0.76, "start", vec!["preserve-opening".into()])];
    }
    let limit = start + opt(s, "maxEntrySkipSeconds", 45.).min(len * 0.45);
    let mut candidates: Vec<Value> = arr(&b["cues"]["entry"])
        .iter()
        .filter(|c| n(c, "time") >= start - 0.05 && n(c, "time") <= limit)
        .cloned()
        .collect();
    let bars = nums(&b["beat"]["downbeats"]);
    let snap = |time: f64| {
        let mut best = time;
        if let Some(first) = bars.first() {
            best = *first;
            for t in bars.iter().skip(1) {
                if (t - time).abs() < (best - time).abs() {
                    best = *t;
                }
            }
        }
        best
    };
    let mut targets = nums(&b["sectionBoundaries"]);
    targets.push(n(&b["intro"], "end"));
    if s["stemMixing"] != false {
        targets.extend(vocal_starts(b, 75.));
    }
    for target in targets
        .into_iter()
        .filter(|t| *t > start + 4. && *t <= limit + total)
    {
        for lead in [0., before, total] {
            let time = snap(target - lead);
            if time < start - 0.03
                || time > limit
                || candidates
                    .iter()
                    .any(|c| (n(c, "time") - time).abs() < 0.03)
            {
                continue;
            }
            candidates.push(cue(
                r3(time),
                0.68,
                "section",
                vec![
                    "structural-arrival".into(),
                    format!("arrival:{}", r3(target)),
                ],
            ));
        }
    }
    let first = first_voice(b, start, n(b, "audibleEnd"));
    let grid = &b["beat"];
    let grid_valid = !grid.is_null()
        && grid["stable"] == true
        && n(grid, "confidence") >= 0.45
        && n(grid, "period") > 0.;
    let phrases = if allow_lead && grid_valid && first.is_some_and(f64::is_finite) {
        vocal_starts(b, 75.)
    } else {
        vec![]
    };
    if grid_valid && !phrases.is_empty() {
        let bar = n(grid, "period") * 4.;
        for target in phrases {
            for count in [1., 2., 4.] {
                let time = r3(snap(target - count * bar));
                let lead = target - time;
                if time < start - 0.03
                    || time > limit
                    || lead < bar - 0.1
                    || lead > bar * 4. + 0.1
                    || first_voice(b, time, target) != Some(f64::INFINITY)
                    || candidates
                        .iter()
                        .any(|c| (n(c, "time") - time).abs() < 0.03)
                {
                    continue;
                }
                candidates.push(cue(
                    time,
                    1.,
                    "section",
                    vec![
                        "measured-vocal-lead".into(),
                        format!("lead-target:{}", r3(target)),
                        format!("lead-bars:{count}"),
                    ],
                ));
            }
        }
        let local: Vec<Value> = vocal_phrases(b)
            .into_iter()
            .filter(|p| {
                n(p, "confidence") >= 0.5
                    && candidates.iter().any(|c| {
                        n(c, "time") >= n(p, "start") - 0.2 && n(c, "time") <= n(p, "end") + 0.2
                    })
            })
            .collect();
        if !local.is_empty() {
            candidates = candidates
                .into_iter()
                .filter(|c| {
                    !local.iter().any(|p| {
                        n(c, "time") >= n(p, "start") - 0.2 && n(c, "time") <= n(p, "end") + 0.2
                    })
                })
                .map(|mut c| {
                    if local.iter().any(|p| {
                        let lead = n(p, "start") - n(&c, "time");
                        lead >= bar - 0.1
                            && lead <= bar * 4. + 0.1
                            && first_voice(b, n(&c, "time"), n(p, "start")) == Some(f64::INFINITY)
                    }) {
                        c["score"] = json!(n(&c, "score").max(1.));
                        c["tags"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!("measured-vocal-lead"));
                    }
                    c
                })
                .collect();
            if candidates.is_empty() {
                candidates.push(cue(
                    start,
                    0.76,
                    "start",
                    vec!["measured-vocal-lead-unavailable".into()],
                ));
            }
        }
    }
    if allow_lead && s["stemMixing"] != false {
        candidates.retain(|c| !voice_too_soon(b, n(c, "time"), outgoing_unknown));
    }
    if candidates.is_empty() {
        candidates.push(cue(start, 0.6, "start", vec![]));
    } else if voice_unknown(b, s)
        && !candidates
            .iter()
            .any(|c| (n(c, "time") - start).abs() < 0.05)
    {
        candidates.push(cue(start, 0.6, "start", vec!["full-mix-start".into()]));
    }
    candidates
}
pub fn arrival_fit(b: &Value, entry: f64, before: f64, total: f64) -> (f64, Option<f64>) {
    let mut best = (0., None);
    let mut targets = nums(&b["sectionBoundaries"]);
    targets.push(n(&b["intro"], "end"));
    for time in targets {
        if time < n(b, "audibleStart") + 3. || time < entry - 0.1 {
            continue;
        }
        let before_level = level_mean(b, n(b, "audibleStart").max(time - 6.), time);
        let after = level_mean(b, time, n(b, "audibleEnd").min(time + 6.));
        if after < n(b, "bodyRmsDb") - 6. || after < before_level - 2. {
            continue;
        }
        let distance = (entry + before - time)
            .abs()
            .min((entry + total - time).abs());
        let score = (0.5 + 0.5 * clamp((after - before_level) / 8., 0., 1.))
            * (1. - clamp(distance / 3f64.max(total * 0.35), 0., 1.));
        if score > best.0 {
            best = (score, Some(time));
        }
    }
    best
}
pub fn describe_entry(p: &mut Value, b: &Value, c: &Value, arrival: Option<f64>) {
    let skipped = r3((n(p, "bEntry") - n(b, "audibleStart")).max(0.));
    let mut targets = nums(&b["sectionBoundaries"]);
    targets.push(n(&b["intro"], "end"));
    let kind = if skipped < 1. {
        "start"
    } else if s(c, "kind") == "section"
        || arrival.is_some_and(|a| targets.iter().any(|t| (t - a).abs() < 0.05))
    {
        "section"
    } else {
        "intro-trim"
    };
    p["entrySelection"] =
        json!({"kind":kind,"skippedSeconds":skipped,"confidence":r3(clamp(n(c,"score"),0.,1.))});
    if let Some(time) = arrival {
        p["entrySelection"]["arrivalTime"] = json!(r3(time));
    }
    if skipped >= 2. {
        let reason = format!(
            "вход в следующий трек с {} с: выбрана подходящая граница по энергии и структуре",
            fixed(n(p, "bEntry"), 1)
        );
        p["reasons"].as_array_mut().unwrap().push(json!(reason));
    }
}
pub fn voice_clash(
    a: &Value,
    b: &Value,
    a_start: f64,
    native_a: f64,
    b_start: f64,
    native_b: f64,
    duration: f64,
    gains: impl Fn(f64) -> [f64; 2],
) -> f64 {
    if a["vocalActivity"].is_null() || b["vocalActivity"].is_null() {
        return 0.;
    }
    let mut lost = 0.;
    for i in 0..12 {
        let x = (i as f64 + 0.5) / 12.;
        let [ga, gb] = gains(x);
        let aa = clamp(
            (vocal_mean(
                a,
                a_start + x * native_a - 0.4,
                a_start + x * native_a + 0.4,
            ) - 0.15)
                / 0.7,
            0.,
            1.,
        ) * ga;
        let bb = clamp(
            (vocal_mean(
                b,
                b_start + x * native_b - 0.4,
                b_start + x * native_b + 0.4,
            ) - 0.15)
                / 0.7,
            0.,
            1.,
        ) * gb;
        lost += aa.min(bb) * duration / 12.;
    }
    lost
}
pub struct PickedEntry {
    pub cue: Value,
    pub score: f64,
    pub arrival: Option<f64>,
    pub aligned: bool,
}
pub fn pick_handoff(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    a_start: f64,
    swap: f64,
    duration: f64,
    align: bool,
) -> PickedEntry {
    let preserving = s(ctx.s, "entryMode") == "preserve" || ctx.s["maxEntrySkipSeconds"] == 0;
    let unknown_a = a["vocalActivity"].is_null() && !b["vocalActivity"].is_null();
    let mut candidates = entry_candidates(
        b,
        ctx.s,
        swap,
        duration,
        ctx.requested_at.is_none(),
        unknown_a,
    );
    let grid = &b["beat"];
    let grid_valid = !grid.is_null() && grid["stable"] == true && n(grid, "confidence") >= 0.45;
    if align && grid_valid && !preserving {
        let limit = n(b, "audibleStart")
            + opt(ctx.s, "maxEntrySkipSeconds", 45.)
                .min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.45);
        let mut aligned: Vec<Value> = nums(&grid["downbeats"])
            .into_iter()
            .filter(|t| t - swap >= n(b, "audibleStart") - 0.01 && t - swap <= limit)
            .map(|t| {
                cue(
                    r3(n(b, "audibleStart").max(t - swap)),
                    0.68,
                    "downbeat",
                    vec!["handoff-downbeat".into()],
                )
            })
            .collect();
        let valid = n(grid, "period") > 0.;
        let first = first_voice(b, n(b, "audibleStart"), n(b, "audibleEnd"));
        let phrases = if ctx.requested_at.is_none()
            && ctx.s["stemMixing"] != false
            && valid
            && first.is_some_and(f64::is_finite)
        {
            vocal_phrases(b)
                .into_iter()
                .filter(|p| {
                    n(p, "confidence") >= 0.5
                        && candidates.iter().any(|c| {
                            n(c, "time") >= n(p, "start") - 0.2 && n(c, "time") <= n(p, "end") + 0.2
                        })
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        if !phrases.is_empty() && valid {
            aligned.retain(|c| {
                phrases.iter().all(|p| {
                    let time = n(c, "time");
                    if time < n(p, "start") - 0.2 || time > n(p, "end") + 0.2 {
                        return true;
                    }
                    let lead = n(p, "start") - time;
                    let bar = n(grid, "period") * 4.;
                    lead >= bar - 0.1
                        && lead <= bar * 4. + 0.1
                        && first_voice(b, time, n(p, "start")) == Some(f64::INFINITY)
                })
            });
        }
        if ctx.requested_at.is_none() && ctx.s["stemMixing"] != false {
            aligned.retain(|c| !voice_too_soon(b, n(c, "time"), unknown_a));
        }
        candidates = aligned;
    }
    if candidates.is_empty() {
        candidates.push(cue(n(b, "audibleStart"), 0.6, "start", vec![]));
    }
    let dens_a = density(a, a_start, a_start + swap.max(1.));
    let mut best: Option<PickedEntry> = None;
    for c in candidates {
        let time = n(&c, "time");
        if time + duration
            > n(b, "audibleEnd") - 3f64.min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.15)
        {
            continue;
        }
        let handoff = power_level(b, time + (swap - 0.5).max(0.), time + swap + 2., "rmsDb");
        let body = power_level(
            b,
            n(b, "audibleStart").max(n(&b["intro"], "end")),
            n(b, "audibleEnd").min((n(&b["intro"], "end") + 8.).max(n(b, "audibleStart") + 16.)),
            "rmsDb",
        );
        let energy = 1. - clamp((handoff - body).abs() / 15., 0., 1.);
        let needed = (level_before(a, a_start) + ctx.gain_a()).min(body + ctx.gain_b());
        let hole = clamp((needed - handoff - ctx.gain_b() - 2.5) / 12., 0., 1.);
        let conflict = clamp(dens_a * density(b, time, time + swap.max(1.)) * 6., 0., 1.);
        let arrival = arrival_fit(b, time, swap, duration);
        let voice_score = if ctx.s["stemMixing"] != false {
            vocal_entry_score(a, b, a_start + swap, time + swap)
        } else {
            0.
        };
        let clash = if ctx.s["stemMixing"] != false {
            voice_clash(a, b, a_start, duration, time, duration, duration, |x| {
                [cos_down(x), sin_up(x)]
            })
        } else {
            0.
        };
        let unknown_b = voice_unknown(b, ctx.s);
        let score =
            0.18 * n(&c, "score") + 0.35 * energy + 0.23 * (1. - conflict) + 0.24 * arrival.0
                - entry_skip_cost(b, time, false, unknown_b)
                - 0.45 * hole
                + 0.18 * voice_score
                - if unknown_b {
                    0.12 * pickup_lost(b, time)
                } else {
                    0.
                }
                + if tags(&c, "measured-vocal-lead") {
                    0.18
                } else {
                    0.
                }
                - 0.2f64.min(0.02 * clash);
        let aligned = grid_valid
            && nums(&grid["downbeats"])
                .iter()
                .any(|t| (t - time - swap).abs() < 0.004);
        if best.as_ref().is_none_or(|p| score > p.score) {
            best = Some(PickedEntry {
                cue: c,
                score,
                arrival: arrival.1,
                aligned,
            });
        }
    }
    best.unwrap_or_else(|| PickedEntry {
        cue: cue(n(b, "audibleStart"), 0.6, "start", vec![]),
        score: 0.,
        arrival: None,
        aligned: false,
    })
}
