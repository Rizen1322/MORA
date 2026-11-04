//! Explicit measured auditions. Kept out of ordinary automatic ranking.
use super::{common::*, primitives::normalization_gain};
use serde_json::{Value, json};

const CURVES: [&str; 5] = ["rmsDb", "lowDb", "midDb", "highDb", "midDensity"];
const STYLES: [(&str, &str, &str); 15] = [
    ("echo-pickup", "Эхо + затакт", "Сохранить затакт B под ограниченным эхом A и открыть первую сильную долю."),
    ("echo-adaptive", "Адаптивное эхо", "Подобрать атаку B по измеренным RMS и onset, сохранив начало записи."),
    ("natural-break", "Естественный брейк", "Передать музыку в измеренной паузе A без наложения ударных."),
    ("one-bar-breath", "Однотактное дыхание", "Оставить один такт ограниченного эха перед входом B."),
    ("half-time-handoff", "Полутемповая передача", "Передать бас на общей границе темпов 2:1 без растяжения."),
    ("percussion-exchange", "Обмен перкуссией", "Ввести верх B, освободить середину и затем передать бас."),
    ("bandpass-bridge", "Полосовой мост", "Сузить A до середины и раскрыть B снизу вверх."),
    ("two-stage-bass", "Двухступенчатый бас", "Сначала убрать низ A, затем в две доли ввести низ B."),
    ("dub-throw", "Короткий dub throw", "Один короткий посыл и два тихих повтора вместо длинного хвоста."),
    ("slowing-echo", "Замедляющееся эхо", "Увеличить интервал последних повторов перед более медленным B."),
    ("filter-arrival", "Фильтр к приходу энергии", "Раскрыть спектр B к измеренному подъёму его энергии."),
    ("single-loop", "Один повтор такта", "Повторить измеренный устойчивый такт A один раз, без roll."),
    ("tail-threshold", "Вход по затуханию", "Ввести B после измеренного падения хвоста A на 14 дБ."),
    ("short-brake", "Короткий тормоз", "Коротко остановить разреженную фразу A и мягко открыть B."),
    ("stereo-reveal", "Раскрытие стерео", "Слегка сузить A и раскрыть B после проверки реальных stereo-окон."),
];

fn mean(values: &Value, rate: f64, from: f64, to: f64, power: bool) -> f64 {
    let lo = (from * rate).floor();
    let hi = (to * rate).ceil();
    let Some(values) = values.as_array() else { return f64::NAN };
    if !rate.is_finite() || rate <= 0. || lo < 0. || hi <= lo || hi > values.len() as f64 {
        return f64::NAN;
    }
    let mut sum = 0.;
    for value in &values[lo as usize..hi as usize] {
        let x = num(value);
        if !x.is_finite() { return f64::NAN; }
        sum += if power { 10f64.powf(x / 10.) } else { x };
    }
    let avg = sum / (hi - lo);
    if power { 10. * avg.max(1e-12).log10() } else { avg }
}
fn measured(an: &Value, name: &str, from: f64, to: f64) -> f64 {
    mean(&an["curves"][name], n(&an["curves"], "rate"), from, to, name != "midDensity")
}
fn onset(an: &Value, from: f64, to: f64) -> f64 {
    mean(&an["local"]["transients"], n(&an["local"], "rate"), from, to, false)
}
fn voice_clear(an: &Value, from: f64, to: f64, limit: f64) -> bool {
    let v = &an["vocalActivity"];
    if v.is_null() { return true; }
    let value = mean(&v["values"], n(v, "rate"), from, to, false);
    value.is_finite() && value <= limit
}
fn valid_grid(an: &Value) -> bool {
    let g = &an["beat"];
    if g["stable"] != true || ["period", "bpm", "confidence", "downbeatConfidence", "jitterMs"].iter().any(|k| !n(g, k).is_finite())
        || n(g, "period") < 0.25 || n(g, "period") > 1.5 || (n(g, "bpm") * n(g, "period") - 60.).abs() > 0.6
        || n(g, "confidence") < 0.7 || n(g, "downbeatConfidence") < 0.65 || n(g, "jitterMs") > 25.
        || !an["structure"]["gridCheck"]["periodHint"].is_null() || arr(&g["downbeats"]).len() < 2 { return false; }
    arr(&g["downbeats"]).iter().enumerate().all(|(i, v)| {
        let t = num(v);
        t.is_finite() && t >= 0. && t <= n(an, "duration") && (i == 0 || t > num(&g["downbeats"][i - 1]))
    })
}
fn valid_analysis(track: &Value) -> bool {
    let a = &track["analysis"];
    track["mixingAllowed"] == true && !a.is_null()
        && [n(track, "duration"), n(a, "duration"), n(a, "audibleStart"), n(a, "audibleEnd"), n(a, "bodyRmsDb"), n(&a["curves"], "rate")].iter().all(|v| v.is_finite())
        && n(&a["curves"], "rate") > 0. && n(&a["curves"], "rate") <= 200.
        && n(a, "audibleStart") >= 0. && n(a, "audibleEnd") > n(a, "audibleStart")
        && n(a, "audibleEnd") <= n(track, "duration").min(n(a, "duration")) + 1e-6
        && CURVES.iter().all(|k| a["curves"][k].is_array() && arr(&a["curves"][k]).len() as f64 >= (n(a, "audibleEnd") * n(&a["curves"], "rate")).ceil())
}
fn stereo_safe(an: &Value, from: f64, to: f64) -> bool {
    let st = &an["stereo"];
    let rate = n(st, "rate");
    if !rate.is_finite() || rate <= 0. || !st["correlation"].is_array() || !st["sideToMidDb"].is_array() { return false; }
    let lo = (from.max(0.) * rate).floor() as usize;
    let hi = (to * rate).ceil() as usize;
    hi > lo && hi <= arr(&st["correlation"]).len() && hi <= arr(&st["sideToMidDb"]).len()
        && (lo..hi).all(|i| {
            let corr = num(&st["correlation"][i]);
            let side = num(&st["sideToMidDb"][i]);
            corr.is_finite() && side.is_finite() && corr >= 0.05 && corr <= 1. && side <= 0.
        })
}
fn smooth_points(knots: Points, end: f64) -> Points {
    let mut sorted: Points = knots.into_iter().map(|[t, v]| [r3(clamp(t, 0., end)), r3(v)]).collect();
    sorted.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Points = Vec::new();
    for p in sorted {
        if let Some(last) = out.last_mut().filter(|last| last[0] == p[0]) { *last = p; }
        else { out.push(p); }
    }
    if out[0][0] > 0. { out.insert(0, [0., out[0][1]]); }
    if out.last().unwrap()[0] < r3(end) { out.push([r3(end), out.last().unwrap()[1]]); }
    let mut smooth = vec![out[0]];
    for w in out.windows(2) {
        let ([a, x], [b, y]) = (w[0], w[1]);
        let count = if x == y { 1 } else { 8 };
        for j in 1..=count {
            let u = j as f64 / count as f64;
            let t = r3(a + (b - a) * u);
            let v = r3(x + (y - x) * u * u * (3. - 2. * u));
            if t == smooth.last().unwrap()[0] { smooth.last_mut().unwrap()[1] = v; }
            else { smooth.push([t, v]); }
        }
    }
    smooth
}
fn add(p: &mut Value, deck: &str, name: &str, mut knots: Points) {
    if deck == "B" && name == "gain" {
        let initial = knots[0][1];
        knots.retain(|p| p[0] > 0.012);
        knots.insert(0,[0.012,initial]); knots.insert(0,[0.,0.]);
    }
    let end = n(p, "duration") - if deck == "B" { n(p, "bDelay") } else { 0. };
    let lane = json!({"deck":deck,"lane":name,"points":smooth_points(knots,end)});
    let lanes = p["automation"].as_array_mut().unwrap();
    if let Some(old) = lanes.iter_mut().find(|l| s(l, "deck") == deck && s(l, "lane") == name) { *old = lane; }
    else { lanes.push(lane); }
}
fn fade_a(p: &mut Value, from: f64, to: f64) {
    let d = n(p, "duration");
    add(p, "A", "gain", vec![[0., 1.], [from, 1.], [to, 0.], [d, 0.]]);
}
fn open_b(p: &mut Value, time: f64, initial: f64) {
    let d = n(p, "duration") - n(p, "bDelay");
    add(p, "B", "gain", vec![[0., initial], [time, 1.], [d, 1.]]);
}
fn echo(p: &mut Value, pre: f64, beat: f64, feedback: f64, clear_at: f64, send: f64) {
    let d = n(p, "duration");
    p["method"] = json!("echo_out");
    p["echo"] = json!({"delay":r3(0.75*beat),"feedback":feedback,"clearAt":r3(d.min(clear_at))});
    add(p, "A", "echo", vec![[0., 0.], [(pre-beat).max(0.), 0.], [pre-0.4*beat, send], [pre, send], [pre+0.06, 0.], [d, 0.]]);
}
fn loop_difference(an: &Value, start: f64, bar: f64) -> f64 {
    let mut sum = 0.;
    for name in &CURVES[..4] { for i in 0..8 {
        let t = start + i as f64 * bar / 8.;
        let dt = (bar / 8.).min(0.1);
        let a = measured(an, name, t, t + dt);
        let b = measured(an, name, t + bar, t + bar + dt);
        if !a.is_finite() || !b.is_finite() { return f64::NAN; }
        sum += (a - b).abs();
    }}
    sum / 32.
}

pub fn plan(a: &Value, b: &Value, settings: &Value, style: &str) -> Value {
    let Some((_, name, description)) = STYLES.iter().find(|(id, _, _)| *id == style) else { return Value::Null };
    if settings["enabled"] != true || !valid_analysis(a) || !valid_analysis(b) || !n(settings, "maxBlendSeconds").is_finite() || n(settings, "maxBlendSeconds") <= 0. { return Value::Null; }
    let aa = &a["analysis"];
    let bb = &b["analysis"];
    if !valid_grid(aa) || !valid_grid(bb) { return Value::Null; }
    let ga = &aa["beat"];
    let gb = &bb["beat"];
    let (beat, beat_b) = (n(ga, "period"), n(gb, "period"));
    let (bar, bar_b) = (4.*beat, 4.*beat_b);
    let entry = n(bb, "audibleStart");
    let Some(first) = nums(&gb["downbeats"]).into_iter().find(|t| *t >= entry-0.002 && *t <= entry+bar_b+0.002) else { return Value::Null };
    let pickup = (first-entry).max(0.);
    let b_end = n(bb, "audibleEnd");
    let b_level = measured(bb, "rmsDb", entry, b_end.min(entry+beat_b));
    let b_density = measured(bb, "midDensity", entry, b_end.min(entry+bar_b));
    let b_onset = onset(bb, entry, b_end.min(entry+beat_b));
    if !b_level.is_finite() || !b_density.is_finite() { return Value::Null; }
    let native_lock = (beat/beat_b-1.).abs() <= 0.015;
    let (mut pre, mut delay, mut duration, mut arrival) = (bar, bar, bar+bar_b, 0.);
    match style {
        "echo-pickup" => {
            if pickup < 0.08 || pickup > bar-0.05 { return Value::Null; }
            delay = pre-pickup;
        },
        "echo-adaptive" => { if !b_onset.is_finite() { return Value::Null; } },
        "natural-break" => { pre = beat; delay = pre; duration = pre+bar_b; },
        "one-bar-breath" => { delay = pre+bar; duration = delay+bar_b; },
        "half-time-handoff" => {
            if (beat/beat_b-2.).abs().min((beat_b/beat-2.).abs()) > 0.03 { return Value::Null; }
            pre = 4.*beat.max(beat_b); delay = pre-pickup; duration = pre*2.;
        },
        "percussion-exchange" | "two-stage-bass" => {
            if !native_lock || pickup > bar-0.05 || settings["eqHandoff"] != true { return Value::Null; }
            delay = bar-pickup; pre = 2.*bar; duration = 3.*bar;
        },
        "bandpass-bridge" => {
            if settings["eqHandoff"] != true || b_density > 0.4 || !voice_clear(bb, entry, b_end.min(entry+bar_b), 0.25) { return Value::Null; }
        },
        "dub-throw" => { pre = 2.*beat; delay = pre; duration = pre+bar_b; },
        "slowing-echo" => {
            if n(gb,"bpm")/n(ga,"bpm") < 0.5 || n(gb,"bpm")/n(ga,"bpm") > 0.82 { return Value::Null; }
            delay = pre+beat_b; duration = delay+bar_b;
        },
        "filter-arrival" => {
            if settings["eqHandoff"] != true || b_density > 0.5 || !voice_clear(bb, entry, b_end.min(entry+bar_b), 0.25) { return Value::Null; }
            let initial = measured(bb,"rmsDb",entry,entry+beat_b);
            let initial_low = measured(bb,"lowDb",entry,entry+beat_b);
            let rise = nums(&gb["downbeats"]).into_iter().filter(|t| *t >= entry+beat_b && *t <= (b_end-beat_b).min(entry+4.*bar_b))
                .find(|t| measured(bb,"rmsDb",*t,*t+beat_b)-initial >= 5. && measured(bb,"lowDb",*t,*t+beat_b)-initial_low >= 4.);
            let Some(rise) = rise else { return Value::Null };
            arrival = rise-entry; pre = arrival; delay = 0.; duration = pre+bar_b;
        },
        "single-loop" => {
            if settings["loopBridges"] == false || n(ga,"confidence") < 0.85 || n(ga,"downbeatConfidence") < 0.8 || n(ga,"jitterMs") > 12. || bar > 8. || pickup > bar-0.05 { return Value::Null; }
            pre = 2.*bar; delay = pre-pickup; duration = pre+bar_b;
        },
        "short-brake" => { pre = beat; delay = pre+clamp(beat,0.25,0.65)-0.03; duration = delay+bar_b; },
        _ => {},
    }
    duration = r3(duration); delay = r3(delay); pre = r3(pre);
    if delay < 0. || duration > n(settings,"maxBlendSeconds").min(60.) || entry+duration-delay > b_end+1e-6 { return Value::Null; }
    let rhythmic = ["half-time-handoff","percussion-exchange","two-stage-bass"].contains(&style);
    let mut phase_drift = 0.;
    if rhythmic {
        let mismatch = if style == "half-time-handoff" { (beat.max(beat_b)/(2.*beat.min(beat_b))-1.).abs() } else { (beat/beat_b-1.).abs() };
        phase_drift = mismatch * if style == "half-time-handoff" { pre+2.*beat.min(beat_b)-delay } else { duration-delay };
        let swap_source = entry+pre-delay;
        let incoming_low = measured(bb,"lowDb",swap_source,swap_source+beat_b);
        let incoming_rms = measured(bb,"rmsDb",swap_source,swap_source+beat_b);
        let body_low = measured(bb,"lowDb",entry,b_end);
        if phase_drift > 0.02 || ![incoming_low,incoming_rms,body_low].iter().all(|v| v.is_finite())
            || incoming_low < body_low-6. || incoming_low < incoming_rms-14. || incoming_rms < n(bb,"bodyRmsDb")-8. { return Value::Null; }
        if style == "percussion-exchange" {
            let high = measured(bb,"highDb",entry,entry+bar_b);
            let body_high = measured(bb,"highDb",entry,b_end);
            if !high.is_finite() || !body_high.is_finite() || high < body_high-8. { return Value::Null; }
        }
    }
    let earliest = (n(aa,"audibleStart")+pre).max(n(aa,"audibleEnd")*0.55).max(n(aa,"audibleEnd")-40.);
    let latest = n(aa,"audibleEnd")-(duration-pre)-0.025;
    let mut handoffs: Vec<f64> = nums(&ga["downbeats"]).into_iter().filter(|t| *t >= earliest && *t <= latest).collect();
    if style == "tail-threshold" {
        handoffs.clear();
        let threshold = n(aa,"bodyRmsDb")-14.;
        let rate = n(&aa["curves"],"rate");
        let mut i = (earliest*rate).ceil();
        while i <= (latest*rate).floor() {
            let t = i/rate;
            if measured(aa,"rmsDb",t,t+beat*0.5) <= threshold && measured(aa,"rmsDb",t-beat*0.5,t) > threshold
                && measured(aa,"rmsDb",t-bar,t-bar+beat) > threshold+2. { handoffs.push(t); }
            i += 1.;
        }
    }
    let marked = |t: f64| (n(aa,"phraseConfidence") >= 0.5 && arr(&aa["phrases"]).iter().any(|p| (num(p)-t).abs() <= 0.06))
        || arr(&aa["sectionBoundaries"]).iter().any(|p| (num(p)-t).abs() <= 0.06);
    handoffs.sort_by(|x,y| marked(*y).cmp(&marked(*x)).then_with(|| y.total_cmp(x)));
    for handoff in handoffs {
        let exit = r3(handoff-pre);
        let end = exit+duration;
        let b_clock = r3(duration-delay);
        if exit < n(aa,"audibleStart") || end > n(aa,"audibleEnd") || exit < 0.025 { continue; }
        if CURVES.iter().any(|k| !measured(aa,k,exit,end).is_finite() || !measured(bb,k,entry,entry+b_clock).is_finite()) { continue; }
        let a_level = measured(aa,"rmsDb",exit.max(handoff-beat),handoff);
        if rhythmic && measured(aa,"lowDb",exit.max(handoff-beat),handoff) < a_level-14. { continue; }
        let a_density = measured(aa,"midDensity",exit,end.min(handoff+beat));
        let a_onset = onset(aa,exit,end.min(handoff+beat));
        let mut reasons = vec![(*description).to_string(), "Начало B сохранено с первого слышимого сэмпла; вариант предназначен для прослушивания.".to_string()];
        let mut measured_info = json!({"bpmA":r3(n(ga,"bpm")),"bpmB":r3(n(gb,"bpm")),"firstDownbeatB":r3(first),"pickupSeconds":r3(pickup),
            "outgoingRmsDb":r3(a_level),"incomingRmsDb":r3(b_level),"outgoingMidDensity":r3(a_density),"incomingMidDensity":r3(b_density),
            "phraseBoundary":marked(handoff),"vocalActivityKnown":!aa["vocalActivity"].is_null() && !bb["vocalActivity"].is_null()});
        if rhythmic { measured_info["phaseDriftMs"] = json!(r3(phase_drift*1000.)); }
        if a_onset.is_finite() { measured_info["outgoingOnset"] = json!(r3(a_onset)); }
        if b_onset.is_finite() { measured_info["incomingOnset"] = json!(r3(b_onset)); }
        let mut score = 0.65+if marked(handoff) { 0.08 } else { 0. };
        let mut attack = clamp(beat_b*0.35,0.06,0.3);
        let target = settings["loudnessTarget"].as_f64().filter(|t| t.is_finite());
        let gain_a = if n(&aa["loudness"],"truePeakDb").is_finite() { normalization_gain(aa,target) } else { 0. };
        let gain_b = if n(&bb["loudness"],"truePeakDb").is_finite() { normalization_gain(bb,target) } else { 0. };
        let mut p = json!({"id":"","version":VERSION,"fromTrackId":a["id"],"toTrackId":b["id"],"method":"crossfade","confidence":0,"reasons":[],
            "aExit":exit,"bEntry":r3(entry),"duration":duration,"gap":0,"swapAt":pre,"bDelay":delay,"tempoB":[[0,1]],"automation":[],"gainA":gain_a,"gainB":gain_b,
            "entrySelection":{"kind":"start","skippedSeconds":0,"arrivalTime":r3(first),"confidence":r3(n(gb,"downbeatConfidence"))},"debug":{}});
        fade_a(&mut p,pre-0.2*beat,pre+0.2*beat);
        open_b(&mut p,attack,0.);
        match style {
            "echo-pickup" => {
                if !voice_clear(aa,handoff-beat,handoff+0.2*beat,0.4) { continue; }
                echo(&mut p,pre,beat,0.55,pre+(2.*beat).min(bar_b),0.38);
                add(&mut p,"B","gain",vec![[0.,0.55],[0.025,0.65],[(pickup-0.05).max(0.026),0.7],[pickup+0.06,1.],[b_clock,1.]]);
                measured_info["pickupRetained"] = json!(true); score += 0.08;
            },
            "echo-adaptive" => {
                let load = clamp((b_level-n(bb,"bodyRmsDb")+8.)/12.,0.,1.)*0.6+clamp(b_onset,0.,1.)*0.4;
                attack = clamp(beat_b*(0.16+0.8*load),0.055,0.7);
                let voice = mean(&bb["vocalActivity"]["values"],n(&bb["vocalActivity"],"rate"),entry,entry+0.3f64.min(beat_b),false);
                if voice.is_finite() && voice > 0.3 { attack = attack.min(0.08); }
                echo(&mut p,pre,beat,0.48,pre+2.*beat,0.34); open_b(&mut p,attack,0.12);
                measured_info["attackSeconds"] = json!(r3(attack)); measured_info["attackLoad"] = json!(r3(load)); score += 0.04;
            },
            "natural-break" => {
                let after = measured(aa,"rmsDb",handoff,handoff+beat*0.75);
                let drop = a_level-after;
                if drop < 7. || after > n(aa,"bodyRmsDb")-9. { continue; }
                fade_a(&mut p,pre-0.025,pre+0.06); open_b(&mut p,clamp(beat_b*0.15,0.025,0.1),0.2);
                measured_info["breakDropDb"] = json!(r3(drop)); measured_info["breakRmsDb"] = json!(r3(after)); score += clamp(drop/60.,0.,0.18);
            },
            "one-bar-breath" => {
                if a_level < n(aa,"bodyRmsDb")-3. || !a_onset.is_finite() || a_onset < 0.3 || !voice_clear(aa,handoff-beat,handoff+0.1,0.2) { continue; }
                echo(&mut p,pre,beat,0.72,delay+0.5*beat_b,0.6); fade_a(&mut p,pre-0.08,pre+0.06); open_b(&mut p,0.15f64.min(0.25*beat_b),0.15);
                p["swapAt"] = json!(delay); measured_info["breathSeconds"] = json!(r3(bar)); score -= 0.06;
            },
            "half-time-handoff" => {
                p["method"] = json!("beatmatch_blend");
                add(&mut p,"A","low",vec![[0.,1.],[pre-0.3*beat.min(beat_b),1.],[pre,0.],[duration,0.]]);
                add(&mut p,"B","low",vec![[0.,0.],[pickup,0.],[pickup+0.5*beat.min(beat_b),1.],[b_clock,1.]]);
                fade_a(&mut p,pre,pre+2.*beat.min(beat_b)); open_b(&mut p,(pickup+0.05).max(0.08),0.5);
                measured_info["tempoRelation"] = json!(if n(ga,"bpm") > n(gb,"bpm") { 2. } else { 0.5 }); measured_info["nativeTempo"] = json!(true); score += 0.1;
            },
            "percussion-exchange" => {
                if a_density > 0.4 || b_density > 0.4 || !a_onset.is_finite() || !b_onset.is_finite() || a_onset < 0.25 || b_onset < 0.25
                    || !voice_clear(aa,exit,handoff+beat,0.25) || !voice_clear(bb,entry,entry+b_clock,0.25) { continue; }
                p["method"] = json!("beatmatch_blend");
                add(&mut p,"A","high",vec![[0.,1.],[delay,1.],[delay+beat,0.25],[duration,0.]]);
                add(&mut p,"A","mid",vec![[0.,1.],[delay,1.],[pre,0.2],[duration,0.]]);
                add(&mut p,"B","mid",vec![[0.,0.2],[pickup+beat,0.35],[pre-delay,0.7],[pre-delay+beat,1.]]);
                add(&mut p,"A","low",vec![[0.,1.],[pre-0.2*beat,1.],[pre+0.2*beat,0.]]);
                add(&mut p,"B","low",vec![[0.,0.],[pre-delay-0.2*beat,0.],[pre-delay+0.2*beat,1.]]);
                fade_a(&mut p,pre,duration); open_b(&mut p,pickup+bar,0.65); score += 0.08;
            },
            "bandpass-bridge" => {
                if a_density > 0.4 || !voice_clear(aa,exit,handoff+beat,0.25) { continue; }
                add(&mut p,"A","low",vec![[0.,1.],[pre-beat,0.2],[pre,0.]]);
                add(&mut p,"A","high",vec![[0.,1.],[pre-beat,0.2],[pre,0.]]);
                add(&mut p,"A","mid",vec![[0.,1.],[pre,0.6],[pre+beat,0.]]);
                add(&mut p,"B","mid",vec![[0.,0.25],[beat_b,0.65],[2.*beat_b,1.]]);
                add(&mut p,"B","high",vec![[0.,0.1],[2.*beat_b,0.4],[bar_b,1.]]);
                fade_a(&mut p,pre,pre+beat); open_b(&mut p,0.2f64.min(0.5*beat_b),0.25); score += 0.02;
            },
            "two-stage-bass" => {
                let low_a = measured(aa,"lowDb",handoff-beat,handoff);
                let low_b = measured(bb,"lowDb",entry,entry+bar_b);
                if low_a < a_level-12. || low_b < b_level-14. { continue; }
                p["method"] = json!("beatmatch_blend");
                add(&mut p,"A","low",vec![[0.,1.],[pre-beat,1.],[pre-0.5*beat,0.25],[pre-0.15*beat,0.]]);
                add(&mut p,"B","low",vec![[0.,0.],[pre-delay,0.],[pre-delay+beat_b,0.55],[pre-delay+2.*beat_b,1.]]);
                add(&mut p,"A","mid",vec![[0.,1.],[pre,0.65],[pre+beat,0.]]);
                add(&mut p,"B","mid",vec![[0.,0.45],[pre-delay,0.7],[pre-delay+beat_b,1.]]);
                fade_a(&mut p,pre,duration); open_b(&mut p,pickup+beat_b,0.6);
                measured_info["outgoingLowDb"] = json!(r3(low_a)); measured_info["incomingLowDb"] = json!(r3(low_b)); score += 0.06;
            },
            "dub-throw" => {
                if a_density > 0.45 || !a_onset.is_finite() || a_onset < 0.35 || !voice_clear(aa,handoff-beat,handoff+0.1,0.2) { continue; }
                echo(&mut p,pre,beat,0.25,pre+1.25*beat,0.6);
                add(&mut p,"A","echo",vec![[0.,0.],[pre-beat,0.],[pre-0.9*beat,0.6],[pre-0.65*beat,0.6],[pre-0.55*beat,0.],[duration,0.]]);
                fade_a(&mut p,pre-0.06,pre+0.04); open_b(&mut p,0.12f64.min(0.25*beat_b),0.25); score += 0.05;
            },
            "slowing-echo" => {
                if a_level < n(aa,"bodyRmsDb")-6. || !a_onset.is_finite() || a_onset < 0.25 || !voice_clear(aa,handoff-beat,handoff+0.1,0.25) { continue; }
                echo(&mut p,pre,beat,0.56,delay+beat_b,0.5);
                let slow_end = pre+(2.*beat).max(beat_b);
                p["echo"]["delayPoints"] = json!([[0.,r3(0.75*beat)],[pre,r3(0.75*beat)],[r3(slow_end),r3(beat_b)],[duration,r3(beat_b)]]);
                add(&mut p,"A","low",vec![[0.,1.],[pre,0.25],[pre+0.2*beat,0.]]);
                measured_info["finalEchoDelay"] = json!(r3(beat_b)); score += 0.04;
            },
            "filter-arrival" => {
                let rise = measured(bb,"rmsDb",entry+arrival,entry+arrival+beat_b)-b_level;
                add(&mut p,"B","filter",vec![[0.,-0.7],[arrival*0.5,-0.5],[arrival,0.]]);
                add(&mut p,"B","low",vec![[0.,0.25],[(arrival-beat_b).max(0.),0.25],[arrival,1.]]);
                add(&mut p,"A","filter",vec![[0.,0.],[(pre-beat).max(0.),0.],[pre+0.25*beat,0.7]]);
                fade_a(&mut p,(pre-beat).max(0.),pre+0.5*beat); open_b(&mut p,beat_b.min(arrival*0.5),0.65);
                p["entrySelection"]["arrivalTime"] = json!(r3(entry+arrival)); measured_info["energyRiseDb"] = json!(r3(rise)); measured_info["arrivalSeconds"] = json!(r3(arrival)); score += 0.08;
            },
            "single-loop" => {
                let difference = loop_difference(aa,exit,bar);
                let density = measured(aa,"midDensity",exit,exit+2.*bar);
                if !difference.is_finite() || difference > 3. || density > 0.23 || !a_onset.is_finite() || a_onset < 0.28 || !voice_clear(aa,exit-0.006,exit+2.*bar,0.12) { continue; }
                p["loopA"] = json!({"start":exit,"end":r3(exit+bar),"until":r3(exit+2.*bar),"crossfade":0.006});
                fade_a(&mut p,pre-0.2*beat,pre); open_b(&mut p,(pickup+0.04).max(0.06),0.65);
                reasons.push("Повторяется полный микс: сходство огибающих не доказывает отсутствие слов.".into());
                measured_info["loopDifferenceDb"] = json!(r3(difference)); measured_info["loopCycles"] = json!(2); score -= 0.03;
            },
            "tail-threshold" => {
                let tail = measured(aa,"rmsDb",handoff,handoff+0.5*beat);
                if tail > n(aa,"bodyRmsDb")-14. { continue; }
                fade_a(&mut p,pre,pre+beat); open_b(&mut p,0.15f64.min(0.25*beat_b),0.3);
                measured_info["thresholdDb"] = json!(r3(n(aa,"bodyRmsDb")-14.)); measured_info["tailRmsDb"] = json!(r3(tail)); score += 0.1;
            },
            "short-brake" => {
                let brake = clamp(beat,0.25,0.65);
                let stop_end = handoff+brake;
                if a_density > 0.25 || !a_onset.is_finite() || a_onset > 0.25 || a_level > n(aa,"bodyRmsDb")-3. || a_level < n(aa,"bodyRmsDb")-20.
                    || !voice_clear(aa,handoff-0.025,stop_end,0.12) { continue; }
                p["method"] = json!("drop_mix"); p["tapeStopA"] = json!({"start":r3(handoff),"end":r3(stop_end),"crossfade":0.025});
                fade_a(&mut p,pre+brake-0.025,pre+brake);
                attack = if b_onset.is_finite() { clamp(0.05+b_onset*0.08,0.05,0.13) } else { 0.08 };
                open_b(&mut p,attack,0.72); p["swapAt"] = json!(delay);
                measured_info["brakeSeconds"] = json!(r3(brake)); measured_info["attackSeconds"] = json!(r3(attack)); score -= 0.02;
            },
            "stereo-reveal" => {
                if !stereo_safe(aa,exit-0.025,end) || !stereo_safe(bb,entry,entry+b_clock) { continue; }
                add(&mut p,"A","width",vec![[0.,1.],[pre-beat,0.8],[pre,0.65],[duration,0.65]]);
                add(&mut p,"B","width",vec![[0.,0.6],[beat_b,0.75],[bar_b,1.]]);
                fade_a(&mut p,pre-0.5*beat,pre+beat); open_b(&mut p,0.18f64.min(0.35*beat_b),0.3);
                measured_info["stereoWindowsChecked"] = json!(true); measured_info["minimumCorrelation"] = json!(0.05); score += 0.04;
            },
            _ => {},
        }
        p["confidence"] = json!(r3(clamp(score,0.,1.)));
        p["reasons"] = json!(reasons);
        let mut limits = vec!["requires-listening"];
        if aa["vocalActivity"].is_null() || bb["vocalActivity"].is_null() { limits.push("vocal-overlap-unknown"); }
        p["debug"] = json!({"processingAllowed":true,"creative":{"style":style,"name":name,"score":p["confidence"],"reasons":reasons,"experimental":true,"limits":limits,"measured":measured_info}});
        let key = [s(a,"id").to_string(),s(b,"id").to_string(),style.to_string(),js_stringify(&p["aExit"]),js_stringify(&p["bEntry"]),js_stringify(&p["duration"]),js_stringify(&p["gainA"]),js_stringify(&p["gainB"])].join("|");
        p["id"] = json!(format!("creative_{}",fnv1a(&format!("creative-1|{key}"))));
        return p;
    }
    Value::Null
}
