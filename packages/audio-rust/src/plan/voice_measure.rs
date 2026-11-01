use super::common::*;
use serde_json::{Value, json};

pub fn vocal_phrases(an: &Value) -> Vec<Value> {
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    if v.is_null() || !rate.is_finite() || rate <= 0. {
        return vec![];
    }
    let supplied = arr(&v["phrases"]);
    if !supplied.is_empty()
        && supplied.iter().enumerate().all(|(i, p)| {
            let start = n(p, "start");
            let end = n(p, "end");
            let confidence = n(p, "confidence");
            start.is_finite()
                && end.is_finite()
                && confidence.is_finite()
                && start >= 0.
                && end > start
                && end <= n(an, "duration") + 1. / rate
                && (0. ..=1.).contains(&confidence)
                && (i == 0 || start >= n(&supplied[i - 1], "end"))
        })
    {
        return supplied.to_vec();
    }
    let mut result = Vec::new();
    let (mut start, mut last) = (-1i64, -1i64);
    let (mut sum, mut count) = (0., 0usize);
    let finish = |out: &mut Vec<Value>, start: i64, last: i64, sum: f64, count: usize| {
        if start >= 0 && (last + 1 - start) as f64 / rate >= 0.18 {
            out.push(json!({"start":start as f64/rate,"end":(last+1) as f64/rate,"confidence":clamp(sum/count.max(1) as f64,0.,1.)}));
        }
    };
    for (i, x) in nums(&v["values"]).iter().enumerate() {
        let x = if x.is_finite() { clamp(*x, 0., 1.) } else { 0. };
        if start < 0 {
            if x < 0.52 {
                continue;
            }
            start = i as i64;
        }
        if x >= 0.28 {
            last = i as i64;
            sum += x;
            count += 1;
        }
        if (i as i64 - last) as f64 / rate > 0.2 + 1e-9 {
            finish(&mut result, start, last, sum, count);
            start = -1;
            last = -1;
            sum = 0.;
            count = 0;
        }
    }
    finish(&mut result, start, last, sum, count);
    result
}
#[derive(Clone)]
pub struct Lyrics {
    pub words: Points,
    pub lines: Points,
    pub edit: Points,
    pub verified: bool,
}
fn valid_spans(raw: &Value, duration: f64) -> bool {
    let Some(raw) = raw.as_array() else {
        return false;
    };
    raw.iter().enumerate().all(|(i, p)| {
        p.is_array()
            && num(&p[0]).is_finite()
            && num(&p[1]).is_finite()
            && num(&p[0]) >= 0.
            && num(&p[1]) > num(&p[0])
            && num(&p[1]) <= duration + 0.1
            && (i == 0 || num(&p[0]) >= num(&raw[i - 1][1]))
    })
}
pub fn lyric_timing(an: &Value) -> Option<Lyrics> {
    let l = &an["vocalActivity"]["lyrics"];
    let confidence = n(l, "confidence");
    let duration = n(an, "duration");
    if l.is_null()
        || !confidence.is_finite()
        || confidence < 0.6
        || confidence > 1.
        || arr(&l["words"]).len() < 10
        || !valid_spans(&l["words"], duration)
        || !valid_spans(&l["lines"], duration)
    {
        return None;
    }
    if s(l, "timing") == "stem-verified-1"
        && !arr(&l["voiced"]).is_empty()
        && valid_spans(&l["voiced"], duration)
    {
        return Some(Lyrics {
            words: points(&l["words"]),
            lines: points(&l["lines"]),
            edit: points(&l["voiced"]),
            verified: true,
        });
    }
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    let values = nums(&v["values"]);
    let words: Points = points(&l["words"])
        .iter()
        .map(|[a, b]| {
            if b - a <= 1. || rate <= 0. {
                return [*a, *b];
            }
            let lo = (a * rate).floor().max(0.) as usize;
            let hi = ((b * rate).ceil().max(0.) as usize).min(values.len());
            let mut first = None;
            let mut last = 0;
            for i in lo..hi {
                if values[i] >= 0.28 {
                    first.get_or_insert(i);
                    last = i;
                }
            }
            let Some(first) = first else {
                return [*a, *b];
            };
            let start = a.max(first as f64 / rate - 0.05);
            let end = b.min((last + 1) as f64 / rate + 0.05);
            if end - start >= 0.05 {
                [start, end]
            } else {
                [*a, *b]
            }
        })
        .collect();
    let mut spans = words.clone();
    spans.extend(
        vocal_phrases(an)
            .iter()
            .filter(|p| n(p, "confidence") >= 0.35)
            .map(|p| [n(p, "start"), n(p, "end")]),
    );
    spans.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut edit: Points = Vec::new();
    for [a, b] in spans {
        if let Some(last) = edit.last_mut() {
            if a <= last[1] {
                last[1] = last[1].max(b);
                continue;
            }
        }
        edit.push([a, b]);
    }
    Some(Lyrics {
        words,
        lines: points(&l["lines"]),
        edit,
        verified: false,
    })
}
pub fn splits_word(t: &Lyrics, start: f64, end: f64) -> bool {
    t.words
        .iter()
        .any(|[a, b]| end > a + 0.03 && start < b - 0.03)
}
pub fn between_lines(t: &Lyrics, x: f64) -> f64 {
    for (i, [_, end]) in t.lines.iter().enumerate() {
        let next = t.lines.get(i + 1).map_or(f64::INFINITY, |p| p[0]);
        if x >= end - 0.02 && x <= next + 0.02 {
            return 1.;
        }
        if x < *end {
            return 0.;
        }
    }
    1.
}
pub fn words_in(t: &Lyrics, start: f64, end: f64) -> usize {
    t.words
        .iter()
        .filter(|[a, b]| (a + b) / 2. >= start && (a + b) / 2. < end)
        .count()
}
pub fn vocal_mean(an: &Value, start: f64, end: f64) -> f64 {
    let v = &an["vocalActivity"];
    if v.is_null() {
        return 0.;
    }
    let rate = n(v, "rate");
    let values = arr(&v["values"]);
    let lo = (start * rate).floor().max(0.) as usize;
    let hi = ((end * rate).ceil().max(0.) as usize).min(values.len());
    if hi > lo {
        values[lo..hi].iter().map(num).sum::<f64>() / (hi - lo) as f64
    } else {
        0.
    }
}
pub fn vocal_power_retained(an: &Value, start: f64, end: f64, gain: f64) -> f64 {
    if gain >= 1. {
        return 1.;
    }
    let v = &an["vocalActivity"];
    let voice = nums(&v["vocalRmsDb"]);
    let bed = nums(&v["accompanimentRmsDb"]);
    let rate = n(v, "rate");
    if voice.is_empty() || bed.is_empty() || !(rate > 0.) {
        return 1.;
    }
    let lo = (start * rate).floor().max(0.) as usize;
    let hi = ((end * rate).ceil().max(0.) as usize)
        .min(voice.len())
        .min(bed.len());
    let (mut vp, mut ip, mut count) = (0., 0., 0);
    for i in lo..hi {
        if voice[i].is_finite() && bed[i].is_finite() {
            vp += 10f64.powf(clamp(voice[i], -120., 12.) / 10.);
            ip += 10f64.powf(clamp(bed[i], -120., 12.) / 10.);
            count += 1;
        }
    }
    if count > 0 {
        clamp(
            (ip + clamp(gain, 0., 1.).powi(2) * vp) / (ip + vp).max(1e-12),
            0.,
            1.,
        )
    } else {
        1.
    }
}
pub fn vocal_starts(an: &Value, limit: f64) -> Vec<f64> {
    if an["vocalActivity"].is_null() {
        return vec![];
    }
    let phrases = vocal_phrases(an);
    phrases
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            n(p, "start") < n(an, "audibleStart") + limit
                && n(p, "confidence") >= 0.5
                && n(p, "start")
                    - if *i == 0 {
                        0.
                    } else {
                        n(&phrases[i - 1], "end")
                    }
                    >= 0.7 - 1e-9
        })
        .map(|(_, p)| n(p, "start"))
        .collect()
}
pub fn vocal_entry_score(a: &Value, b: &Value, a_swap: f64, b_swap: f64) -> f64 {
    if a["vocalActivity"].is_null() || b["vocalActivity"].is_null() {
        return 0.;
    }
    let gap = 1. - vocal_mean(a, a_swap - 0.25, a_swap + 0.2);
    let before = vocal_mean(b, b_swap - 0.9, b_swap - 0.1);
    let after = vocal_mean(b, b_swap + 0.1, b_swap + 0.9);
    0.45 * gap + 0.55 * clamp((after - before + 0.15) / 0.65, 0., 1.)
}
pub fn first_voice(an: &Value, from: f64, to: f64) -> Option<f64> {
    let v = &an["vocalActivity"];
    let rate = n(v, "rate");
    let values = nums(&v["values"]);
    if v.is_null()
        || rate <= 0.
        || !rate.is_finite()
        || !from.is_finite()
        || !to.is_finite()
        || from < 0.
        || to <= from
        || to > n(an, "duration") + 1e-6
        || ((to - 1e-8) * rate).ceil() > values.len() as f64
    {
        return None;
    }
    let mut first = f64::INFINITY;
    let lo = (from * rate).floor() as usize;
    let hi = (to * rate).ceil().max(0.) as usize;
    for i in lo..hi.min(values.len()) {
        let x = values[i];
        if !x.is_finite() || x < 0. || x > 1. {
            return None;
        }
        if x >= 0.28 && !first.is_finite() {
            first = from.max(i as f64 / rate);
        }
    }
    if let Some(words) = lyric_timing(an).filter(|w| w.verified) {
        for [a, b] in words.edit {
            if b > from && a < to {
                first = first.min(from.max(a));
                break;
            }
        }
    }
    Some(first)
}
