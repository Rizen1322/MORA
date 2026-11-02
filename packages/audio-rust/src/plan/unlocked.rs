use super::{
    common::*,
    context::Ctx,
    entries::*,
    fullmix::{body_density, voice_unknown},
    primitives::{natural_fade, tempo_relation},
    voice_measure::*,
};
use serde_json::{Value, json};

fn finish_fields(p: &mut Value, key: &Value, reason: Option<&str>) {
    p["keyInfo"] = key.clone();
    if let Some(reason) = reason {
        p["fallbackReason"] = json!(reason);
    } else {
        p.as_object_mut().unwrap().remove("fallbackReason");
    }
}
fn reasons(first: String, reason: Option<&str>, rest: Vec<String>) -> Value {
    let mut out = vec![first];
    if let Some(r) = reason.filter(|r| !r.is_empty()) {
        out.push(r.into());
    }
    out.extend(rest);
    json!(out)
}
fn at(lanes: &[Value], deck: &str, name: &str, t: f64) -> f64 {
    lanes
        .iter()
        .find(|v| s(v, "deck") == deck && s(v, "lane") == name)
        .map_or(1., |v| point_value(&points(&v["points"]), t))
}
pub fn measured_curves(an: &Value, from: f64, to: f64) -> bool {
    let rate = n(&an["curves"], "rate");
    if !rate.is_finite() || rate <= 0. {
        return false;
    }
    let lo = (from * rate).floor().max(0.) as usize;
    let hi = (to * rate).ceil().max(0.) as usize;
    ["rmsDb", "lowDb", "midDb", "highDb"].iter().all(|key| {
        let c = arr(&an["curves"][key]);
        c.len() >= hi
            && c.get(lo..hi)
                .is_some_and(|c| c.iter().all(|v| num(v).is_finite()))
    })
}
pub fn decay_handoff(a: &Value, exit: f64, duration: f64) -> f64 {
    let reference = power_level(
        a,
        n(a, "audibleStart").max(exit - 6.),
        (n(a, "audibleStart") + 0.1).max(exit - 2.),
        "rmsDb",
    );
    let mut t = 0.;
    while t < duration * 0.75 {
        if power_level(a, exit + t, n(a, "audibleEnd").min(exit + t + 1.5), "rmsDb")
            < reference - 2.5
        {
            return clamp(t, 0.65f64.min(duration * 0.2), duration * 0.75);
        }
        t += 0.25;
    }
    duration / 2.
}
pub fn loud_until(a: &Value) -> f64 {
    let rate = n(&a["curves"], "rate");
    let rms = nums(&a["curves"]["rmsDb"]);
    let end =
        ((n(a, "audibleEnd") * rate).floor().max(0.) as usize).min(rms.len().saturating_sub(1));
    let w = (rate * 2.) as usize;
    for i in (w + 1..=end).rev() {
        if rms[i - w..i].iter().sum::<f64>() / (rate * 2.) >= n(a, "bodyRmsDb") - 3. {
            return i as f64 / rate;
        }
    }
    n(a, "audibleEnd")
}
pub fn plan_unlocked(ctx: &Ctx, a: &Value, b: &Value, key: &Value, reason: Option<&str>) -> Value {
    let fade = natural_fade(a);
    let len = n(&fade, "length");
    let ga = &a["beat"];
    let gb = &b["beat"];
    let hard_end = len < 2.5
        && level_mean(a, n(a, "audibleEnd") - 1.5, n(a, "audibleEnd") - 0.2)
            > n(a, "bodyRmsDb") - 6.;
    let hard_start =
        level_mean(b, n(b, "audibleStart"), n(b, "audibleStart") + 0.6) > n(b, "bodyRmsDb") - 6.;
    let strong = !ga.is_null()
        && !gb.is_null()
        && ga["stable"] == true
        && n(ga, "confidence") >= 0.5
        && n(gb, "confidence") >= 0.45
        && n(ga, "downbeatConfidence") >= 0.3
        && arr(&ga["downbeats"]).len() > 8
        && arr(&gb["downbeats"]).len() > 2;
    if s(ctx.s, "style") == "tight" && strong && len < 6. {
        if let Some(p) = plan_phrase_cut(ctx, a, b, key, reason) {
            return p;
        }
    }
    let short = n(a, "audibleEnd") - n(a, "audibleStart") < 30.
        || n(b, "audibleEnd") - n(b, "audibleStart") < 30.;
    if short && hard_end && hard_start && len == 0. {
        return plan_minimal(ctx, a, b, key, reason);
    }
    if n(a, "rhythmStrength") > 0.45 && n(b, "rhythmStrength") > 0.45 {
        if let Some(p) = plan_intro_drop(ctx, a, b, key, reason) {
            return p;
        }
    }
    if let Some(p) = plan_instrumental_bridge(ctx, a, b, key, reason) {
        return p;
    }
    if ctx.requested_at.is_none() && !ga.is_null() && !gb.is_null() {
        let mut base = ctx.base("echo_out");
        finish_fields(&mut base, key, reason);
        if let Some(p) = plan_echo_out(
            &base,
            a,
            b,
            ctx.s,
            n(
                &tempo_relation(n(ga, "bpm"), n(gb, "bpm")),
                "stretchPercent",
            ),
        ) {
            return p;
        }
    }
    // v19: steady grooves that cannot be locked swap on a downbeat instead of a 9-16 s unlocked blend
    if ctx.s["eqHandoff"] == true
        && (ctx.requested_at.is_some() || len < 3.)
        && n(a, "rhythmStrength") > 0.45
        && n(b, "rhythmStrength") > 0.45
        && !(ctx.s["stemMixing"] != false
            && !a["vocalActivity"].is_null()
            && !b["vocalActivity"].is_null())
        && [ga, gb].iter().all(|g| {
            !g.is_null()
                && g["stable"] == true
                && n(g, "confidence") >= 0.6
                && n(g, "jitterMs") <= 20.
        })
        && n(ga, "downbeatConfidence") >= 0.3
    {
        if let Some(p) = plan_drop_swap(ctx, a, b, key, reason) {
            return p;
        }
    }
    plan_crossfade(ctx, a, b, key, reason)
}
pub fn plan_instrumental_bridge(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    key: &Value,
    reason: Option<&str>,
) -> Option<Value> {
    let voice = &a["vocalActivity"];
    let gb = &b["beat"];
    let end = n(a, "audibleEnd");
    let start_a = n(a, "audibleStart");
    if ctx.requested_at.is_some()
        || voice.is_null()
        || ctx.s["eqHandoff"] != true
        || n(key, "compatibility") < 0.5
        || gb["stable"] != true
        || n(gb, "confidence") < 0.6
        || n(gb, "downbeatConfidence") < 0.5
    {
        return None;
    }
    let rate = n(voice, "rate");
    let values = nums(&voice["values"]);
    if !(rate > 0.)
        || values.len() as f64 / rate < end - 0.1
        || !values
            .get(((end - 8.).max(0.) * rate).floor() as usize..)
            .is_some_and(|v| v.iter().all(|v| v.is_finite()))
    {
        return None;
    }
    let low = power_level(a, start_a, end, "lowDb");
    let high = power_level(a, start_a, end, "highDb");
    let click = 0.75f64.min(n(gb, "period"));
    let limit = 16f64
        .min(n(ctx.s, "maxBlendSeconds") - click)
        .min((end - start_a) * 0.15);
    if !measured_curves(a, start_a.max(end - limit - 8.), end) {
        return None;
    }
    let mut start = end;
    let mut t = end - 0.25;
    while t >= end - limit {
        if vocal_mean(a, t, t + 0.25) > 0.18
            || power_level(a, t, t + 0.25, "lowDb") > low - 9.
            || power_level(a, t, t + 0.25, "highDb") > high - 5.
        {
            break;
        }
        start = t;
        t -= 0.25;
    }
    let tail = end - start;
    if tail < 2.5
        || tail >= limit - 0.25
        || power_level(a, start - 1., start, "rmsDb") < n(a, "bodyRmsDb") - 7.
    {
        return None;
    }
    let quiet = start;
    let bar = n(gb, "period") * 4.;
    let rise = [1., 2., 3.].into_iter().map(|x| x * bar).find(|r| {
        *r <= 8.
            && tail + r <= n(ctx.s, "maxBlendSeconds")
            && quiet - r >= start_a
            && power_level(a, quiet - r, quiet - r + 0.75, "rmsDb") >= n(a, "bodyRmsDb") - 3.5
    })?;
    start -= rise;
    let d = end - start;
    let outgoing = vocal_mean(a, start, quiet) > 0.18;
    let mut candidates = entry_candidates(
        b,
        ctx.s,
        0.,
        0.,
        ctx.requested_at.is_none(),
        a["vocalActivity"].is_null() && !b["vocalActivity"].is_null(),
    );
    if s(ctx.s, "entryMode") != "preserve" && ctx.s["maxEntrySkipSeconds"] != 0 {
        let skip = opt(ctx.s, "maxEntrySkipSeconds", 45.)
            .min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.45);
        for time in nums(&gb["downbeats"]) {
            if time >= n(b, "audibleStart") && time <= n(b, "audibleStart") + skip {
                candidates.push(
                    json!({"time":time,"score":0.68,"kind":"downbeat","tags":["bridge-arrival"]}),
                );
            }
        }
    }
    candidates.retain(|c| {
        let t = n(c, "time");
        nums(&gb["downbeats"]).iter().any(|v| (v - t).abs() < 0.025)
            && t + d + 1. <= n(b, "audibleEnd")
            && measured_curves(b, t, t + d + 1.)
            && (!outgoing
                || !b["vocalActivity"].is_null()
                    && (ctx.s["stemMixing"] != false || vocal_mean(b, t, t + rise) <= 0.18))
            && power_level(b, t, t + 1., "rmsDb") >= n(b, "bodyRmsDb") - 4.
            && (t - n(b, "audibleStart") < 1.
                || !b["vocalActivity"].is_null()
                    && vocal_mean(b, n(b, "audibleStart"), t) * (t - n(b, "audibleStart")) < 1.)
    });
    candidates.sort_by(|x, y| {
        entry_skip_cost(b, n(x, "time"), false, false)
            .total_cmp(&entry_skip_cost(b, n(y, "time"), false, false))
            .then_with(|| n(x, "time").total_cmp(&n(y, "time")))
    });
    let entry = candidates.first()?;
    let mut p = ctx.base("crossfade");
    p["aExit"] = json!(r3(start));
    p["bEntry"] = json!(r3(n(entry, "time")));
    p["duration"] = json!(r3(d));
    p["swapAt"] = json!(r3(rise));
    p["automation"] = json!([
        lane("B", "gain", vec![shape(0., 3f64.min(rise), sin_up, 8)]),
        lane(
            "A",
            "gain",
            vec![vec![[0., 1.]], shape(rise, d, cos_down, 10)]
        ),
        lane(
            "A",
            "low",
            vec![
                vec![[0., 1.]],
                shape(rise - click, rise, |x| 1. - smoothstep(x), 6)
            ]
        ),
        lane(
            "B",
            "low",
            vec![vec![[0., 0.]], shape(rise - click, rise, smoothstep, 6)]
        ),
        lane(
            "B",
            "high",
            vec![shape(0., rise, |x| 0.25 + 0.75 * smoothstep(x), 8)]
        )
    ]);
    p["confidence"] = json!(r3(0.8f64.min(n(gb, "confidence"))));
    finish_fields(&mut p, key, reason);
    p["debug"] = json!({"variant":"instrumental-bridge","holdUntil":rise,"measuredTail":r3(tail),"preparation":r3(rise)});
    p["reasons"] = json!([
        "смена темпа через измеренный инструментальный хвост: следующий трек подготовлен заранее, бас входит на сильную долю после ухода старых барабанов, окончание звучит до конца"
    ]);
    describe_entry(&mut p, b, entry, None);
    let reference = (n(a, "bodyRmsDb") + ctx.gain_a()).min(n(b, "bodyRmsDb") + ctx.gain_b());
    let lanes = arr(&p["automation"]);
    let mut hole = 0f64;
    let mut t = rise;
    while t <= d + 0.001 {
        let power = at(lanes, "A", "gain", t).powi(2)
            * filtered_power(
                a,
                start + t,
                ctx.gain_a(),
                at(lanes, "A", "low", t),
                1.,
                1.,
                1.,
            )
            + 10f64.powf(
                (power_level(
                    b,
                    n(entry, "time") + t - 0.25,
                    n(entry, "time") + t + 0.5,
                    "rmsDb",
                ) + ctx.gain_b())
                    / 10.,
            );
        hole = hole.max(reference - 10. * power.max(1e-12).log10());
        t += 0.25;
    }
    if hole > 3. {
        return None;
    }
    p["debug"]["levelHole"] = json!(r3(hole));
    Some(p)
}
fn edit_spans(a: &Value) -> Points {
    lyric_timing(a).map(|v| v.edit).unwrap_or_else(|| {
        vocal_phrases(a)
            .iter()
            .filter(|p| n(p, "confidence") >= 0.35)
            .map(|p| [n(p, "start"), n(p, "end")])
            .collect()
    })
}
/// Drop swap (v19): steady grooves that cannot be locked never play together. Echo out: A's high-pass
/// sweeps up over its last two (or four) bars, the high-pass takes its bass, its last beat goes into a
/// 3/4-beat echo heard over B's first bar. Loop roll (no clean exit, tight grid): A's last bar before
/// the boundary is caught and rolled 1 -> 1/2 -> 1/4 -> 1/8 bar, B drops at full on the one.
pub fn plan_drop_swap(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    key: &Value,
    reason: Option<&str>,
) -> Option<Value> {
    let ga = &a["beat"];
    let gb = &b["beat"];
    let beat = n(ga, "period");
    let bar = 4. * beat;
    let bar_b = 4. * n(gb, "period");
    let sweep = if 2. * bar >= 3. { 2. * bar } else { 4. * bar };
    let tail = if ctx.requested_at.is_none() { 3f64.max(6f64.min(2. * bar_b)) } else { 3. };
    let l = round(bar * 75.) / 75.;
    let max_blend = n(ctx.s, "maxBlendSeconds");
    let rollable = n(ga, "confidence") >= 0.8
        && n(ga, "jitterMs") <= 12.
        && ctx.s["loopBridges"] != false
        && ctx.s["djPhrasing"] != false
        && l >= 1.2
        && l <= 8.
        && 3. * l + tail <= max_blend;
    if sweep + tail > max_blend && !rollable {
        return None;
    }
    let phrases = if n(a, "phraseConfidence") >= 0.2 {
        nums(&a["phrases"])
    } else {
        vec![]
    };
    let start = n(a, "audibleStart");
    let end = n(a, "audibleEnd");
    let body_dens = density(a, start, end);
    let lead = sweep.max(bar);
    let mut best: Option<(f64, f64, bool, f64)> = None;
    for (i, d) in nums(&ga["downbeats"]).into_iter().enumerate() {
        let phrase = phrases.iter().any(|x| round(x * 1000.) == round(d * 1000.));
        let skip = match ctx.requested_at {
            None => {
                !phrase && i % 4 != 0
                    || d - lead < start + (end - start) * 0.5
                    || d > end - 0.5
                    || end - d > 24.
            }
            Some(now) => d - lead < now + 0.15 || d - lead > now + 0.15 + bar + 0.02 || d > end - 0.5,
        };
        if skip {
            continue;
        }
        if !measured_curves(a, d - lead, d)
            || power_level(a, d - lead, d, "rmsDb") < n(a, "bodyRmsDb") - 6.
        {
            continue;
        }
        if !a["vocalActivity"].is_null() && vocal_mean(a, d - 0.2, d + 0.25) >= 0.2 {
            continue;
        }
        let dens = density(a, d - beat, d + beat) / body_dens.max(1e-6);
        let score = if phrase { 0.3 } else { 0. }
            - 0.5 * clamp((end - d) / 24., 0., 1.)
            - 0.3 * clamp(dens - 0.7, 0., 1.);
        if best.is_none_or(|(_, s0, _, _)| score > s0) {
            best = Some((d, score, phrase, dens));
        }
    }
    let (d, _, phrase, dens) = best?;
    let looped = rollable && (!phrase || dens > 0.9);
    if !looped && sweep + tail > max_blend {
        return None;
    }
    let picked = if n(gb, "downbeatConfidence") >= 0.5 {
        Some(pick_handoff(ctx, a, b, d, 0., tail, true))
    } else {
        None
    };
    let aligned = picked.as_ref().is_some_and(|p| p.aligned);
    let entry = match picked {
        Some(p) if p.aligned => p.cue,
        _ => json!({"time":b["audibleStart"],"score":0.6,"kind":"start","tags":["drop-swap-start"]}),
    };
    let time = n(&entry, "time");
    if power_level(b, time, time + 1., "rmsDb") < n(b, "bodyRmsDb") - 6.
        || time + tail > n(b, "audibleEnd")
    {
        return None;
    }
    let energy_delta = power_level(b, time, time + 8. * bar_b, "rmsDb") + ctx.gain_b()
        - (power_level(a, d - 2. * bar, d, "rmsDb") + ctx.gain_a());
    let calm = n(gb, "bpm") < 0.85 * n(ga, "bpm") && energy_delta <= -3.;
    let wash = looped && calm;
    let roll = looped && !calm;
    // v19.4 soft echo out: B enters from its own opening, never a trimmed intro; after more than 1 s of
    // leading silence, on its first downbeat. A Next press keeps B's energetic arrival (v19.2).
    let start_b = n(b, "audibleStart");
    let opening = if start_b <= 1. {
        start_b
    } else {
        nums(&gb["downbeats"]).into_iter().find(|t| *t >= start_b - 0.025).unwrap_or(start_b)
    };
    let b_in = if looped || ctx.requested_at.is_some() {
        entry.clone()
    } else {
        json!({"time":opening,"score":0.6,"kind":if opening == start_b { "start" } else { "downbeat" },"tags":["drop-swap-start"]})
    };
    // v19.4: an echo out opens B over two of its bars; a Next keeps one bar
    let echo_span = if looped {
        0.
    } else if ctx.requested_at.is_some() {
        bar_b.min(tail)
    } else {
        (2. * bar_b).min(max_blend - sweep)
    };
    let soft_tail = if wash {
        tail.max(8f64.min(3. * bar_b)).min(max_blend - 2. * l)
    } else {
        tail.max(echo_span)
    };
    if wash && (soft_tail < tail || time + soft_tail > n(b, "audibleEnd")) {
        return None;
    }
    let t_end = if roll {
        3. * l
    } else if wash {
        2. * l
    } else {
        sweep
    };
    let mut delay = if roll { beat / 2. } else { beat * 0.75 };
    while delay < 0.25 {
        delay *= 2.;
    }
    while delay > 0.6 {
        delay /= 2.;
    }
    let feedback = (if roll || wash { 0.72f64 } else { 0.78 }).min(10f64.powf(
        -1.5 / (if wash {
            2.5
        } else if roll {
            1.5
        } else {
            3.
        } * bar
            / delay),
    ));
    let total = r3(t_end + soft_tail);
    let mut p = ctx.base("echo_out");
    p["bEntry"] = json!(r3(n(&b_in, "time")));
    p["duration"] = json!(total);
    p["swapAt"] = json!(r3(t_end));
    p["bDelay"] = json!(r3(t_end));
    p["echo"] = json!({"delay":r3(delay),"feedback":r3(feedback)});
    if wash {
        let s0 = round((d - l) * 300.) / 300.;
        p["aExit"] = json!(r3(s0));
        p["loopA"] = json!({"start":s0,"end":s0 + l,"until":s0 + 2. * l,"crossfade":0.006});
        p["automation"] = json!([
            lane("A", "gain", vec![vec![[0., 1.], [r3(t_end - 0.03), 1.], [r3(t_end), 0.], [total, 0.]]]),
            lane("A", "filter", vec![vec![[0., 0.]], shape(l / 2., t_end, |x| -0.5 * smoothstep(x), 8), vec![[total, -0.5]]]),
            lane("A", "echo", vec![
                vec![[0., 0.], [r3(l), 0.]],
                shape(l, t_end - 0.05, |x| 0.7 * smoothstep(x), 6),
                vec![[r3(t_end), 0.7], [r3(t_end + 0.02), 0.], [total, 0.]],
            ]),
            lane("B", "gain", vec![
                vec![[0., 0.], [0.02, 0.6]],
                shape(0.02, (2. * bar_b).min(total - t_end), |x| 0.6 + 0.4 * sin_up(x), 8),
                vec![[r3(total - t_end), 1.]],
            ]),
            lane("B", "filter", vec![
                shape(0., bar_b.min(total - t_end), |x| -0.35 * (1. - smoothstep(x)), 6),
                vec![[r3(total - t_end), 0.]],
            ]),
        ]);
    } else if roll {
        let s0 = round((d - l) * 300.) / 300.;
        p["aExit"] = json!(r3(s0));
        p["loopA"] = json!({"start":s0,"end":s0 + l,"until":s0 + 3. * l,"crossfade":0.006,
            "roll":[{"at":s0 + l,"length":l / 2.},{"at":s0 + 2. * l,"length":l / 4.},{"at":s0 + 2.5 * l,"length":l / 8.}]});
        p["automation"] = json!([
            lane("A", "gain", vec![vec![[0., 1.], [r3(t_end - 0.03), 1.], [r3(t_end), 0.], [total, 0.]]]),
            lane("A", "filter", vec![vec![[0., 0.]], shape(l, t_end, |x| 0.6 * smoothstep(x), 8), vec![[total, 0.6]]]),
            lane("A", "echo", vec![
                vec![[0., 0.], [r3(2. * l), 0.]],
                shape(2. * l, t_end - 0.05, |x| 0.8 * smoothstep(x), 6),
                vec![[r3(t_end), 0.8], [r3(t_end + 0.02), 0.], [total, 0.]],
            ]),
            lane("B", "gain", vec![vec![[0., 0.], [0.02, 1.], [r3(total - t_end), 1.]]]),
        ]);
    } else {
        p["aExit"] = json!(r3(d - sweep));
        p["automation"] = json!([
            lane("A", "gain", vec![vec![[0., 1.], [r3(sweep - 0.03), 1.], [r3(sweep), 0.], [total, 0.]]]),
            // v19.4 soft echo out: a gentle low-pass muffles A's echo tail, the send steps down over three
            // beats after the cut, B is at 0.8 at once and full after a bar, with no bass gate or filter
            lane("A", "filter", vec![vec![[0., 0.], [r3(sweep), -0.25], [r3(sweep + 0.4), -0.3], [total, -0.3]]]),
            lane("A", "echo", vec![vec![
                [0., 0.],
                [r3(sweep - beat), 0.],
                [r3(sweep - 0.05), 0.6],
                [r3(sweep), 0.6],
                [r3(sweep + beat), 0.4],
                [r3(sweep + 2. * beat), 0.2],
                [r3(sweep + 3. * beat), 0.],
            ]]),
            lane("B", "gain", vec![vec![[0., 0.], [0.01, 0.8], [r3(bar), 1.]]]),
        ]);
    }
    p["confidence"] = json!(r3(0.7f64.min(n(ga, "confidence")).min(n(gb, "confidence"))));
    finish_fields(&mut p, key, reason);
    let cut = (end - d).max(0.);
    let boundary = if phrase { "фразы" } else { "четырёх тактов" };
    p["reasons"] = reasons(
        if wash {
            format!(
                "петля с размывом: темпы {} и {} BPM не сводятся, следующий трек спокойнее — последний такт текущего повторяется без ускорения, уходит в фильтр и эхо, следующий мягко поднимается под хвост",
                fixed(n(ga, "bpm"), 0),
                fixed(n(gb, "bpm"), 0)
            )
        } else if roll {
            format!(
                "петля с ускорением: темпы {} и {} BPM не сводятся — последний такт текущего трека перед границей {} повторяется и дробится до 1/8 такта под нарастающий фильтр, следующий вступает в полную силу на своей сильной доле",
                fixed(n(ga, "bpm"), 0),
                fixed(n(gb, "bpm"), 0),
                boundary
            )
        } else {
            format!(
                "смена на сильной доле: темпы {} и {} BPM не сводятся — текущий трек уходит в эхо на границе {}, следующий входит со своего начала",
                fixed(n(ga, "bpm"), 0),
                fixed(n(gb, "bpm"), 0),
                boundary
            )
        },
        reason,
        vec![
            if roll || wash {
                "два ритма не звучат одновременно: под первым тактом следующего звучит только отфильтрованный хвост эха".into()
            } else {
                "два ритма не звучат одновременно: эхо текущего на 3/4 доли, приглушённое фильтром, звучит под первым тактом следующего".into()
            },
            if cut > 2. {
                format!("пропускается {} с финала", round(cut))
            } else {
                "текущий трек звучит почти до конца".into()
            },
        ],
    );
    describe_entry(&mut p, b, &b_in, None);
    p["debug"] = if wash {
        json!({"variant":"loop-wash","style":"loop-wash","cut":r3(cut),"loopWash":{"exitSource":r3(d),"phrase":phrase,"dens":r3(dens),"bar":r3(l),"energyDelta":r3(energy_delta),"entryAligned":aligned}})
    } else if roll {
        json!({"variant":"loop-roll","style":"loop-roll","cut":r3(cut),"loopRoll":{"exitSource":r3(d),"phrase":phrase,"dens":r3(dens),"bar":r3(l),"entryAligned":aligned}})
    } else {
        json!({"variant":"drop-swap","style":"drop-swap","cut":r3(cut),"dropSwap":{"cutSource":r3(d),"phrase":phrase,"sweep":r3(sweep),"entryAligned":s(&b_in, "kind") == "downbeat"}})
    };
    Some(p)
}
pub fn plan_phrase_cut(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    key: &Value,
    reason: Option<&str>,
) -> Option<Value> {
    let ga = &a["beat"];
    let gb = &b["beat"];
    let beat = n(ga, "period");
    let d = 0.12f64
        .min(beat / 4.)
        .min(n(gb, "period") / 4.)
        .min(n(ctx.s, "maxBlendSeconds"));
    if d < 0.03 {
        return None;
    }
    let phrases = if n(a, "phraseConfidence") >= 0.2 {
        nums(&a["phrases"])
    } else {
        vec![]
    };
    let downs = nums(&ga["downbeats"]);
    let spans = edit_spans(a);
    let min_t = n(a, "audibleStart") + (n(a, "audibleEnd") - n(a, "audibleStart")) * 0.5;
    let is_phrase = |t: f64| phrases.iter().any(|x| round(x * 1000.) == round(t * 1000.));
    let latest = |pred: &dyn Fn(f64, usize) -> bool| {
        downs
            .iter()
            .enumerate()
            .rev()
            .find(|(i, t)| {
                pred(**t, *i)
                    && **t + d <= n(a, "audibleEnd")
                    && ctx
                        .requested_at
                        .map_or(**t > min_t && n(a, "audibleEnd") - **t <= 8., |now| {
                            **t >= now + 0.15 && **t <= now + 3.
                        })
                    && (a["vocalActivity"].is_null()
                        || vocal_mean(a, **t - 0.2, **t + 0.25) < 0.2
                            && !spans
                                .iter()
                                .any(|[s, e]| **t + d + 0.015 > *s && **t - 0.015 < *e))
            })
            .map(|(_, t)| *t)
    };
    let phrase_exit = latest(&|t, _| is_phrase(t));
    let bar_exit = latest(&|_, i| i % 4 == 0).or_else(|| latest(&|_, _| true));
    let cut_of = |v: Option<f64>| v.map_or(f64::INFINITY, |t| n(a, "audibleEnd") - t - d);
    let exit = if phrase_exit.is_some() && cut_of(phrase_exit) <= cut_of(bar_exit) + 4. {
        phrase_exit
    } else {
        bar_exit
    }?;
    let (entry, aligned) = if let Some(repair) = &ctx.vocal_repair {
        let time = n(repair, "entry");
        (
            json!({"time":time,"score":0.76,"kind":"downbeat","tags":["preserved-cut-entry"]}),
            nums(&gb["downbeats"])
                .iter()
                .any(|v| (v - time).abs() < 0.025),
        )
    } else {
        let selected = pick_handoff(ctx, a, b, exit, 0., d, true);
        (selected.cue, selected.aligned)
    };
    let time = n(&entry, "time");
    if !aligned
        || n(gb, "downbeatConfidence") < 0.5
        || edit_spans(b)
            .iter()
            .any(|[s, e]| time > *s + 0.025 && time < *e - 0.025)
        || power_level(b, time, time + 0.6, "rmsDb") < n(b, "bodyRmsDb") - 6.
    {
        return None;
    }
    let rel = tempo_relation(n(ga, "bpm"), n(gb, "bpm"));
    let mut p = ctx.base("phrase_cut");
    p["aExit"] = json!(r3(exit));
    p["bEntry"] = json!(r3(time));
    p["duration"] = json!(r3(d));
    p["swapAt"] = json!(r3(d / 2.));
    p["automation"] = json!([
        lane(
            "B",
            "gain",
            vec![shape(0., 0.012f64.min(d / 4.), sin_up, 4)]
        ),
        lane(
            "A",
            "gain",
            vec![shape(0., d, |x| cos_down(x).powf(1.4), 10)]
        ),
        lane(
            "A",
            "low",
            vec![shape(0., (beat / 4.).min(d), |x| 1. - smoothstep(x), 4)]
        ),
        lane(
            "A",
            "mid",
            vec![
                vec![[0., 1.]],
                shape(beat.min(d / 2.), d, |x| 1. - 0.5 * smoothstep(x), 4)
            ]
        )
    ]);
    p["confidence"] = json!(r3(0.45
        * (n(ga, "confidence") * n(gb, "confidence")).sqrt()
        + 0.25));
    finish_fields(&mut p, key, reason);
    p["beatAlign"] = json!({"bpmA":ga["bpm"],"bpmB":gb["bpm"],"relation":rel["m"],"ratio":1,"stretchPercent":0,"overlapBeats":round(d/beat),"phraseAligned":is_phrase(exit)});
    let cut = (n(a, "audibleEnd") - exit - d).max(0.);
    p["reasons"] = reasons(
        format!(
            "смена темпа на сильной доле у границы {}: короткий срез с защитой от щелчка",
            if is_phrase(exit) {
                "фразы"
            } else {
                "такта"
            }
        ),
        reason,
        vec![if cut > 2. {
            format!("пропускается {:.0} с финала", round(cut))
        } else {
            "текущий трек звучит почти до конца".into()
        }],
    );
    p["debug"] = json!({"cut":r3(cut),"variant":"downbeat-cut"});
    describe_entry(&mut p, b, &entry, None);
    Some(p)
}
pub fn plan_minimal(ctx: &Ctx, a: &Value, b: &Value, key: &Value, reason: Option<&str>) -> Value {
    let mut p = ctx.base("gapless");
    let d = 0.03;
    p["aExit"] = json!(r3((n(a, "duration") - d).min(n(a, "audibleEnd"))));
    p["bEntry"] = json!(r3(0f64.max(n(b, "audibleStart") - 0.02)));
    p["duration"] = json!(d);
    p["gap"] = json!(0.12);
    p["swapAt"] = json!(d);
    p["automation"] = json!([lane("A", "gain", vec![vec![[0., 1.], [d, 0.]]])]);
    p["confidence"] = json!(0.7);
    finish_fields(&mut p, key, reason);
    let mut out = vec![
        "резкий финал и резкое начало: наложение испортило бы оба трека".to_string(),
        "стык без наложения с короткой паузой".into(),
    ];
    if let Some(r) = reason.filter(|r| !r.is_empty()) {
        out.push(r.into());
    }
    p["reasons"] = json!(out);
    p
}
pub fn plan_crossfade(ctx: &Ctx, a: &Value, b: &Value, key: &Value, reason: Option<&str>) -> Value {
    let fade = natural_fade(a);
    let rhythmic = n(a, "rhythmStrength") > 0.45 && n(b, "rhythmStrength") > 0.45;
    let style: f64 = match s(ctx.s, "style") {
        "tight" => 0.55,
        "smooth" => 1.3,
        _ => 1.,
    };
    let mut p = ctx.base("crossfade");
    let cap = n(ctx.s, "maxBlendSeconds")
        .min((n(a, "audibleEnd") - n(a, "audibleStart")) * 0.3)
        .min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.35);
    let (mut len, mut handoff, mut ag, bg);
    let mut notes: Vec<String> = vec![];
    if n(&fade, "length") >= 3. {
        let start = n(a, "audibleStart")
            .max(n(&fade, "start") - 1.)
            .min(n(&a["outro"], "start"));
        len = (8. * style)
            .max(n(a, "audibleEnd") - start)
            .min(14. * style)
            .min(cap);
        p["aExit"] = json!(r3(n(a, "audibleStart").max(n(a, "audibleEnd") - len)));
        handoff = decay_handoff(a, n(&p, "aExit"), len);
        let extra = (3.5 - handoff)
            .min((16. * style).min(cap) - len)
            .min(n(&p, "aExit") - n(a, "audibleStart"));
        if extra > 0.25 {
            len += extra;
            p["aExit"] = json!(r3(n(&p, "aExit") - extra));
            handoff = decay_handoff(a, n(&p, "aExit"), len);
        }
        handoff = handoff.max(3.5f64.min(len * 0.35));
        let rise = len.min(0.3f64.max(handoff * 1.15).max(len * 0.5));
        let release = (handoff + 1.).max(rise * 0.85).min(len * 0.7);
        ag = vec![[0., 1.], [r3(release), 1.]];
        ag.extend(shape(release, len, cos_down, 10).into_iter().skip(1));
        bg = shape(0., rise, sin_up, 10);
        notes.push("текущий трек затихает сам: следующий нарастает внутри его затухания".into());
    } else {
        len = (if rhythmic { 9. } else { 11. } * style).min(cap);
        let loud = loud_until(a);
        let late = n(a, "audibleEnd") - len;
        p["aExit"] = json!(r3((n(a, "audibleStart")
            + (n(a, "audibleEnd") - n(a, "audibleStart")) * 0.5)
            .max(if n(a, "audibleEnd") - loud >= 4. {
                late.min(loud - len * 0.5)
            } else {
                late
            })));
        ag = shape(0., len, cos_down, 14);
        bg = shape(0., len, sin_up, 14);
        handoff = len / 2.;
        notes.push("тишина в начале и в конце обрезана, переход в самом конце трека".into());
    }
    let selected = pick_handoff(ctx, a, b, n(&p, "aExit"), handoff, len, false);
    let cue = n(&selected.cue, "time");
    let mut arrival = None;
    if power_level(b, cue, cue + 2., "rmsDb") < n(b, "bodyRmsDb") - 6. {
        let mut t = cue + 0.5;
        while t <= (n(b, "audibleEnd") - 3.).min(cue + len + 8.) {
            if power_level(b, t, t + 1.5, "rmsDb") >= n(b, "bodyRmsDb") - 4.
                && power_level(b, t, t + 3., "rmsDb") >= n(b, "bodyRmsDb") - 5.
            {
                arrival = Some(t);
                break;
            }
            t += 0.25;
        }
    }
    let early = arrival.map_or(0., |t| t - cue - (loud_until(a) - n(&p, "aExit")) + 4.);
    if early > 0.5
        && early <= 14.
        && len + early <= n(ctx.s, "maxBlendSeconds")
        && n(&p, "aExit") - early
            >= n(a, "audibleStart") + (n(a, "audibleEnd") - n(a, "audibleStart")) * 0.5
    {
        p["aExit"] = json!(r3(n(&p, "aExit") - early));
        len += early;
        handoff += early;
        for (i, point) in ag.iter_mut().enumerate() {
            if i > 0 {
                point[0] = r3(point[0] + early);
            }
        }
        let stop = len.min(loud_until(a) - n(&p, "aExit"));
        let r0 = 0f64.max(stop - 4.);
        let ramp = |t: f64| {
            if t <= r0 {
                1.
            } else if t >= stop {
                0.15
            } else {
                1. - 0.85 * smoothstep((t - r0) / (stop - r0))
            }
        };
        let mut knots: Vec<f64> = ag.iter().map(|p| p[0]).collect();
        knots.extend((0..9).map(|i| r0 + (stop - r0) * i as f64 / 8.));
        knots.sort_by(f64::total_cmp);
        knots.dedup();
        ag = knots
            .iter()
            .map(|t| [r3(*t), r3(point_value(&ag, *t).min(ramp(*t)))])
            .collect();
        notes.push("переход начинается раньше: музыка текущего трека держит тихое начало следующего до прихода его основной части".into());
    }
    p["bEntry"] = json!(r3(cue));
    p["duration"] = json!(r3(len));
    p["swapAt"] = json!(r3(handoff));
    let mut lanes = vec![lane("A", "gain", vec![ag]), lane("B", "gain", vec![bg])];
    let wash = ctx.s["eqHandoff"] == true && rhythmic && n(&fade, "length") < 3.;
    if wash {
        lanes.extend([
            lane(
                "A",
                "filter",
                vec![
                    vec![[0., 0.]],
                    shape(len * 0.3, len * 0.85, |x| 0.7 * smoothstep(x), 12),
                ],
            ),
            lane(
                "A",
                "low",
                vec![
                    vec![[0., 1.]],
                    shape(len * 0.25, len * 0.5, |x| 1. - smoothstep(x), 6),
                ],
            ),
            lane(
                "B",
                "low",
                vec![vec![[0., 0.]], shape(len * 0.4, len * 0.58, smoothstep, 6)],
            ),
            lane(
                "A",
                "high",
                vec![
                    vec![[0., 1.]],
                    shape(len * 0.1, len * 0.45, |x| 1. - 0.6 * smoothstep(x), 6),
                ],
            ),
            lane(
                "B",
                "high",
                vec![
                    vec![[0., 0.3]],
                    shape(len * 0.35, len * 0.65, |x| 0.3 + 0.7 * smoothstep(x), 6),
                ],
            ),
        ]);
        notes.push("уход через фильтр: бас и верха текущего трека растворяются до того, как входит ритм следующего".into());
    } else if ctx.s["eqHandoff"] == true {
        let from = 0f64.max(handoff - 0.75f64.min(len * 0.08));
        let to = len.min(handoff + 0.75f64.min(len * 0.08));
        lanes.push(lane(
            "A",
            "low",
            vec![vec![[0., 1.]], shape(from, to, |x| 1. - smoothstep(x), 4)],
        ));
        lanes.push(lane(
            "B",
            "low",
            vec![
                vec![[0., 0.15]],
                shape(from, to, |x| 0.15 + 0.85 * smoothstep(x), 4),
            ],
        ));
        let da = density(a, n(&p, "aExit"), n(&p, "aExit") + len);
        let db = density(b, n(&p, "bEntry"), n(&p, "bEntry") + len);
        let clash = n(key, "compatibility") < 0.3
            && n(&a["key"], "confidence") >= 0.4
            && n(&b["key"], "confidence") >= 0.4;
        if da * db * 6. > 0.35 || clash {
            lanes.push(lane(
                "B",
                "mid",
                vec![
                    vec![[0., 0.4]],
                    shape(
                        0f64.max(handoff - len * 0.15),
                        len.min(handoff + len * 0.25),
                        |x| 0.4 + 0.6 * smoothstep(x),
                        6,
                    ),
                ],
            ));
            lanes.push(lane(
                "A",
                "mid",
                vec![
                    vec![[0., 1.]],
                    shape(
                        0f64.max(handoff - len * 0.2),
                        len.min(handoff + len * 0.2),
                        |x| 1. - 0.6 * smoothstep(x),
                        6,
                    ),
                ],
            ));
            notes.push(if clash&&da*db*6.<=0.35{"тональности конфликтуют: середина треков меняется по очереди, а не звучит одновременно"}else{"плотные средние частоты меняются по очереди, чтобы уменьшить конфликт мелодий"}.into());
        }
        if rhythmic {
            lanes.push(lane(
                "A",
                "high",
                vec![shape(
                    0.,
                    len.min(handoff + len * 0.1),
                    |x| 1. - 0.55 * smoothstep(x),
                    6,
                )],
            ));
            lanes.push(lane(
                "B",
                "high",
                vec![
                    vec![[0., 0.45]],
                    shape(
                        0f64.max(handoff - len * 0.1),
                        len.min(handoff + len * 0.5),
                        |x| 0.45 + 0.55 * smoothstep(x),
                        6,
                    ),
                ],
            ));
            notes.push(
                "верха и бас меняются по очереди, чтобы уменьшить конфликт разных ритмов".into(),
            );
        }
    }
    p["automation"] = json!(lanes);
    p["confidence"] = json!(0.6);
    finish_fields(&mut p, key, reason);
    p["reasons"] = reasons(
        format!(
            "{}, {} с",
            if n(&fade, "length") >= 3. {
                "передача по измеренному затуханию"
            } else {
                "плавный переход с постоянной мощностью"
            },
            fixed(len, 0)
        ),
        reason,
        notes,
    );
    describe_entry(&mut p, b, &selected.cue, selected.arrival);
    p["debug"] = json!({"naturalFade":n(&fade,"length")>=3.,"washout":wash,"acousticHandoff":r3(handoff),"entryScore":r3(selected.score)});
    p
}
pub fn bass_arrivals(b: &Value, until: f64) -> Vec<Value> {
    let curve = nums(&b["curves"]["lowDb"]);
    let rate = n(&b["curves"], "rate");
    let lo = (n(b, "audibleStart") * rate).floor().max(0.) as usize;
    let hi = ((n(b, "audibleEnd") * rate).ceil().max(0.) as usize).min(curve.len());
    let mut sorted = curve.get(lo..hi).unwrap_or(&[]).to_vec();
    if sorted.is_empty() {
        return vec![];
    }
    sorted.sort_by(f64::total_cmp);
    let body = sorted[sorted.len() >> 1];
    let grid = if n(&b["beat"], "confidence") >= 0.45 {
        nums(&b["beat"]["downbeats"])
    } else {
        vec![]
    };
    let mut out = vec![];
    let mut start = None;
    let mut t = n(b, "audibleStart");
    while t <= until.min(n(b, "audibleEnd") - 6.) {
        if power_level(b, t - 0.5, t + 0.5, "lowDb") < body - 10. {
            start.get_or_insert(t);
            t += 0.25;
            continue;
        }
        if let Some(run) = start {
            if t - run >= 6. && power_level(b, t, t + 4., "lowDb") >= body - 4. {
                let mut at = t - 1.;
                while at < t + 1.5 && power_level(b, at, at + 0.25, "lowDb") < body - 6. {
                    at += 0.05;
                }
                let bar = grid
                    .iter()
                    .find(|d| (**d - at).abs() < 0.3)
                    .copied()
                    .unwrap_or(at);
                out.push(json!({"start":run,"arrival":r3(bar)}));
            }
        }
        start = None;
        t += 0.25;
    }
    out
}
pub fn plan_intro_drop(
    ctx: &Ctx,
    a: &Value,
    b: &Value,
    key: &Value,
    reason: Option<&str>,
) -> Option<Value> {
    if ctx.s["eqHandoff"] != true || s(ctx.s, "style") == "tight" || ctx.requested_at.is_some() {
        return None;
    }
    let lb = n(b, "audibleEnd") - n(b, "audibleStart");
    let la = n(a, "audibleEnd") - n(a, "audibleStart");
    let preserve = s(ctx.s, "entryMode") == "preserve" || ctx.s["maxEntrySkipSeconds"] == 0;
    let limit = n(b, "audibleStart")
        + if preserve {
            0.5
        } else {
            opt(ctx.s, "maxEntrySkipSeconds", 45.).min(lb * 0.45)
        };
    let tail = 2.;
    let max_t = 16f64
        .min(n(ctx.s, "maxBlendSeconds") - tail)
        .min(la * 0.3)
        .min(lb * 0.35);
    if max_t < 6. {
        return None;
    }
    let bd = if n(&b["beat"], "confidence") >= 0.45 {
        nums(&b["beat"]["downbeats"])
    } else {
        vec![]
    };
    let ad = if a["beat"]["stable"] == true && n(&a["beat"], "confidence") >= 0.45 {
        Some(nums(&a["beat"]["downbeats"]))
    } else {
        None
    };
    let phrases = if n(a, "phraseConfidence") >= 0.2 {
        nums(&a["phrases"])
    } else {
        vec![]
    };
    let clash = n(key, "compatibility") < 0.5;
    let lanes_at = |t: f64, duck: bool| {
        let len = t + tail;
        let mut lanes = vec![
            lane("B", "gain", vec![shape(0., 4f64.min(t * 0.4), sin_up, 8)]),
            lane(
                "B",
                "low",
                vec![vec![[0., 0.]], shape(t - 0.4, t - 0.05, smoothstep, 4)],
            ),
            lane(
                "B",
                "high",
                vec![
                    vec![[0., 0.5]],
                    shape(t * 0.5, t, |x| 0.5 + 0.5 * smoothstep(x), 6),
                ],
            ),
            lane(
                "A",
                "gain",
                vec![
                    vec![[0., 1.]],
                    shape(t * 0.7, t + tail * 0.4, cos_down, 10),
                    vec![[r3(len), 0.]],
                ],
            ),
            lane(
                "A",
                "low",
                vec![
                    vec![[0., 1.]],
                    shape(t * 0.65, t - 0.8, |x| 1. - smoothstep(x), 6),
                ],
            ),
            lane(
                "A",
                "high",
                vec![
                    vec![[0., 1.]],
                    shape(t * 0.4, t * 0.85, |x| 1. - 0.5 * smoothstep(x), 6),
                ],
            ),
        ];
        if duck {
            lanes.push(lane(
                "A",
                "mid",
                vec![
                    vec![[0., 1.]],
                    shape(t * 0.3, t * 0.7, |x| 1. - 0.5 * smoothstep(x), 6),
                ],
            ));
        }
        lanes
    };
    let unknown_a = voice_unknown(a, ctx.s);
    let unknown_b = voice_unknown(b, ctx.s);
    let mut best: Option<Value> = None;
    for run in bass_arrivals(b, limit + max_t) {
        let arrival = n(&run, "arrival");
        let mut entries = vec![];
        for initial in [arrival - max_t, arrival - 12., arrival - 8.] {
            let e = initial.max(n(&run, "start")).max(n(b, "audibleStart"));
            let time = r3(bd
                .iter()
                .find(|d| **d >= e - 0.01 && **d < e + 1.)
                .copied()
                .unwrap_or(e));
            if !entries.contains(&time) {
                entries.push(time);
            }
        }
        for entry in entries {
            let t = arrival - entry;
            if t < 6. || t > max_t + 0.01 || entry > limit {
                continue;
            }
            let len = t + tail;
            let mut lanes = lanes_at(t, clash);
            let dens_b = if unknown_b {
                density(b, entry, entry + t) / body_density(b)
            } else {
                0.
            };
            let mut muted = 0.;
            if ctx.s["stemMixing"] != false && !b["vocalActivity"].is_null() {
                let mut x = 0.;
                while x < t / 2. {
                    muted += clamp(
                        (vocal_mean(b, entry + x, entry + x + 0.25) - 0.15) / 0.7,
                        0.,
                        1.,
                    ) * at(&lanes, "B", "gain", x)
                        * 0.25;
                    x += 0.25;
                }
            }
            if muted > 1.5 {
                continue;
            }
            let drops: Vec<f64> = ad.as_ref().map_or_else(
                || {
                    (0..120)
                        .map(|i| n(a, "audibleEnd") - tail - i as f64 * 0.5)
                        .collect()
                },
                |v| {
                    v.iter()
                        .copied()
                        .filter(|v| {
                            *v > n(a, "audibleEnd") - 60. && *v <= n(a, "audibleEnd") - tail
                        })
                        .collect()
                },
            );
            for drop in drops {
                let exit = drop - t;
                if exit < n(a, "audibleStart") + la * 0.5 {
                    continue;
                }
                let dens_a = if dens_b >= 0.9 {
                    density(a, exit, exit + t * 0.7) / body_density(a)
                } else {
                    0.
                };
                if unknown_a && dens_a >= 1.1 && dens_b >= 1.1 {
                    continue;
                }
                let duck = clash || dens_b >= 0.9 && dens_a >= 0.9;
                lanes = lanes_at(t, duck);
                let reference = (level_before(a, exit) + ctx.gain_a()).min(
                    power_level(b, arrival, n(b, "audibleEnd").min(arrival + 6.), "rmsDb")
                        + ctx.gain_b(),
                );
                let mut hole = 0f64;
                for i in 1..=16 {
                    let x = len * i as f64 / 16.;
                    let stems = ctx.s["stemMixing"] != false
                        && !a["vocalActivity"].is_null()
                        && !b["vocalActivity"].is_null();
                    let sum = at(&lanes, "A", "gain", x).powi(2)
                        * filtered_power(
                            a,
                            exit + x,
                            ctx.gain_a(),
                            at(&lanes, "A", "low", x),
                            at(&lanes, "A", "mid", x),
                            at(&lanes, "A", "high", x),
                            if stems && x >= t / 2. { 0. } else { 1. },
                        )
                        + at(&lanes, "B", "gain", x).powi(2)
                            * filtered_power(
                                b,
                                entry + x,
                                ctx.gain_b(),
                                at(&lanes, "B", "low", x),
                                at(&lanes, "B", "mid", x),
                                at(&lanes, "B", "high", x),
                                if stems && x < t / 2. { 0. } else { 1. },
                            );
                    hole = hole.max(reference - 10. * sum.max(1e-12).log10() - 3.);
                    if at(&lanes, "A", "gain", x) >= 0.5 {
                        hole = hole.max(
                            level_before(a, exit)
                                - power_level(a, exit + x - 0.75, exit + x + 0.75, "rmsDb")
                                - 6.,
                        );
                    }
                }
                if hole > 3. {
                    continue;
                }
                let cut = n(a, "audibleEnd") - drop - tail;
                let vocal_clash = if ctx.s["stemMixing"] != false {
                    voice_clash(a, b, exit, len, entry, len, len, |x| {
                        [
                            at(&lanes, "A", "gain", x * len),
                            at(&lanes, "B", "gain", x * len),
                        ]
                    })
                } else {
                    0.
                };
                let score = 0.45 * cut_score(a, drop + tail) - 0.5 * clamp(hole / 10., 0., 1.)
                    + if phrases
                        .iter()
                        .any(|v| round(v * 1000.) == round(drop * 1000.))
                    {
                        0.08
                    } else {
                        0.
                    }
                    + 0.12 * (1. - clamp((t - 12.).abs() / 8., 0., 1.))
                    - entry_skip_cost(b, entry, false, unknown_b)
                    - 0.4f64.min(0.08 * vocal_clash)
                    - 0.1 * muted
                    - 0.1 * vocal_mean(a, drop - 0.3, drop + 0.2);
                if best.as_ref().is_none_or(|p| score > n(p, "score")) {
                    best = Some(
                        json!({"score":score,"exit":exit,"entry":entry,"T":t,"cut":cut,"hole":hole,"duck":duck}),
                    );
                }
            }
        }
    }
    let best = best?;
    if n(&best, "score") < 0.2 {
        return None;
    }
    let exit = n(&best, "exit");
    let entry = n(&best, "entry");
    let t = n(&best, "T");
    let mut p = ctx.base("crossfade");
    p["aExit"] = json!(r3(exit));
    p["bEntry"] = json!(r3(entry));
    p["duration"] = json!(r3(t + tail));
    p["swapAt"] = json!(r3(t));
    p["automation"] = json!(lanes_at(t, best["duck"] == true));
    p["confidence"] = json!(0.65);
    finish_fields(&mut p, key, reason);
    let mut rest=vec!["бас и верха текущего трека растворяются до того, как вступает бит следующего: две бочки не звучат вместе".into()];
    if best["duck"] == true && !clash {
        rest.push("вступление следующего плотное, голос в нём не измерен: середина текущего трека отступает, две ведущие партии не звучат в полную силу".into());
    }
    rest.push(if n(&best, "cut") > 2. {
        format!("пропускается {:.0} с финала", round(n(&best, "cut")))
    } else {
        "текущий трек звучит почти до конца".into()
    });
    p["reasons"] = reasons(
        format!(
            "вступление следующего трека поверх ритма текущего, {} с; бит следующего входит, когда ритм текущего уже ушёл",
            fixed(t, 0)
        ),
        reason,
        rest,
    );
    describe_entry(
        &mut p,
        b,
        &json!({"time":entry,"score":0.7,"kind":"section","tags":["bass-arrival"]}),
        Some(entry + t),
    );
    p["debug"] = json!({"washout":true,"variant":"intro-drop","bassArrival":r3(entry+t),"holdUntil":r3(t*0.85),"levelHole":r3(n(&best,"hole")),"cut":r3(n(&best,"cut")),"entryScore":r3(n(&best,"score"))});
    Some(p)
}
fn echo_level(an: &Value, key: &str, a: f64, b: f64) -> f64 {
    let rate = n(&an["curves"], "rate");
    let curve = nums(&an["curves"][key]);
    let lo = (a * rate).floor();
    let hi = (b * rate).ceil();
    if !(rate > 0.) || lo < 0. || hi > curve.len() as f64 || hi <= lo {
        return f64::NAN;
    }
    let values = &curve[lo as usize..hi as usize];
    if !values.iter().all(|v| v.is_finite()) {
        return f64::NAN;
    }
    10. * (values.iter().map(|v| 10f64.powf(v / 10.)).sum::<f64>() / values.len() as f64)
        .max(1e-12)
        .log10()
}
fn voice_known(an: &Value, a: f64, b: f64) -> bool {
    let voice = &an["vocalActivity"];
    let rate = n(voice, "rate");
    let values = nums(&voice["values"]);
    if voice.is_null() || !(rate > 0.) || a < 0. || (b * rate).ceil() > values.len() as f64 {
        return false;
    }
    let lo = (a * rate).floor() as usize;
    let hi = (b * rate).ceil().max(0.) as usize;
    values
        .get(lo..hi)
        .is_some_and(|v| v.iter().all(|v| v.is_finite()))
}
fn sung(an: &Value, t: f64) -> bool {
    vocal_mean(an, t - 0.05, t + 0.05) >= 0.28
}
fn quiet_for(an: &Value, from: f64, to: f64) -> f64 {
    let mut t = from;
    while t < to {
        if echo_level(an, "rmsDb", t, t + 0.5) >= n(an, "bodyRmsDb") - 12. {
            return t - from;
        }
        t += 0.25;
    }
    to - from
}
fn quiet_before(an: &Value, to: f64) -> f64 {
    let mut t = to - 0.5;
    while t >= to - 8. {
        if echo_level(an, "rmsDb", t, t + 0.5) >= n(an, "bodyRmsDb") - 12. {
            return to - t - 0.5;
        }
        t -= 0.25;
    }
    8.
}
fn echo_delay(beat: f64) -> f64 {
    let mut d = beat;
    while d < 0.3 {
        d *= 2.;
    }
    while d > 0.8 {
        d /= 2.;
    }
    d
}
pub fn plan_echo_out(
    base: &Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    stretch: f64,
) -> Option<Value> {
    let ga = &a["beat"];
    let gb = &b["beat"];
    if stretch < 25.
        || ga.is_null()
        || gb.is_null()
        || ga["stable"] != true
        || gb["stable"] != true
        || n(ga, "confidence") < 0.6
        || n(gb, "confidence") < 0.45
        || n(ga, "downbeatConfidence") < 0.3
        || n(a, "rhythmStrength") <= 0.45
        || n(b, "rhythmStrength") <= 0.45
        || a["vocalActivity"].is_null()
        || b["vocalActivity"].is_null()
    {
        return None;
    }
    let beat = n(ga, "period");
    let bar = 4. * beat;
    let need = bar.max(2.);
    let skip = if s(settings, "entryMode") == "preserve" {
        0.
    } else {
        opt(settings, "maxEntrySkipSeconds", 45.)
            .min((n(b, "audibleEnd") - n(b, "audibleStart")) * 0.45)
    };
    let look = n(b, "audibleEnd").min(n(b, "audibleStart") + skip + 12.);
    if !voice_known(b, n(b, "audibleStart"), look) {
        return None;
    }
    let mut voice_b = f64::INFINITY;
    let mut t = n(b, "audibleStart");
    while t < look {
        if sung(b, t) {
            voice_b = t;
            break;
        }
        t += 0.02;
    }
    let mut entries = vec![n(b, "audibleStart")];
    entries.extend(nums(&gb["downbeats"]).iter().filter(|t| {
        **t > n(b, "audibleStart") && **t <= n(b, "audibleStart") + skip && **t <= voice_b - 0.15
    }));
    let entries:Vec<Value>=entries.iter().map(|entry|json!({"entry":entry,"lead":if voice_b.is_finite(){json!(voice_b-entry)}else{Value::Null},"quiet":quiet_for(b,*entry,*entry+8.)})).filter(|e|n(e,"quiet")<8.).collect();
    let mut options = vec![];
    for d in nums(&ga["downbeats"]) {
        if d < (n(a, "audibleStart") + 30.).max(n(a, "audibleEnd") - 40.)
            || d > n(a, "audibleEnd") - 0.5
        {
            continue;
        }
        let start = d - bar;
        if !voice_known(a, start - 10., n(a, "audibleEnd"))
            || echo_level(a, "rmsDb", start, d).is_nan()
            || vocal_mean(a, d - 0.1, d + 0.25) >= 0.18
        {
            continue;
        }
        let lost = vocal_mean(a, d, n(a, "audibleEnd")) * (n(a, "audibleEnd") - d);
        if lost > 3. {
            continue;
        }
        let mut last = f64::NEG_INFINITY;
        let mut t = d;
        while t >= start - 10. {
            if sung(a, t) {
                last = t - start;
                break;
            }
            t -= 0.02;
        }
        let quiet = quiet_before(a, d);
        for e in &entries {
            let lead = if e["lead"].is_null() {
                f64::INFINITY
            } else {
                n(e, "lead")
            };
            let delay = (bar + beat).max(last + need - lead);
            if delay > 2. * bar + 1e-6 {
                continue;
            }
            let valley = quiet + (delay - bar) + n(e, "quiet");
            if valley > 5. {
                continue;
            }
            options.push(json!({"cost":lost+0.03*(n(a,"audibleEnd")-d)+0.3*valley,"d":d,"lastA":if last.is_finite(){json!(last)}else{Value::Null},"lostA":lost,"entry":e["entry"],"lead":e["lead"],"bDelay":delay,"valley":valley}));
        }
    }
    options.sort_by(|a, b| n(a, "cost").total_cmp(&n(b, "cost")));
    for best in options.iter().take(8) {
        let cut = r3(bar);
        let start = r3(n(best, "bDelay"));
        let d = r3(6f64.max(start + 1.).max(cut + 2. * bar));
        let preroll = n(best, "entry") - start >= 0.;
        let mut p = base.clone();
        p["aExit"] = json!(r3(n(best, "d") - bar));
        p["bEntry"] = json!(r3(if preroll {
            n(best, "entry") - start
        } else {
            n(best, "entry")
        }));
        p["duration"] = json!(d);
        p["swapAt"] = json!(cut);
        p["tempoB"] = json!([[0, 1]]);
        if !preroll {
            p["bDelay"] = json!(start);
        }
        p["echo"] = json!({"delay":r3(echo_delay(beat)),"feedback":0.55});
        p["automation"] = json!([
            {"deck":"A","lane":"gain","points":[[0.,1.],[r3(cut-0.03),1.],[cut,0.],[d,0.]]},
            {"deck":"A","lane":"low","points":[[0.,1.],[r3(cut-beat),1.],[r3(cut-0.05),0.],[d,0.]]},
            {"deck":"A","lane":"echo","points":[[0.,0.],[r3(cut-2.*beat),0.],[r3(cut-beat),0.7],[cut,0.7],[r3(cut+0.02),0.],[d,0.]]},
            {"deck":"B","lane":"gain","points":if preroll{vec![[0.,0.],[start,0.],[r3(start+0.02),1.],[d,1.]]}else{vec![[0.,0.],[0.02,1.],[r3(d-start),1.]]}}]);
        p["confidence"] = json!(r3(0.7f64.min(n(ga, "confidence")).min(n(gb, "confidence"))));
        p["reasons"] = json!([
            format!(
                "эхо-выход: темпы {} и {} BPM не сводятся по битам — текущий трек заканчивает фразу, его последний такт уходит в эхо, следующий входит со своей сильной доли под хвост эха",
                fixed(n(ga, "bpm"), 0),
                fixed(n(gb, "bpm"), 0)
            ),
            "ритмы двух треков не звучат одновременно; между последней строкой текущего и первой строкой следующего — не меньше такта инструментала"
        ]);
        if !p["debug"].is_object() {
            p["debug"] = json!({});
        }
        p["debug"]["variant"] = json!("echo-out");
        let last = if best["lastA"].is_null() {
            f64::NEG_INFINITY
        } else {
            n(best, "lastA")
        };
        let lead = if best["lead"].is_null() {
            f64::INFINITY
        } else {
            n(best, "lead")
        };
        p["debug"]["echoOut"] = json!({"cutSource":r3(n(best,"d")),"bStartsAt":start,"bSource":r3(n(best,"entry")),"preroll":preroll,"lastVoiceA":r3(last),"voiceLeadB":r3(lead),"voiceGap":r3(start+lead-last),"lostA":r3(n(best,"lostA")),"valley":r3(n(best,"valley")),"cost":r3(n(best,"cost"))});
        let h = super::vocal_handoff::apply_vocal_handoff(p.clone(), a, b, settings);
        let shift = opt(&p, "bDelay", 0.);
        let mut ok = true;
        let mut t = 0.;
        while t < bar && ok {
            if sung(a, n(&p, "aExit") + t)
                && point_value(
                    &if h["vocalA"].is_null() {
                        vec![[0., 1.]]
                    } else {
                        points(&h["vocalA"])
                    },
                    t,
                ) < 0.5
            {
                ok = false;
            }
            t += 0.05;
        }
        let mut t = 0.;
        while t < d - shift && ok {
            if point_value(&points(&p["automation"][3]["points"]), t) > 0.5
                && sung(b, n(&p, "bEntry") + t)
                && point_value(
                    &if h["vocalB"].is_null() {
                        vec![[0., 1.]]
                    } else {
                        points(&h["vocalB"])
                    },
                    t,
                ) < 0.5
            {
                ok = false;
            }
            t += 0.05;
        }
        if ok {
            return Some(p);
        }
    }
    let from = n(a, "audibleStart").max(n(a, "audibleEnd") - 40.);
    if !voice_known(a, from, n(a, "audibleEnd")) {
        return None;
    }
    let mut last = f64::NEG_INFINITY;
    let mut quiet = n(a, "audibleEnd");
    let mut t = n(a, "audibleEnd");
    while t >= from {
        if sung(a, t) {
            last = t;
            break;
        }
        t -= 0.02;
    }
    let body_low = echo_level(a, "lowDb", n(a, "audibleStart"), n(a, "audibleEnd"));
    let mut t = n(a, "audibleEnd") - 0.5;
    while t >= from
        && echo_level(a, "rmsDb", t, t + 0.5) < n(a, "bodyRmsDb") - 6.
        && echo_level(a, "lowDb", t, t + 0.5) < body_low - 15.
    {
        quiet = t;
        t -= 0.25;
    }
    let entry = 0f64.max(n(b, "audibleStart") - 0.5);
    let lead = voice_b - entry;
    let exit = quiet.max(last + 0.3).max(last + need - lead);
    let fade = bar.min(n(a, "audibleEnd") - exit);
    if exit > n(a, "audibleEnd") - 1.5
        || exit - quiet.max(last) > 4.
        || quiet_for(b, entry, entry + 8.) > 4.
    {
        return None;
    }
    let d = r3(6f64.max(fade + 2.));
    let mut p = base.clone();
    p["aExit"] = json!(r3(exit));
    p["bEntry"] = json!(r3(entry));
    p["duration"] = json!(d);
    p["swapAt"] = json!(0);
    p["tempoB"] = json!([[0, 1]]);
    p["echo"] = json!({"delay":r3(echo_delay(beat)),"feedback":0.55});
    p["automation"] = json!([
        {"deck":"A","lane":"gain","points":[[0.,1.],[r3(fade/2.),0.7],[r3(fade),0.],[d,0.]]},
        {"deck":"A","lane":"echo","points":[[0.,0.5],[r3(fade),0.5],[r3(fade+0.02),0.],[d,0.]]},
        {"deck":"B","lane":"gain","points":[[0.,0.],[0.02,1.],[d,1.]]}]);
    p["confidence"] = json!(r3(0.6f64.min(n(ga, "confidence")).min(n(gb, "confidence"))));
    p["reasons"] = json!([
        format!(
            "эхо-выход: темпы {} и {} BPM не сводятся по битам — текущий трек допевает и уходит своим тихим окончанием в эхо, следующий начинается с начала поверх него",
            fixed(n(ga, "bpm"), 0),
            fixed(n(gb, "bpm"), 0)
        ),
        "ритмы двух треков не звучат одновременно; между последней строкой текущего и первой строкой следующего — не меньше такта инструментала"
    ]);
    if !p["debug"].is_object() {
        p["debug"] = json!({});
    }
    p["debug"]["variant"] = json!("echo-tail");
    p["debug"]["echoOut"] = json!({"quietFrom":r3(quiet),"lastVoiceA":r3(last),"voiceLeadB":r3(lead),"voiceGap":r3(exit+lead-last)});
    let h = super::vocal_handoff::apply_vocal_handoff(p.clone(), a, b, settings);
    let mut t = 0.;
    while t < d {
        if sung(b, entry + t)
            && point_value(
                &if h["vocalB"].is_null() {
                    vec![[0., 1.]]
                } else {
                    points(&h["vocalB"])
                },
                t,
            ) < 0.5
        {
            return None;
        }
        t += 0.05;
    }
    Some(p)
}
