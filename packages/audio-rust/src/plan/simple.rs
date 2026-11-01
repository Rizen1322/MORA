use super::{common::*, primitives::*};
use serde_json::{Value, json};

pub(super) fn base_plan(a: &Value, b: &Value, settings: &Value, method: &str) -> Value {
    let settings_json = js_stringify(settings);
    let key = format!(
        "{}|{}|{}|{}|{}|{}",
        s(a, "id"),
        s(b, "id"),
        method,
        feature_key(&a["analysis"]),
        feature_key(&b["analysis"]),
        settings_json
    );
    let processing = a["mixingAllowed"] == true && b["mixingAllowed"] == true;
    let gain = |track: &Value| {
        if processing {
            normalization_gain(&track["analysis"], settings["loudnessTarget"].as_f64())
        } else {
            0.
        }
    };
    json!({"id":format!("tp_{}_{}",fnv1a(&key),fnv1a(&(VERSION.to_owned()+&key))),"version":VERSION,"fromTrackId":a["id"],"toTrackId":b["id"],"method":method,"confidence":0,"reasons":[],"aExit":0,"bEntry":0,"duration":0,"gap":0,"swapAt":0,"tempoB":[[0,1]],"automation":[],"gainA":gain(a),"gainB":gain(b),"debug":{"processingAllowed":processing}})
}
pub(super) fn sequential(a: &Value, b: &Value, settings: &Value, reason: &str) -> Value {
    let mut p = base_plan(a, b, settings, "gapless");
    p["aExit"] = json!(r3(n(a, "duration")));
    p["confidence"] = json!(1);
    p["reasons"] = json!([reason]);
    p
}
pub(super) fn fallback(a: &Value, b: &Value, settings: &Value, reason: &str) -> Value {
    let length = n(settings, "fallbackSeconds")
        .min(n(settings, "maxBlendSeconds"))
        .min(n(a, "duration") * 0.15)
        .min(n(b, "duration") * 0.35);
    if length < 0.03 {
        return sequential(a, b, settings, reason);
    }
    let mut p = base_plan(a, b, settings, "fallback_crossfade");
    p["aExit"] = json!(r3((n(a, "duration") - length).max(0.)));
    p["duration"] = json!(r3(length));
    p["swapAt"] = json!(r3(length / 2.));
    p["automation"] = json!([
        lane("A", "gain", vec![shape(0., length, cos_down, 8)]),
        lane("B", "gain", vec![shape(0., length, sin_up, 8)])
    ]);
    p["confidence"] = json!(0.3);
    p["fallbackReason"] = json!(reason);
    p["reasons"] = json!([reason, "мягкий кроссфейд по длительности файла"]);
    p
}
pub(super) fn skip(a: &Value, b: &Value, position: f64, settings: &Value) -> Value {
    let pos = safe_position(position, n(a, "duration"));
    if a["mixingAllowed"] != true || b["mixingAllowed"] != true {
        let mut p = sequential(
            a,
            b,
            settings,
            "источник не разрешает обработку звука: переключение без наложения",
        );
        p["aExit"] = json!(r3(pos.max(0.).min(n(a, "duration"))));
        return p;
    }
    let mut p = base_plan(a, b, settings, "skip_fade");
    p["id"] = json!(format!("{}_skip_{}", s(&p, "id"), round(pos * 10.)));
    let an = &b["analysis"];
    let entry = if an.is_null() || settings["enabled"] != true {
        0.
    } else if s(settings, "entryMode") == "preserve" {
        n(an, "audibleStart")
    } else {
        arr(&an["cues"]["entry"])
            .iter()
            .find(|c| s(c, "kind") == "start")
            .map(|c| n(c, "time"))
            .unwrap_or(n(an, "audibleStart"))
    };
    p["aExit"] = json!(r3(pos));
    p["bEntry"] = json!(r3(entry.max(0.)));
    p["duration"] = json!(0.4);
    p["swapAt"] = json!(0);
    p["automation"] = json!([
        lane("A", "gain", vec![shape(0., 0.4, cos_down, 6)]),
        lane("B", "gain", vec![shape(0., 0.12, sin_up, 4)])
    ]);
    p["confidence"] = json!(1);
    p["reasons"] = json!(["переключение вручную: быстрое затухание"]);
    p
}
