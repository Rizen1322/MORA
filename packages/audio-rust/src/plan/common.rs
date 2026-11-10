use serde_json::{Value, json};

pub const VERSION: &str = "am-planner-v18-echo-entry-2";
pub type Points = Vec<[f64; 2]>;
pub fn n(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(f64::NAN)
}
pub fn opt(v: &Value, k: &str, default: f64) -> f64 {
    v[k].as_f64().unwrap_or(default)
}
pub fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn nums(v: &Value) -> Vec<f64> {
    arr(v).iter().map(num).collect()
}
pub fn points(v: &Value) -> Points {
    arr(v).iter().map(|p| [num(&p[0]), num(&p[1])]).collect()
}
pub fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}
pub fn r3(v: f64) -> f64 {
    round(v * 1000.) / 1000.
}
/// JavaScript toFixed rounds the exact binary value, with ties away from zero.
pub fn fixed(v: f64, digits: u32) -> String {
    if !v.is_finite() {
        return if v.is_nan() {
            "NaN".into()
        } else if v < 0. {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    }
    if v.abs() >= 1e21 {
        return js_stringify(&json!(v));
    }
    let bits = v.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = if exponent == 0 {
        bits & ((1u64 << 52) - 1)
    } else {
        (bits & ((1u64 << 52) - 1)) | (1u64 << 52)
    };
    let exponent = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let scaled = mantissa as u128 * 10u128.pow(digits);
    let value = if exponent >= 0 {
        scaled << exponent
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let quotient = scaled >> shift;
            let remainder = scaled - (quotient << shift);
            quotient + u128::from(shift > 0 && remainder >= (1u128 << (shift - 1)))
        }
    };
    let mut out = value.to_string();
    if digits > 0 {
        let digits = digits as usize;
        if out.len() <= digits {
            out = format!("{}{}", "0".repeat(digits + 1 - out.len()), out);
        }
        out.insert(out.len() - digits, '.');
    }
    if v < 0. {
        out.insert(0, '-');
    }
    out
}
pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    v.max(a).min(b)
}
pub fn point_value(p: &[[f64; 2]], t: f64) -> f64 {
    if p.is_empty() {
        return 1.;
    }
    if t <= p[0][0] {
        return p[0][1];
    }
    for i in 1..p.len() {
        if t <= p[i][0] {
            let [a, x] = p[i - 1];
            let [b, y] = p[i];
            return if b > a {
                x + (y - x) * (t - a) / (b - a)
            } else {
                y
            };
        }
    }
    p[p.len() - 1][1]
}
pub fn integrate_tempo(p: &[[f64; 2]], time: f64) -> f64 {
    if time <= 0. {
        return time;
    }
    let mut previous = 0.;
    let mut total = 0.;
    for t in p
        .iter()
        .map(|p| p[0])
        .filter(|t| *t > 0. && *t < time)
        .chain(std::iter::once(time))
    {
        total += (t - previous) * (point_value(p, t) + point_value(p, previous)) / 2.;
        previous = t;
    }
    total
}
pub fn output_time_at(p: &[[f64; 2]], delta: f64, limit: f64) -> f64 {
    let (mut lo, mut hi) = (0., limit);
    for _ in 0..32 {
        let mid = (lo + hi) / 2.;
        if integrate_tempo(p, mid) < delta {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.
}
pub fn curve_mean(curve: &[f64], rate: f64, a: f64, b: f64) -> f64 {
    let lo = (a * rate).floor().max(0.).min(curve.len() as f64) as usize;
    let hi = (b * rate)
        .ceil()
        .max((lo + 1) as f64)
        .min(curve.len() as f64) as usize;
    if hi > lo {
        curve[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
    } else {
        curve.last().copied().unwrap_or(0.)
    }
}
pub fn level_mean(an: &Value, a: f64, b: f64) -> f64 {
    curve_mean_values(&an["curves"]["rmsDb"], n(&an["curves"], "rate"), a, b)
}
pub fn curve_mean_values(value: &Value, rate: f64, a: f64, b: f64) -> f64 {
    let curve = arr(value);
    let lo = (a * rate).floor().max(0.).min(curve.len() as f64) as usize;
    let hi = (b * rate)
        .ceil()
        .max((lo + 1) as f64)
        .min(curve.len() as f64) as usize;
    if hi > lo {
        curve[lo..hi].iter().map(num).sum::<f64>() / (hi - lo) as f64
    } else {
        curve.last().map(num).unwrap_or(0.)
    }
}
pub fn power_level(an: &Value, a: f64, b: f64, key: &str) -> f64 {
    let curve = arr(&an["curves"][key]);
    let rate = n(&an["curves"], "rate");
    let lo = (a * rate).floor().max(0.) as usize;
    let hi = (b * rate).ceil().min(curve.len() as f64).max(0.) as usize;
    if hi > lo {
        10. * (curve[lo..hi]
            .iter()
            .map(|v| 10f64.powf(num(v) / 10.))
            .sum::<f64>()
            / (hi - lo) as f64)
            .max(1e-12)
            .log10()
    } else {
        -90.
    }
}
pub fn shape(t0: f64, t1: f64, f: impl Fn(f64) -> f64, count: usize) -> Points {
    (0..=count)
        .map(|i| {
            let x = i as f64 / count as f64;
            [r3(t0 + (t1 - t0) * x), r3(f(x))]
        })
        .collect()
}
pub fn sin_up(x: f64) -> f64 {
    (x * std::f64::consts::PI / 2.).sin()
}
pub fn cos_down(x: f64) -> f64 {
    (x * std::f64::consts::PI / 2.).cos()
}
pub fn smoothstep(x: f64) -> f64 {
    x * x * (3. - 2. * x)
}
pub fn lane(deck: &str, name: &str, parts: Vec<Points>) -> Value {
    let mut out: Points = Vec::new();
    for part in parts {
        for p in part {
            if let Some(last) = out.last_mut() {
                if p[0] < last[0] {
                    continue;
                }
                if p[0] == last[0] {
                    last[1] = p[1];
                    continue;
                }
            }
            out.push(p);
        }
    }
    json!({"deck":deck,"lane":name,"points":out})
}
pub fn fnv1a(s: &str) -> String {
    let mut h = 0x811c9dc5u32;
    for c in s.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(0x01000193);
    }
    if h == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while h > 0 {
        let d = (h % 36) as u8;
        out.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        h /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
pub use crate::js_json::stringify as js_stringify;
pub fn safe_position(position: f64, duration: f64) -> f64 {
    clamp(
        if position.is_finite() { position } else { 0. },
        0.,
        (duration - 0.01).max(0.),
    )
}
pub fn consecutive_album(a: &Value, b: &Value) -> bool {
    if s(a, "album").is_empty()
        || s(b, "album").is_empty()
        || a["album"] != b["album"]
        || s(a, "albumArtist") != s(b, "albumArtist")
        || a["trackNo"].is_null()
        || b["trackNo"].is_null()
    {
        return false;
    }
    let da = a["discNo"].as_f64().unwrap_or(1.);
    let db = b["discNo"].as_f64().unwrap_or(1.);
    if da == db {
        n(b, "trackNo") == n(a, "trackNo") + 1.
    } else {
        db == da + 1. && n(b, "trackNo") == 1.
    }
}
pub fn sanitized_settings(v: &Value) -> Value {
    let mut out = v.clone();
    for (key, default, lo, hi) in [
        ("maxStretchPercent", 12., 0., 30.),
        ("maxBlendSeconds", 32., 0., 60.),
        ("fallbackSeconds", 6., 0., 20.),
    ] {
        out[key] = json!(clamp(
            v[key].as_f64().filter(|v| v.is_finite()).unwrap_or(default),
            lo,
            hi
        ));
    }
    out["entryMode"] = json!(if s(v, "entryMode") == "preserve" {
        "preserve"
    } else {
        "smart"
    });
    out["maxEntrySkipSeconds"] = json!(clamp(
        v["maxEntrySkipSeconds"]
            .as_f64()
            .filter(|v| v.is_finite())
            .unwrap_or(45.),
        0.,
        75.
    ));
    out
}
pub fn feature_key(an: &Value) -> String {
    let version = an["version"].as_str().unwrap_or("undefined");
    let feature = |key: &str| {
        an["vocalActivity"][key]
            .as_str()
            .map(String::from)
            .or_else(|| {
                an["vocalActivity"][key]
                    .as_number()
                    .map(ToString::to_string)
            })
            .unwrap_or_default()
    };
    format!(
        "{}|{}|{}|{}",
        version,
        feature("model"),
        feature("version"),
        feature("revision")
    )
}
pub fn closure_at(st: &Value, t: f64, tolerance: f64) -> f64 {
    let segments = arr(&st["segments"]);
    for (i, seg) in segments.iter().enumerate() {
        if (n(seg, "end") - t).abs() <= tolerance {
            return n(seg, "endClosure");
        }
        if i == 0 && (n(seg, "start") - t).abs() <= tolerance {
            return 0.5;
        }
    }
    segments
        .iter()
        .find(|seg| t > n(seg, "start") && t < n(seg, "end"))
        .map_or(0., |seg| 0.15 * (1. - n(seg, "chorusLikelihood")))
}
pub fn camelot_compatibility(a: &str, b: &str) -> Value {
    let parse = |s: &str| {
        let bytes = s.as_bytes();
        if !(2..=3).contains(&bytes.len())
            || ![b'A', b'B'].contains(bytes.last().unwrap())
            || !bytes[..bytes.len() - 1].iter().all(u8::is_ascii_digit)
        {
            None
        } else {
            Some((
                s[..s.len() - 1].parse::<i32>().ok()?,
                bytes[bytes.len() - 1],
            ))
        }
    };
    let (Some((a, la)), Some((b, lb))) = (parse(a), parse(b)) else {
        return json!({"score":0.5,"label":"тональность неизвестна"});
    };
    let diff = ((a - b + 12) % 12).min((b - a + 12) % 12);
    let (score, label) = if la == lb {
        match diff {
            0 => (1., "та же тональность"),
            1 => (0.85, "соседняя тональность"),
            2 => (0.55, "близкая тональность"),
            7 => (0.45, "энергетический сдвиг"),
            _ => (
                0.05f64.max(0.4 - diff as f64 * 0.06),
                "конфликт тональностей",
            ),
        }
    } else {
        match diff {
            0 => (0.85, "параллельный мажор/минор"),
            1 => (0.55, "диагональный переход"),
            _ => (
                0.05f64.max(0.35 - diff as f64 * 0.05),
                "конфликт тональностей",
            ),
        }
    };
    json!({"score":score,"label":label})
}

#[cfg(test)]
mod decimal_tests {
    use super::fixed;
    #[test]
    fn javascript_fixed_keeps_binary_ties() {
        assert_eq!(fixed(120.25, 1), "120.3");
        assert_eq!(fixed(120.5, 0), "121");
        assert_eq!(fixed(1.005, 2), "1.00");
        assert_eq!(fixed(-0.0, 1), "0.0");
        assert_eq!(fixed(-0.01, 1), "-0.0");
    }
}
