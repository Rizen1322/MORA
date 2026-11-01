use super::{
    common::*,
    context::Ctx,
    primitives::{grid_trust, tempo_relation},
    voice_measure::vocal_mean,
};
use serde_json::{Value, json};

fn region_trusted(an: &Value, region: &Value, trust: &Value) -> bool {
    if trust["trusted"] == true || an["beat"].is_null() {
        return true;
    }
    let family = |x: f64, y: f64| {
        [0.5, 1., 2.]
            .iter()
            .any(|m| (x / (y * m) - 1.).abs() < 0.03)
    };
    if opt(trust, "hintBpm", 0.) != 0. && family(n(region, "bpm"), n(trust, "hintBpm")) {
        return true;
    }
    !family(n(region, "bpm"), n(&an["beat"], "bpm"))
}

struct View {
    analysis: Value,
    region: Option<Value>,
}
fn views(ctx: &Ctx, an: &Value, role: &str) -> Vec<View> {
    let mut list = Vec::new();
    let trust = grid_trust(an);
    if an["beat"]["stable"] == true
        && n(&an["beat"], "confidence") >= 0.45
        && trust["trusted"] == true
    {
        list.push(View {
            analysis: an.clone(),
            region: None,
        });
    }
    let limit = n(an, "audibleStart")
        + opt(ctx.s, "maxEntrySkipSeconds", 45.)
            .min((n(an, "audibleEnd") - n(an, "audibleStart")) * 0.45);
    for region in arr(&an["beatRegions"]) {
        if n(region, "confidence") < 0.55
            || n(region, "end") - n(region, "start") < 12.
            || !region_trusted(an, region, &trust)
        {
            continue;
        }
        if role == "A"
            && ctx
                .requested_at
                .map_or(n(region, "end") < n(an, "audibleEnd") - 24., |at| {
                    n(region, "end") < at + 2. || n(region, "start") > at + 3.
                })
        {
            continue;
        }
        if role == "B"
            && (n(region, "start") > limit
                || s(ctx.s, "entryMode") == "preserve"
                    && n(region, "start") > n(an, "audibleStart") + 0.1)
        {
            continue;
        }
        let entry = nums(&region["downbeats"])
            .into_iter()
            .find(|t| *t >= n(region, "start") && *t <= limit);
        let mut analysis = an.clone();
        analysis["beat"] = region.clone();
        analysis["beat"]["stable"] = json!(true);
        analysis["beat"]["alternatives"] = json!([]);
        if role == "B" {
            if let Some(entry) = entry {
                let mut entries = arr(&analysis["cues"]["entry"]).to_vec();
                entries.push(json!({"time":entry,"score":0.68,"kind":"downbeat","tags":["measured-local-entry"]}));
                analysis["cues"]["entry"] = json!(entries);
            }
        }
        analysis["phrases"] = json!(
            nums(&an["phrases"])
                .into_iter()
                .filter(|t| *t >= n(region, "start") && *t <= n(region, "end"))
                .collect::<Vec<_>>()
        );
        analysis["phraseConfidence"] =
            json!(n(an, "phraseConfidence").min(n(region, "downbeatConfidence")));
        list.push(View {
            analysis,
            region: Some(region.clone()),
        });
    }
    list.truncate(9);
    list
}

pub fn local_rhythm(ctx: &Ctx, a: &Value, b: &Value, key_info: &Value) -> Option<Value> {
    let mut best = None;
    let mut best_score = f64::NEG_INFINITY;
    for av in views(ctx, a, "A") {
        for bv in views(ctx, b, "B") {
            if av.region.is_none() && bv.region.is_none() {
                continue;
            }
            let context = Ctx {
                a: ctx.a,
                b: ctx.b,
                s: ctx.s,
                requested_at: ctx.requested_at,
                vocal_repair: ctx.vocal_repair.clone(),
                fixed: ctx.fixed.clone(),
                region_a: av.region.clone(),
                region_b: bv.region.clone(),
            };
            let rel = tempo_relation(
                n(&av.analysis["beat"], "bpm"),
                n(&bv.analysis["beat"], "bpm"),
            );
            let min_bars =
                if n(&rel, "stretchPercent") <= n(ctx.s, "maxStretchPercent").min(8.) + 1e-6 {
                    1.
                } else if n(&rel, "stretchPercent") <= n(ctx.s, "maxStretchPercent").min(10.) + 1e-6
                    && s(ctx.s, "style") != "tight"
                {
                    8.
                } else {
                    continue;
                };
            let Some(mut plan) = super::beatmatch::beatmatch(
                &context,
                &av.analysis,
                &bv.analysis,
                &rel,
                key_info,
                min_bars,
            ) else {
                continue;
            };
            let tail =
                n(&plan, "aExit") + integrate_tempo(&points(&plan["tempoA"]), n(&plan, "duration"));
            let cut = n(a, "audibleEnd") - tail;
            if ctx.requested_at.is_none()
                && cut > 20.
                && vocal_mean(a, tail, n(a, "audibleEnd")) > 0.2
            {
                continue;
            }
            let score = opt(&plan["debug"], "score", 0.) + 0.1 * n(&plan, "confidence")
                - 0.08 * cut.max(0.) / 24.;
            if score > best_score {
                if !plan["beatAlign"].is_null() {
                    let mut regions = json!({});
                    for (deck, region) in [("A", &av.region), ("B", &bv.region)] {
                        if let Some(r) = region {
                            regions[deck] = json!({"start":r["start"],"end":r["end"],"period":r["period"],"downbeat":r["downbeats"][0]});
                        }
                    }
                    plan["beatAlign"]["regions"] = regions;
                }
                best = Some(plan);
                best_score = score;
            }
        }
    }
    if let Some(p) = &mut best {
        p["reasons"].as_array_mut()?.push(json!(
            "сведение по проверенной локальной сетке: общий BPM всей песни не используется"
        ));
        p["debug"]["localRhythm"] = json!(true);
    }
    best
}
