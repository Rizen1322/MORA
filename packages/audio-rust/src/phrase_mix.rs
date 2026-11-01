use crate::plan::common::{VERSION, arr, n, num, points, s};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn source_time(points: &[[f64; 2]], t: f64) -> f64 {
    if points.is_empty() {
        return t;
    }
    let (mut area, mut previous, mut rate) = (0., 0., points[0][1]);
    for &[at, next] in points {
        if at <= previous {
            rate = next;
            continue;
        }
        let end = t.min(at);
        let span = end - previous;
        if span > 0. {
            area += span * (rate + (rate + (next - rate) * span / (at - previous))) / 2.;
        }
        if t <= at {
            return area;
        }
        previous = at;
        rate = next;
    }
    area + (t - previous).max(0.) * rate
}
fn grid(base: &Value, a: &Value) -> Option<(f64, f64)> {
    let beat = &a["beat"];
    let period = n(beat, "period");
    let beats = arr(&beat["beats"]);
    if beat["stable"] != true
        || n(beat, "confidence") < 0.7
        || n(beat, "downbeatConfidence") < 0.6
        || arr(&beat["downbeats"]).is_empty()
        || !period.is_finite()
        || period <= 0.
        || n(&a["structure"]["gridCheck"], "tripleShare") > 0.25
        || beats.is_empty()
        || n(base, "aExit") < num(&beats[0])
        || n(base, "aExit") > num(beats.last().unwrap())
    {
        return None;
    }
    Some((60. / period, 4. * period))
}
pub fn create(base: &Value, a: &Value, b: &Value) -> Value {
    let duration0 = n(base, "duration");
    let desired = (if duration0 == 0. { 6. } else { duration0 }).clamp(0.5, 64.);
    let pa = points(&base["tempoA"]);
    let pb = points(&base["tempoB"]);
    let end_a = a["duration"]
        .as_f64()
        .unwrap_or(f64::INFINITY)
        .min(n(base, "aExit") + source_time(&pa, duration0.max(0.)))
        .max(0.);
    let b_entry = if !b.is_null() && n(b, "duration") - n(base, "bEntry") < 0.5 {
        0.
    } else {
        n(base, "bEntry")
    };
    let delay = |d: f64| {
        (if duration0 > 0. {
            base["bDelay"].as_f64().unwrap_or(0.)
        } else {
            0.
        })
        .min(d - 0.1)
        .max(0.)
    };
    let fits = |d: f64| {
        source_time(&pa, d) <= end_a
            && (b.is_null() || b_entry + source_time(&pb, d - delay(d)) <= n(b, "duration"))
    };
    let mut duration = desired;
    if !fits(duration) {
        let (mut lo, mut hi) = (0., desired);
        for _ in 0..50 {
            let mid = (lo + hi) / 2.;
            if fits(mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        duration = lo.max(0.5);
    }
    let a_exit = n(base, "aExit")
        .min(end_a - source_time(&pa, duration))
        .max(0.);
    let b_delay = delay(duration);
    let mut tempo = json!({});
    if !base["tempoA"].is_null() {
        tempo["a"] = base["tempoA"].clone();
    }
    tempo["b"] = base["tempoB"].clone();
    json!({"version":1,"preset":"bass_swap","timing":{"unit":"seconds","seconds":duration},"aExit":a_exit,"bEntry":b_entry,"bDelay":b_delay,
        "handoff":b_delay.max(duration.min(if n(base,"swapAt")==0. { duration/2. } else { n(base,"swapAt") })),"tempo":tempo})
}
fn map_valid(value: &Value) -> bool {
    let Some(p) = value.as_array() else {
        return false;
    };
    !p.is_empty()
        && p.len() <= 256
        && p.iter().enumerate().all(|(i, v)| {
            let Some(pair) = v.as_array() else {
                return false;
            };
            pair.len() == 2
                && num(&pair[0]).is_finite()
                && num(&pair[0]) >= 0.
                && (i != 0 || num(&pair[0]) == 0.)
                && num(&pair[1]).is_finite()
                && (0.5..=2.).contains(&num(&pair[1]))
                && (i == 0 || num(&pair[0]) > num(&p[i - 1][0]))
        })
}
fn err(issues: &[String]) -> String {
    issues.join("; ")
}
pub fn compile(base: &Value, recipe: &Value, a: &Value, b: &Value) -> Result<Value, String> {
    let mut issues = Vec::<String>::new();
    if base["debug"]["processingAllowed"] == false {
        return Err("Источник не поддерживает обработку перехода".into());
    }
    if !recipe.is_object() || num(&recipe["version"]) != 1. {
        return Err("Неизвестная версия сценария".into());
    }
    let preset = s(recipe, "preset");
    let native = preset == "tail_to_start";
    if !["bass_swap", "drop_in", "tail_to_start"].contains(&preset) {
        issues.push("Неизвестный пресет".into());
    }
    let has_tempo = recipe.get("tempo").is_some();
    let tempo = &recipe["tempo"];
    if has_tempo && (!tempo.is_object() || !tempo["b"].is_array()) {
        issues.push("Некорректная темповая карта".into());
    }
    let source_a = if has_tempo {
        &tempo["a"]
    } else {
        &base["tempoA"]
    };
    let source_b = if has_tempo {
        &tempo["b"]
    } else {
        &base["tempoB"]
    };
    let present_a = if has_tempo {
        tempo.get("a").is_some()
    } else {
        base.get("tempoA").is_some()
    };
    let present_b = if has_tempo {
        tempo.get("b").is_some()
    } else {
        base.get("tempoB").is_some()
    };
    for (source, present) in [(source_a, present_a), (source_b, present_b)] {
        if present && !map_valid(source) {
            issues.push("Некорректная темповая карта".into());
        }
    }
    if !issues.is_empty() {
        return Err(err(&issues));
    }
    let tempo_a = if native { Vec::new() } else { points(source_a) };
    let tempo_b = if native {
        vec![[0., 1.]]
    } else {
        points(source_b)
    };
    let timing = &recipe["timing"];
    let mut duration = if s(timing, "unit") == "seconds" {
        n(timing, "seconds")
    } else {
        f64::NAN
    };
    if s(timing, "unit") == "bars" {
        let bars = n(timing, "bars");
        if ![4., 8., 16.].contains(&bars) {
            issues.push("Для тактов нужна надёжная сетка 4/4".into());
        } else if timing.get("resolvedDuration").is_some() {
            duration = n(timing, "resolvedDuration");
        } else {
            let mut source = base.clone();
            source["aExit"] = recipe["aExit"].clone();
            if let Some((_, bar_seconds)) = grid(&source, a) {
                let target = bar_seconds * bars;
                let (mut lo, mut hi) = (0., 128.);
                for _ in 0..50 {
                    let mid = (lo + hi) / 2.;
                    if source_time(&tempo_a, mid) < target {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                duration = (lo + hi) / 2.;
            } else {
                issues.push("Для тактов нужна надёжная сетка 4/4".into());
            }
        }
    }
    if !duration.is_finite() || !(0.5..=64.).contains(&duration) {
        issues.push("Длительность должна быть от 0,5 до 64 секунд".into());
    }
    for key in ["aExit", "bEntry", "bDelay", "handoff"] {
        if !n(recipe, key).is_finite() || n(recipe, key) < 0. {
            issues.push(format!("Некорректная точка {key}"));
        }
    }
    let delay = n(recipe, "bDelay");
    let handoff = n(recipe, "handoff");
    if delay >= duration || handoff < delay || handoff > duration {
        issues.push("Старт B и передача должны находиться внутри перехода".into());
    }
    if !a.is_null()
        && n(recipe, "aExit") + source_time(&tempo_a, duration) > n(a, "duration") + 0.001
    {
        issues.push("Переход выходит за конец A".into());
    }
    if !b.is_null()
        && n(recipe, "bEntry") + source_time(&tempo_b, duration - delay) > n(b, "duration") + 0.001
    {
        issues.push("Переход выходит за конец B".into());
    }
    if recipe.get("curves").is_some() && !recipe["curves"].is_array() {
        issues.push("Некорректные кривые".into());
    }
    let mut seen = HashSet::new();
    for curve in arr(&recipe["curves"]) {
        if !curve.is_object() {
            issues.push("Некорректная полоса".into());
            continue;
        }
        let deck = s(curve, "deck");
        let lane = s(curve, "lane");
        if !seen.insert(format!("{deck}/{lane}"))
            || !["A", "B"].contains(&deck)
            || !["gain", "low", "mid", "high", "filter"].contains(&lane)
        {
            issues.push("Некорректная или повторная полоса".into());
        }
        let p = arr(&curve["points"]);
        let invalid = !curve["points"].is_array()
            || p.len() < 2
            || p.len() > 128
            || num(&p[0][0]) != 0.
            || num(&p[p.len() - 1][0]) != 1.
            || p.iter().enumerate().any(|(i, v)| {
                let Some(pair) = v.as_array() else {
                    return true;
                };
                pair.len() != 2
                    || !num(&pair[0]).is_finite()
                    || !num(&pair[1]).is_finite()
                    || !(0. ..=1.).contains(&num(&pair[0]))
                    || num(&pair[1]) < if lane == "filter" { -1. } else { 0. }
                    || num(&pair[1]) > 1.
                    || (i > 0 && num(&pair[0]) <= num(&p[i - 1][0]))
            });
        if invalid {
            issues.push("Узлы кривой должны идти от 0 до 1 по возрастанию".into());
            continue;
        }
        let first = num(&p[0][1]);
        let last = num(&p[p.len() - 1][1]);
        if lane == "gain"
            && ((deck == "A" && (first != 1. || last != 0.))
                || (deck == "B" && (first != 0. || last != 1.)))
        {
            issues.push(
                "Громкость должна плавно соединяться с сольным воспроизведением: A 1→0, B 0→1"
                    .into(),
            );
        }
        if deck == "B" && lane != "gain" && last != if lane == "filter" { 0. } else { 1. } {
            issues.push("В конце B должен вернуться к исходному EQ/фильтру".into());
        }
        if deck == "A" && lane != "gain" && first != if lane == "filter" { 0. } else { 1. } {
            issues.push("В начале A должен сохранить исходный EQ/фильтр".into());
        }
    }
    if !issues.is_empty() {
        return Err(err(&issues));
    }
    let b_span = duration - delay;
    let mut automation = Vec::<Value>::new();
    let mut lane = |deck: &str, name: &str, before: f64, after: f64, center: f64, width: f64| {
        let span = if deck == "A" { duration } else { b_span };
        let at = (center - if deck == "B" { delay } else { 0. }).clamp(0., span);
        let start = (at - width / 2.).max(0.);
        let end = (at + width / 2.).min(span);
        let mut points = vec![[0., before]];
        if start > 0. {
            points.push([start, before]);
        }
        if end > 0. {
            points.push([end, after]);
        }
        if end < span {
            points.push([span, after]);
        }
        automation.push(json!({"deck":deck,"lane":name,"points":points}));
    };
    let default_width = 1.5f64.min(duration * 0.2);
    lane(
        "A",
        "gain",
        1.,
        0.,
        if native {
            handoff
        } else {
            duration.min(handoff + if preset == "drop_in" { 0.15 } else { 0.7 })
        },
        if native {
            2f64.min(duration)
        } else if preset == "drop_in" {
            0.6
        } else {
            2f64.min(duration * 0.3)
        },
    );
    if native {
        lane(
            "B",
            "gain",
            0.,
            1.,
            delay + 0.175f64.min(b_span / 2.),
            0.35f64.min(b_span),
        );
    }
    // Release the closure's mutable borrow before constructing B's custom gain lane.
    drop(lane);
    if !native {
        let at = handoff - delay;
        let width = if preset == "drop_in" {
            0.6f64.min(b_span)
        } else {
            2f64.min(b_span)
        };
        let intro = 0.5f64.min(b_span * 0.1);
        let bed = if preset == "drop_in" { 0.18 } else { 0.3 };
        let raw = [
            [0., 0.],
            [intro, bed],
            [intro.max(at - width / 2.), bed],
            [b_span.min(intro.max(at + width / 2.)), 1.],
            [b_span, 1.],
        ];
        let p: Vec<_> = raw
            .iter()
            .enumerate()
            .filter(|(i, v)| *i == raw.len() - 1 || raw[*i + 1][0] != v[0])
            .map(|(_, p)| *p)
            .collect();
        automation.push(json!({"deck":"B","lane":"gain","points":p}));
    }
    let mut lane = |deck: &str, name: &str, before: f64, after: f64, center: f64, width: f64| {
        let span = if deck == "A" { duration } else { b_span };
        let at = (center - if deck == "B" { delay } else { 0. }).clamp(0., span);
        let start = (at - width / 2.).max(0.);
        let end = (at + width / 2.).min(span);
        let mut p = vec![[0., before]];
        if start > 0. {
            p.push([start, before]);
        }
        if end > 0. {
            p.push([end, after]);
        }
        if end < span {
            p.push([span, after]);
        }
        automation.push(json!({"deck":deck,"lane":name,"points":p}));
    };
    lane("A", "low", 1., if native { 1. } else { 0. }, handoff, 0.6);
    lane("B", "low", if native { 1. } else { 0. }, 1., handoff, 0.6);
    lane(
        "A",
        "mid",
        1.,
        if native { 1. } else { 0. },
        (handoff - 0.5).max(0.),
        default_width,
    );
    lane(
        "B",
        "mid",
        if native { 1. } else { 0.15 },
        1.,
        handoff,
        default_width,
    );
    lane("A", "high", 1., 1., handoff, default_width);
    lane("B", "high", 1., 1., handoff, default_width);
    lane("A", "filter", 0., 0., handoff, default_width);
    lane(
        "B",
        "filter",
        if preset == "drop_in" { -0.65 } else { 0. },
        0.,
        handoff,
        4f64.min(b_span),
    );
    drop(lane);
    for curve in arr(&recipe["curves"]) {
        let deck = s(curve, "deck");
        let name = s(curve, "lane");
        let mut compiled = curve.clone();
        compiled["points"] = json!(
            points(&curve["points"])
                .iter()
                .map(|p| [p[0] * if deck == "A" { duration } else { b_span }, p[1]])
                .collect::<Vec<_>>()
        );
        if let Some(i) = automation
            .iter()
            .position(|l| s(l, "deck") == deck && s(l, "lane") == name)
        {
            automation[i] = compiled;
        } else {
            automation.push(compiled);
        }
    }
    let mut plan = base.clone();
    let obj = plan.as_object_mut().ok_or("Некорректный исходный план")?;
    for key in [
        "loopA",
        "tapeStopA",
        "vocalA",
        "vocalB",
        "echo",
        "voiceEcho",
        "beatAlign",
        "entrySelection",
    ] {
        obj.remove(key);
    }
    let mut hash = 2166136261u32;
    for c in crate::js_json::stringify(recipe).chars() {
        let mut utf16 = [0u16; 2];
        let first = c.encode_utf16(&mut utf16)[0];
        hash = (hash ^ (first as u32)).wrapping_mul(16777619);
    }
    obj.insert(
        "id".into(),
        json!(format!("{}:phrase:{hash:x}", s(base, "id"))),
    );
    obj.insert("version".into(), json!(VERSION));
    obj.insert(
        "method".into(),
        json!(if native { "crossfade" } else { "phrase_cut" }),
    );
    for (key, value) in [
        ("aExit", recipe["aExit"].clone()),
        ("bEntry", recipe["bEntry"].clone()),
        ("duration", json!(duration)),
        ("bDelay", recipe["bDelay"].clone()),
        ("swapAt", json!(handoff)),
        ("gap", json!(0)),
        ("tempoB", json!(tempo_b)),
        ("automation", json!(automation)),
        ("reasons", json!(["Ручной переход по фразам"])),
        (
            "debug",
            json!({"phraseMix":{"version":1,"preset":preset,"recipe":recipe,"manual":true}}),
        ),
    ] {
        obj.insert(key.into(), value);
    }
    if native || source_a.is_null() {
        obj.remove("tempoA");
    } else {
        obj.insert("tempoA".into(), json!(tempo_a));
    }
    Ok(plan)
}

pub fn dispatch(input: &Value) -> Result<Value, String> {
    if input["mode"] == "create" {
        Ok(create(&input["base"], &input["a"], &input["b"]))
    } else {
        compile(&input["base"], &input["recipe"], &input["a"], &input["b"])
    }
}
