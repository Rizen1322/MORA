use super::{
    beatmatch, common::*, context::Ctx, entries::*, feedback, first_words, fullmix, human,
    level_decorators as level, local_rhythm, musical_decorators as musical, primitives::*,
    rhythm_overlap, simple, tempo_decorators as tempo, unlocked, vocal_handoff,
};
use serde_json::{Value, json};

pub fn build(
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
    repair: Option<Value>,
    geometry: Option<Value>,
) -> Value {
    let clean = sanitized_settings(settings);
    let ctx = Ctx {
        a,
        b,
        s: &clean,
        requested_at: requested,
        vocal_repair: repair,
        fixed: geometry,
        region_a: None,
        region_b: None,
    };
    if n(&clean, "maxBlendSeconds") < 0.03 {
        return simple::sequential(
            a,
            b,
            &clean,
            "наложение выключено в настройках длительности",
        );
    }
    if settings["enabled"] != true {
        return simple::sequential(a, b, &clean, "AutoMix выключен: треки играют подряд");
    }
    if a["mixingAllowed"] != true || b["mixingAllowed"] != true {
        return simple::sequential(
            a,
            b,
            &clean,
            "источник не разрешает обработку звука: без наложения",
        );
    }
    if settings["respectAlbums"] == true && consecutive_album(a, b) {
        return simple::sequential(
            a,
            b,
            &clean,
            "треки одного альбома идут подряд: без паузы и без наложения",
        );
    }
    let aa = &a["analysis"];
    let bb = &b["analysis"];
    if aa.is_null() || bb.is_null() {
        return simple::fallback(
            a,
            b,
            &clean,
            if aa.is_null() && bb.is_null() {
                "анализ обоих треков ещё не готов"
            } else if aa.is_null() {
                "анализ текущего трека ещё не готов"
            } else {
                "анализ следующего трека ещё не готов"
            },
        );
    }
    if [aa, bb]
        .iter()
        .any(|an| arr(&an["warnings"]).iter().any(|w| w == "silent"))
    {
        return simple::sequential(a, b, &clean, "в треке нет звука: переход без наложения");
    }
    if (n(aa, "audibleEnd") - n(aa, "audibleStart"))
        .min(n(bb, "audibleEnd") - n(bb, "audibleStart"))
        < 0.06
    {
        return simple::sequential(
            a,
            b,
            &clean,
            "слишком короткий звуковой фрагмент для наложения",
        );
    }
    let trust_a = grid_trust(aa);
    let trust_b = grid_trust(bb);
    let rhythm = |an: &Value, trust: &Value| {
        !an["beat"].is_null()
            && n(&an["beat"], "confidence") >= 0.45
            && an["beat"]["stable"] == true
            && trust["trusted"] == true
    };
    let compatibility = camelot_compatibility(s(&aa["key"], "camelot"), s(&bb["key"], "camelot"));
    let known = n(&aa["key"], "confidence") > 0.15
        && n(&bb["key"], "confidence") > 0.15
        && !s(&aa["key"], "camelot").is_empty()
        && !s(&bb["key"], "camelot").is_empty();
    let key = json!({"a":if s(&aa["key"],"camelot").is_empty(){"?"}else{s(&aa["key"],"camelot")},"b":if s(&bb["key"],"camelot").is_empty(){"?"}else{s(&bb["key"],"camelot")},"compatibility":if known{n(&compatibility,"score")}else{0.5},"label":if known{s(&compatibility,"label")}else{"тональность не определена уверенно"}});
    let reason = if rhythm(aa, &trust_a) && rhythm(bb, &trust_b) {
        let rel = tempo_relation(n(&aa["beat"], "bpm"), n(&bb["beat"], "bpm"));
        let limit = n(&clean, "maxStretchPercent").min(8.);
        if n(&rel, "stretchPercent") <= limit + 1e-6 {
            if let Some(p) = beatmatch::beatmatch(&ctx, aa, bb, &rel, &key, 1.) {
                return p;
            }
            "не нашлось общих фраз с достаточным запасом звука".into()
        } else if n(&rel, "stretchPercent") <= n(&clean, "maxStretchPercent").min(10.) + 1e-6
            && s(&clean, "style") != "tight"
        {
            if let Some(p) = beatmatch::beatmatch(&ctx, aa, bb, &rel, &key, 8.) {
                return p;
            }
            format!(
                "темп отличается на {} %: для такой разницы нужна долгая плавная стыковка, а места для неё нет — мягкий переход без стыковки ритмов",
                fixed(n(&rel, "stretchPercent"), 1)
            )
        } else {
            format!(
                "темп отличается слишком сильно для сведения по битам: {} и {} BPM (нужно {} %, без слышимого растяжения до {} %): мягкий переход без стыковки ритмов",
                fixed(n(&aa["beat"], "bpm"), 1),
                fixed(n(&bb["beat"], "bpm"), 1),
                fixed(n(&rel, "stretchPercent"), 1),
                limit
            )
        }
    } else if aa["beat"].is_null() || bb["beat"].is_null() {
        "у одного из треков нет устойчивого ритма".into()
    } else if trust_a["trusted"] != true || trust_b["trusted"] != true {
        "повторы музыки не ложатся на такты найденной сетки битов: такты не совпадут, сведение по этой сетке не используется".into()
    } else {
        "сетка битов неустойчива или уверенность низкая".into()
    };
    let annotate = |mut p: Value| {
        if trust_a["trusted"] != true || trust_b["trusted"] != true {
            p["debug"]["gridTrust"] = json!({"A":trust_a,"B":trust_b});
        }
        p
    };
    if let Some(p) = local_rhythm::local_rhythm(&ctx, aa, bb, &key) {
        return annotate(p);
    }
    let mut grid_a = aa.clone();
    let mut grid_b = bb.clone();
    if trust_a["trusted"] != true {
        grid_a["beat"] = Value::Null;
    }
    if trust_b["trusted"] != true {
        grid_b["beat"] = Value::Null;
    }
    annotate(unlocked::plan_unlocked(
        &ctx,
        &grid_a,
        &grid_b,
        &key,
        Some(&reason),
    ))
}
pub fn finish(p: Value, a: &Value, b: &Value, settings: &Value, requested: Option<f64>) -> Value {
    let timed = tempo::master_tempo(p, a, b, settings, requested);
    let mut p =
        vocal_handoff::apply_vocal_handoff(level::hold_loudness(timed, a, b), a, b, settings);
    if (!p["vocalA"].is_null() || !p["vocalB"].is_null())
        && (!a["vocalActivity"]["accompanimentRmsDb"].is_null()
            || !b["vocalActivity"]["accompanimentRmsDb"].is_null())
    {
        p = level::hold_loudness(p, a, b);
    }
    if settings["eqHandoff"] == true
        && requested.is_none()
        && s(&p, "method") == "beatmatch_blend"
        && !a.is_null()
        && !b.is_null()
    {
        p = level::phrase_bass_swap(p, a, b);
    }
    if settings["eqHandoff"] == true && requested.is_none() && !a.is_null() && !b.is_null() {
        p = level::bass_continuity(p, a, b);
    }
    p = musical::dj_phrasing(
        musical::instrumental_loop(p, a, b, settings, requested),
        a,
        b,
        settings,
        requested,
    );
    if requested.is_none() {
        p = first_words::with_vocal_gap(
            first_words::preserve_first_words(p, a, b, settings),
            a,
            b,
            settings,
        );
    }
    if opt(&p, "bDelay", 0.) != 0. || !p["debug"]["vocalGap"].is_null() {
        return p;
    }
    p = tempo::micro_onset(p, a, b, settings, requested);
    tempo::tape_stop(
        tempo::harmonic_handoff(
            musical::voice_answer(p, a, b, settings, requested),
            a,
            b,
            settings,
            requested,
        ),
        a,
        b,
        settings,
        requested,
    )
}
fn active_feedback(fb: &Value) -> Option<&Value> {
    (!fb.is_null()
        && (fb["features"].as_object().is_some_and(|v| !v.is_empty())
            || fb["reasons"].as_object().is_some_and(|v| !v.is_empty())))
    .then_some(fb)
}
struct Rated {
    name: String,
    plan: Value,
    cost: Option<Value>,
    bias: f64,
}
fn ratings(entries: &mut [Rated], fb: Option<&Value>, a: &Value, b: &Value) -> Option<Value> {
    let fb = fb?;
    let mut rows = Vec::new();
    for entry in entries {
        let rating = feedback::rating_bias(fb, &entry.plan, a, b);
        entry.bias = n(&rating, "bias");
        rows.push(json!({"name":entry.name,"bias":entry.bias,"features":rating["features"]}));
    }
    Some(json!({"policy":"listener-ratings-1","version":fb["version"],"candidates":rows}))
}
fn full_mix(p: Value, a: &Value, b: &Value, settings: &Value, fb: Option<&Value>) -> Vec<Value> {
    let aa = &a["analysis"];
    let bb = &b["analysis"];
    let clean = sanitized_settings(settings);
    if aa.is_null()
        || bb.is_null()
        || p["debug"]["processingAllowed"] == false
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || !p["loopA"].is_null()
    {
        return vec![p];
    }
    let make = |settings: &Value, fixed: Option<Value>| {
        finish(
            build(a, b, settings, None, None, fixed),
            aa,
            bb,
            settings,
            None,
        )
    };
    let mut entries = vec![("baseline".to_string(), p.clone())];
    entries.extend(human::automatic_scenarios(&p, aa, bb, &clean));
    if s(&p, "method") == "beatmatch_blend"
        && !p["beatAlign"].is_null()
        && p["beatAlign"]["regions"].is_null()
        && !aa["beat"].is_null()
    {
        let bars = n(&p["beatAlign"], "overlapBeats") / 4.;
        let bar_a = n(&aa["beat"], "period") * 4.;
        let base = fullmix::full_mix_cost(&p, aa, bb, &clean);
        let fault = base.as_ref().is_some_and(|c| {
            n(c, "unsupported") > 0.
                || n(c, "holeDb") > 6.
                || n(c, "jumpDb") > 2.
                || n(c, "doubleBass") / n(&p, "duration") > 0.2
        });
        if bars > 4.
            && (fullmix::voice_unknown(aa, &clean)
                || fullmix::voice_unknown(bb, &clean)
                || fault
                || p["debug"]["fullMixRules"]["looseGrid"] == true)
        {
            let half = 4f64.max(bars / 2.);
            let q = make(
                &clean,
                Some(json!({"exit":p["aExit"],"entry":p["bEntry"],"bars":half})),
            );
            if s(&q, "method") == "beatmatch_blend"
                && n(&q["beatAlign"], "overlapBeats") == half * 4.
            {
                entries.push(("shorter".into(), q));
            }
        }
        if let Some(near) = arr(&p["debug"]["candidates"]).iter().find(|c| {
            n(c, "bars") == bars
                && (n(c, "exit") - n(&p, "aExit")).abs() >= 4. * bar_a - 0.05
                && (n(c, "exit") - n(&p, "aExit")).abs() <= 8. * bar_a + 0.05
        }) {
            let q = make(
                &clean,
                Some(json!({"exit":near["exit"],"entry":near["entry"],"bars":near["bars"]})),
            );
            if s(&q, "method") == "beatmatch_blend"
                && (n(&q, "aExit") - n(near, "exit")).abs() < 0.01
            {
                entries.push(("neighbor-exit".into(), q));
            }
        }
        if p["debug"]["fullMixRules"]["looseGrid"] == true {
            let mut settings = clean.clone();
            settings["maxStretchPercent"] = json!(0);
            let q = make(&settings, None);
            if s(&q, "method") != "beatmatch_blend"
                && ["crossfade", "beatmatch_blend"].contains(&s(&q, "method"))
            {
                entries.push(("unlocked".into(), q));
            }
        }
    }
    if s(&clean, "entryMode") != "preserve"
        && clean["maxEntrySkipSeconds"] != 0
        && n(&p, "bEntry") - n(bb, "audibleStart") >= 2.
    {
        let mut settings = clean.clone();
        settings["entryMode"] = json!("preserve");
        let q = make(&settings, None);
        if ["crossfade", "beatmatch_blend"].contains(&s(&q, "method"))
            && n(&q, "bEntry") < n(&p, "bEntry") - 1.
            && (s(&p, "method") != "beatmatch_blend" || s(&q, "method") == "beatmatch_blend")
        {
            entries.push(("preserve-start".into(), q));
        }
    }
    let mut rated: Vec<Rated> = entries
        .into_iter()
        .take(9)
        .map(|(name, plan)| {
            let cost = fullmix::full_mix_cost(&plan, aa, bb, &clean);
            Rated {
                name,
                plan,
                cost,
                bias: 0.,
            }
        })
        .collect();
    let rating_debug = ratings(&mut rated, fb, aa, bb);
    let automatic = |i: usize| {
        if i == 0 {
            return true;
        }
        let (Some(x), Some(y)) = (&rated[0].cost, &rated[i].cost) else {
            return false;
        };
        let q = &rated[i].plan;
        if fullmix::has_material_mix_regression(x, y) {
            return false;
        }
        if p["debug"]["fullMixRules"]["looseGrid"] == true && rated[i].name == "unlocked" {
            return true;
        }
        if !p["debug"]["drumPattern"].is_null() && q["debug"]["drumPattern"].is_null()
            || !p["beatAlign"].is_null() && q["beatAlign"].is_null()
            || p["beatAlign"]["phraseAligned"] == true && q["beatAlign"]["phraseAligned"] != true
            || n(q, "bEntry") > n(&p, "bEntry") + 0.1
            || !p["debug"]["washout"].is_null() && q["debug"]["washout"].is_null()
            || !p["debug"]["loudnessHold"].is_null()
                && q["debug"]["loudnessHold"].is_null()
                && !(n(x, "holeDb") > 3. && n(y, "holeDb") < n(x, "holeDb") - 1.5)
        {
            return false;
        }
        let substantial = n(x, "holeDb") > 3. && n(y, "holeDb") < n(x, "holeDb") - 1.5
            || n(x, "unsupported") >= 1. && n(y, "unsupported") <= n(x, "unsupported") - 0.75
            || n(x, "jumpDb") > 2. && n(y, "jumpDb") < n(x, "jumpDb") - 1.
            || n(x, "cutA") > 0.5 && n(y, "cutA") < n(x, "cutA") - 0.3
            || n(x, "skippedUnknownB") > 2.
                && n(y, "skippedUnknownB") < n(x, "skippedUnknownB") - 2.;
        let no_new = n(y, "holeDb") <= n(x, "holeDb") + 0.5
            && n(y, "jumpDb") <= n(x, "jumpDb") + 0.5
            && n(y, "unsupported") <= n(x, "unsupported") + 0.25
            && n(y, "cutA") <= n(x, "cutA") + 0.1
            && n(y, "pickup") <= n(x, "pickup")
            && n(y, "openingSuppression") <= n(x, "openingSuppression") + 0.5;
        substantial && no_new
    };
    let adj = |i: usize| n(rated[i].cost.as_ref().unwrap(), "total") - rated[i].bias;
    let safe = |i: usize| {
        let Some(base) = &rated[0].cost else {
            return true;
        };
        let c = rated[i].cost.as_ref().unwrap();
        rating_debug.is_none()
            || n(c, "total") < n(base, "total") - 0.1
            || n(c, "unsupported") <= n(base, "unsupported")
                && n(c, "holeDb") <= n(base, "holeDb") + 0.5
                && n(c, "jumpDb") <= n(base, "jumpDb") + 0.5
    };
    let mut valid: Vec<usize> = (0..rated.len())
        .filter(|i| rated[*i].cost.is_some())
        .collect();
    valid.sort_by(|a, b| adj(*a).total_cmp(&adj(*b)));
    let best = valid.iter().find(|i| automatic(**i) && safe(**i));
    let winner = if rated[0].cost.is_some() {
        best.filter(|i| **i != 0 && adj(**i) < adj(0) - 0.1)
            .copied()
            .unwrap_or(0)
    } else {
        0
    };
    let reason = if rated[0].cost.is_none() {
        "полосы не измерены: исходный план".to_string()
    } else if winner == 0 {
        "альтернативы полного микса не дали заметного улучшения".into()
    } else if !rated[winner].plan["debug"]["humanScenario"].is_null() {
        arr(&rated[winner].plan["reasons"])
            .last()
            .and_then(Value::as_str)
            .unwrap_or("переход привязан к измеренной структуре")
            .into()
    } else {
        match rated[winner].name.as_str(){"shorter"=>"полный микс: короче общий участок, A уходит по окончании своего раздела","neighbor-exit"=>"полный микс: выход на соседней фразе, где текущий трек слышно заканчивает раздел","unlocked"=>"полный микс: без стыковки ритмов, ровнее путь громкости и баса",_=>"полный микс: следующий трек входит со своего начала, без срезанного затакта и вступления"}.into()
    };
    let candidates:Vec<Value>=rated.iter().enumerate().map(|(i,c)|{let mut v=json!({"name":c.name,"method":c.plan["method"],"duration":c.plan["duration"],"bEntry":c.plan["bEntry"],"automaticEligible":automatic(i),"cost":c.cost,"rhythmOverlap":rhythm_overlap::rhythm_overlap(&c.plan,aa,bb)});if let Some(variant)=c.plan["debug"].get("variant"){v["variant"]=variant.clone();}v}).collect();
    let debug = json!({"policy":"full-mix-1","selected":rated[winner].name,"reason":reason,"margin":0.1,"candidates":candidates});
    let label = |i: usize| {
        let c = &rated[i];
        let mut plan = c.plan.clone();
        if i != 0 {
            plan["id"] = json!(format!("{}_{}", s(&plan, "id"), c.name));
        }
        if i == winner && i != 0 {
            plan["reasons"].as_array_mut().unwrap().push(json!(reason));
        }
        let mut full = debug.clone();
        full["this"] = json!(c.name);
        plan["debug"]["fullMix"] = full;
        if let Some(rating) = &rating_debug {
            let mut rating = rating.clone();
            rating["selected"] = json!(rated[winner].name);
            rating["margin"] = json!(0.1);
            plan["debug"]["ratingFeedback"] = rating;
        }
        plan
    };
    let mut output = vec![label(winner)];
    valid.extend((0..rated.len()).filter(|i| rated[*i].cost.is_none()));
    output.extend(valid.into_iter().filter(|i| *i != winner).map(label));
    output
}
fn musical_cost(q: &Value, a: &Value, b: &Value, known: bool) -> Option<Value> {
    let delay = opt(q, "bDelay", 0.);
    let end_b = n(q, "bEntry") + integrate_tempo(&points(&q["tempoB"]), n(q, "duration") - delay);
    if !known
        || super::voice_measure::first_voice(
            a,
            n(a, "audibleStart").max(n(q, "aExit") - 2.),
            n(a, "audibleEnd"),
        )
        .is_none()
        || super::voice_measure::first_voice(b, n(q, "bEntry"), end_b).is_none()
        || !unlocked::measured_curves(
            a,
            n(a, "audibleStart").max(n(q, "aExit") - 2.),
            n(a, "audibleEnd"),
        )
        || !unlocked::measured_curves(b, n(q, "bEntry"), n(b, "audibleEnd").min(end_b + 3.))
    {
        return None;
    }
    let at = |deck: &str, name: &str, t: f64| {
        arr(&q["automation"])
            .iter()
            .find(|l| s(l, "deck") == deck && s(l, "lane") == name)
            .map_or(1., |l| point_value(&points(&l["points"]), t))
    };
    let reference = (level_before(a, n(q, "aExit")) + n(q, "gainA"))
        .min(power_level(b, end_b, n(b, "audibleEnd").min(end_b + 3.), "rmsDb") + n(q, "gainB"));
    let (mut lost_a, mut lost_b, mut voice_overlap, mut drum_overlap, mut hole) =
        (0., 0., 0., 0., 0f64);
    for i in 0..32 {
        let t = n(q, "duration") * (i as f64 + 0.5) / 32.;
        let dt = n(q, "duration") / 32.;
        let tb = t - delay;
        let sa = n(q, "aExit") + integrate_tempo(&points(&q["tempoA"]), t);
        let sb = n(q, "bEntry") + integrate_tempo(&points(&q["tempoB"]), tb.max(0.));
        let va = super::voice_measure::vocal_mean(a, sa, sa + 0.05);
        let vb = if tb < 0. {
            0.
        } else {
            super::voice_measure::vocal_mean(b, sb, sb + 0.05)
        };
        let ma = point_value(&points(&q["vocalA"]), t);
        let mb = point_value(&points(&q["vocalB"]), tb);
        let ag = at("A", "gain", t);
        let bg = if tb < 0. { 0. } else { at("B", "gain", tb) };
        lost_a += va * (1. - (ag * ma).min(1.)) * dt;
        lost_b += vb * (1. - (bg * mb).min(1.)) * dt;
        voice_overlap += (va * ag * ma).min(vb * bg * mb) * dt;
        if s(q, "method") != "beatmatch_blend" {
            drum_overlap += (ag * at("A", "low", t)).min(bg * at("B", "low", tb))
                * dt
                * n(a, "rhythmStrength")
                * n(b, "rhythmStrength");
        }
        let power = ag
            * ag
            * filtered_power(
                a,
                sa,
                n(q, "gainA"),
                at("A", "low", t),
                at("A", "mid", t),
                at("A", "high", t),
                ma,
            )
            + bg * bg
                * filtered_power(
                    b,
                    sb,
                    n(q, "gainB"),
                    at("B", "low", tb),
                    at("B", "mid", tb),
                    at("B", "high", tb),
                    mb,
                );
        hole = hole.max(reference - 10. * power.max(1e-12).log10() - 3.);
    }
    let tail = n(q, "aExit") + integrate_tempo(&points(&q["tempoA"]), n(q, "duration"));
    if tail < n(a, "audibleEnd") {
        lost_a += super::voice_measure::vocal_mean(a, tail, n(a, "audibleEnd"))
            * (n(a, "audibleEnd") - tail);
    }
    let total = 0.16 * lost_a
        + 0.8 * lost_b
        + 0.5 * voice_overlap
        + 0.2 * drum_overlap
        + 0.2 * hole.max(0.)
        + if s(q, "method") == "phrase_cut" {
            0.3
        } else {
            0.
        };
    if !total.is_finite() {
        return None;
    }
    Some(
        json!({"total":r3(total),"cutA":first_words::outgoing_phrase_cut(q,a).is_some(),"lostA":r3(lost_a),"lostB":r3(lost_b),"voiceOverlap":r3(voice_overlap),"drumOverlap":r3(drum_overlap),"holeDb":r3(hole.max(0.))}),
    )
}
fn choose_musical(
    p: Value,
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
    fb: Option<&Value>,
) -> Value {
    let aa = &a["analysis"];
    let bb = &b["analysis"];
    if requested.is_some()
        || settings["enabled"] != true
        || aa.is_null()
        || bb.is_null()
        || p["debug"]["processingAllowed"] == false
        || !p["loopA"].is_null()
        || !p["beatAlign"]["regions"].is_null()
        || !["crossfade", "beatmatch_blend"].contains(&s(&p, "method"))
        || grid_trust(aa)["trusted"] != true
        || grid_trust(bb)["trusted"] != true
    {
        return p;
    }
    let end_b = n(&p, "bEntry")
        + integrate_tempo(
            &points(&p["tempoB"]),
            n(&p, "duration") - opt(&p, "bDelay", 0.),
        );
    let known = super::voice_measure::first_voice(
        aa,
        n(aa, "audibleStart").max(n(&p, "aExit") - 2.),
        n(aa, "audibleEnd"),
    )
    .is_some()
        && super::voice_measure::first_voice(bb, n(&p, "bEntry"), end_b).is_some()
        && unlocked::measured_curves(
            aa,
            n(aa, "audibleStart").max(n(&p, "aExit") - 2.),
            n(aa, "audibleEnd"),
        )
        && unlocked::measured_curves(bb, n(&p, "bEntry"), n(bb, "audibleEnd").min(end_b + 3.));
    let mut entries = vec![("baseline".to_string(), p.clone())];
    if known {
        let clean = sanitized_settings(settings);
        let protection = &p["debug"]["firstWords"];
        let repair = json!({"entry":p["bEntry"],"minHandoff":n(&p,"aExit")+integrate_tempo(&points(&p["tempoA"]),opt(protection,"previousHandoff",n(&p,"swapAt")))-0.5});
        if s(&p, "method") == "beatmatch_blend"
            && n(&p, "duration") > 8.
            && (protection["wholeDeckFade"] == true || protection["earlyStemHandoff"] == true)
        {
            let q = finish(
                build(a, b, settings, None, Some(repair.clone()), None),
                aa,
                bb,
                settings,
                None,
            );
            if s(&q, "method") == "beatmatch_blend"
                && (n(&q, "bEntry") - n(&p, "bEntry")).abs() < 0.001
                && n(&q, "duration") < n(&p, "duration") - 0.1
                && q["beatAlign"]["regions"].is_null()
            {
                entries.push(("short-phrase".into(), q));
            }
        }
        let ga = &aa["beat"];
        let gb = &bb["beat"];
        if !ga.is_null()
            && !gb.is_null()
            && ga["stable"] == true
            && gb["stable"] == true
            && n(ga, "confidence") >= 0.8
            && n(gb, "confidence") >= 0.8
            && n(ga, "downbeatConfidence") >= 0.7
            && n(gb, "downbeatConfidence") >= 0.7
            && n(ga, "jitterMs") <= 12.
            && n(gb, "jitterMs") <= 12.
            && n(aa, "phraseConfidence") >= 0.6
            && n(
                &tempo_relation(n(ga, "bpm"), n(gb, "bpm")),
                "stretchPercent",
            ) > 10f64.max(n(settings, "maxStretchPercent"))
        {
            let ctx = Ctx {
                a,
                b,
                s: &clean,
                requested_at: None,
                vocal_repair: Some(repair),
                fixed: None,
                region_a: None,
                region_b: None,
            };
            if let Some(q) =
                unlocked::plan_phrase_cut(&ctx, aa, bb, &p["keyInfo"], p["fallbackReason"].as_str())
            {
                if q["beatAlign"]["phraseAligned"] == true
                    && (n(&q, "bEntry") - n(&p, "bEntry")).abs() < 0.001
                {
                    entries.push(("phrase-cut".into(), finish(q, aa, bb, settings, None)));
                }
            }
        }
    }
    let mut rated: Vec<Rated> = entries
        .into_iter()
        .map(|(name, plan)| {
            let cost = musical_cost(&plan, aa, bb, known);
            Rated {
                name,
                plan,
                cost,
                bias: 0.,
            }
        })
        .collect();
    let rating_debug = ratings(&mut rated, fb, aa, bb);
    let mut winner = 0;
    let adj = |i: usize| n(rated[i].cost.as_ref().unwrap(), "total") - rated[i].bias;
    for i in 1..rated.len() {
        if let (Some(c), Some(w)) = (&rated[i].cost, &rated[winner].cost) {
            if (adj(i) < adj(winner) - 0.15
                || w["cutA"] == true
                    && c["cutA"] != true
                    && adj(i) <= adj(winner)
                    && n(c, "lostB") <= n(w, "lostB")
                    && n(c, "voiceOverlap") <= n(w, "voiceOverlap"))
                && n(c, "holeDb") <= 3f64.max(n(w, "holeDb") + 0.5)
            {
                winner = i;
            }
        }
    }
    let reason = if !known {
        "измерения неполны: исходный план, неизвестный вокал не оценивался как тишина"
    } else if winner == 0 {
        "альтернативы не дали подтверждённого улучшения с запасом"
    } else {
        "меньше потерянных фраз и конфликтов без ухудшения расчётного провала мощности"
    };
    let mut output = rated[winner].plan.clone();
    if winner == 0 {
        output["id"] = p["id"].clone();
    } else {
        output["id"] = json!(format!("{}_{}", s(&output, "id"), rated[winner].name));
        output["reasons"]
            .as_array_mut()
            .unwrap()
            .push(json!(reason));
    }
    output["debug"]["candidateSelection"] = json!({"policy":"metadata-candidates-1","baseline":"baseline","selected":rated[winner].name,"reason":reason,"knownCoverage":known,"margin":0.15,"candidates":rated.iter().map(|c|json!({"name":c.name,"method":c.plan["method"],"duration":c.plan["duration"],"cost":c.cost})).collect::<Vec<_>>()});
    if let Some(mut debug) = rating_debug {
        debug["selected"] = json!(rated[winner].name);
        debug["margin"] = json!(0.15);
        output["debug"]["ratingFeedback"] = debug;
    }
    output
}
pub fn rank(
    a: &Value,
    b: &Value,
    settings: &Value,
    requested: Option<f64>,
    fb: &Value,
) -> Vec<Value> {
    let p = finish(
        build(a, b, settings, requested, None, None),
        &a["analysis"],
        &b["analysis"],
        settings,
        requested,
    );
    let fb = active_feedback(fb);
    if requested.is_none()
        && settings["enabled"] == true
        && fullmix::full_mix_pair(&a["analysis"], &b["analysis"], settings)
    {
        return full_mix(p, a, b, settings, fb);
    }
    vec![choose_musical(p, a, b, settings, requested, fb)]
}
fn finalists(a: &Value, b: &Value, settings: &Value, fb: &Value) -> Vec<Value> {
    let ranked = rank(a, b, settings, None, fb);
    let top = &ranked[0];
    if top["debug"]["fullMix"].is_null() {
        return vec![top.clone()];
    }
    let beat = opt(&b["analysis"]["beat"], "period", 0.5)
        / point_value(&points(&top["tempoB"]), n(top, "swapAt"));
    let mut shifted = if ["beatmatch_blend", "crossfade"].contains(&s(top, "method")) {
        [-1., 1.]
            .into_iter()
            .filter_map(|k| fullmix::with_bass_shift(top, k * beat))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let active = active_feedback(fb);
    let full = &top["debug"]["fullMix"];
    let rating = &top["debug"]["ratingFeedback"];
    for q in &mut shifted {
        let dt = n(&q["debug"], "bassShift");
        let name = format!("bass-shift-{}", r3(dt));
        let measured = fullmix::full_mix_cost(
            q,
            &a["analysis"],
            &b["analysis"],
            &sanitized_settings(settings),
        );
        let inherited = full
            .get("this")
            .and_then(Value::as_str)
            .unwrap_or("baseline");
        let mut entry = json!({"name":name,"cost":measured});
        if let Some(eligible) = arr(&full["candidates"])
            .iter()
            .find(|c| s(c, "name") == inherited)
            .and_then(|c| c.get("automaticEligible"))
        {
            entry["automaticEligible"] = eligible.clone();
        }
        let mut debug = full.clone();
        debug["this"] = json!(name);
        let mut candidates = arr(&full["candidates"]).to_vec();
        candidates.push(entry);
        debug["candidates"] = json!(candidates);
        q["debug"]["fullMix"] = debug;
        if let Some(fb) = active {
            let bias = feedback::rating_bias(fb, q, &a["analysis"], &b["analysis"]);
            let mut debug = if rating.is_null() {
                json!({})
            } else {
                rating.clone()
            };
            let mut rows = arr(&rating["candidates"]).to_vec();
            rows.push(json!({"name":name,"bias":bias["bias"],"features":bias["features"]}));
            debug["candidates"] = json!(rows);
            q["debug"]["ratingFeedback"] = debug;
        }
    }
    let mut indices: Vec<usize> = (1..ranked.len().min(3)).collect();
    if let Some(index) = ranked
        .iter()
        .position(|p| s(&p["debug"]["fullMix"], "this") == "baseline")
    {
        if index != 0 && !indices.contains(&index) {
            indices.push(index);
        }
    }
    let family = |i: usize| {
        ranked[i]["debug"]["humanScenario"]
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("baseline")
            .to_string()
    };
    let mut families = vec![family(0)];
    families.extend(indices.iter().map(|i| family(*i)));
    for i in 0..ranked.len() {
        if let Some(kind) = ranked[i]["debug"]["humanScenario"]
            .get("kind")
            .and_then(Value::as_str)
        {
            if !families.iter().any(|f| f == kind) && indices.len() < 4 {
                indices.push(i);
                families.push(kind.into());
            }
        }
    }
    let mut output = vec![top.clone()];
    output.extend(indices.into_iter().map(|i| ranked[i].clone()));
    output.extend(shifted);
    output
}
fn requested(a: &Value, b: &Value, position: f64, settings: &Value) -> Value {
    let clean = sanitized_settings(settings);
    let now = safe_position(position, n(a, "duration"));
    if clean["enabled"] != true
        || clean["mixOnNext"] == false
        || a["mixingAllowed"] != true
        || b["mixingAllowed"] != true
    {
        return simple::skip(a, b, now, &clean);
    }
    let aa = &a["analysis"];
    let bb = &b["analysis"];
    let mut limited = clean.clone();
    limited["maxBlendSeconds"] = json!(8f64.min(n(&clean, "maxBlendSeconds")));
    let mut model = rank(a, b, &limited, Some(now), &Value::Null).remove(0);
    if s(&model, "method") == "gapless" {
        return simple::skip(a, b, now, &clean);
    }
    let exit = n(&model, "aExit");
    let pts = if model["tempoA"].is_null() {
        vec![[0., 1.]]
    } else {
        points(&model["tempoA"])
    };
    let mut knots = vec![0.];
    knots.extend(
        pts.iter()
            .map(|p| p[0])
            .filter(|t| *t > 0. && *t < n(&model, "duration")),
    );
    knots.push(n(&model, "duration"));
    let value = |t: f64| {
        for i in 1..pts.len() {
            if t <= pts[i][0] {
                return pts[i - 1][1]
                    + (pts[i][1] - pts[i - 1][1]) * (t - pts[i - 1][0])
                        / (pts[i][0] - pts[i - 1][0]);
            }
        }
        pts.last().unwrap()[1]
    };
    let consumed = knots
        .windows(2)
        .map(|p| (p[1] - p[0]) * (value(p[1]) + value(p[0])) / 2.)
        .sum::<f64>();
    if exit.is_finite()
        && exit + consumed <= n(a, "duration").min(opt(aa, "audibleEnd", n(a, "duration")))
        && !["crossfade", "fallback_crossfade"].contains(&s(&model, "method"))
    {
        model["id"] = json!(format!(
            "{}_request_{}",
            s(&model, "id"),
            round(now * 1000.)
        ));
        model["aExit"] = json!(r3(exit));
        let mut reasons = vec![json!(
            "переход по кнопке «Следующий»: начинается у ближайшей музыкальной доли"
        )];
        reasons.extend(
            arr(&model["reasons"])
                .iter()
                .filter(|r| {
                    !r.as_str().unwrap_or("").contains("финала")
                        && !r.as_str().unwrap_or("").contains("до конца")
                })
                .cloned(),
        );
        model["reasons"] = json!(reasons);
        model["debug"]["requested"] = json!(true);
        model["debug"]["requestedAt"] = json!(now);
        return model;
    }
    let ctx = Ctx {
        a,
        b,
        s: &clean,
        requested_at: None,
        vocal_repair: None,
        fixed: None,
        region_a: None,
        region_b: None,
    };
    let mut p = ctx.base(if !aa.is_null() && !bb.is_null() {
        "crossfade"
    } else {
        "fallback_crossfade"
    });
    let duration = 6f64
        .min(n(&clean, "maxBlendSeconds"))
        .min(opt(aa, "audibleEnd", n(a, "duration")) - now - 0.08)
        .min(opt(bb, "audibleEnd", n(b, "duration")) - opt(bb, "audibleStart", 0.));
    if duration < 0.2 {
        return simple::skip(a, b, now, &clean);
    }
    p["id"] = json!(format!("{}_request_{}", s(&p, "id"), round(now * 1000.)));
    p["aExit"] = json!(r3(now + 0.08));
    p["duration"] = json!(r3(duration));
    p["swapAt"] = json!(r3(duration / 2.));
    let selected = if !aa.is_null() && !bb.is_null() {
        Some(pick_handoff(
            &ctx,
            aa,
            bb,
            n(&p, "aExit"),
            duration / 2.,
            duration,
            false,
        ))
    } else {
        None
    };
    p["bEntry"] = json!(r3(selected
        .as_ref()
        .map_or(opt(bb, "audibleStart", 0.), |c| n(&c.cue, "time"))));
    let mut automation = vec![
        lane("A", "gain", vec![shape(0., duration, cos_down, 16)]),
        lane("B", "gain", vec![shape(0., duration, sin_up, 16)]),
    ];
    if clean["eqHandoff"] == true {
        automation.push(lane(
            "A",
            "low",
            vec![
                vec![[0., 1.]],
                shape(duration * 0.35, duration * 0.65, |x| 1. - smoothstep(x), 8),
            ],
        ));
        automation.push(lane(
            "B",
            "low",
            vec![
                vec![[0., 0.]],
                shape(duration * 0.35, duration * 0.65, smoothstep, 8),
            ],
        ));
    }
    p["automation"] = json!(automation);
    p["confidence"] = json!(if !aa.is_null() && !bb.is_null() {
        0.65
    } else {
        0.3
    });
    p["reasons"] = json!([
        "переход по кнопке «Следующий»: плавная передача из текущего места",
        format!(
            "наложение {} с с выравниванием громкости",
            fixed(duration, 1)
        )
    ]);
    if let Some(c) = selected {
        describe_entry(&mut p, bb, &c.cue, c.arrival);
    }
    p["debug"] = json!({"requested":true,"requestedAt":now});
    finish(p, aa, bb, &clean, Some(now))
}
pub fn dispatch(input: &Value) -> Result<Value, String> {
    let a = &input["from"];
    let b = &input["to"];
    for track in [a, b] {
        if !track.is_object()
            || s(track, "id").is_empty()
            || !n(track, "duration").is_finite()
            || n(track, "duration") < 0.
            || !track["mixingAllowed"].is_boolean()
        {
            return Err("Invalid planner track".into());
        }
    }
    let settings = &input["settings"];
    if !settings.is_object() {
        return Err("Invalid planner settings".into());
    }
    Ok(match input["mode"].as_str().unwrap_or("normal") {
        "normal" => rank(a, b, settings, None, &input["feedback"]).remove(0),
        "finalists" => json!(finalists(a, b, settings, &input["feedback"])),
        "skip" => simple::skip(a, b, n(input, "position"), settings),
        "requested" => requested(a, b, n(input, "position"), settings),
        "creative" => super::creative::plan(a, b, settings, s(input, "style")),
        _ => return Err("Unknown planner mode".into()),
    })
}
