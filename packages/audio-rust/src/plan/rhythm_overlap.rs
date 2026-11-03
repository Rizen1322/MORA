use super::common::*;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
struct Event {
    time: f64,
    kick: f64,
    snare: f64,
}
fn lane(p: &Value, deck: &str, t: f64) -> f64 {
    arr(&p["automation"])
        .iter()
        .find(|l| s(l, "deck") == deck && s(l, "lane") == "gain")
        .map_or(1., |l| point_value(&points(&l["points"]), t))
}
fn selected<'a>(
    an: &'a Value,
    p: &Value,
    deck: &str,
    from: f64,
    to: f64,
) -> Option<(&'a Value, &'static str)> {
    let summary = &p["beatAlign"]["regions"][deck];
    if !summary.is_null() {
        let region = arr(&an["beatRegions"]).iter().find(|r| {
            (n(r, "start") - n(summary, "start")).abs() < 0.05
                && (n(r, "end") - n(summary, "end")).abs() < 0.05
                && n(r, "start") <= from
                && n(r, "end") >= to
        })?;
        return if region["accents"].is_null() {
            None
        } else {
            Some((region, "region"))
        };
    }
    if an["beat"]["accents"].is_null() || !an["structure"]["gridCheck"]["periodHint"].is_null() {
        None
    } else {
        Some((&an["beat"], "global"))
    }
}
fn coverage(g: &Value, from: f64, to: f64) -> bool {
    let beats = nums(&g["beats"]);
    let period = n(g, "period");
    let confidence = n(g, "confidence");
    let jitter = n(g, "jitterMs");
    let kick = nums(&g["accents"]["kick"]);
    let snare = nums(&g["accents"]["snare"]);
    if !(period > 0. && period.is_finite())
        || !confidence.is_finite()
        || confidence < 0.65
        || g["stable"] == false
        || !jitter.is_finite()
        || jitter > 20.
        || kick.len() != beats.len()
        || snare.len() != beats.len()
        || beats.is_empty()
        || beats
            .iter()
            .enumerate()
            .any(|(i, t)| !t.is_finite() || i > 0 && *t <= beats[i - 1])
        || kick.iter().chain(&snare).any(|x| !x.is_finite() || *x < 0.)
    {
        return false;
    }
    let window: Vec<f64> = beats
        .into_iter()
        .filter(|t| *t >= from && *t < to)
        .collect();
    window.len() >= 8
        && window[0] - from <= period * 1.5
        && to - window[window.len() - 1] <= period * 1.5
        && window.windows(2).all(|p| p[1] - p[0] <= period * 1.5)
}
fn events(
    p: &Value,
    g: &Value,
    deck: &str,
    from: f64,
    to: f64,
    a: &Value,
    b: &Value,
) -> Vec<Event> {
    let delay = if deck == "B" {
        opt(p, "bDelay", 0.)
    } else {
        0.
    };
    let cue = n(p, if deck == "A" { "aExit" } else { "bEntry" });
    let tempo = points(&p[if deck == "A" { "tempoA" } else { "tempoB" }]);
    let mut result = Vec::new();
    for (i, source) in nums(&g["beats"]).into_iter().enumerate() {
        if source < from || source >= to {
            continue;
        }
        let out = delay + output_time_at(&tempo, source - cue, (n(p, "duration") - delay).max(0.));
        if out < delay || out >= n(p, "duration") || lane(p, deck, out - delay) <= 0. {
            continue;
        }
        let (peer, peer_an) = if deck == "A" { ("B", b) } else { ("A", a) };
        let peer_time = out
            - if peer == "B" {
                opt(p, "bDelay", 0.)
            } else {
                0.
            };
        if peer_time < 0. || lane(p, peer, peer_time) <= 0. {
            continue;
        }
        let peer_source = n(p, if peer == "A" { "aExit" } else { "bEntry" })
            + integrate_tempo(
                &points(&p[if peer == "A" { "tempoA" } else { "tempoB" }]),
                peer_time,
            );
        if peer_source < n(peer_an, "audibleStart") || peer_source >= n(peer_an, "audibleEnd") {
            continue;
        }
        result.push(Event {
            time: out,
            kick: num(&g["accents"]["kick"][i]),
            snare: num(&g["accents"]["snare"][i]),
        });
    }
    result
}
fn median_interval(events: &[Event]) -> Option<f64> {
    let mut times: Vec<f64> = events
        .windows(2)
        .map(|x| x[1].time - x[0].time)
        .filter(|x| *x > 0. && x.is_finite())
        .collect();
    times.sort_by(f64::total_cmp);
    times.get(times.len() / 2).copied()
}
fn agreement(pairs: &[(Option<Event>, Option<Event>)], kick: bool) -> Value {
    if pairs.len() < 8 {
        return Value::Null;
    }
    let band = |v: Option<Event>| v.map_or(0., |v| if kick { v.kick } else { v.snare });
    let a: Vec<f64> = pairs.iter().map(|p| band(p.0)).collect();
    let b: Vec<f64> = pairs.iter().map(|p| band(p.1)).collect();
    let ma = a.iter().sum::<f64>() / a.len() as f64;
    let mb = b.iter().sum::<f64>() / b.len() as f64;
    let va = a.iter().map(|v| (v - ma).powi(2)).sum::<f64>();
    let vb = b.iter().map(|v| (v - mb).powi(2)).sum::<f64>();
    if !(va > 1e-9 && vb > 1e-9) {
        return Value::Null;
    }
    let cov = a
        .iter()
        .zip(&b)
        .map(|(a, b)| (a - ma) * (b - mb))
        .sum::<f64>();
    json!({"correlation":r3(cov/(va*vb).sqrt()),"samples":pairs.len()})
}
pub fn rhythm_overlap(p: &Value, a: &Value, b: &Value) -> Value {
    if !p["loopA"].is_null()
        || !p["tapeStopA"].is_null()
        || !(n(p, "duration") > 0.)
        || n(p, "gap") > 0.
        || !opt(p, "bDelay", 0.).is_finite()
    {
        return Value::Null;
    }
    let delay = opt(p, "bDelay", 0.);
    let from = delay.max(0.);
    let to = n(p, "duration");
    if to - from < 4. {
        return Value::Null;
    }
    let pa = points(&p["tempoA"]);
    let pb = points(&p["tempoB"]);
    let mut simultaneous = false;
    let mut t = from + 0.025;
    while t < to {
        let tb = t - delay;
        let sa = n(p, "aExit") + integrate_tempo(&pa, t);
        let sb = n(p, "bEntry") + integrate_tempo(&pb, tb);
        if sa >= n(a, "audibleStart")
            && sa < n(a, "audibleEnd")
            && sb >= n(b, "audibleStart")
            && sb < n(b, "audibleEnd")
            && lane(p, "A", t) > 0.
            && lane(p, "B", tb) > 0.
        {
            simultaneous = true;
            break;
        }
        t += 0.05;
    }
    if !simultaneous {
        return Value::Null;
    }
    let af = n(p, "aExit") + integrate_tempo(&pa, from);
    let at = n(p, "aExit") + integrate_tempo(&pa, to);
    let bf = n(p, "bEntry") + integrate_tempo(&pb, from - delay);
    let bt = n(p, "bEntry") + integrate_tempo(&pb, to - delay);
    if af < n(a, "audibleStart")
        || at > n(a, "audibleEnd")
        || bf < n(b, "audibleStart")
        || bt > n(b, "audibleEnd")
    {
        return Value::Null;
    }
    let (Some((ga, source_a)), Some((gb, source_b))) =
        (selected(a, p, "A", af, at), selected(b, p, "B", bf, bt))
    else {
        return Value::Null;
    };
    if !coverage(ga, af, at) || !coverage(gb, bf, bt) {
        return Value::Null;
    }
    let ea = events(p, ga, "A", af, at, a, b);
    let eb = events(p, gb, "B", bf, bt, a, b);
    if ea.len() < 8 || eb.len() < 8 {
        return Value::Null;
    }
    let (Some(period_a), Some(period_b)) = (median_interval(&ea), median_interval(&eb)) else {
        return Value::Null;
    };
    let tolerance = period_a.min(period_b) * 0.2;
    let mut used = vec![false; eb.len()];
    let mut pairs = Vec::new();
    for x in &ea {
        let mut best = None;
        let mut distance = f64::INFINITY;
        for (i, y) in eb.iter().enumerate() {
            if used[i] {
                continue;
            }
            let d = (x.time - y.time).abs();
            if d < distance {
                distance = d;
                best = Some(i);
            }
        }
        if let Some(i) = best.filter(|_| distance <= tolerance) {
            used[i] = true;
            pairs.push((Some(*x), Some(eb[i])));
        } else {
            pairs.push((Some(*x), None));
        }
    }
    for (i, y) in eb.iter().enumerate() {
        if !used[i] {
            pairs.push((None, Some(*y)));
        }
    }
    let paired = pairs
        .iter()
        .filter(|p| p.0.is_some() && p.1.is_some())
        .count();
    json!({"policy":"rhythm-overlap-1","interpretation":"structural-beat-accent-agreement-not-audibility","windowSeconds":r3(to-from),"timingToleranceMs":round(tolerance*1000.),
        "grids":{"A":{"source":source_a,"confidence":ga["confidence"],"jitterMs":ga["jitterMs"],"beats":ea.len()},"B":{"source":source_b,"confidence":gb["confidence"],"jitterMs":gb["jitterMs"],"beats":eb.len()}},"pairedBeats":paired,"unmatchedBeats":pairs.len()-paired,"kick":agreement(&pairs,true),"snare":agreement(&pairs,false)})
}
