use super::common::*;
use serde_json::{Value, json};

/// Candidates accepted by automatic selection; audition-only hypotheses stay in the editor.
pub fn automatic_scenarios(
    base: &Value,
    a: &Value,
    b: &Value,
    settings: &Value,
) -> Vec<(String, Value)> {
    let mut result = vec![];
    if settings["enabled"] != true || base["debug"]["processingAllowed"] == false {
        return result;
    }
    let end = n(a, "duration").min(n(a, "audibleEnd"));
    let entry = 0f64.max(n(b, "audibleStart"));
    let room = n(b, "duration").min(n(b, "audibleEnd")) - entry;
    let max_blend = n(settings, "maxBlendSeconds");
    if ![end, entry, room, max_blend].iter().all(|v| v.is_finite())
        || room < 0.5
        || end - n(a, "audibleStart") < 0.5
        || max_blend < 0.5
    {
        return result;
    }
    let both_unknown = settings["stemMixing"] == false
        || (a["vocalActivity"].is_null() && b["vocalActivity"].is_null());
    let shaky = [&a["beat"], &b["beat"]]
        .iter()
        .any(|g| !g.is_null() && (n(g, "confidence") < 0.55 || n(g, "jitterMs") > 20.));
    if !both_unknown || s(settings, "style") != "auto" || (!base["beatAlign"].is_null() && !shaky) {
        return result;
    }
    let strong = |t: f64| {
        arr(&a["structure"]["segments"])
            .iter()
            .any(|v| n(v, "endClosure") >= 0.75 && (n(v, "end") - t).abs() < 0.001)
    };
    let mut add = |name: &str, at: f64, span: f64, delay: f64, fade: f64, evidence: &str| {
        let start = at - span;
        let b_span = span - delay;
        if start < n(a, "audibleStart").max(n(base, "aExit")) - 0.001
            || at > end
            || b_span > room
            || b_span < 0.1
        {
            return;
        }
        let mut p = base.clone();
        for key in [
            "beatAlign",
            "tempoA",
            "loopA",
            "tapeStopA",
            "vocalA",
            "vocalB",
            "echo",
            "voiceEcho",
            "entrySelection",
            "fallbackReason",
        ] {
            p.as_object_mut().unwrap().remove(key);
        }
        let mut points_a = vec![[0., 1.]];
        if span > fade {
            points_a.push([span - fade, 1.]);
        }
        points_a.push([span, 0.]);
        let attack = 0.12f64.min(b_span / 3.);
        p["id"] = json!(format!("{}:{name}", s(base, "id")));
        p["version"] = json!(VERSION);
        p["method"] = json!(if name == "natural-tail-start" {
            "crossfade"
        } else {
            "phrase_cut"
        });
        p["aExit"] = json!(start);
        p["bEntry"] = json!(entry);
        p["duration"] = json!(span);
        p["gap"] = json!(0);
        p["bDelay"] = json!(delay);
        p["swapAt"] = json!(delay + attack);
        p["tempoB"] = json!([[0, 1]]);
        p["confidence"] = json!(n(base, "confidence").min(0.65));
        p["automation"] = json!([
            {"deck":"A","lane":"gain","points":points_a},{"deck":"B","lane":"gain","points":[[0.,0.],[attack,1.],[b_span,1.]]}]);
        p["reasons"] = json!([if name == "natural-tail-start" {
            "Естественный хвост A перед сохранённым началом B"
        } else if strong(at) {
            "Короткая передача полной записи у структурного закрытия A"
        } else {
            "Пробная передача у предполагаемой границы фразы A"
        }]);
        p["entrySelection"] = json!({"kind":"start","skippedSeconds":0,"confidence":1});
        p["debug"] = json!({"humanScenario":{"policy":"human-1","kind":if name=="natural-tail-start"{"natural-tail"}else{"phrase-handoff"},"name":name,"evidence":evidence,"sourceEndA":at,"preservedOpeningB":true,"nativeTempo":true,"auditionOnly":false,"limits":["structure-is-not-word-timing","not-beatmatched"]}});
        result.push((name.into(), p));
    };
    let mut closures: Vec<f64> = arr(&a["structure"]["segments"])
        .iter()
        .filter(|v| n(v, "endClosure") >= 0.65)
        .map(|v| n(v, "end"))
        .collect();
    if n(a, "phraseConfidence") >= 0.65 {
        closures.extend(nums(&a["phrases"]));
    }
    closures
        .retain(|t| t.is_finite() && *t >= (n(base, "aExit") + 0.5).max(end - 12.) && *t <= end);
    closures.sort_by(|a, b| b.total_cmp(a));
    if let Some(at) = closures.first().copied() {
        let span = 1.2f64
            .min(max_blend)
            .min(at - n(a, "audibleStart").max(n(base, "aExit")))
            .min(room + 0.35);
        if span >= 0.5 && strong(at) {
            add(
                "section-handoff",
                at,
                span,
                span * 0.65,
                span * 0.55,
                "late measured structural closure; short full-deck overlap",
            );
        }
    }
    let rate = n(&a["curves"], "rate");
    let curve = nums(&a["curves"]["rmsDb"]);
    let mean = |from: f64, to: f64| {
        if !(rate > 0.) {
            return f64::NAN;
        }
        let lo = (from * rate).floor().max(0.) as usize;
        let hi = (to * rate).ceil().max(0.) as usize;
        if hi > curve.len() {
            return f64::NAN;
        }
        let values = curve.get(lo..hi).unwrap_or(&[]);
        if values.is_empty() || !values.iter().all(|v| v.is_finite()) {
            f64::NAN
        } else {
            10. * (values.iter().map(|x| 10f64.powf(x / 10.)).sum::<f64>() / values.len() as f64)
                .log10()
        }
    };
    let tail = 4f64
        .min(max_blend)
        .min(end - n(a, "audibleStart").max(n(base, "aExit")));
    if tail >= 1.5 && room >= 0.5 {
        let early = mean(end - tail, end - tail / 2.);
        let late = mean(end - 0.7, end);
        if late < early - 6. && late < n(a, "bodyRmsDb") - 10. {
            add(
                "natural-tail-start",
                end,
                tail,
                tail - 0.5,
                0.25,
                "measured declining RMS tail; B starts at audible opening",
            );
        }
    }
    result
}
