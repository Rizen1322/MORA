// v20 echo-out flavors: the desktop planner picks washout / dub / brake from B's opening, and the
// echo's ping-pong cross-feed alternates the repeats L, R, L (TS twin: packages/core/test/echo-flavors.test.ts).
use mora_audio::{dsp::Echo, plan::plan};
use serde_json::{json, Value};

fn song(id: &str, bpm: f64, intro: &[(&str, f64)]) -> Value {
    let (duration, rate, period) = (180usize, 20usize, 60. / bpm);
    let beats: Vec<f64> = (0..).map(|i| i as f64 * period).take_while(|t| *t < duration as f64).collect();
    let downbeats: Vec<f64> = beats.iter().step_by(4).copied().collect();
    let phrases: Vec<f64> = downbeats.iter().step_by(8).copied().collect();
    let curve = |offset: f64, key: &str| -> Vec<f64> {
        let shift = intro.iter().find(|(k, _)| *k == key || *k == "all").map_or(0., |(_, db)| *db);
        (0..duration * rate).map(|i| -16. + offset + if i < 30 * rate { shift } else { 0. }).collect()
    };
    let density: Vec<f64> = (0..duration * rate)
        .map(|i| if phrases.iter().any(|t| (i as f64 / rate as f64 - t).abs() < 2. * period) { 0.05 } else { 0.2 })
        .collect();
    json!({"id":id,"duration":duration,"mixingAllowed":true,"analysis":{
        "version":"flavor-test","duration":duration,"audibleStart":0,"audibleEnd":duration,
        "loudness":{"integratedLufs":-16,"samplePeakDb":-4,"truePeakDb":-3},
        "beat":{"bpm":bpm,"period":period,"beats":beats,"downbeats":downbeats,"confidence":0.95,"stable":true,"jitterMs":2,"downbeatConfidence":0.9,"downbeatPhase":0,"alternatives":[]},
        "rhythmStrength":0.95,"key":{"tonic":-1,"mode":"unknown","name":"unknown","camelot":"","confidence":0},
        "phrases":phrases,"phraseConfidence":0.8,"sectionBoundaries":[],"intro":{"start":0,"end":0},"outro":{"start":duration - 16,"end":duration},"bodyRmsDb":-16,
        "curves":{"rate":rate,"rmsDb":curve(0., "rmsDb"),"lowDb":curve(-3., "lowDb"),"midDb":curve(-6., "midDb"),"highDb":curve(-10., "highDb"),"midDensity":density},
        "peaks":vec![0.8; duration * rate],"cues":{"entry":[{"time":0,"score":0.76,"kind":"start","tags":[]}],"exit":[]},
        "features":{"energy":0.6,"brightness":0.5,"rhythmStrength":0.95,"onsetRate":0.4,"bassWeight":0.6,"midDensity":0.2,"dynamics":0.2,"acousticness":0.1},
        "warnings":[],"elapsedMs":0}})
}
fn settings() -> Value {
    json!({"enabled":true,"maxStretchPercent":12,"maxBlendSeconds":32,"eqHandoff":true,"respectAlbums":true,"loudnessTarget":-16,
        "style":"auto","fallbackSeconds":6,"entryMode":"smart","maxEntrySkipSeconds":45,"mixOnNext":true,"stemMixing":true,
        "loopBridges":true,"masterTempo":true,"djPhrasing":true})
}
fn flavors(intro: &[(&str, f64)]) -> Vec<Value> {
    ["b", "c", "d", "e", "f", "g"]
        .iter()
        .map(|id| plan(&json!({"from":song("a", 124., &[]),"to":song(id, 160., intro),"settings":settings()})).unwrap())
        .collect()
}
fn lane_at(p: &Value, deck: &str, name: &str, t: f64) -> f64 {
    let pts = p["automation"].as_array().unwrap().iter().find(|l| l["deck"] == deck && l["lane"] == name).unwrap()["points"].as_array().unwrap().clone();
    let pts: Vec<(f64, f64)> = pts.iter().map(|q| (q[0].as_f64().unwrap(), q[1].as_f64().unwrap())).collect();
    if t <= pts[0].0 {
        return pts[0].1;
    }
    for w in pts.windows(2) {
        if t <= w[1].0 {
            return w[0].1 + (w[1].1 - w[0].1) * (t - w[0].0) / (w[1].0 - w[0].0);
        }
    }
    pts.last().unwrap().1
}

#[test]
fn flavor_follows_b_opening_and_varies_per_pair() {
    let drop = flavors(&[]);
    let names: Vec<&str> = drop.iter().map(|p| p["echoFlavor"].as_str().unwrap()).collect();
    assert!(names.contains(&"dub") && names.contains(&"brake"), "{names:?}");
    for p in drop.iter().filter(|p| p["echoFlavor"] == "brake") {
        let tape = &p["tapeStopA"];
        assert!((tape["end"].as_f64().unwrap() - tape["start"].as_f64().unwrap() - 60. / 124.).abs() < 0.002);
    }
    assert!(flavors(&[("all", -5.)]).iter().all(|p| p["echoFlavor"] == "washout" && p["echo"]["lowpass"] == 2500));
    // a loud opening its kick does not carry eases in instead of starting dry
    for p in flavors(&[("lowDb", -6.)]) {
        assert_eq!(p["debug"]["dropSwap"]["harsh"], true);
        assert!(lane_at(&p, "B", "gain", 0.005) < 0.15);
    }
}

#[test]
fn ping_pong_alternates_and_width_zero_is_the_plain_echo() {
    let (d, len) = (400usize, 1600usize);
    let run = |width: Option<f64>| {
        let mut e = Echo::new(8000.);
        match width {
            Some(w) => e.configure_with(d as f64, 0.8, 6000., w),
            None => e.configure(d as f64, 0.8),
        }
        let input: Vec<f32> = (0..len).map(|i| if i < 40 { (i as f32 * 2.7).sin() } else { 0. }).collect();
        let (mut l, mut r) = (vec![0f32; len], vec![0f32; len]);
        e.process(&input, &input, &mut l, &mut r);
        (l, r)
    };
    assert_eq!(run(None), run(Some(0.)));
    let (l, r) = run(Some(1.));
    let energy = |x: &[f32], k: usize| x[k * d..(k + 1) * d].iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
    assert!(energy(&l, 1) > 100. * energy(&r, 1));
    assert!(energy(&r, 2) > 100. * energy(&l, 2));
    assert!(energy(&l, 3) > 100. * energy(&r, 3));
}
