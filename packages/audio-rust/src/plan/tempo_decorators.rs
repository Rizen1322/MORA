use super::{
    common::*,
    fullmix::{lane_value, voice_unknown},
    voice_measure::{first_voice, vocal_mean},
};
use serde_json::{Value, json};

fn reason(p: &mut Value, text: Value) {
    p["reasons"].as_array_mut().unwrap().push(text);
}
fn covered(an: &Value, from: f64, to: f64) -> bool {
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    let values = arr(&v["values"]);
    !v.is_null()
        && rate.is_finite()
        && rate > 0.
        && from >= 0.
        && to > from
        && to * rate <= values.len() as f64
        && values[(from * rate).floor() as usize..(to * rate).ceil() as usize]
            .iter()
            .all(|x| num(x).is_finite() && (0. ..=1.).contains(&num(x)))
}
pub fn master_tempo(
    mut p: Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
) -> Value {
    if settings["enabled"] != true
        || settings["masterTempo"] == false
        || settings["stemMixing"] == false
        || requested.is_some()
        || a.is_null()
        || b.is_null()
        || p["debug"]["processingAllowed"] == false
        || s(&p, "method") != "beatmatch_blend"
        || arr(&p["tempoA"]).is_empty()
        || p["beatAlign"].is_null()
        || n(&p, "duration") < 6.
        || ["loopA", "vocalA", "vocalB", "voiceEcho"]
            .iter()
            .any(|k| !p[k].is_null())
        || !p["beatAlign"]["bridge"].is_null()
        || !p["beatAlign"]["regions"].is_null()
        || a["beat"]["stable"] != true
        || b["beat"]["stable"] != true
        || n(&a["beat"], "confidence") < 0.8
        || n(&b["beat"], "confidence") < 0.8
        || n(&a["beat"], "jitterMs") > 12.
        || n(&b["beat"], "jitterMs") > 12.
        || !a["structure"]["gridCheck"]["periodHint"].is_null()
        || !b["structure"]["gridCheck"]["periodHint"].is_null()
    {
        return p;
    }
    let pa = points(&p["tempoA"]);
    let pb = points(&p["tempoB"]);
    let ratio = point_value(&pb, 0.) / point_value(&pa, 0.);
    let stretch = (ratio - 1.).abs().max((1. / ratio - 1.).abs()) * 100.;
    if !ratio.is_finite()
        || stretch < 0.2
        || stretch > 3f64.min(n(settings, "maxStretchPercent")) + 1e-6
    {
        return p;
    }
    for point in pa.iter().chain(&pb) {
        let t = point[0];
        if t > n(&p, "duration") || (point_value(&pb, t) / point_value(&pa, t) - ratio).abs() > 2e-6
        {
            return p;
        }
    }
    let a_exit = n(&p, "aExit");
    let b_entry = n(&p, "bEntry");
    let old_duration = n(&p, "duration");
    let a_end = a_exit + integrate_tempo(&pa, old_duration);
    let b_end = b_entry + integrate_tempo(&pb, old_duration);
    let voice_end = a_exit + (a_end - a_exit) * 0.6;
    let intro_end = b_entry + 3f64.min((b_end - b_entry) * 0.3);
    if !covered(a, a_exit, voice_end)
        || vocal_mean(a, a_exit, voice_end) < 0.5
        || !covered(b, b_entry, intro_end)
        || vocal_mean(b, b_entry, intro_end) > 0.2
    {
        return p;
    }
    let duration = r3(a_end - a_exit);
    if duration > n(settings, "maxBlendSeconds") || duration <= 0. {
        return p;
    }
    let recovery = r3(4f64.max(8f64.min(n(&a["beat"], "period") * 8.)));
    if b_end + recovery * ratio.max(1.) + 2. > n(b, "audibleEnd") {
        return p;
    }
    let time = |t: f64| r3(integrate_tempo(&pa, t));
    let mut tempo_b = vec![[0., ratio], [duration, ratio]];
    for i in 1..=12 {
        let x = i as f64 / 12.;
        tempo_b.push([
            r3(duration + recovery * x),
            if i == 12 {
                1.
            } else {
                ratio + (1. - ratio) * smoothstep(x)
            },
        ]);
    }
    if !p["echo"].is_null() {
        let mut delay = n(&a["beat"], "period");
        while delay < 0.3 {
            delay *= 2.;
        }
        while delay > 0.8 {
            delay /= 2.;
        }
        p["echo"]["delay"] = json!(r3(delay));
    }
    p["duration"] = json!(duration);
    p["swapAt"] = json!(time(n(&p, "swapAt")));
    p.as_object_mut().unwrap().remove("tempoA");
    p["tempoB"] = json!(tempo_b);
    for l in p["automation"].as_array_mut().unwrap() {
        l["points"] = json!(
            points(&l["points"])
                .iter()
                .map(|[t, g]| [time(*t), *g])
                .collect::<Vec<_>>()
        );
    }
    p["beatAlign"]["glide"] = json!(false);
    p["beatAlign"]["masterDeck"] = json!("A");
    p["beatAlign"]["recoverySeconds"] = json!(recovery);
    p["reasons"].as_array_mut().unwrap().retain(|r| {
        !r.as_str()
            .unwrap_or("")
            .starts_with("общий темп плавно переходит")
    });
    reason(
        &mut p,
        json!(format!(
            "темп текущего вокала сохраняется: следующий трек подстраивается, затем за {} с возвращается к своему темпу",
            crate::js_json::stringify(&json!(recovery))
        )),
    );
    if let Some(hold) = p["debug"]["holdUntil"].as_f64() {
        p["debug"]["holdUntil"] = json!(time(hold));
    }
    p["debug"]["masterTempo"] = json!({"policy":"vocal-master-1","deck":"A","ratio":ratio,"recoverySeconds":recovery,"previousDuration":old_duration});
    p
}
fn trusted(beat: &Value) -> bool {
    !beat.is_null()
        && beat["stable"] == true
        && n(beat, "confidence") >= 0.85
        && n(beat, "jitterMs") <= 8.
        && n(beat, "downbeatConfidence") >= 0.7
        && beat["attacks"]["version"] == "lf-attack-1"
        && arr(&beat["attacks"]["offsetsMs"]).len() == arr(&beat["beats"]).len()
        && arr(&beat["attacks"]["strength"]).len() == arr(&beat["beats"]).len()
}
pub fn micro_onset(
    mut p: Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
) -> Value {
    if settings["enabled"] != true
        || requested.is_some()
        || p["debug"]["requested"] == true
        || p["debug"]["processingAllowed"] == false
        || !p["debug"]["microOnset"].is_null()
        || !p["debug"]["firstWords"].is_null()
        || s(&p, "method") != "beatmatch_blend"
        || p["beatAlign"].is_null()
        || !p["beatAlign"]["regions"].is_null()
        || ["loopA", "tapeStopA", "voiceEcho"]
            .iter()
            .any(|k| !p[k].is_null())
        || n(&p, "duration") < 3.
        || a.is_null()
        || b.is_null()
        || !trusted(&a["beat"])
        || !trusted(&b["beat"])
        || !a["structure"]["gridCheck"]["periodHint"].is_null()
        || !b["structure"]["gridCheck"]["periodHint"].is_null()
    {
        return p;
    }
    let full = voice_unknown(a, settings) || voice_unknown(b, settings);
    for (an, cue) in [(a, n(&p, "aExit")), (b, n(&p, "bEntry"))] {
        let voice = if cue < n(an, "audibleStart") + 0.025 {
            Some(0.)
        } else {
            first_voice(an, cue - 0.025, cue + 0.18)
        };
        if voice != Some(f64::INFINITY) && !(full && voice.is_none()) {
            return p;
        }
    }
    let ga = &a["beat"];
    let gb = &b["beat"];
    let beats_b = nums(&gb["beats"]);
    let mut shifts = Vec::new();
    let until = n(&p, "duration").min(6.);
    let mut previous = -1i64;
    let pa = points(&p["tempoA"]);
    let pb = points(&p["tempoB"]);
    for (i, ta) in nums(&ga["beats"]).into_iter().enumerate() {
        if shifts.len() >= 8 {
            break;
        }
        if ta < n(&p, "aExit") - 0.001 {
            continue;
        }
        if ta > n(&p, "aExit") + integrate_tempo(&pa, until) {
            break;
        }
        let t = output_time_at(&pa, ta - n(&p, "aExit"), until);
        let predicted = n(&p, "bEntry") + integrate_tempo(&pb, t);
        let mut j = None;
        let mut distance = 0.018;
        for k in (previous + 1).max(0) as usize..beats_b.len() {
            let d = (beats_b[k] - predicted).abs();
            if d < distance {
                distance = d;
                j = Some(k);
            }
            if beats_b[k] > predicted + 0.018 {
                break;
            }
        }
        let Some(j) = j else {
            continue;
        };
        let oa = num(&ga["attacks"]["offsetsMs"][i]);
        let ob = num(&gb["attacks"]["offsetsMs"][j]);
        let sa = num(&ga["attacks"]["strength"][i]);
        let sb = num(&gb["attacks"]["strength"][j]);
        if !oa.is_finite()
            || !ob.is_finite()
            || oa.abs() > 25.
            || ob.abs() > 25.
            || !sa.is_finite()
            || !sb.is_finite()
            || !(0.7..=1.).contains(&sa)
            || !(0.7..=1.).contains(&sb)
        {
            continue;
        }
        previous = j as i64;
        let ra = point_value(&pa, t);
        let rb = point_value(&pb, t);
        if !ra.is_finite()
            || !rb.is_finite()
            || !(0.8..=1.2).contains(&ra)
            || !(0.8..=1.2).contains(&rb)
        {
            return p;
        }
        shifts.push(beats_b[j] - predicted + ob / 1000. - oa / 1000. * rb / ra);
    }
    if shifts.len() < if full { 6 } else { 4 } {
        return p;
    }
    let mut sorted = shifts.clone();
    sorted.sort_by(f64::total_cmp);
    let i = sorted.len() / 2;
    let shift = if sorted.len() % 2 == 1 {
        sorted[i]
    } else {
        (sorted[i - 1] + sorted[i]) / 2.
    };
    let residual = shifts.iter().map(|x| (x - shift).abs()).fold(0., f64::max);
    if shift.abs() < 0.002 || shift.abs() > 0.015 || residual > if full { 0.002 } else { 0.003 } {
        return p;
    }
    let entry = round((n(&p, "bEntry") + shift) * 1e6) / 1e6;
    if entry < n(b, "audibleStart")
        || entry + integrate_tempo(&pb, n(&p, "duration")) > n(b, "audibleEnd")
    {
        return p;
    }
    p["id"] = json!(format!("{}_onset_{}", s(&p, "id"), round(shift * 1e6)));
    p["bEntry"] = json!(entry);
    if !p["entrySelection"].is_null() {
        p["entrySelection"]["skippedSeconds"] =
            json!((n(&p["entrySelection"], "skippedSeconds") + shift).max(0.));
    }
    reason(
        &mut p,
        json!(format!(
            "атаки бочки уточнены по {} измеренным долям: {} мс",
            shifts.len(),
            round(shift * 1000.)
        )),
    );
    p["debug"]["microOnset"] = json!({"policy":if full {"lf-attack-fullmix-1"}else{"lf-attack-1"},"shiftMs":round(shift*1e6)/1000.,"pairs":shifts.len(),"residualMs":round(residual*1e6)/1000.});
    p
}
pub fn harmonic_handoff(
    mut p: Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
) -> Value {
    if settings["enabled"] != true
        || settings["eqHandoff"] != true
        || settings["djPhrasing"] == false
        || requested.is_some()
        || a.is_null()
        || b.is_null()
        || !p["loopA"].is_null()
        || p["debug"]["processingAllowed"] == false
        || n(&p, "duration") < 3.
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || !(n(&a["key"], "confidence") >= 0.75)
        || !(n(&b["key"], "confidence") >= 0.75)
        || p["keyInfo"].is_null()
        || n(&p["keyInfo"], "compatibility") >= 0.3
    {
        return p;
    }
    let Some(index) = arr(&p["automation"])
        .iter()
        .position(|l| s(l, "deck") == "A" && s(l, "lane") == "mid")
    else {
        return p;
    };
    let mut times: Vec<f64> = points(&p["automation"][index]["points"])
        .iter()
        .map(|p| p[0])
        .chain((0..=16).map(|i| n(&p, "duration") * i as f64 / 16.))
        .collect();
    times.sort_by(f64::total_cmp);
    times.dedup();
    let mut out = Vec::new();
    for t in times {
        let sa = n(&p, "aExit") + integrate_tempo(&points(&p["tempoA"]), t);
        let sb = n(&p, "bEntry") + integrate_tempo(&points(&p["tempoB"]), t);
        let read = |an: &Value, key: &str, time: f64| {
            let i = (time * n(&an["curves"], "rate")).floor();
            if i < 0. {
                f64::NAN
            } else {
                num(&an["curves"][key][i as usize])
            }
        };
        let (x, y, m) = (
            read(a, "rmsDb", sa),
            read(b, "rmsDb", sb),
            read(a, "midDb", sa),
        );
        if ![x, y, m].iter().all(|v| v.is_finite()) {
            return p;
        }
        let ag = lane_value(&p, "A", "gain", t);
        let bg = lane_value(&p, "B", "gain", t);
        let old = lane_value(&p, "A", "mid", t);
        let total = 10f64.powf((x + n(&p, "gainA")) / 10.) * ag * ag
            + 10f64.powf((y + n(&p, "gainB")) / 10.) * bg * bg;
        let mid = 10f64.powf((m + n(&p, "gainA")) / 10.) * ag * ag;
        let budget = total * (1. - 10f64.powf(-1. / 10.));
        let floor = if mid > 0. {
            (old * old - budget / mid).max(0.).sqrt()
        } else {
            old
        };
        let depth = (std::f64::consts::PI * t / n(&p, "duration")).sin().powi(2);
        out.push([
            t,
            old.min(
                floor
                    .max(old * 10f64.powf(-1. / 20.))
                    .max(old * (1. - 0.35 * depth)),
            ),
        ]);
    }
    p["automation"][index]["points"] = json!(out);
    reason(
        &mut p,
        json!("конфликтующие тональные середины расходятся мягче; бас и новый голос сохраняются"),
    );
    p["debug"]["harmonicHandoff"] =
        json!({"policy":"measured-mid-1","maxAdditionalMidAttenuationDb":1});
    p
}
pub fn tape_stop(
    mut p: Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
) -> Value {
    if settings["enabled"] != true
        || settings["eqHandoff"] != true
        || settings["loopBridges"] == false
        || settings["djPhrasing"] == false
        || s(settings, "style") != "auto"
        || requested.is_some()
        || a.is_null()
        || b.is_null()
        || p["debug"]["processingAllowed"] == false
        || !p["debug"]["firstWords"].is_null()
        || s(&p, "method") != "crossfade"
        || n(&p, "duration") < 4.
        || n(&p, "duration") > 10.
        || ["loopA", "echo", "voiceEcho"]
            .iter()
            .any(|k| !p[k].is_null())
        || points(&p["tempoA"])
            .iter()
            .chain(&points(&p["tempoB"]))
            .any(|p| (p[1] - 1.).abs() > 0.00001)
        || a["beat"]["stable"] != true
        || b["beat"]["stable"] != true
        || n(&a["beat"], "confidence") < 0.85
        || n(&b["beat"], "confidence") < 0.85
        || n(&a["beat"], "jitterMs") > 8.
        || n(&b["beat"], "jitterMs") > 8.
        || (n(&a["beat"], "bpm") / n(&b["beat"], "bpm") - 1.).abs() < 0.15
    {
        return p;
    }
    let Some(start) = nums(&a["beat"]["downbeats"]).into_iter().find(|t| {
        *t >= n(&p, "aExit") + 0.5 && *t <= n(&p, "aExit") + 2f64.min(n(&p, "duration") * 0.4)
    }) else {
        return p;
    };
    let v = &a["vocalActivity"];
    let end = start + 0.3f64.max(0.9f64.min(n(&a["beat"], "period") * 1.5));
    let rate = n(v, "rate");
    if v["vocalRmsDb"].is_null()
        || v["accompanimentRmsDb"].is_null()
        || !(rate > 0.)
        || end > n(a, "audibleEnd") - 0.01
        || end > n(&p, "aExit") + n(&p, "duration")
    {
        return p;
    }
    let lo = ((start - 0.05) * rate).floor();
    let hi = (n(a, "audibleEnd") * rate).ceil() as usize;
    if lo < 0. || hi > arr(&v["vocalRmsDb"]).len() || hi > arr(&v["accompanimentRmsDb"]).len() {
        return p;
    }
    for i in lo as usize..hi {
        let x = num(&v["vocalRmsDb"][i]);
        let y = num(&v["accompanimentRmsDb"][i]);
        if !x.is_finite() || !y.is_finite() || x + n(&p, "gainA") > -42. || x > y - 25. {
            return p;
        }
    }
    let from = start - n(&p, "aExit");
    let until = end - n(&p, "aExit");
    let duration = n(&p, "duration");
    for name in ["gain", "low", "mid", "high", "filter"] {
        let lane = arr(&p["automation"])
            .iter()
            .find(|l| s(l, "deck") == "B" && s(l, "lane") == name);
        let pts = lane
            .map(|l| points(&l["points"]))
            .unwrap_or(vec![[0., if name == "filter" { 0. } else { 1. }]]);
        for t in [until, duration].into_iter().chain(
            pts.iter()
                .map(|p| p[0])
                .filter(|t| *t > until && *t < duration),
        ) {
            let x = point_value(&pts, t);
            if !x.is_finite()
                || if name == "filter" {
                    x.abs() > 0.001
                } else {
                    x < if name == "gain" { 0.95 } else { 0.9 }
                }
            {
                return p;
            }
        }
    }
    for l in p["automation"].as_array_mut().unwrap() {
        if s(l, "deck") == "A" && s(l, "lane") == "gain" {
            let pts = points(&l["points"]);
            let mut out: Points = pts.iter().copied().filter(|p| p[0] < from).collect();
            out.extend([[from, point_value(&pts, from)], [until, 0.], [duration, 0.]]);
            l["points"] = json!(out);
        }
    }
    p["tapeStopA"] = json!({"start":start,"end":end,"crossfade":0.025});
    reason(
        &mut p,
        json!("короткая остановка инструментального финала с понижением тона перед сменой темпа"),
    );
    p["debug"]["tapeStop"] = json!({"policy":"quiet-tail-1","start":start,"end":end});
    p
}
