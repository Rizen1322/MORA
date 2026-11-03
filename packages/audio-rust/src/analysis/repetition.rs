use super::{
    common::*,
    spectral::{FRAME, Spectral},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::f64::consts::PI;
struct Scale {
    hop: f64,
    smooth: usize,
    min_lag: usize,
    min_repeat: usize,
    kernel: usize,
    min_segment: usize,
}
impl Scale {
    fn new(hop: f64) -> Self {
        let fr = |s: f64| round(s / hop).max(1.) as usize;
        Self {
            hop,
            smooth: fr(8.),
            min_lag: fr(8.),
            min_repeat: fr(12.),
            kernel: fr(6.),
            min_segment: fr(6.),
        }
    }
    fn fr(&self, s: f64) -> usize {
        round(s / self.hop).max(1.) as usize
    }
}
struct Features {
    n: usize,
    chroma: Vec<f32>,
    timbre: Vec<f32>,
    level: Vec<f32>,
    voiced: Vec<u8>,
}
fn normalize(x: &mut [f32], d: usize, keep: &[u8]) {
    for (i, &keep) in keep.iter().enumerate() {
        let mut s = 0.;
        for k in 0..d {
            s += (x[i * d + k] as f64).powi(2);
        }
        let inv = if keep != 0 && s > 1e-12 {
            1. / s.sqrt()
        } else {
            0.
        };
        for k in 0..d {
            x[i * d + k] = (x[i * d + k] as f64 * inv) as f32;
        }
    }
}
fn centre(x: &mut [f32], d: usize, keep: &[u8], scale: bool) {
    let n = keep.iter().map(|v| *v as usize).sum::<usize>();
    if n == 0 {
        return;
    }
    for k in 0..d {
        let mut m = 0.;
        let mut v = 0.;
        for i in 0..keep.len() {
            if keep[i] != 0 {
                m += x[i * d + k] as f64;
            }
        }
        m /= n as f64;
        for i in 0..keep.len() {
            if keep[i] != 0 {
                v += (x[i * d + k] as f64 - m).powi(2);
            }
        }
        let inv = if scale {
            1. / (v / n as f64 + 1e-12).sqrt()
        } else {
            1.
        };
        for i in 0..keep.len() {
            x[i * d + k] = if keep[i] != 0 {
                ((x[i * d + k] as f64 - m) * inv) as f32
            } else {
                0.
            };
        }
    }
}
fn features(sp: &Spectral, rms: &[f64], start: f64, end: f64, body: f64, hop: f64) -> Features {
    let n = ((end - start) / hop).floor().max(0.) as usize;
    let centre_time = FRAME as f64 / 2. / SR;
    let mut f = Features {
        n,
        chroma: vec![0.; n * 12],
        timbre: vec![0.; n * 12],
        level: vec![0.; n],
        voiced: vec![0; n],
    };
    for i in 0..n {
        let a = start + i as f64 * hop;
        let b = a + hop;
        let (mut sum, mut count) = (0., 0);
        for k in (a * RATE).floor().max(0.) as usize..((b * RATE).ceil() as usize).min(rms.len()) {
            sum += rms[k];
            count += 1;
        }
        f.level[i] = if count > 0 {
            (sum / count as f64) as f32
        } else {
            -90.
        };
        f.voiced[i] = u8::from(f.level[i] as f64 > (body - 25.).max(-70.));
        let c0 = ((a - centre_time) * sp.chroma_fps).ceil().max(0.) as usize;
        let c1 =
            (((b - centre_time) * sp.chroma_fps).ceil().max(0.) as usize).min(sp.chroma_frames);
        for frame in c0..c1 {
            for k in 0..12 {
                let at = i * 12 + k;
                f.chroma[at] = (f.chroma[at] as f64 + sp.chroma[frame * 12 + k] as f64) as f32;
            }
        }
        let f0 = ((a - centre_time) * sp.fps).ceil().max(0.) as usize;
        let f1 = (((b - centre_time) * sp.fps).ceil().max(0.) as usize).min(sp.frames);
        let mut log_mel = [0f64; 24];
        for frame in f0..f1 {
            for k in 0..24 {
                log_mel[k] += sp.mel[frame * 24 + k] as f64;
            }
        }
        for v in &mut log_mel {
            *v = (*v / f1.saturating_sub(f0).max(1) as f64 + 1e-10).log10();
        }
        for q in 1..=12 {
            let mut v = 0.;
            for k in 0..24 {
                v += log_mel[k] * (PI * q as f64 * (k as f64 + 0.5) / 24.).cos();
            }
            f.timbre[i * 12 + q - 1] = v as f32;
        }
    }
    normalize(&mut f.chroma, 12, &f.voiced);
    centre(&mut f.chroma, 12, &f.voiced, false);
    normalize(&mut f.chroma, 12, &f.voiced);
    centre(&mut f.timbre, 12, &f.voiced, true);
    normalize(&mut f.timbre, 12, &f.voiced);
    f
}
fn similarity(f: &Features, band: Option<usize>) -> Vec<f32> {
    let n = f.n;
    let stride = band.map_or(n, |w| 2 * w + 1);
    let mut s = vec![0.; n * stride];
    for i in 0..n {
        let from = band.map_or(0, |w| i.saturating_sub(w));
        for j in from..=i {
            let (mut c, mut t) = (0., 0.);
            for k in 0..12 {
                c += f.chroma[i * 12 + k] as f64 * f.chroma[j * 12 + k] as f64;
                t += f.timbre[i * 12 + k] as f64 * f.timbre[j * 12 + k] as f64;
            }
            let v = (0.6 * c + 0.4 * t) as f32;
            if let Some(w) = band {
                s[i * stride + j + w - i] = v;
                s[j * stride + i + w - j] = v;
            } else {
                s[i * n + j] = v;
                s[j * n + i] = v;
            }
        }
    }
    s
}
fn blurred(f: &Features, radius: usize) -> Features {
    let avg = |x: &[f32]| {
        let mut out = vec![0f32; x.len()];
        for i in 0..f.n {
            for j in i.saturating_sub(radius)..=(f.n - 1).min(i + radius) {
                for k in 0..12 {
                    out[i * 12 + k] = (out[i * 12 + k] as f64 + x[j * 12 + k] as f64) as f32;
                }
            }
        }
        normalize(&mut out, 12, &f.voiced);
        out
    };
    Features {
        n: f.n,
        chroma: avg(&f.chroma),
        timbre: avg(&f.timbre),
        level: f.level.clone(),
        voiced: f.voiced.clone(),
    }
}
fn checkerboard(s: &[f32], n: usize, k: &Scale) -> Vec<f32> {
    let mut out = vec![0.; n];
    let w = 2 * k.kernel - 1;
    let stride = 2 * w + 1;
    let g: Vec<_> = (0..2 * k.kernel)
        .map(|a| {
            (-0.5 * ((a as f64 - k.kernel as f64 + 0.5) / (k.kernel as f64 * 0.5)).powi(2)).exp()
        })
        .collect();
    let mut sum = 0.;
    for a in &g {
        for b in &g {
            sum += a * b;
        }
    }
    if n < k.kernel * 2 {
        return out;
    }
    for i in k.kernel..=n - k.kernel {
        let mut v = 0.;
        for a in 0..2 * k.kernel {
            let row = (i - k.kernel + a) * stride + w - a;
            for b in 0..2 * k.kernel {
                v += if (a < k.kernel) == (b < k.kernel) {
                    1.
                } else {
                    -1.
                } * g[a]
                    * g[b]
                    * s[row + b] as f64;
            }
        }
        out[i] = (v / sum).max(0.) as f32;
    }
    out
}
#[derive(Clone)]
struct Repeat {
    lag: usize,
    from: usize,
    to: usize,
    score: f64,
}
fn fill(
    s: &[f32],
    n: usize,
    k: &Scale,
    lag: usize,
    row: &mut [f32],
    pool: &mut Vec<f32>,
    collect: bool,
) {
    row.fill(-1.);
    if lag >= k.min_lag.saturating_sub(1) && lag + k.smooth <= n {
        let mut acc = 0.;
        for i in 0..k.smooth {
            acc += s[(lag + i) * n + i] as f64;
        }
        for i in lag..=n - k.smooth {
            row[i] = (acc / k.smooth as f64) as f32;
            if collect && i & 3 == 0 {
                pool.push(row[i]);
            }
            if i + k.smooth < n {
                acc +=
                    s[(i + k.smooth) * n + i + k.smooth - lag] as f64 - s[i * n + i - lag] as f64;
            }
        }
    }
}
fn paths(s: &[f32], n: usize, k: &Scale) -> Vec<Repeat> {
    let mut pool = vec![];
    let mut scratch = vec![0f32; n];
    for l in 0..n {
        fill(s, n, k, l, &mut scratch, &mut pool, true);
    }
    pool.sort_by(f32::total_cmp);
    let threshold = (pool
        .get((pool.len() as f64 * 0.9).floor() as usize)
        .copied()
        .unwrap_or(1.) as f64)
        .max(0.3);
    let mut rows: Vec<_> = (0..5).map(|_| (-1i64, vec![0f32; n])).collect();
    let raw = |l: usize, i: usize| {
        let (mut v, mut c) = (0., 0);
        for q in i.saturating_sub(1)..=(i + 1).min(n - 1) {
            if q >= l {
                v += s[q * n + q - l] as f64;
                c += 1;
            }
        }
        if c > 0 { v / c as f64 } else { -1. }
    };
    let mut candidates = vec![];
    for l in k.min_lag..n.saturating_sub(k.smooth) {
        for m in l as i64 - 2..=l as i64 + 2 {
            if m < 0 || m >= n as i64 {
                continue;
            }
            let slot = &mut rows[m as usize % 5];
            if slot.0 != m {
                fill(s, n, k, m as usize, &mut slot.1, &mut vec![], false);
                slot.0 = m;
            }
        }
        let at = |m: i64, i: usize| {
            if m < 0 || m >= n as i64 {
                -1.
            } else {
                rows[m as usize % 5].1[i] as f64
            }
        };
        let mark = |i: usize| {
            (l as i64 - 1..=l as i64 + 1).any(|m| {
                m >= 0
                    && m < n as i64
                    && at(m, i) >= threshold
                    && at(m, i) >= at(m - 1, i)
                    && at(m, i) >= at(m + 1, i)
            })
        };
        let mut i = l;
        while i < n {
            if !mark(i) {
                i += 1;
                continue;
            }
            let (mut j, mut gap, mut sum, mut count) = (i, 0, 0., 0);
            let mut q = i;
            while q < n && gap <= 3 {
                if mark(q) {
                    j = q;
                    gap = 0;
                    sum += at(l as i64 - 1, q)
                        .max(at(l as i64, q))
                        .max(at(l as i64 + 1, q));
                    count += 1;
                } else {
                    gap += 1;
                }
                q += 1;
            }
            let score = sum / count as f64;
            let edge = threshold.max(0.6 * score);
            let (mut from, mut to) = (i, n.min(j + k.smooth));
            while to - 1 > j && raw(l, to - 1) < edge {
                to -= 1;
            }
            while from < j && raw(l, from) < edge {
                from += 1;
            }
            if to - from >= k.min_repeat && l as f64 >= (to - from) as f64 * 0.9 {
                candidates.push(Repeat {
                    lag: l,
                    from,
                    to,
                    score,
                });
            }
            i = j + 1;
        }
    }
    candidates.sort_by(|a, b| {
        (b.score * (b.to - b.from) as f64).total_cmp(&(a.score * (a.to - a.from) as f64))
    });
    let mut result: Vec<Repeat> = vec![];
    for c in candidates {
        if result.iter().any(|p| {
            p.lag.abs_diff(c.lag) <= 2
                && p.to.min(c.to) as i64 - p.from.max(c.from) as i64 > 0.max(0) as i64
                && ((p.to.min(c.to) as i64 - p.from.max(c.from) as i64) as f64)
                    > 0.5 * (p.to - p.from).min(c.to - c.from) as f64
        }) {
            continue;
        }
        result.push(c);
    }
    result
}
#[derive(Clone)]
struct Bound {
    t: f64,
    i: usize,
    v: f64,
}
struct Links {
    n: usize,
    hits: Vec<Vec<BTreeSet<usize>>>,
    sums: Vec<Vec<f64>>,
    lengths: Vec<usize>,
    parent: Vec<usize>,
}
fn root(parent: &mut [usize], i: usize) -> usize {
    if parent[i] != i {
        parent[i] = root(parent, parent[i]);
    }
    parent[i]
}
impl Links {
    fn linked(&self, p: usize, q: usize) -> bool {
        let cover =
            |p: usize, q: usize| self.hits[p][q].len() as f64 / self.lengths[p].max(1) as f64;
        cover(p, q).min(cover(q, p)) >= 0.4
            && self.lengths[p].min(self.lengths[q]) as f64
                >= 0.5 * self.lengths[p].max(self.lengths[q]) as f64
    }
    fn sim(&self, p: usize, q: usize) -> f64 {
        self.sums[p][q] / self.hits[p][q].len().max(1) as f64
    }
}
fn link(bounds: &[Bound], paths: &[Repeat], s: &[f32], n: usize) -> Links {
    let count = bounds.len() - 1;
    let mut seg = vec![0usize; n];
    for k in 0..count {
        for i in bounds[k].i..bounds[k + 1].i {
            seg[i] = k;
        }
    }
    let mut links = Links {
        n: count,
        hits: vec![vec![BTreeSet::new(); count]; count],
        sums: vec![vec![0.; count]; count],
        lengths: (0..count).map(|k| bounds[k + 1].i - bounds[k].i).collect(),
        parent: (0..count).collect(),
    };
    let mut add = |fr: usize, partner: usize| {
        let (p, q) = (seg[fr], seg[partner]);
        if p != q && links.hits[p][q].insert(fr) {
            links.sums[p][q] += s[fr * n + partner] as f64;
        }
    };
    for p in paths {
        for i in p.from..p.to {
            add(i, i - p.lag);
            add(i - p.lag, i);
        }
    }
    for p in 0..count {
        for q in p + 1..count {
            if links.linked(p, q) {
                let rq = root(&mut links.parent, q);
                let rp = root(&mut links.parent, p);
                links.parent[rq] = rp;
            }
        }
    }
    links
}
struct Group {
    id: usize,
    occurrences: Vec<[f64; 2]>,
    similarity: f64,
    rel_db: f64,
    chorus: f64,
}
pub fn analyze(
    sp: &Spectral,
    rms: &[f64],
    start: f64,
    end: f64,
    body: f64,
    beat: Option<&Beat>,
    boundaries: &[f64],
) -> Option<Value> {
    let k = Scale::new(0.5f64.max((end - start) / 2400.));
    let f = features(sp, rms, start, end, body, k.hop);
    let n = f.n;
    if n < k.min_lag + k.min_repeat {
        return None;
    }
    let s = similarity(&f, None);
    let paths = paths(&s, n, &k);
    let nov = checkerboard(
        &similarity(&blurred(&f, k.fr(4.)), Some(2 * k.kernel - 1)),
        n,
        &k,
    );
    let mut sorted = nov.clone();
    sorted.sort_by(f32::total_cmp);
    let norm = (sorted[(sorted.len() as f64 * 0.98).floor() as usize] as f64).max(1e-6);
    let mut ends = vec![0f32; n];
    let bump = |arr: &mut [f32], at: i64, weight: f64| {
        for i in (at - k.fr(2.) as i64).max(0)..(at + k.fr(2.) as i64 + 1).min(n as i64) {
            arr[i as usize] = (arr[i as usize] as f64
                + weight * (-0.5 * ((i - at) as f64 / (0.75 / k.hop)).powi(2)).exp())
                as f32;
        }
    };
    for p in &paths {
        for at in [p.from, p.to, p.from - p.lag, p.to - p.lag] {
            bump(&mut ends, at as i64, clamp(p.score));
        }
    }
    let mut acoustic = vec![0.; n];
    for &t in boundaries {
        bump(&mut acoustic, round((t - start) / k.hop) as i64, 1.);
    }
    let evidence: Vec<f64> = (0..n)
        .map(|i| {
            0.5 * clamp(nov[i] as f64 / norm)
                + 0.35 * clamp(ends[i] as f64 / 2.)
                + 0.15 * clamp(acoustic[i] as f64)
        })
        .collect();
    let mut peaks: Vec<_> = evidence
        .iter()
        .enumerate()
        .filter(|(i, v)| {
            **v >= 0.3
                && *i >= k.fr(4.)
                && *i <= n.saturating_sub(k.fr(4.))
                && evidence[i.saturating_sub(k.fr(3.))..n.min(*i + k.fr(3.) + 1)]
                    .iter()
                    .all(|x| *x <= **v)
        })
        .map(|(i, v)| (i, *v))
        .collect();
    peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut cuts: Vec<(usize, f64)> = vec![];
    for p in peaks {
        if cuts.iter().all(|c| c.0.abs_diff(p.0) >= k.min_segment) {
            cuts.push(p);
        }
    }
    cuts.sort_by_key(|p| p.0);
    let grid =
        beat.filter(|b| b.stable && b.downbeat_confidence >= 0.25 && !b.downbeats.is_empty());
    let snap = |t: f64| {
        if let Some(b) = grid {
            let d = *b
                .downbeats
                .iter()
                .min_by(|a, b| (*a - t).abs().total_cmp(&(*b - t).abs()))
                .unwrap();
            if (d - t).abs() <= 1f64.min(b.period * 2.) {
                return d;
            }
        }
        t
    };
    let mut bounds = vec![Bound {
        t: start,
        i: 0,
        v: 0.,
    }];
    bounds.extend(cuts.into_iter().map(|(i, v)| Bound {
        t: snap(start + i as f64 * k.hop),
        i,
        v,
    }));
    bounds.push(Bound {
        t: end,
        i: n,
        v: 1.,
    });
    let mut linkage = link(&bounds, &paths, &s, n);
    for _ in 0..4 {
        let mut drop = BTreeSet::new();
        for j in 0..linkage.n.saturating_sub(1) {
            if !drop.contains(&j)
                && root(&mut linkage.parent, j) == root(&mut linkage.parent, j + 1)
                && !linkage.linked(j, j + 1)
            {
                drop.insert(j + 1);
            }
        }
        if drop.is_empty() {
            break;
        }
        bounds = bounds
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !drop.contains(i))
            .map(|(_, b)| b)
            .collect();
        linkage = link(&bounds, &paths, &s, n);
    }
    let count = linkage.n;
    let levels: Vec<_> = (0..count)
        .map(|j| {
            let (a, b) = (bounds[j].i, bounds[j + 1].i);
            let (mut m, mut c) = (0., 0);
            for i in a..b {
                if f.voiced[i] != 0 {
                    m += f.level[i] as f64;
                    c += 1;
                }
            }
            m = if c > 0 { m / c as f64 } else { -90. };
            let mid = (a + b - 1) as f64 / 2.;
            let (mut xy, mut xx) = (0., 0.);
            for i in a..b {
                if f.voiced[i] != 0 {
                    xy += (i as f64 - mid) * (f.level[i] as f64 - m);
                    xx += (i as f64 - mid).powi(2);
                }
            }
            (m, if xx > 0. { xy / xx * (10. / k.hop) } else { 0. })
        })
        .collect();
    let audible = (end - start).max(1.);
    let mean_rel = levels
        .iter()
        .enumerate()
        .map(|(j, l)| (l.0 - body) * linkage.lengths[j] as f64)
        .sum::<f64>()
        / n.max(1) as f64;
    let mut members: Vec<(usize, Vec<usize>)> = vec![];
    for j in 0..count {
        let r = root(&mut linkage.parent, j);
        if let Some(m) = members.iter_mut().find(|m| m.0 == r) {
            m.1.push(j);
        } else {
            members.push((r, vec![j]));
        }
    }
    let mut groups: Vec<Group> = vec![];
    let mut group_of = vec![-1i64; count];
    for (_, list) in members {
        if list.len() < 2 {
            continue;
        }
        let id = groups.len();
        let (mut sim_total, mut pairs, mut rel, mut frames) = (0., 0, 0., 0usize);
        for &p in &list {
            group_of[p] = id as i64;
            rel += (levels[p].0 - body) * linkage.lengths[p] as f64;
            frames += linkage.lengths[p];
            for &q in &list {
                if q > p && !linkage.hits[p][q].is_empty() {
                    sim_total += linkage.sim(p, q);
                    pairs += 1;
                }
            }
        }
        let similarity = if pairs > 0 {
            sim_total / pairs as f64
        } else {
            0.
        };
        let rel_db = rel / frames as f64;
        let mean_len = frames as f64 * k.hop / list.len() as f64;
        let share = frames as f64 * k.hop / audible;
        let f_rep = if list.len() >= 3 { 1. } else { 0.7 };
        let f_en = clamp(0.5 + (rel_db - mean_rel) / 4.);
        let f_sim = clamp((similarity - 0.3) / 0.4);
        let f_len = clamp(1. - (10. - mean_len).max(0.) / 6. - (mean_len - 45.).max(0.) / 30.);
        let f_pos = if bounds[list[0]].t > start + 10. {
            1.
        } else {
            0.4
        };
        let f_cov = clamp((0.75 - share) / 0.15);
        let chorus = rounded(
            f_rep * f_cov * (0.35 * f_en + 0.25 * f_sim + 0.2 * f_len + 0.2 * f_pos),
            1000.,
        );
        groups.push(Group {
            id,
            occurrences: list
                .iter()
                .map(|j| {
                    [
                        rounded(bounds[*j].t, 1000.),
                        rounded(bounds[*j + 1].t, 1000.),
                    ]
                })
                .collect(),
            similarity: rounded(clamp(similarity), 1000.),
            rel_db: rounded(rel_db, 10.),
            chorus,
        });
    }
    let mut ranked: Vec<_> = groups.iter().collect();
    ranked.sort_by(|a, b| b.chorus.total_cmp(&a.chorus));
    let mut chorus = None;
    if let Some(best) = ranked.first() {
        let second = ranked.get(1).map_or(0., |g| g.chorus);
        if best.chorus >= 0.5 && best.chorus - second >= 0.08 {
            let mut tags = vec![format!("repeats-{}x", best.occurrences.len())];
            if best.rel_db - mean_rel > 1. {
                tags.push("louder-than-average".into());
            }
            if best.similarity > 0.6 {
                tags.push("strong-repetition".into());
            }
            chorus = Some(
                json!({"group":best.id,"confidence":rounded(0.9*best.chorus*(0.6+0.4*clamp((best.chorus-second)/0.25)),1000.),"tags":tags}),
            );
        }
    }
    let bars = grid.map_or(0., |b| b.period * 4.);
    let mut segments = vec![];
    let mut repeated = 0.;
    for j in 0..count {
        let g = group_of[j];
        let next = bounds[j + 1].i;
        let mut bar_fit = 0.5;
        if bars > 0. {
            let units = (bounds[j + 1].t - bounds[j].t) / bars;
            let off = |m: f64| (units / m - round(units / m)).abs();
            bar_fit = if off(4.) < 0.07 {
                1.
            } else if off(2.) < 0.13 {
                0.7
            } else if off(1.) < 0.25 {
                0.4
            } else {
                0.1
            };
        }
        let closure = if j == count - 1 {
            1.
        } else {
            clamp(
                0.4 * clamp(ends[(n - 1).min(next)] as f64)
                    + 0.35 * bounds[j + 1].v
                    + 0.25 * bar_fit,
            )
        };
        let mut best_sim = 0f64;
        if g >= 0 {
            for q in 0..count {
                if q != j && group_of[q] == g && !linkage.hits[j][q].is_empty() {
                    best_sim = best_sim.max(linkage.sim(j, q));
                }
            }
            repeated += bounds[j + 1].t - bounds[j].t;
        }
        let occurrence = if g >= 0 {
            groups[g as usize]
                .occurrences
                .iter()
                .position(|o| (o[0] - rounded(bounds[j].t, 1000.)).abs() < 1e-6)
                .map_or(-1, |i| i as i64)
        } else {
            -1
        };
        segments.push(json!({"start":rounded(bounds[j].t,1000.),"end":rounded(bounds[j+1].t,1000.),"group":g,"occurrence":occurrence,"repeatSimilarity":rounded(clamp(best_sim),1000.),"chorusLikelihood":if g>=0{groups[g as usize].chorus}else{0.},"rmsDb":rounded(levels[j].0,10.),"relDb":rounded(levels[j].0-body,10.),"slopeDb":rounded(levels[j].1,10.),"novelty":rounded(clamp(bounds[j].v),1000.),"endClosure":rounded(closure,1000.)}));
    }
    let groups:Vec<_>=groups.into_iter().map(|g|json!({"id":g.id,"occurrences":g.occurrences.iter().map(|o|json!({"start":o[0],"end":o[1]})).collect::<Vec<_>>(),"similarity":g.similarity,"relDb":g.rel_db,"chorusLikelihood":g.chorus})).collect();
    let mut result = json!({"method":"ssm-repeat-1","segments":segments,"groups":groups,"repetitionCoverage":rounded(repeated/audible,1000.)});
    if let Some(c) = chorus {
        result["likelyChorus"] = c;
    }
    if let Some(b) = beat {
        if let Some(check) = grid_check(sp, &paths, k.hop, start, b) {
            result["gridCheck"] = check;
        }
    }
    Some(result)
}
fn grid_check(sp: &Spectral, paths: &[Repeat], hop: f64, start: f64, beat: &Beat) -> Option<Value> {
    let fps = sp.chroma_fps;
    let n = sp.chroma_frames;
    let centre_time = FRAME as f64 / 2. / SR;
    let mut c = sp.chroma.clone();
    let keep = vec![1; n];
    normalize(&mut c, 12, &keep);
    centre(&mut c, 12, &keep, false);
    normalize(&mut c, 12, &keep);
    let (mut errors, mut lag_beats) = (vec![], vec![]);
    let (mut whole, mut bar_whole, mut triple) = (0, 0, 0);
    for p in paths.iter().filter(|p| p.score >= 0.4).take(24) {
        let base = round(p.lag as f64 * hop * fps) as i64;
        let a = (base + 12).max(((start + p.from as f64 * hop - centre_time) * fps).ceil() as i64);
        let b = (n as i64).min(((start + p.to as f64 * hop - centre_time) * fps).floor() as i64);
        if ((b - a) as f64) < fps * 6. {
            continue;
        }
        let score = |lag: i64| {
            let (mut v, mut count) = (0., 0);
            for t in (a..b).step_by(2) {
                // The reference gives an invalid correlation candidate NaN, never an array panic.
                if t - lag < 0 || t - lag >= n as i64 {
                    return f64::NAN;
                }
                for q in 0..12 {
                    v += c[t as usize * 12 + q] as f64 * c[(t - lag) as usize * 12 + q] as f64;
                }
                count += 1;
            }
            v / count.max(1) as f64
        };
        let radius = (fps * 0.6).ceil() as i64;
        let (mut bd, mut bv) = (0, f64::NEG_INFINITY);
        let mut vals = vec![];
        for d in -radius..=radius {
            let v = score(base + d);
            vals.push(v);
            if v > bv {
                bv = v;
                bd = d;
            }
        }
        let at = (bd + radius) as usize;
        let frac = if at > 0 && at + 1 < vals.len() {
            let (l, r) = (vals[at - 1], vals[at + 1]);
            let den = l - 2. * bv + r;
            if den < 0. {
                ((l - r) / (2. * den)).clamp(-0.5, 0.5)
            } else {
                0.
            }
        } else {
            0.
        };
        let beats = (base as f64 + bd as f64 + frac) / fps / beat.period;
        let err = (beats - round(beats)).abs();
        errors.push(err);
        lag_beats.push(rounded(beats, 100.));
        if err < 0.15 {
            whole += 1;
            let k = round(beats) as i64;
            if k % 4 == 0 {
                bar_whole += 1;
            } else if k % 3 == 0 {
                triple += 1;
            }
        }
    }
    if errors.is_empty() {
        return None;
    }
    let mut hint: Option<(f64, f64)> = None;
    if lag_beats.len() >= 4 && (whole as f64 / lag_beats.len() as f64) < 0.5 {
        for r in [2. / 3., 4. / 3., 3. / 2., 3. / 4.] {
            let share = lag_beats
                .iter()
                .filter(|b| (**b / r - round(**b / r)).abs() < 0.15)
                .count() as f64
                / lag_beats.len() as f64;
            let bpm = 60. / (beat.period * r);
            if share >= 0.8
                && hint.is_none_or(|h| (bpm / 120.).ln().abs() < (h.0 / 120.).ln().abs())
            {
                hint = Some((rounded(bpm, 100.), rounded(share, 1000.)));
            }
        }
    }
    errors.sort_by(f64::total_cmp);
    let mut result = json!({"lags":errors.len(),"beatIntegerShare":rounded(whole as f64/errors.len()as f64,1000.),"barIntegerShare":rounded(if whole>0{bar_whole as f64/whole as f64}else{0.},1000.),"tripleShare":rounded(if whole>0{triple as f64/whole as f64}else{0.},1000.),"medianBeatError":rounded(errors[errors.len()/2],1000.),"lagBeats":lag_beats});
    if let Some((bpm, share)) = hint {
        result["periodHint"] = json!({"bpm":bpm,"share":share});
    }
    Some(result)
}
