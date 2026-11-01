use super::{common::*, voice_measure::*};
use serde_json::{Value, json};
fn mean(an: &Value, curve: &str, from: f64, to: f64, clamp_lo: bool) -> f64 {
    let rate = n(&an["curves"], "rate");
    let v = nums(&an["curves"][curve]);
    let mut lo = (from * rate).floor();
    if clamp_lo {
        lo = lo.max(0.);
    }
    let hi = (to * rate).ceil();
    if rate <= 0. || lo < 0. || hi > v.len() as f64 || hi <= lo {
        return f64::NAN;
    }
    let v = &v[lo as usize..hi as usize];
    if v.iter().any(|v| !v.is_finite()) {
        return f64::NAN;
    }
    10. * (v.iter().map(|v| 10f64.powf(*v / 10.)).sum::<f64>() / v.len() as f64)
        .max(1e-12)
        .log10()
}
pub fn dj_phrasing(
    mut p: Value,
    a: &Value,
    b: &Value,
    s0: &Value,
    requested: Option<f64>,
) -> Value {
    let d = n(&p, "duration");
    let ba = &b["beat"];
    if s0["enabled"] != true
        || s0["djPhrasing"] == false
        || s0["eqHandoff"] != true
        || s0["stemMixing"] == false
        || s(s0, "style") == "tight"
        || requested.is_some()
        || p["debug"]["processingAllowed"] == false
        || a.is_null()
        || b.is_null()
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || d < 6.
        || d > 32.
        || !p["loopA"].is_null()
        || !p["voiceEcho"].is_null()
        || !p["beatAlign"]["regions"].is_null()
        || p["vocalA"].is_null()
        || b["vocalActivity"].is_null()
        || a["vocalActivity"].is_null()
        || arr(&p["automation"])
            .iter()
            .any(|l| s(l, "lane") == "filter")
        || ba["stable"] != true
        || n(ba, "confidence") < 0.8
        || n(ba, "downbeatConfidence") < 0.7
        || n(ba, "jitterMs") > 12.
        || !b["structure"]["gridCheck"]["periodHint"].is_null()
    {
        return p;
    }
    let tb = points(&p["tempoB"]);
    let bx = n(&p, "bEntry");
    let va = points(&p["vocalA"]);
    let vb = points(&p["vocalB"]);
    let value = |deck: &str, name: &str, t: f64| {
        let old = arr(&p["automation"])
            .iter()
            .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
            .map(|l| points(&l["points"]))
            .unwrap_or(vec![[0., if name == "echo" { 0. } else { 1. }]]);
        point_value(&old, t)
    };
    let mut sources = nums(&b["sectionBoundaries"]);
    if let Some(v) = p["entrySelection"]["arrivalTime"].as_f64() {
        sources.push(v);
    }
    let mut candidates = Vec::new();
    let mut seen = Vec::new();
    for source in sources {
        if seen.contains(&source) {
            continue;
        }
        seen.push(source);
        let t = output_time_at(&tb, source - bx, d);
        if source > bx
            && t >= 3f64.max(d * 0.35)
            && t <= d * 0.85
            && nums(&ba["downbeats"])
                .iter()
                .any(|v| (*v - source).abs() < 0.035)
        {
            candidates.push((source, t));
            if candidates.len() == 16 {
                break;
            }
        }
    }
    for (source, arrival) in candidates {
        let speed = point_value(&tb, arrival);
        let beat = n(ba, "period") / speed;
        let start = r3((arrival - beat * 4.).max(0.));
        if arrival - start < 1.2 || arrival - start > 5. || start < 0.5 {
            continue;
        }
        let mut ts = vec![start, arrival];
        ts.extend(
            va.iter()
                .map(|p| p[0])
                .filter(|t| *t > start && *t < arrival),
        );
        if ts.iter().any(|t| point_value(&va, *t) > 0.001) {
            continue;
        }
        if !p["vocalB"].is_null() {
            let mut ts = vec![arrival, d];
            ts.extend(vb.iter().map(|p| p[0]).filter(|t| *t > arrival));
            if ts.iter().any(|t| point_value(&vb, *t) < 0.999) {
                continue;
            }
        }
        let from = bx + integrate_tempo(&tb, start);
        let to = bx + integrate_tempo(&tb, arrival - 0.04);
        let v = &b["vocalActivity"];
        let rate = n(v, "rate");
        let vals = nums(&v["values"]);
        if rate <= 0. || from < 0. || to <= from || (to * rate).ceil() > vals.len() as f64 {
            continue;
        }
        if vals[(from * rate).floor() as usize..(to * rate).ceil() as usize]
            .iter()
            .any(|x| !x.is_finite() || *x < 0. || *x > 0.28)
            || vocal_mean(b, from, to) > 0.12
        {
            continue;
        }
        let low_before = mean(
            b,
            "lowDb",
            n(b, "audibleStart").max(source - n(ba, "period") * 4.),
            source - 0.08,
            false,
        );
        let low_after = mean(
            b,
            "lowDb",
            source,
            n(b, "audibleEnd").min(source + n(ba, "period") * 4.),
            false,
        );
        let before = mean(
            b,
            "rmsDb",
            n(b, "audibleStart").max(source - n(ba, "period") * 4.),
            source - 0.08,
            false,
        );
        let after = mean(
            b,
            "rmsDb",
            source,
            n(b, "audibleEnd").min(source + n(ba, "period") * 4.),
            false,
        );
        let locked = !p["beatAlign"].is_null();
        if ![low_before, low_after, before, after]
            .iter()
            .all(|v| v.is_finite())
            || after - before < 2.
            || low_after - low_before < if locked { 3. } else { 9. }
            || after < n(b, "bodyRmsDb") - 5.
        {
            continue;
        }
        let end = r3(arrival);
        let cut = r3((start + 0.3).max(arrival - 0.12));
        let close = r3((start + 0.3).min(cut - 0.2));
        let prefix = |deck: &str, name: &str| {
            arr(&p["automation"])
                .iter()
                .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
                .map(|l| points(&l["points"]))
                .unwrap_or(vec![[0., value(deck, name, 0.)]])
                .into_iter()
                .filter(|p| p[0] < start)
                .collect::<Points>()
        };
        let mut lanes: Vec<Value> = arr(&p["automation"])
            .iter()
            .filter(|l| {
                !(s(l, "lane") == "echo" && s(l, "deck") == "A")
                    && !["gain", "low"].contains(&s(l, "lane"))
            })
            .cloned()
            .collect();
        let mut add = |deck: &str, name: &str, ps: Points| {
            lanes.push(json!({"deck":deck,"lane":name,"points":ps}))
        };
        let mut ps = prefix("A", "gain");
        ps.extend([
            [start, value("A", "gain", start)],
            [cut, value("A", "gain", cut)],
            [end, 0.],
            [d, 0.],
        ]);
        add("A", "gain", ps);
        let mut ps = prefix("B", "gain");
        ps.extend([[start, value("B", "gain", start)], [end, 1.], [d, 1.]]);
        add("B", "gain", ps);
        let mut ps = prefix("A", "low");
        ps.extend([
            [start, value("A", "low", start)],
            [r3(end - beat * 0.5), 0.],
            [d, 0.],
        ]);
        add("A", "low", ps);
        let mut ps = prefix("B", "low");
        ps.extend([
            [start, value("B", "low", start)],
            [close, 0.],
            [r3(end - 0.06), 0.],
            [r3(end + 0.04), 1.],
            [d, 1.],
        ]);
        add("B", "low", ps);
        add(
            "A",
            "filter",
            vec![[0., 0.], [start, 0.], [cut, 0.68], [d, 0.68]],
        );
        add(
            "B",
            "filter",
            vec![
                [0., 0.],
                [start, 0.],
                [close, -0.55],
                [r3(end - 0.22), -0.55],
                [r3(end - 0.04), 0.],
                [d, 0.],
            ],
        );
        add(
            "A",
            "echo",
            vec![
                [0., 0.],
                [r3(start.max(end - beat)), 0.],
                [r3((start + 0.04).max(end - beat + 0.06)), 0.18],
                [cut, 0.18],
                [end, 0.],
                [d, 0.],
            ],
        );
        let mut delay = beat;
        while delay < 0.3 {
            delay *= 2.;
        }
        while delay > 0.8 {
            delay /= 2.;
        }
        p["automation"] = json!(lanes);
        p["echo"] = json!({"delay":r3(delay),"feedback":0.22});
        p["reasons"].as_array_mut().unwrap().push(json!("подводка к измеренному вступлению: фильтры создают напряжение, бас открывается на сильной доле, инструментал уходящего трека остаётся коротким эхом"));
        p["debug"]["djFilterRelease"] = json!({"policy":"filter-release-1","from":start,"arrival":end,"sourceB":source,"bassRiseDb":r3(low_after-low_before),"energyRiseDb":r3(after-before),"locked":locked,"echoDelay":r3(delay)});
        return p;
    }
    p
}
pub fn instrumental_loop(
    mut p: Value,
    a: &Value,
    b: &Value,
    s0: &Value,
    requested: Option<f64>,
) -> Value {
    let g = &a["beat"];
    let v = &a["vocalActivity"];
    let arrival = p["entrySelection"]["arrivalTime"].as_f64();
    let d = n(&p, "duration");
    if a.is_null()
        || b.is_null()
        || g.is_null()
        || v["vocalRmsDb"].is_null()
        || v["accompanimentRmsDb"].is_null()
        || opt(v, "rate", 0.) == 0.
        || requested.is_some()
        || s0["enabled"] != true
        || s0["eqHandoff"] != true
        || s0["loopBridges"] == false
        || s0["stemMixing"] == false
        || s(s0, "style") == "tight"
        || p["debug"]["processingAllowed"] == false
        || s(&p, "method") != "crossfade"
        || d < 4.
        || d > 24.
        || !p["voiceEcho"].is_null()
        || !p["echo"].is_null()
        || points(&p["tempoA"])
            .iter()
            .chain(points(&p["tempoB"]).iter())
            .any(|p| (p[1] - 1.).abs() > 0.0001)
        || g["stable"] != true
        || n(g, "confidence") < 0.8
        || n(g, "downbeatConfidence") < 0.75
        || n(g, "jitterMs") > 12.
        || !a["structure"]["gridCheck"]["periodHint"].is_null()
        || arrival.is_none()
    {
        return p;
    }
    let ax = n(&p, "aExit");
    let until = ax + d;
    let arrival = arrival.unwrap();
    if until > n(a, "audibleEnd") + 0.001
        || until > n(a, "duration")
        || arrival - n(&p, "bEntry") < d * 0.4
        || arrival - n(&p, "bEntry") > d
    {
        return p;
    }
    let down = nums(&g["downbeats"]);
    let Some(index) = down
        .iter()
        .position(|t| *t >= ax && *t <= ax + 1.5f64.min(d / 4.))
    else {
        return p;
    };
    let start = down[index];
    let crossfade = 0.006;
    let rate = n(v, "rate");
    let lo = ((ax - crossfade) * rate).floor().max(0.) as usize;
    let hi = (n(a, "audibleEnd") * rate).ceil().max(0.) as usize;
    let voice = nums(&v["vocalRmsDb"]);
    let bed = nums(&v["accompanimentRmsDb"]);
    if hi > voice.len() || hi > bed.len() {
        return p;
    }
    for i in lo..hi {
        if !voice[i].is_finite()
            || !bed[i].is_finite()
            || voice[i] + n(&p, "gainA") > -42.
            || voice[i] > bed[i] - 25.
        {
            return p;
        }
    }
    for bars in [1usize, 2] {
        let Some(end) = down.get(index + bars).copied() else {
            continue;
        };
        let length = end - start;
        if !end.is_finite()
            || length < 1.2
            || length > 8.
            || (length - n(g, "period") * 4. * bars as f64).abs() > 0.015
            || until - start < length * 1.4
            || until - start > length * 3.5
            || start < crossfade
        {
            continue;
        }
        let level = mean(a, "rmsDb", start, end, true);
        let tail = mean(a, "rmsDb", end.max(until - 1.), until, true);
        if !level.is_finite()
            || !tail.is_finite()
            || level < n(a, "bodyRmsDb") - 5.
            || level - tail < 5.
            || (mean(a, "rmsDb", start, start + length / 2., true)
                - mean(a, "rmsDb", start + length / 2., end, true))
            .abs()
                > 2.
        {
            continue;
        }
        let roll = s0["djPhrasing"] != false
            && s(s0, "style") == "auto"
            && length >= 1.6
            && until - start >= length * 1.875;
        let mut loop_a = json!({"start":start,"end":end,"until":until,"crossfade":crossfade});
        if roll {
            loop_a["roll"] =
                json!([{"at":end,"length":length/2.},{"at":end+length/2.,"length":length/4.}]);
        }
        p["id"] = json!(format!("{}_loop", p["id"].as_str().unwrap_or("undefined")));
        p["loopA"] = loop_a;
        p["reasons"].as_array_mut().unwrap().push(json!("инструментальный такт удерживает пульс затухающего финала до прихода следующей музыкальной части; уровень вокала проверен по отделённой партии"));
        p["debug"]["loopBridge"] = json!({"bars":bars,"cycles":(until-start)/length,"originalDropDb":level-tail,"measuredVoice":true,"roll":roll});
        return p;
    }
    p
}
pub fn voice_answer(
    mut p: Value,
    a: &Value,
    b: &Value,
    s0: &Value,
    requested: Option<f64>,
) -> Value {
    let d = n(&p, "duration");
    if s0["enabled"] != true
        || s0["djPhrasing"] == false
        || s0["stemMixing"] == false
        || s0["eqHandoff"] != true
        || requested.is_some()
        || a.is_null()
        || b.is_null()
        || p["debug"]["processingAllowed"] == false
        || !p["loopA"].is_null()
        || !p["tapeStopA"].is_null()
        || !p["echo"].is_null()
        || p["vocalA"].is_null()
        || p["vocalB"].is_null()
        || d < 4.
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
    {
        return p;
    }
    let va = points(&p["vocalA"]);
    let vb = points(&p["vocalB"]);
    let Some(end) = va.iter().find(|p| p[0] > 0. && p[1] <= 0.001).map(|p| p[0]) else {
        return p;
    };
    let ta = points(&p["tempoA"]);
    let tb = points(&p["tempoB"]);
    let bx = n(&p, "bEntry");
    let Some(first) = first_voice(b, bx, bx + integrate_tempo(&tb, d)).filter(|v| v.is_finite())
    else {
        return p;
    };
    if end < 0.5 {
        return p;
    }
    let attack = output_time_at(&tb, first - bx, d);
    let clear = attack - 0.15;
    let mut delay = a["beat"]["period"].as_f64().unwrap_or(0.5) / point_value(&ta, end);
    if !delay.is_finite() || delay <= 0. {
        return p;
    }
    while delay < 0.3 {
        delay *= 2.;
    }
    while delay > 0.8 {
        delay /= 2.;
    }
    if clear - end < delay * 2. || point_value(&vb, attack) < 0.999 {
        return p;
    }
    let ax = n(&p, "aExit");
    if first_voice(
        a,
        ax + integrate_tempo(&ta, (end - 0.5).max(0.)),
        ax + integrate_tempo(&ta, end),
    )
    .filter(|v| v.is_finite())
    .is_none()
    {
        return p;
    }
    let from = (end - delay.min(0.5)).max(0.);
    p["voiceEcho"] = json!({"delay":delay,"feedback":0.22,"clearAt":clear});
    let mut lanes: Vec<Value> = arr(&p["automation"])
        .iter()
        .filter(|l| s(l, "lane") != "voiceEcho")
        .cloned()
        .collect();
    lanes.push(json!({"deck":"A","lane":"voiceEcho","points":[[0.,0.],[from,0.],[end.min(from+0.04),0.2],[end,0.2],[end+0.03,0.],[d,0.]]}));
    p["automation"] = json!(lanes);
    p["reasons"].as_array_mut().unwrap().push(json!(
        "вокальное эхо отвечает в измеренной паузе и полностью закрывается перед новой фразой"
    ));
    p["debug"]["voiceAnswer"] = json!({"policy":"measured-gap-1","from":from,"end":end,"clearAt":clear,"attack":attack,"delay":delay});
    p
}
