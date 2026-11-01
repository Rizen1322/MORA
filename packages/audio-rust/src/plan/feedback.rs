use super::{
    common::*,
    fullmix::{lane_value, lead_band_retention},
    primitives::tempo_relation,
};
use serde_json::{Value, json};

fn bucket(x: f64, edges: &[f64], names: &[&'static str]) -> &'static str {
    names[edges
        .iter()
        .position(|edge| x < *edge)
        .unwrap_or(names.len() - 1)]
}
fn geometry(p: &Value) -> Option<[f64; 4]> {
    let duration = n(p, "duration");
    if !duration.is_finite() || duration < 0. || !p["automation"].is_array() {
        return None;
    }
    if arr(&p["automation"]).iter().any(|l| {
        !l["points"].is_array()
            || points(&l["points"])
                .iter()
                .any(|p| !p[0].is_finite() || !p[1].is_finite())
    }) {
        return None;
    }
    let at = |deck: &str, name: &str, t: f64| {
        if t < 0. {
            0.
        } else {
            lane_value(p, deck, name, t)
        }
    };
    let mid = |deck: &str, t: f64| {
        let tt = t - if deck == "B" {
            opt(p, "bDelay", 0.)
        } else {
            0.
        };
        if tt < 0. {
            0.
        } else {
            clamp(at(deck, "gain", tt), 0., 1.) * clamp(lead_band_retention(p, deck, tt), 0., 1.)
        }
    };
    let steps = clamp((duration / 0.1).ceil(), 1., 256.) as usize;
    let dt = duration / steps as f64;
    let (mut overlap, mut exit, mut slope, mut floor) = (0., 0., 0f64, 2f64);
    for i in 0..steps {
        let t = (i as f64 + 0.5) * dt;
        overlap += mid("A", t).min(mid("B", t)) * dt;
        floor = floor.min(
            clamp(at("A", "gain", t), 0., 1.)
                + clamp(at("B", "gain", t - opt(p, "bDelay", 0.)), 0., 1.),
        );
        if mid("A", t) > 0.1 {
            exit = (i + 1) as f64 * dt;
        }
    }
    for l in arr(&p["automation"])
        .iter()
        .filter(|l| ["gain", "mid", "filter"].contains(&s(l, "lane")))
    {
        for w in points(&l["points"]).windows(2) {
            let [a, x] = w[0];
            let [b, y] = w[1];
            if y != x {
                slope = slope.max((y - x).abs() / (b - a).max(0.01));
            }
        }
    }
    Some([overlap, slope, exit, floor])
}
fn rounded(v: &Value) -> Value {
    match v {
        Value::Number(_) => json!(r3(num(v))),
        Value::Array(a) => json!(a.iter().map(rounded).collect::<Vec<_>>()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), rounded(v));
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}
pub fn rating_features(p: &Value, a: &Value, b: &Value) -> Vec<String> {
    let method = s(p, "method");
    let version = if s(p, "version").is_empty() {
        "unknown"
    } else {
        s(p, "version")
    };
    let stretch = p["beatAlign"]["stretchPercent"].as_f64().or_else(|| {
        if !a["beat"].is_null() && !b["beat"].is_null() {
            Some(n(
                &tempo_relation(n(&a["beat"], "bpm"), n(&b["beat"], "bpm")),
                "stretchPercent",
            ))
        } else {
            None
        }
    });
    let mut out = vec![format!("method:{method}")];
    if let Some(stretch) = stretch.filter(|s| s.is_finite()) {
        out.push(format!(
            "bpm:{method}:{}",
            bucket(
                stretch,
                &[2., 5., 8., 12.],
                &["<2", "2-5", "5-8", "8-12", "12+"]
            )
        ));
    }
    if let Some(key) = p["keyInfo"]["compatibility"]
        .as_f64()
        .filter(|x| x.is_finite())
    {
        out.push(format!(
            "key:{method}:{}",
            bucket(key, &[0.5, 0.8], &["low", "mid", "high"])
        ));
    }
    if n(p, "duration").is_finite() {
        out.push(format!(
            "length:{}",
            bucket(
                n(p, "duration"),
                &[4., 10., 20.],
                &["<4", "4-10", "10-20", "20+"]
            )
        ));
    }
    out.push(format!(
        "vocals:{}",
        if !p["vocalA"].is_null() || !p["vocalB"].is_null() {
            "masked"
        } else {
            "none"
        }
    ));
    if let Some([overlap, slope, exit, floor]) = geometry(p) {
        out.push(format!(
            "mid-overlap:geometry-2:{}",
            bucket(
                overlap,
                &[1., 3., 6., 10.],
                &["<1", "1-3", "3-6", "6-10", "10+"]
            )
        ));
        out.push(format!(
            "slope:geometry-2:{}",
            bucket(slope, &[0.15, 0.5, 2.], &["slow", "medium", "fast", "cut"])
        ));
        out.push(format!(
            "gain-floor:geometry-2:{}",
            bucket(
                floor,
                &[0.5, 0.85, 1.15],
                &["deep", "dip", "level", "boost"]
            )
        ));
        if n(a, "audibleEnd").is_finite() && n(p, "aExit").is_finite() {
            let cut =
                (n(a, "audibleEnd") - n(p, "aExit") - integrate_tempo(&points(&p["tempoA"]), exit))
                    .max(0.);
            out.push(format!(
                "cut:geometry-2:{}",
                bucket(
                    cut,
                    &[2., 8., 20., 40.],
                    &["<2", "2-8", "8-20", "20-40", "40+"]
                )
            ));
        }
        let mut recipe = serde_json::Map::new();
        for k in ["method", "aExit", "bEntry", "duration"] {
            if let Some(v) = p.get(k) {
                recipe.insert(k.into(), v.clone());
            }
        }
        recipe.insert("bDelay".into(), json!(opt(p, "bDelay", 0.)));
        for k in ["tempoA", "tempoB", "vocalA", "vocalB"] {
            if let Some(v) = p.get(k) {
                recipe.insert(k.into(), v.clone());
            }
        }
        let mut automation = arr(&p["automation"]).to_vec();
        automation.sort_by_key(|l| format!("{}:{}", s(l, "deck"), s(l, "lane")));
        recipe.insert("automation".into(), json!(automation));
        for k in ["echo", "voiceEcho", "loopA", "tapeStopA", "gainA", "gainB"] {
            if let Some(v) = p.get(k) {
                recipe.insert(k.into(), v.clone());
            }
        }
        if !s(p, "fromTrackId").is_empty() && !s(p, "toTrackId").is_empty() {
            out.push(format!(
                "pair-recipe:{version}:{}:{}",
                fnv1a(&js_stringify(&json!([p["fromTrackId"], p["toTrackId"]]))),
                fnv1a(&js_stringify(&rounded(&Value::Object(recipe))))
            ));
        }
        let shape = p["debug"]["variant"].as_str().unwrap_or("plain");
        out.push(format!("shape:{version}:{shape}"));
        if let Some(preset) = p["debug"]["phraseMix"]["preset"].as_str() {
            out.push(format!("preset:{version}:{preset}"));
        }
        out.push(format!(
            "rhythm:geometry-2:{}:{}",
            if !p["beatAlign"].is_null() {
                "locked"
            } else {
                "free"
            },
            if !p["loopA"].is_null() {
                "loop"
            } else {
                "linear"
            }
        ));
    }
    if n(p, "bEntry").is_finite() && n(b, "audibleStart").is_finite() {
        out.push(format!(
            "entry:geometry-2:{}",
            bucket(
                (n(p, "bEntry") - n(b, "audibleStart")).max(0.),
                &[1., 8., 25.],
                &["start", "1-8", "8-25", "25+"]
            )
        ));
    }
    if let Some(delay) = p["bDelay"].as_f64().filter(|d| d.is_finite()) {
        out.push(format!(
            "delay:geometry-2:{}",
            bucket(delay, &[0.1, 2., 6.], &["none", "<2", "2-6", "6+"])
        ));
    }
    out
}
pub fn rating_bias(stats: &Value, p: &Value, a: &Value, b: &Value) -> Value {
    let mut used = serde_json::Map::new();
    let mut sum = 0.;
    for f in rating_features(p, a, b) {
        let weight = if f.starts_with("pair-recipe:") {
            2.
        } else if ["method:", "bpm:", "key:", "length:", "vocals:"]
            .iter()
            .any(|k| f.starts_with(k))
        {
            1.
        } else {
            0.5
        };
        let mut add = |counts: &Value, key: String| {
            if !counts.is_null() {
                let dev =
                    (n(counts, "good") + 4.) / (n(counts, "good") + n(counts, "bad") + 8.) - 0.5;
                used.insert(key, json!(r3(dev)));
                sum += dev * weight;
            }
        };
        add(&stats["features"][&f], f.clone());
        if let Some(reasons) = stats["reasons"].as_object() {
            for (reason, evidence) in reasons {
                add(&evidence[&f], format!("{reason}/{f}"));
            }
        }
    }
    json!({"bias":r3(clamp(0.8*sum/10.,-0.15,0.15)),"features":used})
}
