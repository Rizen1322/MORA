use super::{common::*, vocal_handoff::*, voice_measure::*};
use serde_json::{Value, json};
use std::f64::consts::PI;
pub fn preserve_first_words(mut p: Value, a: &Value, b: &Value, s0: &Value) -> Value {
    let d = n(&p, "duration");
    if s0["enabled"] != true
        || s0["stemMixing"] == false
        || b.is_null()
        || p["debug"]["processingAllowed"] == false
        || p["debug"]["requested"] == true
        || d < 0.7
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || !p["loopA"].is_null()
    {
        return p;
    }
    let ta = points(&p["tempoA"]);
    let tb = points(&p["tempoB"]);
    let ax = n(&p, "aExit");
    let bx = n(&p, "bEntry");
    let Some(first) = first_voice(b, bx, bx + integrate_tempo(&tb, d)).filter(|v| v.is_finite())
    else {
        return p;
    };
    let attack = r3(if first <= bx {
        0.
    } else {
        output_time_at(&tb, first - bx, d)
    });
    let at = |deck: &str, name: &str, t: f64| point_value(&lane_points(&p, deck, name), t);
    let vb = if p["vocalB"].is_null() {
        vec![[0., 1.]]
    } else {
        points(&p["vocalB"])
    };
    if point_value(&vb, attack) >= 0.999
        && at("B", "gain", attack) >= 0.999
        && at("B", "mid", attack) >= 0.5
        && at("B", "high", attack) >= 0.5
        && at("B", "filter", attack).abs() < 0.001
    {
        return p;
    }
    let deadline = r3((attack - 0.035).max(0.));
    let src = |t| ax + integrate_tempo(&ta, t);
    let sp = spans(a);
    let mut quiet = -1.;
    if !a.is_null()
        && deadline >= 0.1
        && first_voice(a, src(0.), src(d.min(deadline + 0.08))).is_some()
    {
        let mut t = deadline;
        while t >= 0.1f64.max(deadline - 2.) {
            let lo = src((t - 0.08).max(0.));
            let hi = src(t + 0.035);
            if vocal_mean(a, lo, hi) <= 0.12 && !sp.iter().any(|[a, b]| hi > *a && lo < *b) {
                quiet = r3(t);
                break;
            }
            t -= 0.02;
        }
    }
    let old_end = p["debug"]["stems"]["vocalHandoff"].as_f64().unwrap_or(d);
    let later = if a.is_null() {
        None
    } else {
        first_voice(a, src(deadline.min(d - 0.001)), src(d))
    };
    let already_quiet = (!p["vocalA"].is_null() && old_end <= deadline)
        || (!a.is_null() && first_voice(a, src(0.), src(d)) == Some(f64::INFINITY));
    let activity = &a["vocalActivity"];
    let bed = nums(&activity["accompanimentRmsDb"]);
    let bed_from = (src(0.) * n(activity, "rate")).floor().max(0.) as usize;
    let bed_to = (src(d.min(4.)) * n(activity, "rate")).ceil().max(0.) as usize;
    let early = s0["eqHandoff"] == true
        && !p["vocalA"].is_null()
        && s(activity, "source") == "demucs"
        && !a.is_null()
        && first_voice(a, src(0.), src(d)).is_some()
        && !activity["accompanimentRmsDb"].is_null()
        && bed_to > bed_from
        && bed_to <= bed.len()
        && bed[bed_from..bed_to]
            .iter()
            .all(|x| x.is_finite() && *x >= -42. && *x <= 60.);
    let whole = !early && (later != Some(f64::INFINITY) || !already_quiet && quiet < 0.);
    let immediate = attack <= 0.012;
    let end = r3(if early {
        if quiet >= 0. {
            quiet
        } else {
            0.04f64.max(deadline)
        }
    } else if whole {
        (if immediate { 0.3f64 } else { 0.04 }).max(if quiet >= 0. { quiet } else { deadline })
    } else if already_quiet {
        old_end.min(deadline)
    } else {
        quiet
    });
    let fade = if whole && quiet < 0. {
        0.45f64.min(end)
    } else {
        0.06
    };
    let from = r3((end - fade).max(0.));
    let outgoing = |t: f64| {
        if t <= from {
            1.
        } else if t >= end {
            0.
        } else {
            ((t - from) / (end - from) * PI / 2.).cos()
        }
    };
    let open = r3(deadline.max(0.012));
    let gain_open = r3(if immediate { 0.3 } else { open });
    let rise = r3((open - 1.2f64.min(open)).max(0.));
    let lift = !whole;
    let mut lanes = Vec::new();
    for lane in arr(&p["automation"]) {
        let deck = s(lane, "deck");
        let name = s(lane, "lane");
        if deck == "A" && (name == "voiceEcho" || (whole || early) && name == "echo") {
            continue;
        }
        let incoming = deck == "B"
            && (["gain", "mid", "high", "filter"].contains(&name) || whole && name == "low");
        if !incoming && !(whole && deck == "A" && name == "gain") {
            lanes.push(lane.clone());
            continue;
        }
        let old = points(&lane["points"]);
        let mut ts: Vec<f64> = old.iter().map(|p| p[0]).collect();
        ts.extend([0., d]);
        ts.extend((0..13).map(|i| {
            if incoming && name == "gain" && immediate {
                gain_open * i as f64 / 12.
            } else if incoming {
                rise + (open - rise) * i as f64 / 12.
            } else {
                from + (end - from) * i as f64 / 12.
            }
        }));
        let ps: Points = knots(ts)
            .into_iter()
            .map(|t| {
                let value = point_value(&old, t);
                if !incoming {
                    return [r3(t), r3(value.min(outgoing(t)))];
                }
                let lane_open = if name == "gain" && immediate {
                    gain_open
                } else {
                    open
                };
                let lane_rise = if name == "gain" && immediate {
                    0.
                } else {
                    rise
                };
                let x = if t <= lane_rise {
                    0.
                } else if t >= lane_open {
                    1.
                } else {
                    (t - lane_rise) / (lane_open - lane_rise)
                };
                let floor = if name == "low" {
                    (1. - outgoing(t).powi(2)).max(0.).sqrt()
                } else {
                    (x * PI / 2.).sin() * if lift && name == "gain" { 1. / 2.5 } else { 1. }
                };
                [
                    r3(t),
                    r3(if name == "filter" {
                        value * (1. - x)
                    } else {
                        value.max(floor)
                    }),
                ]
            })
            .collect();
        let mut lane = lane.clone();
        lane["points"] = json!(ps);
        lanes.push(lane);
    }
    let mut automation = json!(lanes);
    if !whole && (early || !already_quiet) && s0["eqHandoff"] == true {
        automation = guard_lanes(
            &automation,
            from,
            end.max(deadline),
            d,
            BLEED_MID,
            BLEED_HIGH,
        );
    }
    if whole {
        remove(&mut p, "vocalA");
    } else if !(already_quiet && !early) {
        p["vocalA"] = json!([[0., 1.], [from, 1.], [end, 0.], [d, 0.]]);
    }
    let voice_rise = if immediate { 0. } else { rise };
    let voice_open = if immediate { gain_open } else { open };
    let voice = |t: f64| {
        if t <= voice_rise {
            0.
        } else if t >= voice_open {
            1.
        } else {
            ((t - voice_rise) / (voice_open - voice_rise) * PI / 2.).sin()
        }
    };
    if deadline <= 0.012 {
        remove(&mut p, "vocalB");
    } else {
        p["vocalB"] = json!([[0., 0.], [rise, 0.], [open, 1.], [d, 1.]]);
    }
    if lift {
        let gain = arr(&automation)
            .iter()
            .find(|l| s(l, "deck") == "B" && s(l, "lane") == "gain")
            .map(|l| points(&l["points"]))
            .unwrap_or(vec![[0., 1.]]);
        let mut ts = vec![0., d];
        ts.extend(gain.iter().map(|p| p[0]));
        ts.extend((0..13).map(|i| voice_rise + (voice_open - voice_rise) * i as f64 / 12.));
        ts.extend((0..(d / 0.25).ceil() as usize).map(|i| i as f64 * 0.25));
        let mut vb: Points = knots(ts)
            .into_iter()
            .filter(|t| *t >= 0. && *t <= d)
            .map(|t| {
                [
                    r3(t),
                    r3(2.5f64.min(voice(t) / point_value(&gain, t).max(1e-3))),
                ]
            })
            .collect();
        while vb.len() > 2 && (vb[vb.len() - 2][1] - 1.).abs() < 1e-3 && vb[vb.len() - 1][1] == 1. {
            vb.pop();
        }
        p["vocalB"] = json!(vb);
    }
    remove(&mut p, "voiceEcho");
    if !arr(&automation).iter().any(|l| s(l, "lane") == "echo") {
        remove(&mut p, "echo");
    }
    p["automation"] = automation;
    let prefixes = [
        "голос следующего трека",
        "последнее слово текущего голоса",
        "текущий трек уходит в эхо",
        "подводка к измеренному вступлению:",
    ];
    let mut reasons: Vec<Value> = arr(&p["reasons"])
        .iter()
        .filter(|v| {
            !prefixes
                .iter()
                .any(|x| v.as_str().unwrap_or("").starts_with(x))
        })
        .cloned()
        .collect();
    reasons.push(json!(if early{"новый голос начинается сразу: предыдущий голос убран отдельно, измеренная инструментальная партия сохраняет ритм сведения"}else if whole{"первые слова нового трека не ждут вокальной маски: текущая запись целиком плавно уступает им место"}else{"новый голос открыт до первой измеренной атаки; текущий заканчивается в доступной измеренной паузе"}));
    p["reasons"] = json!(reasons);
    remove(&mut p["debug"], "djFilterRelease");
    p["debug"]["firstWords"] = json!({"policy":"first-words-1","attack":attack,"source":first,"previousHandoff":old_end,"wholeDeckFade":whole,"outgoingTailMeasuredQuiet":later==Some(f64::INFINITY),"earlyStemHandoff":early,"unavoidableOverlapSeconds":r3((end-attack).max(0.)),"declickSeconds":if attack<0.012{0.012}else{0.},"gainRiseSeconds":r3(if immediate{0.3}else{1.2f64.min(open)}),"voiceLift":lift});
    if p["debug"]["stems"].is_null() {
        p["debug"]["stems"] = json!({});
    }
    let st = &mut p["debug"]["stems"];
    st["policy"] = json!("first-words-1");
    st["vocalHandoff"] = json!(end);
    st["bVoiceStart"] = json!(deadline);
    st["lostB"] = json!(0);
    st["voiceEcho"] = Value::Null;
    if whole {
        st["wholeDeckFade"] = json!({"from":from,"to":end});
    }
    p
}
pub fn outgoing_phrase_cut(p: &Value, a: &Value) -> Option<Value> {
    let d = n(p, "duration");
    let ta = points(&p["tempoA"]);
    let ax = n(p, "aExit");
    let src = |t| ax + integrate_tempo(&ta, t);
    let va = if p["vocalA"].is_null() {
        vec![[0., 1.]]
    } else {
        points(&p["vocalA"])
    };
    let ga = lane_points(p, "A", "gain");
    let mid = lane_points(p, "A", "mid");
    let high = lane_points(p, "A", "high");
    let effective = |t| {
        point_value(&va, t) * point_value(&ga, t) * point_value(&mid, t).min(point_value(&high, t))
    };
    let phrases = vocal_phrases(a);
    let mut t = 0.;
    while t < d {
        if effective(t) < 0.5 {
            if let Some(phrase) = phrases.iter().find(|x| {
                n(x, "confidence") >= 0.35 && n(x, "start") < src(t) && n(x, "end") > src(t) + 0.03
            }) {
                let start = if n(phrase, "start") <= ax {
                    0.
                } else {
                    output_time_at(&ta, n(phrase, "start") - ax, d)
                };
                if effective(start) >= 0.5 {
                    return Some(json!({"cut":t,"endSource":n(phrase,"end")}));
                }
            }
        }
        t += 0.02;
    }
    None
}
pub fn with_vocal_gap(mut p: Value, a: &Value, b: &Value, s0: &Value) -> Value {
    if s0["enabled"] != true
        || s0["stemMixing"] == false
        || a["vocalActivity"].is_null()
        || b["vocalActivity"].is_null()
        || opt(&p, "bDelay", 0.) != 0.
        || !p["loopA"].is_null()
        || !p["tapeStopA"].is_null()
        || p["debug"]["processingAllowed"] == false
        || p["debug"]["requested"] == true
        || s(&p["debug"], "variant") == "instrumental-bridge"
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
    {
        return p;
    }
    let d = n(&p, "duration");
    let ta = points(&p["tempoA"]);
    let tb = points(&p["tempoB"]);
    let ax = n(&p, "aExit");
    let bx = n(&p, "bEntry");
    let src = |t| ax + integrate_tempo(&ta, t);
    let available = n(a, "duration").min(n(a, "audibleEnd"));
    if first_voice(a, ax, available.min(src(d))).is_none() {
        return p;
    }
    let Some(attack) = first_voice(b, bx, n(b, "duration").min(bx + integrate_tempo(&tb, d)))
        .filter(|v| v.is_finite())
    else {
        return p;
    };
    let bword = output_time_at(&tb, attack - bx, d);
    let Some(clipped) = outgoing_phrase_cut(&p, a) else {
        return p;
    };
    let cut = n(&clipped, "cut");
    let end_source = n(&clipped, "endSource");
    let phrases = vocal_phrases(a);
    if cut < 0. || end_source > available - 0.08 || end_source > src(cut + 16.) {
        return p;
    }
    let end = output_time_at(&ta, end_source - ax, d + 16.);
    let off = end + 0.12;
    if first_voice(a, ax, available.min(src(off) + 0.02)).is_none() {
        return p;
    }
    if lyric_timing(a).is_some_and(|w| {
        w.edit
            .iter()
            .any(|[a, b]| src(off) + 0.02 > *a && end_source < *b)
    }) {
        return p;
    }
    if phrases.iter().any(|x| {
        n(x, "confidence") >= 0.35
            && n(x, "start") < src(off) + 0.02
            && n(x, "end") > end_source + 0.001
            && n(x, "start") >= end_source
    }) {
        return p;
    }
    let mut delay = (off + 0.08 - bword).max(0.);
    if delay > 0. && s(&p, "method") == "beatmatch_blend" {
        let bar = p["beatAlign"]["regions"]["A"]["period"]
            .as_f64()
            .or_else(|| a["beat"]["period"].as_f64())
            .unwrap_or(0.5)
            * 4.;
        delay = output_time_at(
            &ta,
            (integrate_tempo(&ta, delay) / bar - 1e-6).ceil() * bar,
            d + 16.,
        );
        let rates: Vec<f64> = if ta.is_empty() {
            vec![1.]
        } else {
            ta.iter().map(|p| p[1]).collect()
        };
        if (rates.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - rates.iter().copied().fold(f64::INFINITY, f64::min))
            * (d + delay)
            > 0.02
        {
            return p;
        }
    }
    if delay > 16.01 {
        return p;
    }
    let nd = r3((d + delay).max(off + 0.4));
    let release = (off + 0.4).min(output_time_at(&ta, available - ax, nd));
    let cap = s0["maxBlendSeconds"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| clamp(v, 0., 60.))
        .unwrap_or(32.);
    if release <= off
        || nd > cap + 0.001
        || bx + integrate_tempo(&tb, nd - delay) > n(b, "audibleEnd") + 0.001
    {
        return p;
    }
    let tail = output_time_at(&ta, available - ax, nd);
    let bass = lane_points(&p, "B", "low");
    let gain = lane_points(&p, "B", "gain");
    if delay > 0.
        && tail < nd - 0.02
        && (tail <= delay
            || point_value(&bass, tail - delay) * point_value(&gain, tail - delay) < 0.7)
    {
        return p;
    }
    let mut lanes = Vec::new();
    for lane in arr(&p["automation"]) {
        if s(lane, "lane") == "voiceEcho" || s(lane, "deck") == "A" && s(lane, "lane") == "echo" {
            continue;
        }
        let mut lane = lane.clone();
        let mut old = points(&lane["points"]);
        if s(&lane, "deck") == "A" && delay > 0. {
            let mut shifted = vec![[0., old.first().map_or(1., |p| p[1])]];
            shifted.extend(old.iter().map(|p| [r3(p[0] + delay), p[1]]));
            old = shifted;
            lane["points"] = json!(old);
        }
        if s(&lane, "deck") == "A" && ["gain", "mid", "high", "filter"].contains(&s(&lane, "lane"))
        {
            let mut ts = vec![0., end, off, release, nd];
            ts.extend(old.iter().map(|p| p[0]));
            lane["points"] = json!(
                knots(ts)
                    .iter()
                    .map(|t| {
                        let old = point_value(&old, *t);
                        let keep = if *t <= end {
                            1.
                        } else if *t >= release {
                            0.
                        } else {
                            ((*t - end) / (release - end) * PI / 2.).cos()
                        };
                        [
                            r3(*t),
                            r3(if s(&lane, "lane") == "filter" {
                                old * (1. - keep)
                            } else {
                                old.max(keep)
                            }),
                        ]
                    })
                    .collect::<Points>()
            );
        }
        lanes.push(lane);
    }
    let mut automation = json!(lanes);
    if s0["eqHandoff"] == true {
        automation = guard_lanes(&automation, r3(end), r3(off), nd, BLEED_MID, BLEED_HIGH);
    }
    p["duration"] = json!(nd);
    p["swapAt"] = json!(r3(n(&p, "swapAt") + delay));
    if delay > 0. {
        p["bDelay"] = json!(r3(delay));
    }
    p["automation"] = automation;
    p["vocalA"] = json!([[0., 1.], [r3(end), 1.], [r3(off), 0.], [nd, 0.]]);
    remove(&mut p, "voiceEcho");
    remove(&mut p, "echo");
    p["reasons"].as_array_mut().unwrap().push(json!("звучащая фраза текущего голоса заканчивается до передачи: громкость деки сохраняет её окончание"));
    if !p["debug"]["firstWords"].is_null() {
        let f = &mut p["debug"]["firstWords"];
        f["wholeDeckFade"] = json!(false);
        f["earlyStemHandoff"] = json!(true);
        f["deferredBy"] = json!(r3(delay));
    }
    p["debug"]["vocalGap"] = json!({"policy":"finish-utterance-1","cut":r3(cut),"end":r3(end),"off":r3(off),"bWord":r3(bword+delay),"gap":r3(bword+delay-off),"bDelay":r3(delay)});
    if p["debug"]["stems"].is_null() {
        p["debug"]["stems"] = json!({});
    }
    let st = &mut p["debug"]["stems"];
    st["policy"] = json!("finish-utterance-1");
    st["vocalHandoff"] = json!(r3(off));
    st["bVoiceStart"] = json!(r3(bword + delay));
    st["voiceEcho"] = Value::Null;
    remove(st, "wholeDeckFade");
    st["cleanA"] = json!(true);
    st["fadeA"] = json!(0.12);
    p
}
