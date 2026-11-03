mod common;
mod loudness;
mod regions;
mod repetition;
mod spectral;
mod structure;
mod tempo;
use common::*;
pub use loudness::AnalysisAccumulator;
use serde_json::{Value, json};
use spectral::*;
use std::time::Instant;
use structure::Curves;
use tempo::*;
pub struct Side {
    pub power: Vec<f32>,
    pub low: Vec<f32>,
}
pub fn analyze_stereo(l: &[f32], r: &[f32]) -> Result<Value, String> {
    let mut a = AnalysisAccumulator::new(l.len() as f64 / 44100.);
    a.push(l, r)?;
    a.finish()
}
fn drum_envelopes(mono: &[f32]) -> (Hi, Hi) {
    let band = |cs: &[Coefs]| {
        let mut x = mono.to_vec();
        for &c in cs {
            Biquad::new(c).buffer(&mut x);
        }
        let hop = round(SR / 1000.) as usize;
        let mut env = vec![0f32; x.len() / hop];
        let a = (-1. / (SR * 0.01)).exp();
        let mut e = 0.;
        for i in 0..env.len() {
            for &v in &x[i * hop..(i + 1) * hop] {
                e = a * e + (1. - a) * v as f64 * v as f64;
            }
            env[i] = e.sqrt() as f32;
        }
        Hi {
            rate: SR / hop as f64,
            env,
        }
    };
    let lp = filter(SR, 150., false);
    let hp = filter(SR, 1000., true);
    let lp4 = filter(SR, 4000., false);
    (band(&[lp, lp]), band(&[hp, hp, lp4, lp4]))
}
fn beat_accents(drums: &(Hi, Hi), beats: &[f64]) -> Value {
    let at = |h: &Hi, t: f64| {
        let c = round(t * h.rate) as i64;
        let ms = h.rate / 1000.;
        let (mut peak, mut base, mut n) = (0f64, 0., 0);
        for k in round(-15. * ms) as i64..=round(40. * ms) as i64 {
            peak = peak.max(get(&h.env, c + k));
        }
        for k in round(-90. * ms) as i64..=round(-25. * ms) as i64 {
            base += get(&h.env, c + k);
            n += 1;
        }
        (peak - base / n as f64).max(0.)
    };
    let norm = |v: Vec<f64>| {
        let m = median(&v.iter().copied().filter(|x| *x > 0.).collect::<Vec<_>>());
        let m = if m == 0. { 1. } else { m };
        v.into_iter()
            .map(|x| rounded(x / m, 100.))
            .collect::<Vec<_>>()
    };
    json!({"kick":norm(beats.iter().map(|t|at(&drums.0,*t)).collect()),"snare":norm(beats.iter().map(|t|at(&drums.1,*t)).collect())})
}
fn attacks(h: &Hi, beats: &[f64]) -> Value {
    let mut offsets: Vec<Option<f64>> = vec![];
    let mut strength = vec![];
    let radius = (h.rate * 0.025).ceil() as i64;
    for &t in beats {
        let center = round(t * h.rate) as i64;
        let (lo, hi) = (center - radius, center + radius);
        let (mut peak, mut index, mut total) = (0., -1, 0.);
        let mut valid = t.is_finite()
            && h.rate >= 900.
            && h.rate <= 1100.
            && lo >= 0
            && hi < h.env.len() as i64;
        if valid {
            for i in lo..=hi {
                let x = get(&h.env, i);
                if !x.is_finite() || x < 0. {
                    valid = false;
                    break;
                }
                total += x;
                if x > peak {
                    peak = x;
                    index = i;
                }
            }
        }
        let mut rival = 0f64;
        if valid {
            for i in lo..=hi {
                if (i - index).abs() > (h.rate * 0.004).ceil() as i64 {
                    rival = rival.max(get(&h.env, i));
                }
            }
        }
        let confidence = if peak > 1e-5 {
            1. - total / (hi - lo + 1) as f64 / peak
        } else {
            0.
        };
        let accepted =
            valid && index > lo + 1 && index < hi - 1 && confidence >= 0.65 && rival < peak * 0.7;
        offsets.push(if accepted {
            Some(round((index as f64 / h.rate - t) * 1e6) / 1000.)
        } else {
            None
        });
        strength.push(if accepted {
            rounded(confidence, 1000.)
        } else {
            0.
        });
    }
    json!({"version":"lf-attack-1","offsetsMs":offsets,"strength":strength})
}
fn local_features(sp: &Spectral, onset: &Onset, duration: f64) -> Value {
    let n = duration.ceil().max(1.) as usize;
    let (mut camelot, mut confidence, mut transients) = (vec![], vec![], vec![]);
    for i in 0..n {
        let key = estimate_key(&chroma_mean(
            sp,
            onset.t0,
            i as f64 + 0.5 - 4.,
            i as f64 + 0.5 + 4.,
        ));
        camelot.push(if key.confidence >= 0.15 {
            key.camelot
        } else {
            String::new()
        });
        confidence.push(rounded(key.confidence, 100.));
        let f0 = ((i as f64 - 0.5 - onset.t0) * onset.fps).floor().max(1.) as usize;
        let f1 = (((i as f64 + 1.5 - onset.t0) * onset.fps).ceil().max(0.) as usize)
            .min(onset.env.len().saturating_sub(1));
        let mut peaks = 0;
        for f in f0..f1 {
            let v = onset.env[f];
            if v > 1.5 && v > onset.env[f - 1] && v >= onset.env[f + 1] {
                peaks += 1;
            }
        }
        transients.push(rounded(clamp(peaks as f64 / 2. / 8.), 100.));
    }
    json!({"rate":1,"camelot":camelot,"keyConfidence":confidence,"transients":transients})
}
fn build_beat(
    o: &Onset,
    hi: &Hi,
    fa: usize,
    fb: usize,
    start: f64,
    end: f64,
    sp: &Spectral,
    warnings: &mut Vec<String>,
) -> Option<Beat> {
    let fps = o.fps;
    let tempo = estimate(&o.env, fps, fa, fb);
    let mut bpm = tempo.bpm;
    let win = round(fps * 20.) as usize;
    let (mut agree, mut total) = (0, 0);
    let mut s = fa;
    while s + win <= fb {
        let w = estimate(&o.env, fps, s, s + win).bpm;
        let r = w / bpm;
        if [0.5, 1., 2., 1.5, 2. / 3.]
            .iter()
            .any(|m| (r / m - 1.).abs() < 0.025)
        {
            agree += 1;
        }
        total += 1;
        s += round(win as f64 / 2.) as usize;
    }
    let consistency = if total > 0 {
        agree as f64 / total as f64
    } else {
        0.5
    };
    let bframes = track(&o.env, fps, bpm, 100., fa, fb);
    let off_ratio = if bframes.len() < 8 {
        0.
    } else {
        let (mut on, mut off) = (0., 0.);
        for i in 0..bframes.len() - 1 {
            on += get(&o.low_mid, bframes[i] as i64);
            off += get(&o.low_mid, round((bframes[i] + bframes[i + 1]) / 2.) as i64);
        }
        off / on.max(1e-9)
    };
    let mut alternatives = vec![
        Alternative {
            bpm: bpm / 2.,
            score: 0.,
        },
        Alternative { bpm, score: 1. },
        Alternative {
            bpm: bpm * 2.,
            score: 0.,
        },
    ];
    if (off_ratio > 0.45 && bpm * 2. <= 190.) || bpm < 70. {
        alternatives[2].score = 1.1;
        bpm *= 2.;
        warnings.push("tempo-doubled".into());
    }
    let frames = track(&o.env, fps, bpm, 100., fa, fb);
    if frames.len() < 8 {
        return None;
    }
    let mut times: Vec<_> = frames.into_iter().map(|f| f / fps + o.t0).collect();
    let mut fit = fit_robust(&times, 60. / bpm);
    if tempo.strength >= 0.45 && (fit.inlier_share < 0.65 || fit.jitter_ms > 18.) {
        let direct = fit_onset(o, start, end, bpm);
        if direct.stable {
            fit = Fit {
                t0: direct.t0,
                period: direct.period,
                jitter_ms: direct.jitter_ms,
                inlier_share: direct.support,
            };
            times.clear();
            let mut t = direct.t0;
            while t <= end {
                times.push(t);
                t += direct.period;
            }
            warnings.push("syncopated-grid-recovered".into());
        }
    }
    let inliers: Vec<_> = times
        .iter()
        .filter(|t| {
            (**t - (fit.t0 + round((**t - fit.t0) / fit.period) * fit.period)).abs() < 0.035
        })
        .copied()
        .collect();
    let span = if inliers.is_empty() {
        0.
    } else {
        inliers[inliers.len() - 1] - inliers[0]
    };
    let coverage = span / (end - start).max(1.);
    let stable = (fit.jitter_ms < 15. || (fit.jitter_ms < 24. && fit.inlier_share >= 0.7))
        && fit.inlier_share >= 0.6
        && inliers.len() >= 16
        && coverage > 0.6;
    let mut period = fit.period;
    if stable {
        let kfrom = ((start - fit.t0) / period - 0.01).ceil() as i64;
        let kto = ((end - fit.t0) / period).floor() as i64;
        let (rt, rp) = refine(o, fit.t0, fit.period, kfrom, kto);
        period = rp;
        let t0 = refine_hi(hi, rt, period, kfrom, kto);
        let kfrom = ((start - t0) / period - 0.01).ceil() as i64;
        let kto = ((end - t0) / period).floor() as i64;
        times = (kfrom..=kto).map(|k| t0 + k as f64 * period).collect();
    } else {
        times = snap_hi(hi, &times);
        period = median(&times.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>());
    }
    if times.len() < 8 {
        return None;
    }
    let med = median(&o.env[fa..fb].iter().map(|v| *v as f64).collect::<Vec<_>>());
    let strong = times
        .iter()
        .filter(|t| onset_at(o, &o.env, **t) > med * 1.5)
        .count();
    let salience = strong as f64 / times.len() as f64;
    let mut confidence =
        clamp(0.5 * tempo.strength + 0.25 * clamp((salience - 0.3) / 0.5) + 0.25 * consistency);
    if tempo.strength < 0.4 {
        confidence *= tempo.strength / 0.4;
    }
    if !stable {
        confidence *= 0.75;
    }
    let chroma: Vec<_> = times
        .iter()
        .enumerate()
        .map(|(i, t)| {
            chroma_mean(
                sp,
                o.t0,
                *t,
                times.get(i + 1).copied().unwrap_or(*t + period),
            )
        })
        .collect();
    let change: Vec<_> = chroma
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if i == 0 {
                0.
            } else {
                1. - cosine(&chroma[i - 1], c)
            }
        })
        .collect();
    let low: Vec<_> = times.iter().map(|t| onset_at(o, &o.low, *t)).collect();
    let norm = |a: Vec<f64>| {
        let m = a.iter().sum::<f64>() / a.len().max(1) as f64;
        let m = if m == 0. { 1. } else { m };
        a.into_iter().map(|v| v / m).collect::<Vec<_>>()
    };
    let change = norm(change);
    let low = norm(low);
    let mut scores: Vec<_> = (0..4)
        .map(|phase| {
            let mut s = 0.;
            let mut n = 0;
            for i in (phase..times.len()).step_by(4) {
                s += change[i] * 0.6 + low[i] * 0.4;
                n += 1;
            }
            (phase, s / n.max(1) as f64)
        })
        .collect();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    let phase = scores[0].0;
    let dc = clamp((scores[0].1 - scores[1].1) / scores[0].1.max(1e-9) * 4.);
    let downbeats = times
        .iter()
        .enumerate()
        .filter(|(i, _)| *i % 4 == phase)
        .map(|(_, t)| rounded(*t, 10000.))
        .collect();
    Some(Beat {
        bpm: rounded(60. / period, 100.),
        confidence,
        period,
        stable,
        jitter_ms: rounded(fit.jitter_ms, 10.),
        beats: times.into_iter().map(|t| rounded(t, 10000.)).collect(),
        downbeats,
        downbeat_confidence: dc,
        downbeat_phase: phase,
        alternatives: alternatives
            .into_iter()
            .map(|mut a| {
                a.bpm = rounded(a.bpm, 100.);
                a
            })
            .collect(),
        accents: None,
        attacks: None,
    })
}
fn phrases(beat: &Beat, sp: &Spectral, t0: f64, c: &Curves) -> (Vec<f64>, f64, Vec<f64>) {
    let bars = &beat.downbeats;
    let nb = bars.len();
    let len = beat.period * 4.;
    let feats: Vec<_> = bars
        .iter()
        .map(|b| {
            (
                [
                    curve_mean(&c.rms, RATE, *b, *b + len),
                    curve_mean(&c.low, RATE, *b, *b + len),
                    curve_mean(&c.mid, RATE, *b, *b + len),
                    curve_mean(&c.high, RATE, *b, *b + len),
                ],
                curve_mean(&c.density, RATE, *b, *b + len),
                chroma_mean(sp, t0, *b, *b + len),
            )
        })
        .collect();
    let mut novelty = vec![0f64; nb];
    for j in 1..nb {
        let avg = |from: usize, to: usize| {
            let mut v = vec![0.; 4];
            let mut ch = vec![0.; 12];
            let mut d = 0.;
            for k in from..to {
                for q in 0..4 {
                    v[q] += feats[k].0[q];
                }
                for q in 0..12 {
                    ch[q] += feats[k].2[q];
                }
                d += feats[k].1;
            }
            let n = (to - from).max(1) as f64;
            for x in &mut v {
                *x /= n;
            }
            (v, ch, d / n)
        };
        let l = avg(j.saturating_sub(4), j);
        let r = avg(j, (j + 4).min(nb));
        let mut dist = 0.;
        for q in 0..4 {
            dist += (l.0[q] - r.0[q]).abs() / 10.;
        }
        dist += 2. * (1. - cosine(&l.1, &r.1));
        dist += 3. * (l.2 - r.2).abs();
        novelty[j] = dist;
    }
    let mut scores: Vec<_> = (0..8)
        .map(|offset| {
            let mut s = 0.;
            let mut n = 0;
            for j in (offset..nb).step_by(8) {
                s += novelty[j];
                n += 1;
            }
            (
                offset,
                s / n.max(1) as f64 * if offset == 0 { 1.08 } else { 1. },
            )
        })
        .collect();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    let best = scores[0];
    let conf = clamp((best.1 - scores[1].1) / best.1.max(1e-9) * 3.)
        * if beat.downbeat_confidence == 0. {
            0.3f64.sqrt()
        } else {
            beat.downbeat_confidence.sqrt()
        };
    let result = (best.0..nb).step_by(8).map(|j| bars[j]).collect();
    let mean = novelty.iter().sum::<f64>() / nb.max(1) as f64;
    let sd = (novelty.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / nb.max(1) as f64).sqrt();
    let mut sections = vec![];
    for j in 1..nb.saturating_sub(1) {
        if novelty[j] > mean + sd && novelty[j] >= novelty[j - 1] && novelty[j] >= novelty[j + 1] {
            sections.push(bars[j]);
        }
    }
    (result, conf, sections)
}
fn cues(
    start: f64,
    end: f64,
    beat: Option<&Beat>,
    phrases: &[f64],
    boundaries: &[f64],
    rms: &[f64],
    density: &[f64],
    intro_end: f64,
    outro_start: f64,
) -> Value {
    let len = end - start;
    let section_set: Vec<_> = boundaries.iter().map(|t| round(t * 10.)).collect();
    let mut points: Vec<(f64, &str)> = vec![];
    if let Some(b) = beat {
        let phrase_set: Vec<_> = phrases.iter().map(|t| round(t * 1000.)).collect();
        for (i, &t) in b.downbeats.iter().enumerate() {
            if phrase_set.contains(&round(t * 1000.)) {
                points.push((t, "phrase"));
            } else if section_set.contains(&round(t * 10.)) {
                points.push((t, "section"));
            } else if i % 4 == 0 {
                points.push((t, "downbeat"));
            }
        }
    } else {
        let mut t = start;
        while t < end {
            points.push((t, "energy"));
            t += 1.;
        }
    }
    let mid = |t: f64, span: f64| curve_mean(density, RATE, t, t + span);
    let level = |a: f64, b: f64| curve_mean(rms, RATE, a, b);
    let bonus = |kind: &str| match kind {
        "phrase" => 1.,
        "section" => 0.85,
        "downbeat" => 0.55,
        _ => 0.4,
    };
    let mut exit: Vec<(f64, Value)> = vec![];
    for &(t, kind) in &points {
        let remaining = end - t;
        if t < start + len * 0.5 || remaining < 3. {
            continue;
        }
        let mut tags: Vec<&str> = vec![];
        let pos = (-0.5 * ((remaining - 26.) / 16.).powi(2)).exp();
        let drop = level(t - 8., t) - level(t, t + 8.);
        let drop_score = clamp(drop / 6. + 0.5);
        if drop > 2. {
            tags.push("energy-drop");
        }
        let dens = mid(t, 10.);
        let dens_score = 1. - clamp(dens / 0.5);
        if dens < 0.15 {
            tags.push("low-mid-density");
        }
        if t >= outro_start - 0.5 {
            tags.push("outro");
        }
        let score = clamp(
            0.35 * pos
                + 0.2 * drop_score
                + 0.2 * dens_score
                + 0.25 * bonus(kind)
                + if tags.contains(&"outro") { 0.08 } else { 0. },
        );
        exit.push((
            score,
            json!({"time":rounded(t,1000.),"score":score,"kind":kind,"tags":tags}),
        ));
    }
    let first_bar = beat
        .and_then(|b| b.downbeats.iter().find(|t| **t >= start - 0.05))
        .copied();
    let mut entry = vec![(
        0.76,
        json!({"time":rounded(first_bar.unwrap_or(start),1000.),"score":0.76,"kind":"start","tags":[if beat.is_some(){"first-downbeat"}else{"audible-start"}]}),
    )];
    for &time in boundaries {
        if time > start + 3. && time <= start + (len * 0.45).min(75.) {
            let before = level(start.max(time - 6.), time);
            let after = level(time, time + 6.);
            let mut tags = vec!["structural-change"];
            if after - before > 3. {
                tags.push("energy-arrival");
            }
            if mid(time, 8.) < 0.15 {
                tags.push("low-mid-density");
            }
            let score =
                clamp(0.62 + 0.18 * clamp((after - before) / 8.) - 0.12 * (time - start) / 75.);
            entry.push((
                score,
                json!({"time":time,"kind":"section","score":score,"tags":tags}),
            ));
        }
    }
    if beat.is_some() {
        for (t, kind) in points {
            if t <= first_bar.unwrap_or(0.) + 0.01
                || t > start + (len * 0.45).min(75.)
                || entry
                    .iter()
                    .any(|(_, e)| (e["time"].as_f64().unwrap() - t).abs() < 0.03)
            {
                continue;
            }
            let mut tags = vec![];
            let early = (-(t - start) / 40.).exp();
            let dens = mid(t, 16.);
            if dens < 0.15 {
                tags.push("low-mid-density");
            }
            if t <= intro_end {
                tags.push("intro");
            }
            let score = clamp(0.32 * early + 0.24 * (1. - clamp(dens / 0.5)) + 0.3 * bonus(kind));
            entry.push((
                score,
                json!({"time":rounded(t,1000.),"score":score,"kind":kind,"tags":tags}),
            ));
        }
    }
    exit.sort_by(|a, b| b.0.total_cmp(&a.0));
    entry.sort_by(|a, b| b.0.total_cmp(&a.0));
    json!({"entry":entry.into_iter().take(24).map(|(_,v)|v).collect::<Vec<_>>(),"exit":exit.into_iter().take(24).map(|(_,v)|v).collect::<Vec<_>>()})
}
pub fn analyze_mono(mono: &[f32], loudness: Value, duration: f64, side: Option<&Side>) -> Value {
    let started = Instant::now();
    let duration = if duration == 0. {
        mono.len() as f64 / SR
    } else {
        duration
    };
    let mut warnings: Vec<String> = vec![];
    let sp = compute(mono);
    let n = sp.rms_db.len();
    let rms: Vec<_> = sp
        .rms_db
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let p = side.and_then(|s| s.power.get(i)).copied().unwrap_or(0.) as f64;
            let db = if p != 0. {
                power_db(10f64.powf(*v as f64 / 10.) + p)
            } else {
                *v as f64
            };
            db.max(-90.)
        })
        .collect();
    let low: Vec<_> = to_curve(&sp.pow_low, sp.fps, n)
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            power_db(v + side.and_then(|s| s.low.get(i)).copied().unwrap_or(0.) as f64 * 0.75)
                .max(-90.)
        })
        .collect();
    let mid: Vec<_> = to_curve(&sp.pow_mid, sp.fps, n)
        .into_iter()
        .map(|v| power_db(v).max(-90.))
        .collect();
    let high: Vec<_> = to_curve(&sp.pow_high, sp.fps, n)
        .into_iter()
        .map(|v| power_db(v).max(-90.))
        .collect();
    let density = smooth(&to_curve(&sp.mid_density, sp.fps, n), 10);
    let peak_max = sp.peaks.iter().fold(1e-6f64, |m, v| m.max(*v as f64));
    let peaks: Vec<_> = sp
        .peaks
        .iter()
        .map(|v| rounded(*v as f64 / peak_max, 1000.))
        .collect();
    let loud = percentile(&rms, 0.95);
    let threshold = (loud - 40.).max(-60.);
    let first = (0..n.saturating_sub(1)).find(|i| rms[*i] > threshold && rms[*i + 1] > threshold);
    let last = (1..n)
        .rev()
        .find(|i| rms[*i] > threshold && rms[*i - 1] > threshold);
    let silent = first.is_none() || loud < -65.;
    let start = if silent {
        0.
    } else {
        first.unwrap() as f64 / RATE
    };
    let end = if silent {
        duration
    } else {
        duration.min((last.unwrap() + 1) as f64 / RATE)
    };
    if silent {
        warnings.push("silent".into());
    }
    if duration < 30. {
        warnings.push("short".into());
    }
    let a = (start * RATE).floor().max(0.) as usize;
    let b = ((end * RATE).ceil().max(0.) as usize).min(rms.len());
    let body = if silent { -90. } else { median(&rms[a..b]) };
    let smooth_rms = smooth(&rms, 40);
    let onset = envelope(&sp);
    let fa = ((start - onset.t0) * onset.fps).floor().max(0.) as usize;
    let fb = (((end - onset.t0) * onset.fps).ceil().max(0.) as usize).min(onset.env.len());
    let mut beat = None;
    let mut beat_regions = vec![];
    let mut rhythm_strength = 0.;
    if !silent && fb.saturating_sub(fa) as f64 > onset.fps * 6. {
        let hi = hi_res(mono, SR, 220.);
        beat = build_beat(&onset, &hi, fa, fb, start, end, &sp, &mut warnings);
        rhythm_strength = beat.as_ref().map_or(0., |b| b.confidence);
        if beat.as_ref().is_some_and(|b| b.confidence < 0.22) {
            warnings.push("weak-pulse".into());
            beat = None;
        }
        beat_regions = regions::detect(&onset, start, end, beat.as_ref(), &hi);
        let drums = drum_envelopes(mono);
        if let Some(b) = &mut beat {
            b.accents = Some(beat_accents(&drums, &b.beats));
            b.attacks = Some(attacks(&hi, &b.beats));
        }
        for r in &mut beat_regions {
            let beats = r["beats"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect::<Vec<_>>();
            r["accents"] = beat_accents(&drums, &beats);
        }
    }
    let key = if silent {
        estimate_key(&[0.; 12])
    } else {
        estimate_key(&chroma_mean(&sp, onset.t0, start, end))
    };
    let local = if silent {
        None
    } else {
        Some(local_features(&sp, &onset, duration))
    };
    let c = Curves {
        rms,
        low,
        mid,
        high,
        density,
    };
    let (mut phrase_times, mut phrase_conf, mut harmonic) = (vec![], 0., vec![]);
    if let Some(b) = beat.as_ref().filter(|b| b.downbeats.len() >= 8) {
        (phrase_times, phrase_conf, harmonic) = phrases(b, &sp, onset.t0, &c);
    }
    let sections = structure::sections(&c, start, end, beat.as_ref(), &harmonic);
    let boundaries: Vec<_> = sections
        .iter()
        .skip(1)
        .map(|s| s["start"].as_f64().unwrap())
        .collect();
    let song = if silent {
        None
    } else {
        repetition::analyze(&sp, &c.rms, start, end, body, beat.as_ref(), &boundaries)
    };
    let bars = beat.as_ref().map(|b| b.downbeats.as_slice()).unwrap_or(&[]);
    let snap = |t: f64| {
        bars.iter()
            .min_by(|a, b| (*a - t).abs().total_cmp(&(*b - t).abs()))
            .copied()
            .unwrap_or(t)
    };
    let mut intro_end = start;
    for i in (start * RATE).floor().max(0.) as usize..smooth_rms.len() {
        if smooth_rms[i] >= body - 3. {
            intro_end = i as f64 / RATE;
            break;
        }
    }
    intro_end = intro_end.min(start + (end - start) * 0.35);
    let mut outro_start = end;
    if !smooth_rms.is_empty() {
        let begin = ((end * RATE).floor().max(0.) as usize).min(smooth_rms.len() - 1);
        for i in (0..=begin).rev() {
            if smooth_rms[i] >= body - 3. {
                outro_start = i as f64 / RATE;
                break;
            }
        }
    }
    outro_start = outro_start.max(start + (end - start) * 0.6);
    intro_end = snap(intro_end);
    outro_start = snap(outro_start);
    let cue = cues(
        start,
        end,
        beat.as_ref(),
        &phrase_times,
        &boundaries,
        &smooth_rms,
        &c.density,
        intro_end,
        outro_start,
    );
    let mut onset_count = 0;
    for i in fa + 1..fb.saturating_sub(1) {
        let v = onset.env[i];
        if v > 1.5 && v > onset.env[i - 1] && v >= onset.env[i + 1] {
            onset_count += 1;
        }
    }
    let onset_rate = onset_count as f64 / (end - start).max(1.);
    let mean_pow = |a: &[f32]| {
        a[fa.min(a.len())..fb.min(a.len())]
            .iter()
            .map(|v| *v as f64)
            .sum::<f64>()
            / fb.saturating_sub(fa).max(1) as f64
    };
    let (pl, pm, ph) = (
        mean_pow(&sp.pow_low),
        mean_pow(&sp.pow_mid),
        mean_pow(&sp.pow_high),
    );
    let total = pl + pm + ph + 1e-12;
    let cent = mean_pow(&sp.centroid);
    let lufs = loudness["integratedLufs"].as_f64().unwrap_or(-70.);
    let p95 = percentile(&c.rms[a..b], 0.95);
    let p10 = percentile(&c.rms[a..b], 0.1);
    let features = json!({"energy":clamp(0.35*clamp(onset_rate/6.)+0.25*clamp((ph/total)/0.12)+0.2*rhythm_strength+0.2*clamp((lufs+22.)/16.)),"brightness":clamp((cent-600.)/3000.),"rhythmStrength":rhythm_strength,"onsetRate":clamp(onset_rate/8.),"bassWeight":clamp((pl/total)/0.6),"midDensity":clamp(c.density.iter().sum::<f64>()/c.density.len().max(1)as f64/0.6),"dynamics":clamp((p95-p10)/30.),"acousticness":clamp((1.-rhythm_strength)*0.6+(1.-clamp((ph/total)/0.12))*0.4)});
    let mut result = json!({"version":"am-analyzer-14","duration":duration,"audibleStart":start,"audibleEnd":end,"loudness":loudness,"beat":beat,"beatRegions":beat_regions,"rhythmStrength":rhythm_strength,"key":key,"phrases":phrase_times,"phraseConfidence":phrase_conf,"sectionBoundaries":boundaries,"sections":sections,"intro":{"start":start,"end":intro_end},"outro":{"start":outro_start,"end":end},"bodyRmsDb":body,"curves":{"rate":20,"rmsDb":c.rms.iter().map(|v|rounded(*v,10.)).collect::<Vec<_>>(),"lowDb":c.low.iter().map(|v|rounded(*v,10.)).collect::<Vec<_>>(),"midDb":c.mid.iter().map(|v|rounded(*v,10.)).collect::<Vec<_>>(),"highDb":c.high.iter().map(|v|rounded(*v,10.)).collect::<Vec<_>>(),"midDensity":c.density.iter().map(|v|rounded(*v,1000.)).collect::<Vec<_>>()},"peaks":peaks,"cues":cue,"features":features,"warnings":warnings,"elapsedMs":started.elapsed().as_millis()});
    if let Some(local) = local {
        result["local"] = local;
    }
    if let Some(song) = song {
        result["structure"] = song;
    }
    result
}
