use super::{
    common::*,
    entries::{filtered_power, level_before},
    primitives::grid_trust,
    unlocked::measured_curves,
};
use serde_json::{Value, json};

fn value(p: &Value, deck: &str, name: &str, t: f64) -> f64 {
    arr(&p["automation"])
        .iter()
        .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
        .map_or(1., |l| point_value(&points(&l["points"]), t))
}
fn reason(p: &mut Value, text: &str) {
    p["reasons"].as_array_mut().unwrap().push(json!(text));
}
pub fn hold_loudness(p: Value, a: &Value, b: &Value) -> Value {
    if a.is_null()
        || b.is_null()
        || n(&p, "duration") < 1.
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
    {
        return p;
    }
    raise_lanes(raise_lanes(p, a, b, &["gain"]), a, b, &["mid", "high"])
}
fn raise_lanes(mut p: Value, a: &Value, b: &Value, lanes: &[&str]) -> Value {
    let duration = n(&p, "duration");
    let before = level_before(a, n(&p, "aExit")) + n(&p, "gainA");
    let end_b = n(&p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), duration);
    let after = power_level(b, end_b, n(b, "audibleEnd").min(end_b + 6.), "rmsDb") + n(&p, "gainB");
    let mut boost = Vec::new();
    for i in 0..=16 {
        let t = duration * i as f64 / 16.;
        let ag = value(&p, "A", "gain", t);
        let bg = value(&p, "B", "gain", t);
        let power = |an: &Value, deck: &str, cue: &str, tempo: &str, gain: &str, vocal: &str| {
            filtered_power(
                an,
                n(&p, cue) + integrate_tempo(&points(&p[tempo]), t),
                n(&p, gain),
                value(&p, deck, "low", t),
                value(&p, deck, "mid", t),
                value(&p, deck, "high", t),
                point_value(&points(&p[vocal]), t),
            )
        };
        let sum = ag * ag * power(a, "A", "aExit", "tempoA", "gainA", "vocalA")
            + bg * bg * power(b, "B", "bEntry", "tempoB", "gainB", "vocalB");
        let target = 10f64.powf((before + (after - before) * (t / duration)) / 10.);
        let held = p["debug"]["holdUntil"].as_f64().is_some_and(|h| t > h);
        boost.push([
            r3(t),
            if held {
                1.
            } else {
                10f64
                    .powf(3. / 20.)
                    .min((target / sum.max(1e-12)).sqrt().max(1.))
            },
        ]);
    }
    boost[0][1] = 1.;
    boost[16][1] = 1.;
    if boost.iter().all(|p| p[1] < 1.02) {
        return p;
    }
    let guard = p["debug"]["stems"]["bleedGuard"]["from"].as_f64();
    for l in p["automation"].as_array_mut().unwrap() {
        if !lanes.contains(&s(l, "lane")) {
            continue;
        }
        let old = points(&l["points"]);
        let mut knots: Vec<f64> = old
            .iter()
            .chain(&boost)
            .map(|p| p[0])
            .filter(|t| *t <= duration + 1e-9)
            .collect();
        knots.sort_by(f64::total_cmp);
        knots.dedup();
        let guarded = s(l, "deck") == "A" && ["mid", "high"].contains(&s(l, "lane"));
        let mut raised: Points = knots
            .iter()
            .map(|t| {
                let g = point_value(&old, *t);
                let out = if guarded && guard.is_some_and(|from| *t >= from) {
                    g
                } else {
                    0f64.max(g).max((g * point_value(&boost, *t)).min(1.))
                };
                [*t, r3(out)]
            })
            .collect();
        raised.extend(old.into_iter().filter(|p| p[0] > duration + 1e-9));
        l["points"] = json!(raised);
    }
    let peak = boost.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max);
    let first = p["debug"].get("loudnessHold").is_none();
    if first {
        reason(
            &mut p,
            "громкость в середине перехода выровнена по измеренным полосам: без ямы от одновременного спада обеих дек",
        );
    }
    let mut holds = arr(&p["debug"]["loudnessHold"]).to_vec();
    holds.push(json!(r3(20. * peak.log10())));
    p["debug"]["loudnessHold"] = json!(holds);
    p
}

pub fn bass_continuity(mut p: Value, a: &Value, b: &Value) -> Value {
    if !p["loopA"].is_null()
        || p["debug"]["variant"] == "intro-drop"
        || !["beatmatch_blend", "crossfade"].contains(&s(&p, "method"))
        || !p["debug"]["stems"]["wholeDeckFade"].is_null()
            && p["debug"]["stems"]["wholeDeckFade"] != false
    {
        return p;
    }
    let lane_pts = |deck: &str| {
        arr(&p["automation"])
            .iter()
            .find(|l| s(l, "deck") == deck && s(l, "lane") == "low")
            .map(|l| points(&l["points"]))
    };
    let (Some(la), Some(lb)) = (lane_pts("A"), lane_pts("B")) else {
        return p;
    };
    let duration = n(&p, "duration");
    let pa = points(&p["tempoA"]);
    let pb = points(&p["tempoB"]);
    let src_a = |t: f64| n(&p, "aExit") + integrate_tempo(&pa, t);
    let src_b = |t: f64| n(&p, "bEntry") + integrate_tempo(&pb, t);
    if !measured_curves(a, n(&p, "aExit"), src_a(duration))
        || !measured_curves(
            b,
            n(&p, "bEntry"),
            n(b, "audibleEnd").min(src_b(duration) + 1.),
        )
    {
        return p;
    }
    let (mut from, mut to) = (-1., -1.);
    let mut t = 0.;
    while t <= duration {
        let v = point_value(&la, t);
        if from < 0. && v < 0.98 {
            from = t;
        }
        if v <= 0.02 {
            to = t;
            break;
        }
        t += 0.02;
    }
    if from < 0. || to < 0. {
        return p;
    }
    let cut = (from + to) / 2.;
    let body = power_level(b, n(b, "audibleStart"), n(b, "audibleEnd"), "lowDb");
    let bass_at = |t: f64| power_level(b, src_b(t), src_b(t) + 1., "lowDb") >= body - 8.;
    let mut at = Some(cut);
    if !bass_at(cut) {
        at = None;
        let mut t = cut;
        while t <= duration - 1. {
            if bass_at(t) && bass_at(t + 0.5) {
                at = Some(t);
                break;
            }
            t += 0.05;
        }
        if let Some(found) = at {
            let mut near = None;
            for d in nums(&b["beat"]["downbeats"]) {
                let t = output_time_at(&pb, d - n(&p, "bEntry"), duration);
                if t > cut
                    && t < duration - 0.5
                    && near.is_none_or(|best: f64| (t - found).abs() < (best - found).abs())
                {
                    near = Some(t);
                }
            }
            if let Some(near) = near {
                if (near - found).abs() < 0.6 {
                    at = Some(near);
                }
            }
        }
    }
    let led = |an: &Value, x: f64| {
        power_level(an, x, x + 2., "lowDb") >= power_level(an, x, x + 2., "rmsDb") - 3.
    };
    let beat = opt(&b["beat"], "period", 0.5) / point_value(&pb, at.unwrap_or(cut));
    let wide = s(&p, "method") == "beatmatch_blend"
        && at.is_some_and(|t| led(b, src_b(t)))
        && opt(&p["keyInfo"], "compatibility", 0.) >= 0.5;
    let pre = if wide { 0.35 } else { 0. };
    let fader = s(&p, "method") == "crossfade"
        && p["debug"]["washout"] != true
        && at.is_some_and(|t| led(a, src_a(t)) || led(b, src_b(t)));
    let width = if wide { 4. * beat } else { to - from };
    let fade_width = clamp(duration * 0.25, 3., 5.);
    if at.is_some_and(|t| (t - cut).abs() < 0.05) && !wide && !fader {
        return p;
    }
    let b0 = point_value(&lb, 0.).max(0.);
    let start = at.map_or(duration, |at| {
        0f64.max((duration - width).min(at - width / 2.))
    });
    let end = duration.min(start + width);
    let mut knots = vec![0.];
    if pre != 0. {
        knots.extend((0..8).map(|i| start * (i + 1) as f64 / 9.));
    }
    knots.extend((0..13).map(|i| start + (end - start) * i as f64 / 12.));
    knots.push(duration);
    let filtered: Vec<f64> = knots
        .iter()
        .enumerate()
        .filter(|(i, t)| **t <= duration && (*i == 0 || **t > knots[*i - 1]))
        .map(|(_, t)| *t)
        .collect();
    let x = |t: f64| {
        if end > start {
            clamp((t - start) / (end - start), 0., 1.)
        } else if t >= end {
            1.
        } else {
            0.
        }
    };
    let b_low = |t: f64| {
        if t < start {
            b0.max(pre * (t / start * std::f64::consts::PI / 2.).sin())
        } else {
            b0.max(pre) + (1. - b0.max(pre)) * (x(t) * std::f64::consts::PI / 2.).sin()
        }
    };
    let mut automation = arr(&p["automation"]).to_vec();
    for l in &mut automation {
        let deck = s(l, "deck");
        if s(l, "lane") != "low" || deck == "B" && at.is_none() {
            continue;
        }
        *l = lane(
            deck,
            "low",
            vec![
                filtered
                    .iter()
                    .map(|t| {
                        [
                            r3(*t),
                            r3(if deck == "A" {
                                if at.is_none() { 1. } else { cos_down(x(*t)) }
                            } else {
                                b_low(*t)
                            }),
                        ]
                    })
                    .collect(),
            ],
        );
    }
    if fader {
        let gb = arr(&p["automation"])
            .iter()
            .find(|l| s(l, "deck") == "B" && s(l, "lane") == "gain")
            .map_or(vec![[0., 1.]], |l| points(&l["points"]));
        let mut b_up = 0.;
        while b_up < duration && point_value(&gb, b_up) < 0.85 {
            b_up += 0.05;
        }
        let at = at.unwrap();
        let f0 = at.min(0f64.max(at - fade_width).max(b_up));
        let f1 = duration.min(at + fade_width);
        let y = |t: f64| clamp((t - f0) / (f1 - f0).max(1e-3), 0., 1.);
        for l in &mut automation {
            if s(l, "deck") != "A" || s(l, "lane") != "gain" {
                continue;
            }
            let old = points(&l["points"]);
            let mut knots: Vec<f64> = old
                .iter()
                .map(|p| p[0])
                .chain((0..13).map(|i| f0 + (f1 - f0) * i as f64 / 12.))
                .collect();
            knots.sort_by(f64::total_cmp);
            knots.dedup();
            l["points"] = json!(
                knots
                    .iter()
                    .map(|t| [r3(*t), r3(point_value(&old, *t).min(cos_down(y(*t))))])
                    .collect::<Points>()
            );
        }
    }
    p["automation"] = json!(automation);
    reason(
        &mut p,
        if at.is_none() {
            "бас текущего трека уходит вместе с ним: у следующего в переходе нет своего баса"
        } else if fader {
            "басовые треки меняются фейдерами за несколько секунд вокруг смены баса: без переключения"
        } else if wide {
            "бас следующего трека входит тихо заранее и забирает низ за такт: смена бита не звучит как переключение"
        } else {
            "бас передаётся, когда у следующего трека появляется свой бас: без провала"
        },
    );
    p["debug"]["bassContinuity"] = json!({"previousAt":r3(cut),"at":at.map(r3),"width":r3(if fader {fade_width}else{width}),"wide":wide,"fader":fader});
    p
}

pub fn phrase_bass_swap(mut p: Value, a: &Value, b: &Value) -> Value {
    if p["debug"]["stems"]["wholeDeckFade"] == true
        || a["beat"].is_null()
        || b["beat"].is_null()
        || grid_trust(a)["trusted"] != true
        || grid_trust(b)["trusted"] != true
        || n(b, "phraseConfidence") < 0.6
        || n(&b["beat"], "downbeatConfidence") < 0.5
        || n(&a["beat"], "downbeatConfidence") < 0.5
        || n(&p, "duration") < 8.
        || opt(&p["debug"]["drumPattern"], "k", 0.) != 0.
    {
        return p;
    }
    let duration = n(&p, "duration");
    let original = n(&p, "swapAt");
    let pa = points(&p["tempoA"]);
    let pb = points(&p["tempoB"]);
    let mut candidates: Vec<(f64, f64)> = nums(&b["phrases"])
        .into_iter()
        .map(|source| {
            (
                source,
                output_time_at(&pb, source - n(&p, "bEntry"), duration),
            )
        })
        .filter(|(source, time)| {
            *time >= duration * 0.25
                && *time <= duration * 0.75
                && (*time - original).abs() <= 5f64.min(duration * 0.25)
                && (*time - original).abs() > n(&b["beat"], "period") * 0.5
                && nums(&b["beat"]["downbeats"])
                    .iter()
                    .any(|t| (*t - source).abs() < 0.035)
                && nums(&a["beat"]["downbeats"])
                    .iter()
                    .any(|t| (*t - n(&p, "aExit") - integrate_tempo(&pa, *time)).abs() < 0.035)
        })
        .collect();
    candidates.sort_by(|x, y| (x.1 - original).abs().total_cmp(&(y.1 - original).abs()));
    for (source, time) in candidates {
        if !measured_curves(
            a,
            n(&p, "aExit"),
            n(&p, "aExit") + integrate_tempo(&pa, duration),
        ) || !measured_curves(
            b,
            n(&p, "bEntry"),
            n(&p, "bEntry") + integrate_tempo(&pb, duration),
        ) {
            continue;
        }
        let beat = n(&b["beat"], "period") / point_value(&pb, time);
        if power_level(b, source, source + n(&b["beat"], "period") * 4., "lowDb")
            < power_level(b, n(b, "audibleStart"), n(b, "audibleEnd"), "lowDb") - 5.
        {
            continue;
        }
        let new_low = |deck: &str, t: f64| {
            let x = clamp((t - time + beat / 2.) / beat, 0., 1.);
            if deck == "A" { 1. - x } else { x }
        };
        let (mut regression, mut old_peak, mut new_peak) = (0f64, 0f64, 0f64);
        let begin = 0f64.max(time.min(original) - beat);
        let end = duration.min(time.max(original) + beat);
        let mut t = begin;
        while t <= end {
            let estimate = |replacement: bool| {
                [
                    (a, "A", "aExit", "tempoA", "gainA", "vocalA"),
                    (b, "B", "bEntry", "tempoB", "gainB", "vocalB"),
                ]
                .iter()
                .map(|(an, deck, cue, tempo, gain, vocal)| {
                    let position = n(&p, cue) + integrate_tempo(&points(&p[tempo]), t);
                    value(&p, deck, "gain", t).powi(2)
                        * filtered_power(
                            an,
                            position,
                            n(&p, gain),
                            if replacement {
                                new_low(deck, t)
                            } else {
                                value(&p, deck, "low", t)
                            },
                            value(&p, deck, "mid", t),
                            value(&p, deck, "high", t),
                            point_value(&points(&p[vocal]), t),
                        )
                })
                .sum::<f64>()
            };
            let before = estimate(false);
            let after = estimate(true);
            regression = regression.max(10. * (before.max(1e-12) / after.max(1e-12)).log10());
            old_peak = old_peak.max(before);
            new_peak = new_peak.max(after);
            t += 0.2;
        }
        let bump = 10. * (new_peak.max(1e-12) / old_peak.max(1e-12)).log10();
        if regression > 0.5 || bump > 0.5 {
            continue;
        }
        for l in p["automation"].as_array_mut().unwrap() {
            if s(l, "lane") != "low" {
                continue;
            }
            let deck = s(l, "deck");
            let start = if deck == "A" { 1. } else { 0. };
            *l = lane(
                deck,
                "low",
                vec![
                    vec![[0., start]],
                    vec![
                        [r3(time - beat / 2.), start],
                        [r3(time + beat / 2.), 1. - start],
                    ],
                ],
            );
        }
        reason(
            &mut p,
            "бас передаётся на измеренной границе фразы следующего трека: сохранены точки входа, выхода и передача голоса",
        );
        p["debug"]["bassSwap"] = json!({"technique":"phrase-bass-swap","at":r3(time),"sourceB":r3(source),"previousAt":original,"maxPredictedLossDb":r3(regression),"maxPredictedRiseDb":r3(bump)});
        return p;
    }
    p
}
