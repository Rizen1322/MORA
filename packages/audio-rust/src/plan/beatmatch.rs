use super::{
    common::*,
    context::Ctx,
    entries::*,
    fullmix::{body_density, local_clash_fraction, pickup_lost, voice_unknown},
    primitives::*,
    voice_measure::*,
};
use serde_json::{Value, json};

pub fn continuity_cost(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    exit: f64,
    entry: f64,
    native_a: f64,
    native_b: f64,
    bars: f64,
    mid_duck: bool,
) -> f64 {
    let reference = (level_before(a, exit) + ctx.gain_a()).min(
        power_level(
            b,
            entry + native_b,
            n(b, "audibleEnd").min(entry + native_b + 6.),
            "rmsDb",
        ) + ctx.gain_b(),
    );
    let mut hole: f64 = 0.;
    for i in 1..=12 {
        let x = i as f64 / 12.;
        let (mut ag, mut bg, mut al, mut bl, mut am, mut bm, mut ah, mut bh) =
            (cos_down(x), sin_up(x), 1., 1., 1., 1., 1., 1.);
        if ctx.s["eqHandoff"] == true {
            let start = 0.5f64.max((bars - 2.) / bars);
            ag = if x <= start {
                1.
            } else {
                cos_down((x - start) / (1. - start))
            };
            bg = sin_up(clamp(x / 0.5, 0., 1.));
            let bass = smoothstep(clamp((x - 0.5) * bars * 4. + 0.5, 0., 1.));
            al = 1. - bass;
            bl = bass;
            bh = 0.25 + 0.75 * smoothstep(clamp(x * 2., 0., 1.));
            ah = 1. - 0.75 * smoothstep(clamp((x - 0.5) * 2., 0., 1.));
            let b0 = if mid_duck { 0.18 } else { 0.4 };
            bm = b0 + (1. - b0) * smoothstep(clamp(x * 2., 0., 1.));
            am = 1.
                - if mid_duck { 0.8 } else { 0.55 }
                    * smoothstep(clamp((x - 0.5) / 0.5f64.min(2. / bars), 0., 1.));
        }
        let stems = ctx.s["stemMixing"] != false
            && !a["vocalActivity"].is_null()
            && !b["vocalActivity"].is_null();
        let sum = ag
            * ag
            * filtered_power(
                a,
                exit + x * native_a,
                ctx.gain_a(),
                al,
                am,
                ah,
                if stems && x >= 0.5 { 0. } else { 1. },
            )
            + bg * bg
                * filtered_power(
                    b,
                    entry + x * native_b,
                    ctx.gain_b(),
                    bl,
                    bm,
                    bh,
                    if stems && x < 0.5 { 0. } else { 1. },
                );
        hole = hole.max(reference - 10. * sum.max(1e-12).log10() - 2.5);
        if ag >= 0.5 && bl < 0.5 {
            let pos = exit + x * native_a;
            hole = hole
                .max(level_before(a, exit) - power_level(a, pos - 0.75, pos + 0.75, "rmsDb") - 6.);
        }
    }
    clamp(hole / 10., 0., 1.)
}
#[derive(Clone)]
struct Best {
    score: f64,
    e: Value,
    entry: Value,
    bars: f64,
    conflict: f64,
    cut: f64,
    arrival: Option<f64>,
    local_clash: f64,
    drum: Option<Value>,
}
pub fn beatmatch(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    rel: &Value,
    key: &Value,
    min_bars: f64,
) -> Option<Value> {
    beatmatch_capped(ctx, a, b, rel, key, min_bars, f64::INFINITY, false)
}
fn beatmatch_capped(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    rel: &Value,
    key: &Value,
    min_bars: f64,
    max_bars: f64,
    vocal_aware: bool,
) -> Option<Value> {
    let settings = ctx.s;
    let p_a = n(&a["beat"], "period");
    let bar_a = p_a * 4.;
    let ratio = n(rel, "ratio");
    let short = ctx.requested_at.is_some() || bar_a * 4. > n(settings, "maxBlendSeconds");
    let avg_a = if (ratio - 1.).abs() > 0.00001 {
        (1. + 1. / ratio) / 2.
    } else {
        1.
    };
    let repair_bars = [4., 8., 16.]
        .into_iter()
        .find(|bars| {
            bars * bar_a / avg_a >= 9.99
                && bars * bar_a / avg_a <= n(settings, "maxBlendSeconds") + 0.0001
        })
        .unwrap_or(4.);
    let bar_options = if let Some(fixed) = &ctx.fixed {
        vec![n(fixed, "bars")]
    } else if ctx.vocal_repair.is_some() {
        vec![repair_bars]
    } else if s(settings, "style") == "tight" {
        vec![4., 2., 1., 8.]
    } else if short {
        vec![16., 8., 4., 2., 1.]
    } else {
        vec![16., 8., 4.]
    };
    let unknown_a = voice_unknown(a, settings);
    let unknown_b = voice_unknown(b, settings);
    let full_mix = unknown_a || unknown_b;
    let loose = full_mix
        && [&a["beat"], &b["beat"]]
            .iter()
            .any(|g| n(g, "confidence") < 0.55 || n(g, "jitterMs") > 20.);
    let mut bar_cap = if loose { 8. } else { f64::INFINITY };
    if full_mix && n(rel, "m") != 1. {
        let accents = bar_pattern(&a["beat"], n(a, "audibleEnd") - 40., n(a, "audibleEnd"))
            .and_then(|pa| {
                bar_pattern(&b["beat"], n(b, "audibleStart"), n(b, "audibleStart") + 40.)
                    .and_then(|pb| drum_alignment(&pa, &pb))
            });
        bar_cap = bar_cap.min(accents.map_or(8., |v| if v[0] < 0.2 { 4. } else { f64::INFINITY }));
    }
    let key_clash = n(key, "compatibility") < 0.5;
    let phrases = if n(a, "phraseConfidence") >= 0.2 {
        nums(&a["phrases"])
    } else {
        vec![]
    };
    let len = n(a, "audibleEnd") - n(a, "audibleStart");
    let exits: Vec<Value> = nums(&a["beat"]["downbeats"])
        .into_iter()
        .filter(|t| {
            let start = ctx.requested_at.map_or_else(
                || *t > (n(a, "audibleStart") + len * 0.5).max(n(a, "audibleEnd") - 96.),
                |now| *t >= now + 0.15 && *t <= now + 0.15 + 3f64.min(bar_a + 0.02),
            );
            start && *t < n(a, "audibleEnd") - bar_a.min(n(settings, "maxBlendSeconds"))
        })
        .map(|t| {
            let score = arr(&a["cues"]["exit"])
                .iter()
                .rev()
                .find(|c| round(n(c, "time") * 1000.) == round(t * 1000.))
                .map_or(0.4, |c| n(c, "score"));
            let kind = if phrases.iter().any(|p| round(p * 1000.) == round(t * 1000.)) {
                "phrase"
            } else {
                "downbeat"
            };
            json!({"time":t,"score":score,"kind":kind,"tags":[]})
        })
        .collect();
    let b_down = nums(
        &b["beat"][if ctx.vocal_repair.is_some() || ctx.fixed.is_some() {
            "beats"
        } else {
            "downbeats"
        }],
    );
    let p_b = n(&b["beat"], "period");
    let voices = settings["stemMixing"] != false
        && !a["vocalActivity"].is_null()
        && !b["vocalActivity"].is_null();
    // v19: a full-energy A (no natural fade, bass at its body level through the overlap)
    let full_energy_check = ctx.fixed.is_none()
        && ctx.vocal_repair.is_none()
        && ctx.requested_at.is_none()
        && n(&natural_fade(a), "length") < 3.;
    let body_low_a = if full_energy_check {
        power_level(a, n(a, "audibleStart"), n(a, "audibleEnd"), "lowDb")
    } else {
        0.
    };
    let full_energy = |exit: f64, native_a: f64| {
        full_energy_check
            && !voices
            && power_level(a, exit, exit + native_a, "lowDb") >= body_low_a
    };
    let body_dens_a = if vocal_aware { body_density(a).max(1e-6) } else { 1. };
    let mut best: Option<Best> = None;
    let mut tried = Vec::new();
    let glide = (ratio - 1.).abs() > 0.00001;
    let target = 1. / ratio;
    for bars in bar_options {
        let native_a = bars * bar_a;
        let native_b = native_a * ratio;
        let duration = native_a / avg_a;
        if duration > n(settings, "maxBlendSeconds") + 0.0001
            || bars < min_bars
            || bars > max_bars
            || min_bars > 1. && duration < 12.
            || bars > bar_cap && ctx.fixed.is_none()
            || key_clash && bars > 8.
        {
            continue;
        }
        let entries = if let Some(fixed) = &ctx.fixed {
            vec![
                json!({"time":fixed["entry"],"score":0.76,"kind":"start","tags":["full-mix-alternative"]}),
            ]
        } else if let Some(repair) = &ctx.vocal_repair {
            vec![
                json!({"time":repair["entry"],"score":0.76,"kind":"start","tags":["preserved-vocal-repair-entry"]}),
            ]
        } else {
            entry_candidates(
                b,
                settings,
                native_b / 2.,
                native_b,
                ctx.requested_at.is_none(),
                a["vocalActivity"].is_null() && !b["vocalActivity"].is_null(),
            )
        };
        for e in &exits {
            let exit = n(e, "time");
            if ctx
                .vocal_repair
                .as_ref()
                .is_some_and(|v| exit + native_a * 0.1 < n(v, "minHandoff"))
                || exit + native_a > n(a, "audibleEnd") + 0.03
                || ctx
                    .fixed
                    .as_ref()
                    .is_some_and(|v| (exit - n(v, "exit")).abs() > 0.01)
                || ctx.region_a.as_ref().is_some_and(|v| {
                    exit < n(v, "start") - 0.001 || exit + native_a > n(v, "end") + 0.001
                })
            {
                continue;
            }
            for entry in &entries {
                let time = n(entry, "time");
                if !b_down.iter().any(|t| (t - time).abs() < 0.03)
                    || time + native_b
                        > n(b, "audibleEnd")
                            - 12f64.min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.2)
                    || ctx.region_b.as_ref().is_some_and(|v| {
                        time < n(v, "start") - 0.001 || time + native_b > n(v, "end") + 0.001
                    })
                {
                    continue;
                }
                let conflict = clamp(
                    density(a, exit, exit + native_a) * density(b, time, time + native_b) * 6.,
                    0.,
                    1.,
                );
                let dense = conflict > 0.6;
                let lock_target = if dense && !voices {
                    8.
                } else if s(settings, "style") == "smooth" {
                    20.
                } else {
                    14.
                };
                let len_pref = if s(settings, "style") == "tight" {
                    1. - clamp((bars / 4.).log2().abs() / 4., 0., 1.)
                } else {
                    1. - clamp(
                        ((lock_target / duration).log2() / 2.)
                            .max((duration / lock_target).log2() / 4.),
                        0.,
                        1.,
                    ) - if short {
                        0.
                    } else {
                        0.2 * clamp((10. - duration) / 10., 0., 1.)
                    }
                };
                let heard_end = if unknown_a {
                    exit + native_a
                        - if settings["eqHandoff"] == true && bars >= 4. {
                            0.4 * bar_a
                        } else {
                            0.2 * native_a
                        }
                } else {
                    exit + native_a
                };
                let cs = if ctx.requested_at.is_none() {
                    cut_score(a, heard_end)
                } else {
                    1.
                };
                let closure = if ctx.requested_at.is_none() && !a["structure"].is_null() {
                    closure_at(&a["structure"], heard_end, 1.5)
                } else {
                    0.
                };
                let local = if full_mix {
                    local_clash_fraction(a, exit, native_a, b, time, native_b)
                } else {
                    0.
                };
                let arrival = arrival_fit(b, time, native_b / 2., native_b);
                let phrase_bonus = if s(e, "kind") == "phrase" { 0.5 } else { 0. }
                    + if n(b, "phraseConfidence") >= 0.2
                        && ["phrase", "start"].contains(&s(entry, "kind"))
                    {
                        0.5
                    } else {
                        0.
                    };
                let a_level = level_mean(a, exit, exit + native_a) + ctx.gain_a();
                let b_level = level_mean(b, time, time + native_b) + ctx.gain_b();
                let energy = 1. - clamp((a_level - b_level).abs() / 14., 0., 1.);
                let continuity = continuity_cost(
                    ctx,
                    a,
                    b,
                    exit,
                    time,
                    native_a,
                    native_b,
                    bars,
                    conflict > 0.35 || key_clash,
                );
                let voice_score = if settings["stemMixing"] != false {
                    vocal_entry_score(a, b, exit + native_a / 2., time + native_b / 2.)
                } else {
                    0.
                };
                let fade_start = 0.5f64.max((bars - 2.) / bars);
                let clash = if settings["stemMixing"] != false {
                    voice_clash(a, b, exit, native_a, time, native_b, duration, |x| {
                        if settings["eqHandoff"] == true {
                            [
                                if x <= fade_start {
                                    1.
                                } else {
                                    cos_down((x - fade_start) / (1. - fade_start))
                                },
                                sin_up(clamp(x / 0.5, 0., 1.)),
                            ]
                        } else {
                            [cos_down(x), sin_up(x)]
                        }
                    })
                } else {
                    0.
                };
                let score = 0.1 * closure
                    + 0.1 * n(e, "score")
                    + 0.1 * n(entry, "score")
                    + 0.28 * cs
                    + 0.12 * len_pref
                    + 0.12 * (1. - conflict)
                    + 0.11 * arrival.0
                    + 0.08 * energy
                    + 0.09 * phrase_bonus
                    - entry_skip_cost(b, time, true, unknown_b)
                    - 0.45 * continuity
                    + 0.2 * voice_score
                    + if arr(&entry["tags"])
                        .iter()
                        .any(|v| v == "measured-vocal-lead")
                    {
                        0.18
                    } else {
                        0.
                    }
                    - 0.4f64.min(0.02 * clash)
                    - if unknown_b {
                        0.12 * pickup_lost(b, time)
                    } else {
                        0.
                    }
                    - 0.1 * local
                    - if vocal_aware {
                        0.2 * clamp(
                            density(
                                a,
                                exit + native_a / 2. - p_a,
                                exit + native_a / 2. + p_a,
                            ) / body_dens_a
                                - 0.8,
                            0.,
                            1.,
                        )
                    } else {
                        0.
                    };
                tried.push(json!({"exit":exit,"entry":time,"bars":bars,"cut":r3(n(a,"audibleEnd")-exit-native_a),"score":r3(score),"continuityCost":r3(continuity)}));
                if best.as_ref().is_none_or(|p| score > p.score) {
                    best = Some(Best {
                        score,
                        e: e.clone(),
                        entry: entry.clone(),
                        bars,
                        conflict,
                        cut: n(a, "audibleEnd") - exit - native_a,
                        arrival: arrival.1,
                        local_clash: local,
                        drum: None,
                    });
                }
            }
        }
    }
    let mut best = best?;
    if !vocal_aware && full_energy(n(&best.e, "time"), best.bars * bar_a) {
        if let Some(shorter) =
            beatmatch_capped(ctx, a, b, rel, key, min_bars, max_bars.min(8.), true)
        {
            return Some(shorter);
        }
    }
    if ctx.vocal_repair.is_none() && ctx.fixed.is_none() && n(rel, "m") == 1. {
        let native_a = best.bars * bar_a;
        let native_b = native_a * ratio;
        let pa = bar_pattern(
            &a["beat"],
            n(&best.e, "time"),
            n(&best.e, "time") + native_a,
        );
        let matching = pa.as_ref().and_then(|pa| {
            bar_pattern(
                &b["beat"],
                n(&best.entry, "time"),
                n(&best.entry, "time") + native_b,
            )
            .and_then(|pb| drum_alignment(pa, &pb))
        });
        if let Some(matching) = matching {
            let k = matching
                .iter()
                .position(|x| *x == matching.iter().copied().fold(f64::NEG_INFINITY, f64::max))
                .unwrap();
            let mut drum =
                json!({"match":matching.iter().map(|v|r3(*v)).collect::<Vec<_>>(),"k":0});
            if k != 0 && matching[k] - matching[0] >= 0.5 && matching[k] >= 0.3 {
                let preserve =
                    s(settings, "entryMode") == "preserve" || settings["maxEntrySkipSeconds"] == 0;
                let limit = n(b, "audibleStart")
                    + if preserve {
                        0.
                    } else {
                        opt(settings, "maxEntrySkipSeconds", 45.)
                            .min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.45)
                    };
                let eligible: Vec<(f64, usize)> = [
                    (n(&best.entry, "time") + k as f64 * p_b, k),
                    (n(&best.entry, "time") - (4 - k) as f64 * p_b, 4 - k),
                ]
                .into_iter()
                .filter(|(t, _)| {
                    *t >= n(b, "audibleStart")
                        && *t <= limit
                        && !(ctx.requested_at.is_none()
                            && settings["stemMixing"] != false
                            && voice_too_soon(b, *t, a["vocalActivity"].is_null()))
                        && *t + native_b
                            <= n(b, "audibleEnd")
                                - 12f64.min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.2)
                        && !ctx.region_b.as_ref().is_some_and(|v| {
                            *t < n(v, "start") - 0.001 || *t + native_b > n(v, "end") + 0.001
                        })
                })
                .collect();
                let mut selected: Vec<(f64, f64, f64)> = eligible
                    .iter()
                    .filter_map(|(t, mv)| {
                        verified_drum_shift(
                            pa.as_ref().unwrap(),
                            &b["beat"],
                            r3(*t),
                            native_b,
                            k,
                            matching[0],
                        )
                        .map(|actual| {
                            (
                                *t,
                                actual,
                                if voices {
                                    vocal_mean(b, *t, *t + native_b)
                                } else {
                                    0.
                                } + 0.01 * (*mv as f64),
                            )
                        })
                    })
                    .collect();
                selected.sort_by(|a, b| a.2.total_cmp(&b.2));
                if let Some((t, actual, _)) = selected.first() {
                    best.entry["time"] = json!(r3(*t));
                    best.entry["tags"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(format!("drum-shift:{k}")));
                    best.conflict = clamp(
                        density(a, n(&best.e, "time"), n(&best.e, "time") + native_a)
                            * density(b, n(&best.entry, "time"), n(&best.entry, "time") + native_b)
                            * 6.,
                        0.,
                        1.,
                    );
                    best.local_clash = if full_mix {
                        local_clash_fraction(
                            a,
                            n(&best.e, "time"),
                            native_a,
                            b,
                            n(&best.entry, "time"),
                            native_b,
                        )
                    } else {
                        0.
                    };
                    best.arrival =
                        arrival_fit(b, n(&best.entry, "time"), native_b / 2., native_b).1;
                    drum["k"] = json!(k);
                    drum["actualWindowMatch"] = json!(r3(*actual));
                } else {
                    drum["blocked"] = json!(if preserve {
                        "preserve-opening"
                    } else if !eligible.is_empty() {
                        "changed-window-pattern"
                    } else {
                        "no-room"
                    });
                }
            }
            best.drum = Some(drum);
        }
    }
    let mut p = ctx.base("beatmatch_blend");
    let bars = best.bars;
    let half_bars = bars / 2.;
    let duration = bars * bar_a / avg_a;
    let r_a = |t: f64| {
        if glide {
            1. + (target - 1.) * smoothstep(clamp(t / duration, 0., 1.))
        } else {
            1.
        }
    };
    let time_of_a = |x: f64| {
        let mut acc = 0.;
        let dt = duration / 400.;
        let mut t = 0.;
        while t < duration {
            let v = r_a(t + dt / 2.) * dt;
            if acc + v >= x {
                return t + ((x - acc) / v) * dt;
            }
            acc += v;
            t += dt;
        }
        duration
    };
    let swap = time_of_a(half_bars * bar_a);
    let beat = p_a / r_a(swap);
    p["aExit"] = json!(r3(n(&best.e, "time")));
    p["bEntry"] = json!(r3(n(&best.entry, "time")));
    p["duration"] = json!(r3(duration));
    p["swapAt"] = json!(r3(swap));
    if glide {
        let times: Vec<f64> = (0..13).map(|i| duration * i as f64 / 12.).collect();
        p["tempoA"] = json!(
            times
                .iter()
                .map(|t| [r3(*t), round(r_a(*t) * 1e6) / 1e6])
                .collect::<Points>()
        );
        p["tempoB"] = json!(
            times
                .iter()
                .enumerate()
                .map(|(i, t)| [
                    r3(*t),
                    if i == 12 {
                        1.
                    } else {
                        round(r_a(*t) * ratio * 1e6) / 1e6
                    }
                ])
                .collect::<Points>()
        );
    }
    let bar_out = |k: f64| time_of_a(k * bar_a);
    let mut lanes = Vec::new();
    let mut reasons: Vec<String> = Vec::new();
    let mut echo_safe = true;
    let mut filter_handoff = false;
    if settings["eqHandoff"] == true {
        filter_handoff = vocal_aware || full_energy(n(&best.e, "time"), bars * bar_a);
        let fade_start = swap.max(bar_out(bars - if filter_handoff { 1. } else { 2. }));
        lanes.push(lane("B", "gain", vec![shape(0., swap, sin_up, 8)]));
        lanes.push(lane(
            "A",
            "gain",
            vec![vec![[0., 1.]], shape(fade_start, duration, cos_down, 8)],
        ));
        lanes.push(lane(
            "A",
            "low",
            vec![
                vec![[0., 1.]],
                vec![[r3(swap - beat / 2.), 1.], [r3(swap + beat / 2.), 0.]],
            ],
        ));
        lanes.push(lane(
            "B",
            "low",
            vec![
                vec![[0., 0.]],
                vec![[r3(swap - beat / 2.), 0.], [r3(swap + beat / 2.), 1.]],
            ],
        ));
        lanes.push(lane(
            "B",
            "high",
            vec![shape(0., swap, |x| 0.25 + 0.75 * smoothstep(x), 8)],
        ));
        lanes.push(lane(
            "A",
            "high",
            vec![
                vec![[0., 1.]],
                shape(
                    swap,
                    duration,
                    |x| 1. - if filter_handoff { 0.4 } else { 0.75 } * smoothstep(x),
                    8,
                ),
            ],
        ));
        let mid_duck = best.conflict > 0.35 || key_clash || best.local_clash >= 0.5;
        let b_mid = if voices {
            if key_clash { 0.4 } else { 0.7 }
        } else if mid_duck {
            0.18
        } else if filter_handoff {
            0.25
        } else {
            0.4
        };
        let turns = key_clash || best.local_clash >= 0.5 || filter_handoff;
        if filter_handoff {
            lanes.push(lane(
                "A",
                "filter",
                vec![
                    vec![[0., 0.]],
                    shape(swap, duration, |x| 0.8 * smoothstep(x), 12),
                ],
            ));
        }
        if filter_handoff {
            lanes.push(lane(
                "B",
                "mid",
                vec![
                    vec![[0., b_mid]],
                    shape(
                        (swap - beat).max(0.),
                        duration.min(swap + 3. * beat),
                        |x| b_mid + (1. - b_mid) * smoothstep(x),
                        8,
                    ),
                ],
            ));
            let native_b = bars * bar_a * ratio;
            let b_time = n(&best.entry, "time");
            let b_dense = density(b, b_time + native_b / 2., b_time + native_b)
                / body_density(b).max(1e-6)
                > 0.9;
            lanes.push(lane(
                "A",
                "mid",
                vec![
                    vec![[0., 1.]],
                    if b_dense {
                        shape(swap, duration.min(swap + beat), |x| 1. - 0.7 * smoothstep(x), 8)
                    } else {
                        shape(
                            swap,
                            duration.min(bar_out(half_bars + 2.)),
                            |x| 1. - 0.45 * smoothstep(x),
                            8,
                        )
                    },
                ],
            ));
        } else if turns {
            let t0 = (swap - beat).max(0.);
            lanes.push(lane(
                "B",
                "mid",
                vec![
                    vec![[0., b_mid]],
                    shape(
                        t0,
                        duration.min(swap + beat),
                        |x| b_mid + (1. - b_mid) * sin_up(x),
                        8,
                    ),
                ],
            ));
            lanes.push(lane(
                "A",
                "mid",
                vec![
                    vec![[0., 1.]],
                    shape(
                        t0,
                        (t0 + beat).max(duration.min(bar_out(half_bars + 2.))),
                        |x| 0.2 + 0.8 * cos_down(x),
                        8,
                    ),
                ],
            ));
        } else {
            lanes.push(lane(
                "B",
                "mid",
                vec![shape(0., swap, |x| b_mid + (1. - b_mid) * smoothstep(x), 8)],
            ));
            lanes.push(lane(
                "A",
                "mid",
                vec![
                    vec![[0., 1.]],
                    shape(
                        swap,
                        duration.min(bar_out(half_bars + 2.)),
                        |x| 1. - if mid_duck { 0.8 } else { 0.55 } * smoothstep(x),
                        8,
                    ),
                ],
            ));
        }
        reasons.push("бас плавно передаётся на сильной доле в середине перехода, чтобы уменьшить конфликт басовых линий".into());
        if filter_handoff {
            reasons.push("текущий трек ещё на полной энергии: середины меняются по очереди на смене баса, затем текущий уходит через фильтр — две ведущие партии почти не звучат вместе".into());
        } else if turns {
            reasons.push("тональности конфликтуют: середина треков меняется по очереди на смене баса, длина сведения не сокращается".into());
        } else if mid_duck {
            reasons.push("средние частоты обоих треков плотные: середина следующего трека входит приглушённой".into());
        }
        let exit_a = n(&best.e, "time") + bars * bar_a;
        echo_safe = !unknown_a
            || (s(&best.e, "kind") == "phrase"
                || !a["structure"].is_null() && closure_at(&a["structure"], exit_a, 1.5) >= 0.5)
                && density(a, exit_a - bar_a, exit_a) < 0.2;
        if best.cut > 4. && echo_safe {
            let mut delay = n(&b["beat"], "period");
            while delay < 0.3 {
                delay *= 2.;
            }
            while delay > 0.8 {
                delay /= 2.;
            }
            let send = 0.5;
            p["echo"] = json!({"delay":r3(delay),"feedback":r3(0.45f64.min((0.01f64/send).powf(delay/if unknown_a{1.5}else{3.})))});
            lanes.push(lane(
                "A",
                "echo",
                vec![
                    vec![[0., 0.]],
                    vec![[r3(bar_out(bars - 1.)), 0.], [r3(duration), send]],
                ],
            ));
            reasons.push("текущий трек уходит в эхо по сетке битов: повторы ложатся на доли следующего трека".into());
        }
    } else {
        lanes.push(lane("A", "gain", vec![shape(0., duration, cos_down, 12)]));
        lanes.push(lane("B", "gain", vec![shape(0., duration, sin_up, 12)]));
    }
    p["automation"] = json!(lanes);
    let drum_shift = best.drum.as_ref().map_or(0., |d| opt(d, "k", 0.));
    let phrase_aligned = drum_shift == 0.
        && n(a, "phraseConfidence") >= 0.2
        && n(b, "phraseConfidence") >= 0.2
        && s(&best.e, "kind") == "phrase"
        && ["phrase", "start"].contains(&s(&best.entry, "kind"));
    let phrase_conf = (n(a, "phraseConfidence") + n(b, "phraseConfidence")) / 2.;
    p["confidence"] = json!(r3((n(&a["beat"], "confidence")
        * n(&b["beat"], "confidence"))
    .sqrt()
        * (0.75 + 0.25 * phrase_conf)
        * (0.75 + 0.25 * n(key, "compatibility"))
        * (1. - 0.3 * best.conflict)));
    p["beatAlign"] = json!({"bpmA":a["beat"]["bpm"],"bpmB":b["beat"]["bpm"],"relation":rel["m"],"ratio":round(ratio*1e5)/1e5,"stretchPercent":round(n(rel,"stretchPercent")*100.)/100.,"overlapBeats":bars*4.,"phraseAligned":phrase_aligned,"glide":glide});
    p["keyInfo"] = key.clone();
    let bpm_a = n(&a["beat"], "bpm");
    let bpm_b = n(&b["beat"], "bpm");
    let tempo_text = if n(rel, "m") == 1. {
        format!("{} → {} BPM", fixed(bpm_a, 1), fixed(bpm_b, 1))
    } else {
        format!(
            "{} ↔ {} BPM ({} темп)",
            fixed(bpm_a, 1),
            fixed(bpm_b, 1),
            if n(rel, "m") == 2. {
                "половинный"
            } else {
                "двойной"
            }
        )
    };
    let mut all = vec![
        format!("сведение по битам на {bars} тактов, {tempo_text}"),
        if glide {
            format!(
                "общий темп плавно переходит с {} на {} BPM за {} с; сетки битов синхронизированы, высота тона сохраняется",
                fixed(bpm_a, 1),
                fixed(bpm_b * n(rel, "m"), 1),
                fixed(duration, 0)
            )
        } else {
            "темп совпадает".into()
        },
        if phrase_aligned {
            "вход и выход на границах фраз".into()
        } else {
            "выход на сильной доле".into()
        },
        if best.cut > 2. {
            format!("пропускается {} с финала", round(best.cut))
        } else {
            "текущий трек звучит до конца".into()
        },
        s(key, "label").into(),
    ];
    if drum_shift != 0. {
        all.push(format!("рисунок ударных выровнен: такт следующего трека сдвинут на {drum_shift} {} относительно найденной сильной доли, бочка совпадает с бочкой, малый с малым",if drum_shift==1.{"долю"}else{"доли"}));
    }
    all.extend(reasons);
    p["reasons"] = json!(all);
    describe_entry(&mut p, b, &best.entry, best.arrival);
    let count = tried.len();
    tried.sort_by(|a, b| n(b, "score").total_cmp(&n(a, "score")));
    tried.truncate(40);
    p["debug"] = json!({"candidates":tried,"candidateCount":count,"conflict":r3(best.conflict),"score":r3(best.score),"cut":r3(best.cut)});
    if let Some(drum) = best.drum {
        p["debug"]["drumPattern"] = drum;
    }
    if full_mix {
        p["debug"]["fullMixRules"] = json!({"looseGrid":loose,"barCap":if bar_cap.is_finite(){Some(bar_cap)}else{None},"localClash":r3(best.local_clash),"echoSafe":echo_safe});
    }
    if !p["echo"].is_null() {
        p["debug"]["variant"] = json!("echo-tail");
    }
    if filter_handoff {
        p["debug"]["style"] = json!("filter-handoff");
    }
    p["debug"]["consumedA"] = json!(r3(bars * bar_a));
    p["debug"]["consumedB"] = json!(r3(bars * bar_a * ratio));
    p["debug"]["analysisLimits"] =
        json!(["mid-density-is-not-vocal-detection", "4/4-meter-assumed"]);
    Some(p)
}
