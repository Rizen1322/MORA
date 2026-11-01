use super::{common::*, voice_measure::*};
use serde_json::{Value, json};
use std::f64::consts::PI;
pub const BLEED_MID: f64 = 0.35;
pub const BLEED_HIGH: f64 = 0.5;
pub(crate) fn knots(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(f64::total_cmp);
    v.dedup_by(|a, b| *a == *b);
    v
}
pub(crate) fn lane_points(p: &Value, deck: &str, name: &str) -> Points {
    arr(&p["automation"])
        .iter()
        .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
        .map(|l| points(&l["points"]))
        .unwrap_or_else(|| vec![[0., if name == "filter" { 0. } else { 1. }]])
}
pub(crate) fn remove(p: &mut Value, key: &str) {
    if let Some(o) = p.as_object_mut() {
        o.remove(key);
    }
}
pub(crate) fn spans(an: &Value) -> Points {
    lyric_timing(an).map(|l| l.edit).unwrap_or_else(|| {
        vocal_phrases(an)
            .iter()
            .filter(|v| n(v, "confidence") >= 0.35)
            .map(|v| [n(v, "start"), n(v, "end")])
            .collect()
    })
}
pub fn guard_lanes(lanes: &Value, from: f64, to: f64, d: f64, mid: f64, high: f64) -> Value {
    let mut out: Vec<Value> = arr(lanes)
        .iter()
        .filter(|l| !(s(l, "deck") == "A" && ["mid", "high"].contains(&s(l, "lane"))))
        .cloned()
        .collect();
    for (band, gain) in [("mid", mid), ("high", high)] {
        let old = arr(lanes)
            .iter()
            .find(|l| s(l, "deck") == "A" && s(l, "lane") == band)
            .map(|l| points(&l["points"]))
            .unwrap_or(vec![[0., 1.]]);
        let mut ts: Vec<f64> = old.iter().map(|p| p[0]).filter(|t| *t <= d).collect();
        ts.extend((0..9).map(|i| from + (to - from) * i as f64 / 8.));
        ts.push(d);
        let ps: Points = knots(ts)
            .into_iter()
            .filter(|t| *t >= 0.)
            .map(|t| {
                let ramp = if t <= from {
                    1.
                } else if t >= to {
                    gain
                } else {
                    1. - (1. - gain) * (0.5 - 0.5 * (PI * (t - from) / (to - from)).cos())
                };
                [r3(t), r3(point_value(&old, t).min(ramp))]
            })
            .collect();
        out.push(json!({"deck":"A","lane":band,"points":ps}));
    }
    json!(out)
}
fn fit(
    at: f64,
    duration: f64,
    out: bool,
    spans: &Points,
    cue: f64,
    tempo: &Points,
    limit: f64,
) -> f64 {
    let source = cue + integrate_tempo(tempo, at);
    if spans.iter().any(|[a, b]| source > *a && source < *b) {
        return duration;
    }
    let boundary = if out {
        spans
            .iter()
            .filter(|[_, b]| *b <= source)
            .last()
            .map(|p| p[1])
            .filter(|b| *b >= cue)
    } else {
        spans
            .iter()
            .find(|[a, _]| *a >= source)
            .map(|p| p[0])
            .filter(|a| *a <= cue + integrate_tempo(tempo, limit))
    };
    let Some(boundary) = boundary else {
        return duration;
    };
    let t = output_time_at(tempo, boundary - cue, limit);
    let available = if out { at - t - 0.015 } else { t - at - 0.035 };
    if available >= 0.02 {
        duration.min(available)
    } else {
        duration
    }
}
fn breath(spans: &Points, cue: f64, tempo: &Points, limit: f64, out: bool) -> Vec<f64> {
    let end_source = cue + integrate_tempo(tempo, limit);
    let mut result = Vec::new();
    for i in 0..spans.len() {
        let start = cue.max(if i > 0 { spans[i - 1][1] } else { cue });
        let end = end_source.min(spans[i][0]);
        if end <= start {
            continue;
        }
        let a = output_time_at(tempo, start - cue, limit);
        let b = output_time_at(tempo, end - cue, limit);
        let room = b - a - if out { 0.015 } else { 0.035 } - 0.005;
        if room >= 0.02 {
            result.push(if out {
                a + 0.015 + 0.08f64.min(room)
            } else {
                a + 0.005
            });
        }
    }
    result
}
fn covered(an: &Value, from: f64, to: f64, strict: bool) -> bool {
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    let values = nums(&v["values"]);
    let hi = if strict {
        ((to - 1e-8) * rate).ceil()
    } else {
        to * rate
    };
    if v.is_null()
        || !rate.is_finite()
        || rate <= 0.
        || !from.is_finite()
        || !to.is_finite()
        || from < 0.
        || to <= from
        || hi > values.len() as f64
    {
        return false;
    }
    let hi = if strict { hi } else { (to * rate).ceil() } as usize;
    ((from * rate).floor() as usize..hi).all(|i| {
        values
            .get(i)
            .is_some_and(|x| x.is_finite() && *x >= 0. && *x <= 1.)
    })
}
fn partial(mut p: Value, a: &Value, b: &Value, s0: &Value) -> Value {
    if !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || !p["voiceEcho"].is_null()
        || !p["loopA"].is_null()
    {
        return p;
    }
    let d = n(&p, "duration");
    let ta = points(&p["tempoA"]);
    let tb = points(&p["tempoB"]);
    let ax = n(&p, "aExit");
    let bx = n(&p, "bEntry");
    if !a["vocalActivity"].is_null() && b["vocalActivity"].is_null() {
        let gb = lane_points(&p, "B", "gain");
        let mut deadline = 0.;
        while deadline < 1f64.min(d * 0.35) && point_value(&gb, deadline) < 0.12 {
            deadline += 0.02;
        }
        deadline = (deadline - 0.04).max(0.);
        if deadline < 0.1 {
            return p;
        }
        let src = |t| ax + integrate_tempo(&ta, t);
        let words = lyric_timing(a);
        if !covered(a, src(0.), src(deadline + 0.08), false) {
            return p;
        }
        let mut end = -1.;
        let mut t = 0.08;
        while t <= deadline {
            if vocal_mean(a, src(t - 0.06), src(t + 0.08)) <= 0.12
                && !words.as_ref().is_some_and(|w| {
                    w.edit
                        .iter()
                        .any(|[a, b]| src(t) > *a && src(t - 0.06) < *b)
                })
            {
                end = t;
            }
            t += 0.02;
        }
        if end < 0. {
            return p;
        }
        let end = r3(end);
        let from = r3((end - 0.06).max(0.));
        if s0["eqHandoff"] == true {
            p["automation"] = guard_lanes(&p["automation"], from, end, d, BLEED_MID, BLEED_HIGH);
        }
        p["vocalA"] = json!([[0., 1.], [from, 1.], [end, 0.], [d, 0.]]);
        remove(&mut p, "vocalB");
        p["reasons"].as_array_mut().unwrap().push(json!("готов только текущий вокал: он уходит в измеренной паузе до заметного входа следующего трека; новый голос не заглушается"));
        p["debug"]["stems"] = json!({"policy":"one-sided-a-1","model":a["vocalActivity"]["model"],"source":"demucs","vocalHandoff":end,"incomingUnknown":true,"lostB":0,"bleedGuard":if s0["eqHandoff"]==true{json!({"from":from,"to":end,"mid":BLEED_MID,"high":BLEED_HIGH})}else{Value::Null}});
        return p;
    }
    if !b["vocalActivity"].is_null() && a["vocalActivity"].is_null() {
        let src = |t| bx + integrate_tempo(&tb, t);
        if !covered(b, src(0.), src(d), false) {
            return p;
        }
        let v = &b["vocalActivity"];
        let rate = n(v, "rate");
        let values = nums(&v["values"]);
        let mut first = f64::INFINITY;
        for i in (bx * rate).floor() as usize..(src(d) * rate).ceil() as usize {
            if values[i] >= 0.28 {
                first = bx.max(i as f64 / rate);
                break;
            }
        }
        if !first.is_finite() || first <= bx {
            return p;
        }
        let attack = output_time_at(&tb, first - bx, d);
        let end = r3(attack - 0.15);
        if end < 0.8 || end > d * 0.85 || vocal_mean(b, bx, first) > 0.12 {
            return p;
        }
        let fade = 4f64.min(0.6f64.max(end * 0.8));
        let from = r3(end - fade);
        let gain = lane_points(&p, "A", "gain");
        let mut ts = vec![0., end, d];
        ts.extend(gain.iter().map(|p| p[0]));
        ts.extend((0..13).map(|i| from + fade * i as f64 / 12.));
        let ts: Vec<f64> = knots(ts)
            .into_iter()
            .filter(|t| *t >= 0. && *t <= d)
            .collect();
        let envelope = |t: f64| {
            if t <= from {
                1.
            } else if t >= end {
                0.
            } else {
                0.5 + 0.5 * (PI * (t - from) / fade).cos()
            }
        };
        let mut lanes = Vec::new();
        for lane in arr(&p["automation"]) {
            if s(lane, "deck") == "A" && ["gain", "echo"].contains(&s(lane, "lane")) {
                continue;
            }
            let mut lane = lane.clone();
            if s(&lane, "deck") == "B" && ["gain", "low", "mid", "high"].contains(&s(&lane, "lane"))
            {
                let old = points(&lane["points"]);
                let mut times: Vec<f64> = old.iter().map(|p| p[0]).collect();
                times.extend(&ts);
                lane["points"] = json!(
                    knots(times)
                        .iter()
                        .map(|t| {
                            let out = envelope(*t);
                            let floor = if s(&lane, "lane") == "gain" {
                                (1. - out * out).max(0.).sqrt()
                            } else {
                                1. - out
                            };
                            [r3(*t), r3(point_value(&old, *t).max(floor))]
                        })
                        .collect::<Points>()
                );
            }
            lanes.push(lane);
        }
        lanes.push(json!({"deck":"A","lane":"gain","points":ts.iter().map(|t|[r3(*t),r3(point_value(&gain,*t).min(envelope(*t)))]).collect::<Points>()}));
        if !lanes.iter().any(|l| s(l, "lane") == "echo") {
            remove(&mut p, "echo");
        }
        p["automation"] = json!(lanes);
        remove(&mut p, "vocalA");
        remove(&mut p, "vocalB");
        p["reasons"].as_array_mut().unwrap().push(json!("готов только анализ нового голоса: текущий трек плавно уходит до его первого измеренного вступления; голос после выбранной точки входа не заглушается"));
        p["debug"]["stems"] = json!({"policy":"one-sided-b-2","model":v["model"],"source":"demucs","outgoingUnknown":true,"vocalHandoff":end,"bVoiceStart":r3(attack),"lostB":0,"wholeDeckFade":{"from":from,"to":end}});
    }
    p
}
struct Maximum {
    size: usize,
    tree: Vec<usize>,
    weights: Vec<f64>,
}
impl Maximum {
    fn better(w: &[f64], a: usize, b: usize) -> usize {
        if a == usize::MAX {
            return b;
        }
        if b == usize::MAX {
            return a;
        }
        if w[a] > w[b] {
            a
        } else if w[a] < w[b] {
            b
        } else {
            a.min(b)
        }
    }
    fn new(weights: Vec<f64>) -> Self {
        let size = weights.len().max(1).next_power_of_two();
        let mut tree = vec![usize::MAX; size * 2];
        for (i, w) in weights.iter().enumerate() {
            if w.is_finite() {
                tree[size + i] = i;
            }
        }
        for i in (1..size).rev() {
            tree[i] = Self::better(&weights, tree[i * 2], tree[i * 2 + 1]);
        }
        Self {
            size,
            tree,
            weights,
        }
    }
    fn best(&self, from: usize, to: usize) -> Option<usize> {
        let (mut l, mut r, mut found) = (from + self.size, to + self.size, usize::MAX);
        while l < r {
            if l & 1 == 1 {
                found = Self::better(&self.weights, found, self.tree[l]);
                l += 1;
            }
            if r & 1 == 1 {
                r -= 1;
                found = Self::better(&self.weights, found, self.tree[r]);
            }
            l >>= 1;
            r >>= 1;
        }
        if found == usize::MAX {
            None
        } else {
            Some(found)
        }
    }
}
pub fn apply_vocal_handoff(mut p: Value, a: &Value, b: &Value, s0: &Value) -> Value {
    if p["debug"]["processingAllowed"] == false {
        remove(&mut p, "vocalA");
        remove(&mut p, "vocalB");
        remove(&mut p, "voiceEcho");
        p["automation"] = json!(
            arr(&p["automation"])
                .iter()
                .filter(|l| s(l, "lane") != "voiceEcho")
                .collect::<Vec<_>>()
        );
        return p;
    }
    let d = n(&p, "duration");
    if s0["enabled"] != true
        || s0["stemMixing"] == false
        || d < 0.7
        || ["skip_fade", "gapless"].contains(&s(&p, "method"))
    {
        return p;
    }
    if a["vocalActivity"].is_null() || b["vocalActivity"].is_null() {
        return partial(p, a, b, s0);
    }
    let ta = points(&p["tempoA"]);
    let tb = points(&p["tempoB"]);
    let ax = n(&p, "aExit");
    let bx = n(&p, "bEntry");
    let srca = |t| ax + integrate_tempo(&ta, t);
    let srcb = |t| bx + integrate_tempo(&tb, t);
    let va = covered(a, ax, n(a, "duration").min(srca(d)), true);
    let vb = covered(b, bx, srcb(d), true);
    if !va || !vb {
        if !p["vocalA"].is_null()
            || !p["vocalB"].is_null()
            || !p["voiceEcho"].is_null()
            || arr(&p["automation"])
                .iter()
                .any(|l| s(l, "lane") == "voiceEcho")
        {
            remove(&mut p, "vocalA");
            remove(&mut p, "vocalB");
            remove(&mut p, "voiceEcho");
            p["automation"] = json!(
                arr(&p["automation"])
                    .iter()
                    .filter(|l| s(l, "lane") != "voiceEcho")
                    .collect::<Vec<_>>()
            );
        }
        let (mut a, mut b) = (a.clone(), b.clone());
        if !va {
            remove(&mut a, "vocalActivity");
        }
        if !vb {
            remove(&mut b, "vocalActivity");
        }
        return partial(p, &a, &b, s0);
    }
    let drop = s(&p, "method") == "drop_mix";
    let pa = vocal_phrases(a);
    let pb = vocal_phrases(b);
    let la = lyric_timing(a);
    let lb = lyric_timing(b);
    let ea = spans(a);
    let eb = spans(b);
    let beat = p["beatAlign"]["regions"]["A"]["period"]
        .as_f64()
        .unwrap_or_else(|| {
            if !p["beatAlign"].is_null() {
                60. / n(&p["beatAlign"], "bpmA")
            } else {
                a["beat"]["period"].as_f64().unwrap_or(0.5)
            }
        });
    let ga = lane_points(&p, "A", "gain");
    let gb = lane_points(&p, "B", "gain");
    let power = |an: &Value, t: f64| {
        let c = &an["curves"];
        let v = nums(&c["rmsDb"]);
        let rate = n(c, "rate");
        let lo = ((t - 0.75) * rate).floor().max(0.) as usize;
        let hi = (((t + 0.75) * rate).ceil().max(0.) as usize).min(v.len());
        if hi > lo {
            v[lo..hi].iter().map(|x| 10f64.powf(*x / 10.)).sum::<f64>() / (hi - lo) as f64
        } else {
            0.
        }
    };
    let mut takeover = n(&p, "swapAt");
    if !drop && takeover < d * 0.3 {
        let mut t = 0.;
        while t < d {
            let ap =
                point_value(&ga, t).powi(2) * power(a, srca(t)) * 10f64.powf(n(&p, "gainA") / 10.);
            let bp =
                point_value(&gb, t).powi(2) * power(b, srcb(t)) * 10f64.powf(n(&p, "gainB") / 10.);
            if bp >= ap {
                takeover = takeover.max(t);
                break;
            }
            t += 0.1;
        }
    }
    let swap = 0.2f64.max((d - 0.35).min(takeover));
    let count = (d / 0.05).ceil() as usize;
    let heard = |an: &Value, src: &dyn Fn(f64) -> f64, g: &Points| {
        let mut out = vec![0.];
        for i in 0..count {
            let t = i as f64 * 0.05;
            out.push(
                out[i]
                    + clamp((vocal_mean(an, src(t), src(t + 0.05)) - 0.15) / 0.7, 0., 1.)
                        * point_value(g, t)
                        * 0.05,
            );
        }
        out
    };
    let ha = heard(a, &srca, &ga);
    let hb = heard(b, &srcb, &gb);
    let hearda = |t: f64| ha[(round(t / 0.05).max(0.) as usize).min(count)];
    let heardb = |t: f64| hb[(round(t / 0.05).max(0.) as usize).min(count)];
    let window = (beat * 8.).max(1.);
    let locked = s(&p, "method") == "beatmatch_blend";
    let lo = if drop {
        swap
    } else if locked {
        swap.min(d * 0.1 + 0.08)
    } else {
        swap.min(d * 0.1 + 0.08)
            .max((swap - beat * 8.).min(swap * 0.5))
    };
    let incoming_at = |bt: f64| {
        let x = srcb(bt);
        let fade = fit(bt, 0.12, false, &eb, bx, &tb, d);
        let mut gap = (1. - vocal_mean(b, x - 0.15, x + 0.1))
            * if pb.iter().any(|v| {
                n(v, "confidence") >= 0.35
                    && srcb(bt + fade + 0.035) > n(v, "start")
                    && srcb(bt) < n(v, "end")
            }) {
                0.
            } else {
                1.
            };
        let mut arrival = clamp((vocal_mean(b, x + 0.1, x + 0.9) - 0.25) / 0.4, 0., 1.);
        let mut bonus = 0.;
        if let Some(l) = &lb {
            let open = srcb(bt + fade);
            let from = srcb(bt);
            let chopped = l
                .words
                .iter()
                .any(|[a, b]| open > *a + 0.08 && from < *b - 0.05);
            let clear = !l
                .edit
                .iter()
                .any(|[a, b]| open > *a + 0.001 && from < *b - 0.001);
            if clear {
                bonus = 0.1;
            }
            if chopped {
                gap = gap.min(0.3);
            } else if clear {
                let line = l
                    .lines
                    .iter()
                    .find(|p| p[0] >= open)
                    .is_some_and(|p| p[0] - open < 1.)
                    && between_lines(l, from) != 0.;
                gap = gap.max(if line { 1. } else { 0.75 });
                arrival = (arrival * 0.5).max(if line { 1. } else { 0. });
            }
        }
        let lost = lb.as_ref().map_or(0, |l| words_in(l, srcb(0.), srcb(bt)));
        (
            bt,
            gap,
            gap + 0.2 * gap * arrival + bonus - 0.4 * heardb(bt) - 0.12 * lost as f64,
        )
    };
    let mut ts: Vec<f64> = (0..=count).map(|i| i as f64 * 0.05).collect();
    ts.extend(breath(&eb, bx, &tb, d, false));
    let incoming: Vec<_> = knots(ts).into_iter().map(incoming_at).collect();
    let maxima = Maximum::new(
        incoming
            .iter()
            .map(|(b, _, score)| score + 0.1 * b / window)
            .collect(),
    );
    let out_count = ((swap - lo + 1e-9) / 0.05).floor().max(0.) as usize + 1;
    let mut outgoing: Vec<f64> = (0..out_count).map(|i| swap - i as f64 * 0.05).collect();
    outgoing.extend(
        breath(&ea, ax, &ta, d, true)
            .into_iter()
            .filter(|t| *t >= lo && *t <= swap),
    );
    let mut outgoing = knots(outgoing);
    outgoing.reverse();
    let (mut score_best, mut end_a, mut gap_a, mut start_b, mut gap_b) =
        (f64::NEG_INFINITY, swap, 0., swap, 0.);
    for end in outgoing {
        let t = srca(end);
        let fade = fit(end, 0.08, true, &ea, ax, &ta, d);
        let mut agap = (1. - vocal_mean(a, t - 0.13, t + 0.35))
            * if pa.iter().any(|v| {
                n(v, "confidence") >= 0.35
                    && t > n(v, "start")
                    && srca((end - fade).max(0.)) < n(v, "end")
            }) {
                0.
            } else {
                1.
            };
        let mut phrase_end = clamp((vocal_mean(a, t - 1.6, t - 0.2) - 0.25) / 0.4, 0., 1.);
        let mut split = false;
        if let Some(l) = &la {
            let from = srca((end - fade).max(0.));
            split = l
                .edit
                .iter()
                .any(|[a, b]| t > *a + 0.001 && from < *b - 0.001);
            let line = between_lines(l, t);
            agap = if split {
                0.
            } else {
                agap.max(if line != 0. { 1. } else { 0.75 })
            };
            phrase_end = (phrase_end * 0.5).max(line);
        }
        let ascore = agap + 0.15 * phrase_end
            - 0.4 * (hearda(swap) - hearda(end))
            - if split { 0.4 } else { 0. }
            - la.as_ref()
                .map_or(0., |l| 0.06 * words_in(l, t, srca(swap)) as f64);
        let hi = (d - 0.12).min(end + if drop { 0. } else { window });
        let first = incoming.partition_point(|v| v.0 < end - 1e-9);
        let upper = incoming.partition_point(|v| v.0 <= hi + 1e-9);
        let candidate = if drop {
            Some(incoming_at(end))
        } else {
            maxima.best(first, upper).map(|i| incoming[i])
        };
        if let Some((bt, bgap, bscore)) = candidate {
            if bt > hi + 1e-9 {
                continue;
            }
            let score = ascore + bscore + 0.1 * clamp((bt - end) / window, 0., 1.);
            if score > score_best {
                score_best = score;
                end_a = end;
                gap_a = agap;
                start_b = bt;
                gap_b = bgap;
            }
        }
    }
    let breath_a = gap_a >= 0.75;
    let soft_b = gap_b < 0.75 && !drop;
    let fade_a = fit(
        end_a,
        if breath_a || drop {
            0.08f64.min(end_a)
        } else {
            0.45f64.min(0.08f64.max(end_a * 0.5))
        },
        true,
        &ea,
        ax,
        &ta,
        d,
    );
    let fade_b = fit(
        start_b,
        if soft_b { 0.3 } else { 0.12 },
        false,
        &eb,
        bx,
        &tb,
        d,
    );
    let open_b = d.min(start_b + fade_b);
    let clear = |spans: &Points, from: f64, to: f64| {
        !spans
            .iter()
            .any(|[a, b]| to > *a + 0.001 && from < *b - 0.001)
    };
    let clean_a = clear(&ea, srca((end_a - fade_a).max(0.)), srca(end_a));
    let clean_b = clear(&eb, srcb(start_b), srcb(open_b));
    let mut reasons = arr(&p["reasons"]).to_vec();
    reasons.extend([json!("выделенные вокальные партии передаются отдельно от инструментала, без наложения основных голосов"),json!(if breath_a{"голос текущего трека заканчивается в паузе до смены основы"}else{"пауза в голосе не найдена: голос текущего трека плавно уводится к моменту смены"}),json!(if gap_b>=0.75{"голос следующего трека открывается в начале своей фразы"}else{"голос следующего трека мягко открывается сразу после текущего"})]);
    let mut delay = beat / point_value(&ta, end_a).max(0.5);
    while delay < 0.3 {
        delay *= 2.;
    }
    while delay > 0.8 {
        delay /= 2.;
    }
    let mut last_word = None;
    let mut t = end_a;
    while t >= 0.05f64.max(end_a - 1.5) {
        if vocal_mean(a, srca(t - 0.05), srca(t)) > 0.35 {
            last_word = Some(t);
            break;
        }
        t -= 0.05;
    }
    let repeats = ((start_b - end_a) / delay - 1e-9).ceil();
    let mut echo = Value::Null;
    let mut lanes: Vec<Value> = arr(&p["automation"])
        .iter()
        .filter(|l| s(l, "lane") != "voiceEcho")
        .cloned()
        .collect();
    if let Some(last) = last_word.filter(|_| !drop && repeats >= 2.) {
        let level = 0.2f64.max(0.55 * point_value(&ga, last));
        let mut feedback = 0.5f64.min((0.01 / level).powf(1. / (repeats - 1.)));
        if feedback < 0.12 {
            feedback = 0.;
        }
        let from = 0.02f64.max(last - delay.min(0.5));
        echo = json!({"delay":r3(delay),"feedback":r3(feedback)});
        lanes.push(json!({"deck":"A","lane":"voiceEcho","points":[[0.,0.],[r3(from),0.],[r3(from+0.04),r3(level)],[r3(end_a),r3(level)],[r3(end_a+0.03),0.]]}));
        reasons.push(json!(
            "последнее слово текущего голоса повторяется эхом и затихает до входа нового голоса"
        ));
    }
    let mut guard = Value::Null;
    let mut automation = json!(lanes);
    if vocal_mean(a, srca(end_a), srca(d)) > 0.2
        && vocal_mean(b, srcb(start_b), srcb(d)) > 0.2
        && !drop
        && s0["eqHandoff"] != false
    {
        let from = r3((end_a - fade_a).max(0.));
        let to = r3(start_b);
        guard = json!({"from":from,"to":to,"mid":BLEED_MID,"high":BLEED_HIGH});
        automation = guard_lanes(&automation, from, to, d, BLEED_MID, BLEED_HIGH);
        reasons.push(json!("остаток старого голоса в аккомпанементе приглушается: вокальная полоса уходящего трека убирается к входу нового голоса"));
    }
    p["vocalA"] = json!([
        [0., 1.],
        [r3((end_a - fade_a).max(0.)), 1.],
        [r3(end_a), 0.],
        [r3(d), 0.]
    ]);
    p["vocalB"] = json!([[0., 0.], [r3(start_b), 0.], [r3(open_b), 1.], [r3(d), 1.]]);
    p["automation"] = automation;
    p["reasons"] = json!(reasons);
    if echo.is_null() {
        remove(&mut p, "voiceEcho");
    } else {
        p["voiceEcho"] = echo.clone();
    }
    let mut stems = json!({"model":a["vocalActivity"]["model"],"source":"demucs","policy":"phrase-safe-v3","vocalHandoff":r3(end_a),"bVoiceStart":r3(start_b),"aBreath":breath_a,"bBreath":gap_b>=0.75,"lostA":r3(hearda(swap)-hearda(end_a)),"lostB":r3(heardb(start_b)),"phrasesA":pa.len(),"phrasesB":pb.len(),"bleedGuard":guard,"fadeA":r3(fade_a),"fadeB":r3(open_b-start_b),"cleanA":clean_a,"cleanB":clean_b,"voiceEcho":echo,"entryScore":r3(vocal_entry_score(a,b,srca(end_a),srcb(start_b)))});
    if la.is_some() || lb.is_some() {
        let mut last = 0.;
        let mut t = d;
        while t > 0. {
            if point_value(&ga, t) > 0.1 {
                last = t;
                break;
            }
            t -= 0.05;
        }
        stems["lyrics"] = json!({"a":la.is_some(),"b":lb.is_some(),"verifiedA":la.as_ref().is_some_and(|l|l.verified),"verifiedB":lb.as_ref().is_some_and(|l|l.verified),"lostWordsA":la.as_ref().map(|l|words_in(l,srca(end_a),srca(d.min(last)))),"lostWordsB":lb.as_ref().map(|l|words_in(l,srcb(0.),srcb(start_b)))});
    }
    p["debug"]["stems"] = stems;
    p
}
