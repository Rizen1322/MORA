use crate::{
    dsp::{number, Echo, Isolator, Limiter, Reverb, Sweep, Tone},
    playback::Playback,
    source::{Loop, Store, Tape, CHUNK},
    vocal::{source_map, Fit, Heard, Mask},
    wsola::{round, Wsola},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

type Points = Vec<[f64; 2]>;
fn eval(p: &[[f64; 2]], t: f64) -> f64 {
    if p.is_empty() {
        return 1.;
    }
    if t <= p[0][0] {
        return p[0][1];
    }
    if t >= p[p.len() - 1][0] {
        return p[p.len() - 1][1];
    }
    let hi = p.partition_point(|v| v[0] <= t);
    let [t0, v0] = p[hi - 1];
    let [t1, v1] = p[hi];
    if t1 == t0 {
        v1
    } else {
        v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    }
}
#[derive(Clone, Deserialize)]
pub struct Lane {
    deck: String,
    lane: usize,
    points: Points,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    plan_id: String,
    method: String,
    from_token: String,
    to_token: String,
    trigger_frame: f64,
    entry_frame: f64,
    duration_frames: f64,
    gap_frames: f64,
    swap_frame: f64,
    #[serde(default)]
    b_delay_frames: f64,
    tempo_b: Points,
    #[serde(default)]
    tempo_a: Points,
    #[serde(default)]
    loop_a: Option<Loop>,
    #[serde(default)]
    tape_stop_a: Option<Tape>,
    lanes: Vec<Lane>,
    echo_delay_frames: Option<f64>,
    echo_feedback: Option<f64>,
    #[serde(default)]
    echo_lowpass_hz: Option<f64>,
    #[serde(default)]
    echo_width: Option<f64>,
    #[serde(default)]
    vocal_a: Option<Points>,
    #[serde(default)]
    vocal_b: Option<Points>,
    voice_echo_delay_frames: Option<f64>,
    voice_echo_feedback: Option<f64>,
    voice_echo_clear_frame: Option<f64>,
}
impl Transition {
    fn validate(&self) -> Result<(), String> {
        let nonnegative = [
            self.trigger_frame,
            self.entry_frame,
            self.duration_frames,
            self.gap_frames,
            self.swap_frame,
            self.b_delay_frames,
        ];
        if nonnegative
            .iter()
            .any(|x| !x.is_finite() || *x < 0. || x.fract() != 0. || *x > 9_007_199_254_740_991.)
            || self.duration_frames + self.gap_frames <= 0.
            || self.lanes.len() > 64
            || self
                .lanes
                .iter()
                .any(|l| l.lane > 6 || !["A", "B"].contains(&l.deck.as_str()))
        {
            return Err("Invalid transition".into());
        }
        for points in self
            .lanes
            .iter()
            .map(|l| &l.points)
            .chain([&self.tempo_a, &self.tempo_b])
            .chain(self.vocal_a.iter())
            .chain(self.vocal_b.iter())
        {
            if points.len() > 4096
                || points
                    .iter()
                    .any(|p| !p[0].is_finite() || !p[1].is_finite() || p[0] < 0.)
                || points.windows(2).any(|w| w[0][0] > w[1][0])
            {
                return Err("Invalid automation".into());
            }
        }
        if self
            .vocal_a
            .iter()
            .chain(self.vocal_b.iter())
            .flatten()
            .any(|p| !(0.0..=2.5).contains(&p[1]))
            || self
                .voice_echo_delay_frames
                .into_iter()
                .chain(self.voice_echo_feedback)
                .chain(self.voice_echo_clear_frame)
                .any(|x| !x.is_finite() || x < 0.)
        {
            return Err("Invalid vocal automation".into());
        }
        if self
            .tempo_a
            .iter()
            .chain(self.tempo_b.iter())
            .any(|p| !(0.25..=4.).contains(&p[1]))
        {
            return Err("Invalid tempo".into());
        }
        if self.echo_lowpass_hz.into_iter().chain(self.echo_width).any(|x| !x.is_finite() || x < 0.) {
            return Err("Invalid echo".into());
        }
        Ok(())
    }
    fn lanes(&self, role: &str, t: f64) -> [f64; 7] {
        let mut v = unity();
        for l in &self.lanes {
            if l.deck == role {
                v[l.lane] = eval(&l.points, t);
            }
        }
        v
    }
}
fn unity() -> [f64; 7] {
    [1., 1., 1., 1., 0., 0., 0.]
}
#[derive(Clone)]
struct Tempo {
    origin: f64,
    points: Points,
}
struct Deck {
    token: Option<String>,
    store: Store,
    wsola: Wsola,
    iso: Isolator,
    filter: Sweep,
    playing: bool,
    starved: bool,
    norm: f64,
    norm_target: f64,
    lanes: [f64; 7],
    lane_target: Option<[f64; 7]>,
    tempo: Option<Tempo>,
    cue: f64,
    fade: f64,
    fade_target: f64,
    fade_step: f64,
    stop_silent: bool,
    pending_seek: Option<f64>,
    requested: BTreeSet<usize>,
    ended: bool,
    last_l: f32,
    last_r: f32,
    tail_l: f32,
    tail_r: f32,
    tail_left: usize,
    pending_vocal: Option<Mask>,
    vocal_requested: BTreeSet<usize>,
    fit: Fit,
    voice_expected: bool,
    echo_gate: f64,
}
impl Deck {
    fn new(sr: f64) -> Self {
        Self {
            token: None,
            store: Store::new(sr),
            wsola: Wsola::new(sr),
            iso: Isolator::new(sr),
            filter: Sweep::new(sr),
            playing: false,
            starved: false,
            norm: 1.,
            norm_target: 1.,
            lanes: unity(),
            lane_target: None,
            tempo: None,
            cue: 0.,
            fade: 1.,
            fade_target: 1.,
            fade_step: 1.,
            stop_silent: false,
            pending_seek: None,
            requested: BTreeSet::new(),
            ended: false,
            last_l: 0.,
            last_r: 0.,
            tail_l: 0.,
            tail_r: 0.,
            tail_left: 0,
            pending_vocal: None,
            vocal_requested: BTreeSet::new(),
            fit: Fit::default(),
            voice_expected: false,
            echo_gate: 1.,
        }
    }
    fn position(&self) -> f64 {
        self.wsola.position()
    }
    fn ratio(&self, clock: f64) -> f64 {
        self.tempo
            .as_ref()
            .map_or(1., |m| eval(&m.points, clock - m.origin))
    }
    fn clear_tail(&mut self) {
        self.last_l = 0.;
        self.last_r = 0.;
        self.tail_l = 0.;
        self.tail_r = 0.;
        self.tail_left = 0;
    }
    fn fade_stop(&mut self, sr: f64, seconds: f64) {
        self.fade_target = 0.;
        self.fade_step = 1. / round(sr * seconds).max(1.);
        self.stop_silent = true;
        self.pending_seek = None;
    }
    fn request(
        &mut self,
        index: usize,
        sr: f64,
        around: Option<f64>,
        tr: Option<&Transition>,
        events: &mut Vec<Value>,
    ) {
        let Some(token) = self.token.clone() else {
            return;
        };
        if self.store.total <= 0 {
            return;
        }
        let pos = around.unwrap_or(if self.playing {
            self.position()
        } else {
            self.cue
        });
        let ahead = round(24. * sr * 1.1) as i64;
        let mut missing = self.store.missing(
            (pos as i64 - 4096).max(0),
            (pos as i64 + ahead).min(self.store.total),
        );
        let window = |p: f64| {
            (
                p as i64 - (CHUNK * 4) as i64,
                p as i64 + ahead + (CHUNK * 2) as i64,
            )
        };
        let mut keep = vec![window(pos)];
        let loop_ = tr
            .filter(|t| self.token.as_deref() == Some(&t.from_token))
            .and_then(|t| t.loop_a.as_ref())
            .or(self.store.loop_.as_ref());
        let tape = tr
            .filter(|t| self.token.as_deref() == Some(&t.from_token))
            .and_then(|t| t.tape_stop_a.as_ref())
            .or(self.store.tape.as_ref());
        if let Some(p) = loop_ {
            keep.push((p.start - p.fade, p.end));
            missing.extend(self.store.missing(p.start - p.fade, p.end));
        }
        if let Some(p) = tape {
            keep.push((p.start - CHUNK as i64, p.end + CHUNK as i64));
            missing.extend(
                self.store
                    .missing(p.start - CHUNK as i64, p.end + CHUNK as i64),
            );
        }
        if self.playing && self.position() != pos {
            keep.push(window(self.position()));
        }
        if let Some(p) = self.pending_seek {
            if p != pos {
                keep.push(window(p));
            }
        }
        self.store.chunks.retain(|k, _| {
            keep.iter().any(|(a, b)| {
                *b > *a && ((*k * CHUNK) as i64) < *b && (((*k + 1) * CHUNK) as i64) > *a
            })
        });
        let pending_cue = tr
            .filter(|_| self.pending_vocal.is_some())
            .map_or(pos, |tr| {
                if self.token.as_deref() == Some(&tr.from_token) {
                    tr.trigger_frame
                } else {
                    tr.entry_frame
                }
            });
        let mut vocal_keep = keep.clone();
        if self.pending_vocal.is_some() {
            vocal_keep.push(window(pending_cue));
        }
        self.store.voice.borrow_mut().chunks.retain(|k, _| {
            vocal_keep.iter().any(|(a, b)| {
                *b > *a && ((*k * CHUNK) as i64) < *b && (((*k + 1) * CHUNK) as i64) > *a
            })
        });
        let active = self.store.voice.borrow().mask.clone();
        self.request_voice(
            index,
            &active,
            (pos - 4096.).max(0.),
            (pos + ahead as f64).min(self.store.total as f64),
            events,
        );
        if let Some(mask) = self.pending_vocal.clone() {
            self.request_voice(
                index,
                &mask,
                (pending_cue - 4096.).max(0.),
                (pending_cue + ahead as f64).min(self.store.total as f64),
                events,
            );
        }
        for &(from, to) in &keep[1..] {
            self.request_voice(index, &active, from as f64, to as f64, events);
            if let Some(mask) = self.pending_vocal.clone() {
                self.request_voice(index, &mask, from as f64, to as f64, events);
            }
        }
        let mut chunks = Vec::new();
        for k in missing {
            if self.requested.insert(k) {
                chunks.push(k);
            }
        }
        if !chunks.is_empty() {
            events.push(json!({"type":"need","deck":index,"token":token,"chunks":chunks}));
        }
    }
    fn request_voice(
        &mut self,
        index: usize,
        mask: &Mask,
        from: f64,
        to: f64,
        events: &mut Vec<Value>,
    ) {
        if self.token.is_none() || !mask.needs(from, to, self.store.total) {
            return;
        }
        let chunks: Vec<_> = self
            .store
            .voice
            .borrow()
            .missing(from, to)
            .into_iter()
            .filter(|c| {
                !self.vocal_requested.contains(c)
                    && mask.needs(
                        (c * CHUNK) as f64,
                        ((c + 1) * CHUNK) as f64,
                        self.store.total,
                    )
            })
            .collect();
        if chunks.is_empty() {
            return;
        }
        self.vocal_requested.extend(chunks.iter().copied());
        events.push(
            json!({"type":"need","deck":index,"token":self.token,"chunks":chunks,"part":"vocals"}),
        );
    }
    fn vocals_ready(&self, from: f64, to: f64) -> bool {
        self.pending_vocal.as_ref().is_none_or(|mask| {
            self.store.voice.borrow().missing(from, to).iter().all(|c| {
                !mask.needs(
                    (c * CHUNK) as f64,
                    ((c + 1) * CHUNK) as f64,
                    self.store.total,
                )
            })
        })
    }
    fn clear_voice(&mut self) {
        self.pending_vocal = None;
        self.store.voice.borrow_mut().mask = Mask::default();
        self.voice_expected = false;
        self.wsola.set_side(None);
    }
}
struct Musical {
    sr: f64,
    decks: [Deck; 2],
    main: usize,
    clock: f64,
    paused: bool,
    armed: Option<Transition>,
    active: bool,
    late: bool,
    late_notified: bool,
    swapped: bool,
    forced: bool,
    t: f64,
    echo: Echo,
    voice_echo: Echo,
    vl: [f32; 512],
    vr: [f32; 512],
    sl: [f32; 512],
    sr_side: [f32; 512],
    el: [f32; 512],
    er: [f32; 512],
    bl: [f32; 512],
    br: [f32; 512],
    events: Vec<Value>,
}
impl Musical {
    fn new(sr: f64) -> Self {
        Self {
            sr,
            decks: std::array::from_fn(|_| Deck::new(sr)),
            main: 0,
            clock: 0.,
            paused: false,
            armed: None,
            active: false,
            late: false,
            late_notified: false,
            swapped: false,
            forced: false,
            t: 0.,
            echo: Echo::new(sr),
            voice_echo: Echo::new(sr),
            vl: [0.; 512],
            vr: [0.; 512],
            sl: [0.; 512],
            sr_side: [0.; 512],
            el: [0.; 512],
            er: [0.; 512],
            bl: [0.; 512],
            br: [0.; 512],
            events: Vec::new(),
        }
    }
    fn index(&self, token: &str) -> Option<usize> {
        self.decks
            .iter()
            .position(|d| d.token.as_deref() == Some(token))
    }
    fn disarm(&mut self, reason: &str) {
        if !self.active {
            if let Some(tr) = self.armed.take() {
                for d in &mut self.decks {
                    d.store.clear_effects();
                    d.pending_vocal = None;
                }
                self.events
                    .push(json!({"type":"disarmed","planId":tr.plan_id,"reason":reason}));
            }
        }
    }
    fn abort(&mut self, reason: &str) {
        let id = self.armed.take().map_or(String::new(), |t| t.plan_id);
        self.active = false;
        for d in &mut self.decks {
            d.store.clear_effects();
            d.clear_voice();
        }
        self.voice_echo.fade_out(round(self.sr * 0.15));
        self.events
            .push(json!({"type":"transitionAborted","planId":id,"reason":reason}));
    }
    fn detach(&mut self, index: usize, reason: &str) {
        if !self.armed.as_ref().is_some_and(|t| {
            self.decks[index].token.as_deref() == Some(&t.from_token)
                || self.decks[index].token.as_deref() == Some(&t.to_token)
        }) {
            return;
        }
        if !self.active {
            self.disarm(reason);
            return;
        }
        let other = 1 - index;
        let d = &mut self.decks[other];
        if d.playing {
            d.lane_target = Some(unity());
            d.tempo = Some(Tempo {
                origin: self.clock,
                points: vec![[0., d.ratio(self.clock)], [round(self.sr * 0.6), 1.]],
            });
            self.main = other;
        }
        self.echo.reset();
        self.voice_echo.reset();
        self.abort(reason);
    }
    fn try_start(&mut self) -> bool {
        let Some(mut tr) = self.armed.clone() else {
            return false;
        };
        let Some(a) = self.index(&tr.from_token) else {
            return false;
        };
        let Some(b) = self.index(&tr.to_token).filter(|b| *b != a) else {
            self.events
                .push(json!({"type":"fallback","planId":tr.plan_id,"reason":"deck_missing"}));
            self.armed = None;
            return false;
        };
        let need = (tr.duration_frames + self.sr).min(self.sr * 3.) * 1.15 + 4096.;
        let ready = self.decks[b].store.covers(
            (tr.entry_frame - 4096.) as i64,
            (tr.entry_frame + need).ceil() as i64,
        ) && tr
            .loop_a
            .as_ref()
            .is_none_or(|p| self.decks[a].store.covers(p.start - p.fade, p.end))
            && tr
                .tape_stop_a
                .as_ref()
                .is_none_or(|p| self.decks[a].store.covers(p.start - 2, p.end + 2));
        let vocal_ready = self.decks[a]
            .vocals_ready(tr.trigger_frame - 4096., tr.trigger_frame + need)
            && self.decks[b].vocals_ready(tr.entry_frame - 4096., tr.entry_frame + need);
        if !ready || !vocal_ready {
            if !self.late_notified {
                self.late_notified = true;
                self.late = true;
                self.events.push(
                    json!({"type":"fallback","planId":tr.plan_id,"reason":if ready {"vocal_buffer_not_ready"} else {"buffer_not_ready"}}),
                );
                self.decks[b].cue = tr.entry_frame;
                self.request_all();
            }
            return false;
        }
        if self.late {
            let duration = round(self.sr * 2.);
            tr.method = "fallback_crossfade".into();
            tr.duration_frames = duration;
            tr.gap_frames = 0.;
            tr.swap_frame = round(duration / 2.);
            tr.tempo_b = vec![[0., 1.]];
            tr.tempo_a.clear();
            tr.loop_a = None;
            tr.tape_stop_a = None;
            tr.vocal_a = None;
            tr.vocal_b = None;
            self.decks[a].pending_vocal = None;
            self.decks[b].pending_vocal = None;
            tr.lanes = ["A", "B"]
                .into_iter()
                .map(|role| Lane {
                    deck: role.into(),
                    lane: 0,
                    points: (0..=8)
                        .map(|i| {
                            let x = i as f64 / 8.;
                            [
                                round(duration * x),
                                if role == "A" {
                                    (x * std::f64::consts::FRAC_PI_2).cos()
                                } else {
                                    (x * std::f64::consts::FRAC_PI_2).sin()
                                },
                            ]
                        })
                        .collect(),
                })
                .collect();
        }
        for (index, expected) in [(a, tr.vocal_a.is_some()), (b, tr.vocal_b.is_some())] {
            let d = &mut self.decks[index];
            let mut voice = d.store.voice.borrow_mut();
            voice.mask = d.pending_vocal.take().unwrap_or_default();
            voice.scale = d.fit.scale(self.sr);
            d.voice_expected = expected;
            d.echo_gate = if expected { 0. } else { 1. };
        }
        if !self.decks[a].store.set_loop(tr.loop_a.clone()) {
            self.events
                .push(json!({"type":"fallback","planId":tr.plan_id,"reason":"invalid_loop"}));
        }
        if !self.decks[a].store.set_tape(tr.tape_stop_a.clone()) {
            self.events
                .push(json!({"type":"fallback","planId":tr.plan_id,"reason":"invalid_tape_stop"}));
        }
        let d = &mut self.decks[b];
        d.wsola.reset(tr.entry_frame);
        d.clear_tail();
        d.playing = true;
        d.starved = false;
        d.fade = 1.;
        d.fade_target = 1.;
        d.stop_silent = false;
        d.pending_seek = None;
        d.ended = false;
        d.tempo = Some(Tempo {
            origin: self.clock
                + if tr.gap_frames > 0. {
                    tr.duration_frames + tr.gap_frames
                } else {
                    tr.b_delay_frames
                },
            points: tr.tempo_b.clone(),
        });
        d.lanes = tr.lanes("B", 0.);
        d.lane_target = None;
        self.decks[a].lane_target = None;
        if !tr.tempo_a.is_empty() {
            self.decks[a].tempo = Some(Tempo {
                origin: self.clock,
                points: tr.tempo_a.clone(),
            });
        }
        if let Some(delay) = tr.echo_delay_frames.filter(|d| *d != 0.) {
            self.echo.configure_with(
                delay,
                tr.echo_feedback.unwrap_or(0.5),
                tr.echo_lowpass_hz.unwrap_or(6000.),
                tr.echo_width.unwrap_or(0.),
            );
        }
        let throw = tr
            .lanes
            .iter()
            .any(|l| l.deck == "A" && l.lane == 5 && l.points.iter().any(|p| p[1] > 0.));
        if throw
            && tr.voice_echo_delay_frames.is_some_and(|v| v != 0.)
            && self.decks[a].store.voice.borrow().mask.points.is_some()
        {
            self.voice_echo.configure(
                tr.voice_echo_delay_frames.unwrap(),
                tr.voice_echo_feedback.unwrap_or(0.4),
            );
            let opening = tr
                .vocal_b
                .as_ref()
                .and_then(|p| p.iter().position(|p| p[1] > 0.));
            if tr.voice_echo_clear_frame.is_some() || opening.is_some() {
                let starts = tr.voice_echo_clear_frame.unwrap_or_else(|| {
                    tr.vocal_b.as_ref().unwrap()[opening.unwrap().saturating_sub(1)][0]
                        + tr.b_delay_frames
                });
                self.voice_echo.limit_tail_at(
                    self.clock + (starts - round(self.sr * 0.08)).max(0.),
                    round(self.sr * 0.12),
                );
            }
            self.decks[a]
                .wsola
                .set_side(Some(Box::new(Heard(self.decks[a].store.voice.clone()))));
        }
        self.active = true;
        self.t = 0.;
        self.swapped = false;
        self.events.push(json!({"type":"transitionStart","planId":tr.plan_id,"late":self.late,"clock":self.clock}));
        self.armed = Some(tr);
        true
    }
    fn end(&mut self) {
        let Some(tr) = self.armed.take() else {
            return;
        };
        if let Some(a) = self.index(&tr.from_token) {
            self.decks[a].playing = false;
            self.decks[a].store.clear_effects();
            self.decks[a].lanes = unity();
            self.decks[a].clear_voice();
        }
        if let Some(b) = self.index(&tr.to_token) {
            self.decks[b].lanes = unity();
            self.decks[b].voice_expected = false;
            self.main = b;
        }
        self.active = false;
        for d in &mut self.decks {
            d.pending_vocal = None;
        }
        if !self.swapped {
            self.events
                .push(json!({"type":"swap","planId":tr.plan_id,"token":tr.to_token}));
        }
        self.events.push(json!({"type":"transitionEnd","planId":tr.plan_id,"token":tr.to_token,"forced":self.forced}));
    }
    fn request_all(&mut self) {
        for i in 0..2 {
            self.decks[i].request(i, self.sr, None, self.armed.as_ref(), &mut self.events);
        }
    }
    fn retire_voice(&mut self, index: usize) {
        let Some(mut tr) = self.armed.clone() else {
            return;
        };
        let a = &mut self.decks[index];
        let now = if self.active { self.t } else { 0. };
        let fade = round(self.sr * 0.18).max(1.);
        let mut off = None;
        for [time, gain] in tr.vocal_a.as_deref().unwrap_or(&[]) {
            if *gain <= 1e-3 {
                if off.is_none() {
                    off = Some(*time);
                }
            } else {
                off = None;
            }
        }
        let end = off.filter(|v| *v > now + fade).unwrap_or(now + fade);
        let start = now.max(end - fade);
        let neutral = [[0., 1.]];
        let old = tr
            .lanes
            .iter()
            .find(|l| l.deck == "A" && l.lane == 0)
            .map_or(&neutral[..], |l| l.points.as_slice());
        let mut points = if self.active {
            vec![[now, a.lanes[0]]]
        } else {
            old.iter().copied().filter(|p| p[0] < start).collect()
        };
        let at = if self.active {
            a.lanes[0]
        } else {
            eval(old, start)
        };
        if points.is_empty() || points.last().unwrap()[0] < start {
            points.push([start, at]);
        }
        points.push([end.max(start + 1.), 0.]);
        tr.lanes
            .retain(|l| !(l.deck == "A" && [0, 4, 5].contains(&l.lane)));
        tr.lanes.push(Lane {
            deck: "A".into(),
            lane: 0,
            points,
        });
        tr.lanes.push(Lane {
            deck: "A".into(),
            lane: 4,
            points: vec![[0., 0.]],
        });
        tr.vocal_a = None;
        a.wsola.set_side(None);
        a.voice_expected = false;
        a.echo_gate = 0.;
        self.voice_echo.fade_out(round(self.sr * 0.15));
        self.armed = Some(tr);
    }
    fn render(&mut self, l: &mut [f32], r: &mut [f32]) {
        l.fill(0.);
        r.fill(0.);
        if self.paused {
            return;
        }
        let n = l.len();
        for d in &mut self.decks {
            let voice = d.store.voice.borrow();
            let mask = d.pending_vocal.as_ref().or(if voice.mask.points.is_some() {
                Some(&voice.mask)
            } else {
                None
            });
            if let Some(mask) = mask {
                d.fit.advance(&d.store.chunks, &voice, mask);
            }
        }
        self.el[..n].fill(0.);
        self.er[..n].fill(0.);
        self.vl[..n].fill(0.);
        self.vr[..n].fill(0.);
        let mut off = 0;
        while off < n {
            let mut len = n - off;
            if !self.active {
                if let Some(tr) = &self.armed {
                    if let Some(a) = self.index(&tr.from_token) {
                        let d = &self.decks[a];
                        if d.playing {
                            if d.position() >= tr.trigger_frame || self.late {
                                self.try_start();
                            } else {
                                let to = ((tr.trigger_frame - d.position())
                                    / d.ratio(self.clock).max(0.25))
                                .ceil() as usize;
                                if to < len {
                                    len = to.max(1);
                                }
                            }
                        }
                    }
                }
            }
            if self.active {
                if let Some(tr) = &self.armed {
                    let rem = tr.duration_frames + tr.gap_frames - self.t;
                    if rem > 0. && rem < len as f64 {
                        len = rem as usize;
                    }
                    for lane in &tr.lanes {
                        if lane.deck == "B" && tr.gap_frames > 0. {
                            continue;
                        }
                        let shift = if lane.deck == "B" {
                            tr.b_delay_frames
                        } else {
                            0.
                        };
                        for p in &lane.points {
                            let point = p[0] + shift;
                            if point > self.t && point - self.t < len as f64 {
                                len = (point - self.t).ceil() as usize;
                            }
                        }
                    }
                    for point in [
                        if self.swapped { 0. } else { tr.swap_frame },
                        tr.b_delay_frames,
                    ] {
                        if point > self.t && point - self.t < len as f64 {
                            len = (point - self.t).ceil() as usize;
                        }
                    }
                }
            }
            self.render_sub(l, r, off, len);
            self.clock += len as f64;
            if self.active {
                self.t += len as f64;
                if let Some(tr) = &self.armed {
                    if !self.swapped && self.t >= tr.swap_frame {
                        self.swapped = true;
                        self.main = self.index(&tr.to_token).unwrap_or(self.main);
                        self.events
                            .push(json!({"type":"swap","planId":tr.plan_id,"token":tr.to_token}));
                    }
                    if self.t >= tr.duration_frames + tr.gap_frames {
                        self.end();
                    }
                }
            }
            off += len;
        }
        self.echo.process(&self.el[..n], &self.er[..n], l, r);
        self.voice_echo
            .process_at(&self.vl[..n], &self.vr[..n], l, r, self.clock - n as f64);
    }
    fn render_sub(&mut self, l: &mut [f32], r: &mut [f32], off: usize, len: usize) {
        let tr = if self.active {
            self.armed.as_ref()
        } else {
            None
        };
        for (index, d) in self.decks.iter_mut().enumerate() {
            if !d.playing {
                continue;
            }
            let role = tr.and_then(|t| {
                if d.token.as_deref() == Some(&t.from_token) {
                    Some("A")
                } else if d.token.as_deref() == Some(&t.to_token) {
                    Some("B")
                } else {
                    None
                }
            });
            if role == Some("B")
                && tr.is_some_and(|t| t.gap_frames > 0. || self.t < t.b_delay_frames)
            {
                continue;
            }
            let (from, to) = if let (Some(tr), Some(role)) = (tr, role) {
                let t = if role == "B" {
                    (self.t - tr.gap_frames - tr.b_delay_frames).max(0.)
                } else {
                    self.t
                };
                (tr.lanes(role, t), tr.lanes(role, t + len as f64))
            } else if let Some(target) = d.lane_target {
                let from = d.lanes;
                let step = len as f64 / (self.sr * 0.3);
                let to =
                    std::array::from_fn(|i| from[i] + (target[i] - from[i]).clamp(-step, step));
                if to == target {
                    d.lane_target = None;
                }
                (from, to)
            } else {
                (d.lanes, d.lanes)
            };
            d.lanes = to;
            let clock = self.clock;
            let tempo = &d.tempo;
            let pos_start = d.position();
            let throwing = d.wsola.has_side();
            let ratio = |k| {
                tempo
                    .as_ref()
                    .map_or(1., |t| eval(&t.points, clock + k as f64 - t.origin))
            };
            let produced = if throwing {
                d.wsola.render_side(
                    &mut d.store,
                    &mut self.bl[..len],
                    &mut self.br[..len],
                    ratio,
                    &mut self.sl[..len],
                    &mut self.sr_side[..len],
                )
            } else {
                d.wsola.render(
                    &mut d.store,
                    &mut self.bl[..len],
                    &mut self.br[..len],
                    ratio,
                )
            };
            if throwing && produced < len {
                self.sl[produced..len].fill(0.);
                self.sr_side[produced..len].fill(0.);
            }
            if produced < len {
                self.bl[produced..len].fill(0.);
                self.br[produced..len].fill(0.);
                if !d.starved && d.token.is_some() {
                    d.tail_l = if produced > 0 {
                        self.bl[produced - 1]
                    } else {
                        d.last_l
                    };
                    d.tail_r = if produced > 0 {
                        self.br[produced - 1]
                    } else {
                        d.last_r
                    };
                    d.tail_left = round(self.sr * 0.003).max(1.) as usize;
                    d.starved = true;
                    self.events.push(json!({"type":"underrun","deck":index,"token":d.token,"position":d.position()}));
                    d.request(index, self.sr, None, self.armed.as_ref(), &mut self.events);
                }
                let frames = round(self.sr * 0.003).max(1.);
                for i in produced..len {
                    if d.tail_left == 0 {
                        break;
                    }
                    let gain = 0.5
                        - 0.5 * (std::f64::consts::PI * (d.tail_left - 1) as f64 / frames).cos();
                    self.bl[i] = (d.tail_l as f64 * gain) as f32;
                    self.br[i] = (d.tail_r as f64 * gain) as f32;
                    d.tail_left -= 1;
                }
            } else if d.starved {
                d.starved = false;
                d.fade = 0.;
                d.fade_target = 1.;
                d.fade_step = 1. / round(self.sr * 0.008);
            }
            if produced > 0 {
                d.last_l = self.bl[produced - 1];
                d.last_r = self.br[produced - 1];
            }
            let idle = d.lane_target.is_none()
                && !self.armed.as_ref().is_some_and(|t| {
                    d.token.as_deref() == Some(&t.from_token)
                        || d.token.as_deref() == Some(&t.to_token)
                });
            d.iso.process(
                &mut self.bl[..len],
                &mut self.br[..len],
                [from[1], from[2], from[3]],
                [to[1], to[2], to[3]],
                idle,
            );
            d.filter
                .process(&mut self.bl[..len], &mut self.br[..len], from[6], to[6]);
            let n0 = d.norm;
            if n0 != d.norm_target {
                let step = len as f64 / (self.sr * 2.) * (d.norm_target - n0).abs().max(0.05);
                d.norm = if n0 < d.norm_target {
                    (n0 + step).min(d.norm_target)
                } else {
                    (n0 - step).max(d.norm_target)
                };
            }
            let mut g = from[0] * n0;
            let dg = (to[0] * d.norm - g) / len as f64;
            let mut fade = d.fade;
            let mut send = from[4];
            let ds = (to[4] - from[4]) / len as f64;
            let sending = from[4] > 0. || to[4] > 0.;
            let voice = d.store.voice.borrow();
            let gate_target = if d.voice_expected {
                if voice.mask.points.is_none() {
                    0.
                } else {
                    let settle = self.sr * 0.045 * d.ratio(clock).max(0.25);
                    if voice.mask.max_gain(
                        pos_start - settle - d.wsola.w as f64,
                        d.position() + d.wsola.w as f64,
                    ) <= 1e-3
                    {
                        1.
                    } else {
                        0.
                    }
                }
            } else {
                1.
            };
            drop(voice);
            let mut gate = if sending { d.echo_gate } else { gate_target };
            let gate_step = 1. / round(self.sr * 0.015).max(1.);
            for i in 0..len {
                if fade != d.fade_target {
                    fade = if fade < d.fade_target {
                        (fade + d.fade_step).min(d.fade_target)
                    } else {
                        (fade - d.fade_step).max(d.fade_target)
                    };
                }
                let k = g * fade;
                l[off + i] = (l[off + i] as f64 + self.bl[i] as f64 * k) as f32;
                r[off + i] = (r[off + i] as f64 + self.br[i] as f64 * k) as f32;
                if sending {
                    if gate != gate_target {
                        gate = if gate < gate_target {
                            (gate + gate_step).min(gate_target)
                        } else {
                            (gate - gate_step).max(gate_target)
                        };
                    }
                    let pre = d.norm * fade * send * gate;
                    self.el[off + i] = (self.el[off + i] as f64 + self.bl[i] as f64 * pre) as f32;
                    self.er[off + i] = (self.er[off + i] as f64 + self.br[i] as f64 * pre) as f32;
                    send += ds;
                }
                g += dg;
            }
            if throwing && (from[5] > 0. || to[5] > 0.) {
                let mut v = from[5] * n0;
                let dv = (to[5] * d.norm - v) / len as f64;
                let k0 = d.fade;
                let dk = (fade - k0) / len as f64;
                for i in 0..len {
                    let k = v * (k0 + dk * i as f64);
                    self.vl[off + i] = (self.vl[off + i] as f64 + self.sl[i] as f64 * k) as f32;
                    self.vr[off + i] =
                        (self.vr[off + i] as f64 + self.sr_side[i] as f64 * k) as f32;
                    v += dv;
                }
            }
            d.fade = fade;
            d.echo_gate = gate;
            if fade == 0. && d.fade_target == 0. {
                if let Some(target) = d.pending_seek.take() {
                    d.store.clear_effects();
                    d.wsola.reset(target);
                    d.clear_tail();
                    d.iso.reset();
                    d.filter.reset();
                    d.lanes = unity();
                    d.lane_target = None;
                    d.fade = 1.;
                    d.fade_target = 1.;
                } else if d.stop_silent {
                    d.store.clear_effects();
                    d.playing = false;
                    d.stop_silent = false;
                    d.fade = 1.;
                    d.fade_target = 1.;
                }
            }
        }
    }
}

pub struct Mixer {
    musical: Rc<RefCell<Musical>>,
    playback: Playback,
    tone: Tone,
    reverb: Reverb,
    limiter: Limiter,
    sr: f64,
    transport: f64,
    transport_target: f64,
    transport_step: f64,
    silent: usize,
    volume: f64,
    volume_target: f64,
    peak: f64,
    since_tick: usize,
    since_need: usize,
    tick_frames: usize,
}
impl Mixer {
    pub fn new(sr: u32) -> Result<Self, String> {
        if ![44100, 48000, 88200, 96000].contains(&sr) {
            return Err("Unsupported sample rate".into());
        }
        let sr = sr as f64;
        let musical = Rc::new(RefCell::new(Musical::new(sr)));
        let m = musical.clone();
        let playback = Playback::new(sr, Box::new(move |l, r| m.borrow_mut().render(l, r)));
        Ok(Self {
            musical,
            playback,
            tone: Tone::new(sr),
            reverb: Reverb::new(sr),
            limiter: Limiter::new(sr),
            sr,
            transport: 1.,
            transport_target: 1.,
            transport_step: 1. / round(sr * 0.012),
            silent: 0,
            volume: 1.,
            volume_target: 1.,
            peak: 0.,
            since_tick: 0,
            since_need: 0,
            tick_frames: round(sr * 0.05) as usize,
        })
    }
    pub fn command(&mut self, v: &Value) -> Result<(), String> {
        let cmd = v["cmd"].as_str().ok_or("Missing command")?;
        let deck = match v.get("deck") {
            Some(d) => {
                let d = d.as_u64().ok_or("Invalid deck")? as usize;
                if d > 1 {
                    return Err("Invalid deck".into());
                }
                d
            }
            None => 0,
        };
        let token = v["token"].as_str().unwrap_or("");
        if token.len() > 1024 {
            return Err("Invalid token".into());
        }
        let mut m = self.musical.borrow_mut();
        let sr = self.sr;
        match cmd {
            "load" => {
                let total = v["totalFrames"]
                    .as_i64()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or("Invalid totalFrames")?;
                if token.is_empty() {
                    return Err("Missing token".into());
                }
                if m.decks[deck].token.as_deref() != Some(token) {
                    m.detach(deck, "deck_reloaded");
                }
                let d = &mut m.decks[deck];
                d.store.clear_effects();
                d.store.total = total;
                d.store.chunks.clear();
                d.store.voice.borrow_mut().reset(total);
                d.pending_vocal = None;
                d.vocal_requested.clear();
                d.fit = Fit::default();
                d.voice_expected = false;
                d.echo_gate = 1.;
                d.wsola.set_side(None);
                d.token = Some(token.into());
                d.clear_tail();
                d.norm = 10f64.powf(number(v, "gainDb", 0.).clamp(-120., 36.) / 20.);
                d.norm_target = d.norm;
                d.playing = false;
                d.starved = false;
                d.tempo = None;
                d.lanes = unity();
                d.lane_target = None;
                d.cue = round(number(v, "cueFrame", 0.)).max(0.);
                d.fade = 1.;
                d.fade_target = 1.;
                d.stop_silent = false;
                d.pending_seek = None;
                d.requested.clear();
                d.ended = false;
                d.iso.reset();
                d.filter.reset();
                d.wsola.reset(d.cue);
                m.request_all();
            }
            "length" => {
                let n = v["totalFrames"]
                    .as_i64()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or("Invalid length")?;
                let d = &mut m.decks[deck];
                if d.token.as_deref() == Some(token) && n != d.store.total {
                    if let Some(edge) = d.store.resize(n) {
                        d.requested.remove(&edge);
                    }
                    if let Some(edge) = d.store.voice.borrow_mut().resize(n) {
                        d.vocal_requested.remove(&edge);
                    }
                }
            }
            "unload" => {
                m.detach(deck, "deck_unloaded");
                let d = &mut m.decks[deck];
                d.store.clear_effects();
                d.store.total = 0;
                d.store.chunks.clear();
                d.store.voice.borrow_mut().reset(0);
                d.pending_vocal = None;
                d.vocal_requested.clear();
                d.wsola.set_side(None);
                d.token = None;
                d.playing = false;
                d.requested.clear();
            }
            "feedFile" => {
                let chunk = v["chunk"]
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991 / CHUNK as u64)
                    .ok_or("Invalid chunk")? as usize;
                let d = &mut m.decks[deck];
                if d.token.as_deref() != Some(token) {
                    return Ok(());
                }
                let expected =
                    (d.store.total - (chunk as i64 * CHUNK as i64)).clamp(0, CHUNK as i64) as usize;
                let frames = v["frames"].as_u64().ok_or("Invalid PCM length")? as usize;
                if frames != expected || frames == 0 {
                    return Err("Invalid PCM length".into());
                }
                let (l, r) = crate::source::read_pcm_file(
                    v["path"].as_str().ok_or("Missing PCM path")?,
                    v["format"].as_str().ok_or("Missing PCM format")?,
                    chunk,
                    frames,
                )?;
                d.store.chunks.insert(chunk, (l, r));
                d.requested.remove(&chunk);
            }
            "feed" | "feedVocal" => {
                let chunk = v["chunk"]
                    .as_u64()
                    .filter(|v| *v <= 9_007_199_254_740_991 / CHUNK as u64)
                    .ok_or("Invalid chunk")? as usize;
                let d = &mut m.decks[deck];
                if d.token.as_deref() != Some(token) {
                    return Ok(());
                }
                let decode = |key: &str| -> Result<Vec<f32>, String> {
                    let raw = v[key].as_str().ok_or("Missing PCM")?;
                    if raw.len() > CHUNK * 6 {
                        return Err("PCM chunk too large".into());
                    }
                    let bytes = STANDARD.decode(raw).map_err(|_| "Invalid PCM encoding")?;
                    if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() > CHUNK * 4 {
                        return Err("Invalid PCM length".into());
                    }
                    let pcm: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                        .collect();
                    if pcm.iter().any(|f| !f.is_finite()) {
                        return Err("Non-finite PCM".into());
                    }
                    Ok(pcm)
                };
                let l = decode("L")?;
                let r = decode("R")?;
                if l.len() != r.len() {
                    return Err("PCM channel mismatch".into());
                }
                if (chunk as i64) < ((d.store.total - 1) / (CHUNK as i64) + 1) {
                    if cmd == "feedVocal" {
                        d.store.voice.borrow_mut().chunks.insert(chunk, (l, r));
                        d.vocal_requested.remove(&chunk);
                    } else {
                        d.store.chunks.insert(chunk, (l, r));
                        d.requested.remove(&chunk);
                    }
                }
            }
            "nack" => {
                if m.decks[deck].token.as_deref() == Some(token) {
                    if let Some(c) = v["chunk"].as_u64() {
                        if v["part"] == "vocals" {
                            m.decks[deck].vocal_requested.remove(&(c as usize));
                        } else {
                            m.decks[deck].requested.remove(&(c as usize));
                        }
                    }
                }
            }
            "cue" => {
                let d = &mut m.decks[deck];
                d.cue = round(number(v, "frame", 0.)).max(0.);
                if !d.playing {
                    d.wsola.reset(d.cue);
                }
                m.request_all();
            }
            "gain" => {
                let d = &mut m.decks[deck];
                d.norm_target = 10f64.powf(number(v, "gainDb", 0.).clamp(-120., 36.) / 20.);
                if !d.playing {
                    d.norm = d.norm_target;
                }
            }
            "start" => {
                if m.decks[deck].token.as_deref() != Some(token) {
                    return Ok(());
                }
                self.playback.reset();
                if m.active {
                    m.abort("restart");
                }
                m.disarm("restart");
                if m.decks[1 - deck].playing {
                    m.decks[1 - deck].fade_stop(sr, 0.03);
                }
                m.main = deck;
                m.echo.reset();
                m.voice_echo.reset();
                let d = &mut m.decks[deck];
                d.clear_voice();
                d.clear_tail();
                d.iso.reset();
                d.filter.reset();
                d.store.clear_effects();
                d.wsola.reset(round(number(v, "frame", 0.)).max(0.));
                d.playing = true;
                d.starved = false;
                d.tempo = None;
                d.lanes = unity();
                d.lane_target = None;
                d.fade = 1.;
                d.fade_target = 1.;
                d.stop_silent = false;
                d.pending_seek = None;
                d.ended = false;
                m.request_all();
            }
            "stop" => {
                self.playback.reset();
                if m.active {
                    m.abort("stop");
                } else {
                    m.disarm("stop");
                }
                for d in &mut m.decks {
                    d.playing = false;
                    d.store.clear_effects();
                    d.store.voice.borrow_mut().mask = Mask::default();
                    d.pending_vocal = None;
                }
                m.echo.reset();
                m.voice_echo.reset();
                self.tone.reset();
                self.reverb.reset();
                self.limiter.reset();
            }
            "pause" => {
                let paused = v["paused"].as_bool().ok_or("Invalid pause")?;
                self.transport_target = if paused { 0. } else { 1. };
                if !paused {
                    m.paused = false;
                }
            }
            "volume" => self.volume_target = number(v, "value", 1.).clamp(0., 1.5),
            "tone" => {
                self.tone.set(&v["settings"], v["preDb"].as_f64());
                self.reverb.target = if v["settings"]["enabled"] == true {
                    number(&v["settings"], "reverbMix", 0.).clamp(0., 0.35)
                } else {
                    0.
                };
            }
            "playback" => self.playback.set(
                number(&v["settings"], "speed", 1.),
                number(&v["settings"], "semitones", 0.),
            ),
            "tickRate" => {
                self.tick_frames =
                    round(sr * number(v, "seconds", 0.05).clamp(0.01, 1.)).max(1.) as usize
            }
            "seek" => {
                if let Some(i) = m.index(token) {
                    self.playback.reset();
                    // Seek can race the controller receiving the previous transition's end.
                    m.decks[1 - i].fade_stop(sr, 0.25);
                    if m.active {
                        let id = m.armed.take().map_or(String::new(), |t| t.plan_id);
                        m.active = false;
                        for d in &mut m.decks {
                            d.pending_vocal = None;
                        }
                        m.events
                            .push(json!({"type":"transitionAborted","planId":id,"reason":"seek"}));
                    } else {
                        m.disarm("seek");
                    }
                    m.main = i;
                    m.echo.reset();
                    m.voice_echo.reset();
                    for d in &mut m.decks {
                        d.wsola.set_side(None);
                    }
                    let paused = m.paused;
                    let d = &mut m.decks[i];
                    d.store.voice.borrow_mut().mask = Mask::default();
                    d.pending_vocal = None;
                    d.voice_expected = false;
                    let target = round(number(v, "frame", 0.))
                        .max(0.)
                        .min((d.store.total - 1) as f64);
                    d.tempo = None;
                    d.ended = false;
                    d.stop_silent = false;
                    if paused || !d.playing {
                        d.store.clear_effects();
                        d.wsola.reset(target);
                        d.clear_tail();
                        d.iso.reset();
                        d.filter.reset();
                        d.pending_seek = None;
                        d.lanes = unity();
                        d.lane_target = None;
                        d.playing = true;
                        d.fade = 1.;
                        d.fade_target = 1.;
                    } else {
                        d.pending_seek = Some(target);
                        d.fade_target = 0.;
                        d.fade_step = 1. / round(sr * 0.006);
                    }
                    d.cue = target;
                    let tr = m.armed.clone();
                    let mut events = Vec::new();
                    m.decks[i].request(i, sr, Some(target), tr.as_ref(), &mut events);
                    m.events.extend(events);
                }
            }
            "arm" => {
                let tr: Transition = serde_json::from_value(v["transition"].clone())
                    .map_err(|e| format!("Invalid transition: {e}"))?;
                tr.validate()?;
                if !m.active {
                    for d in &mut m.decks {
                        d.store.clear_effects();
                    }
                    for (token, cue, tempo, gains) in [
                        (
                            &tr.from_token,
                            tr.trigger_frame,
                            &tr.tempo_a,
                            tr.vocal_a.as_deref(),
                        ),
                        (
                            &tr.to_token,
                            tr.entry_frame,
                            &tr.tempo_b,
                            tr.vocal_b.as_deref(),
                        ),
                    ] {
                        if let Some(i) = m.index(token) {
                            let d = &mut m.decks[i];
                            d.pending_vocal =
                                source_map(cue, tempo, gains).map(|p| Mask::new(Some(p)));
                            d.fit = Fit::default();
                        }
                    }
                    m.armed = Some(tr);
                    m.active = false;
                    m.late = false;
                    m.late_notified = false;
                    m.swapped = false;
                    m.forced = false;
                    m.t = 0.;
                    m.request_all();
                }
            }
            "disarm" => m.disarm("controller"),
            "finish" => {
                if m.active {
                    let duration = round(sr * number(v, "fade", 0.6).clamp(0.001, 10.)).max(1.);
                    let tr = m.armed.as_ref().unwrap();
                    let a = m.index(&tr.from_token);
                    let b = m.index(&tr.to_token);
                    let mut lanes = Vec::new();
                    for (role, index) in [("A", a), ("B", b)] {
                        if let Some(i) = index {
                            for lane in 0..7 {
                                let target = if lane >= 4 || (role == "A" && lane == 0) {
                                    0.
                                } else {
                                    1.
                                };
                                lanes.push(Lane {
                                    deck: role.into(),
                                    lane,
                                    points: vec![[0., m.decks[i].lanes[lane]], [duration, target]],
                                });
                            }
                        }
                    }
                    let tr = m.armed.as_mut().unwrap();
                    tr.duration_frames = duration;
                    tr.gap_frames = 0.;
                    tr.swap_frame = 0.;
                    tr.b_delay_frames = 0.;
                    tr.lanes = lanes;
                    let id = tr.plan_id.clone();
                    let token = tr.to_token.clone();
                    m.t = 0.;
                    m.forced = true;
                    if let Some(a) = a {
                        m.decks[a].wsola.set_side(None);
                    }
                    m.voice_echo.fade_out(round(sr * 0.12));
                    if let Some(b) = b {
                        let clock = m.clock;
                        let d = &mut m.decks[b];
                        let pos = d.position();
                        let gain = d.store.voice.borrow().mask.gain(pos);
                        let span = duration * d.ratio(clock);
                        let covered = gain == 1.
                            || d.store
                                .voice
                                .borrow()
                                .covers(pos - 4096., pos + span + 4096.);
                        d.store.voice.borrow_mut().mask = Mask::new(if gain == 1. || !covered {
                            None
                        } else {
                            Some(vec![[pos, gain], [pos + span, 1.]])
                        });
                        d.voice_expected = false;
                    }
                    if let Some(a) = a {
                        let clock = m.clock;
                        let d = &mut m.decks[a];
                        let pos = d.position();
                        let voice = d.store.voice.borrow();
                        let masked = voice.mask.points.is_some() || d.voice_expected;
                        let gain = voice.mask.gain(pos);
                        let rate = d.ratio(clock);
                        let voice_frames = duration.min(round(sr * 0.2));
                        let span = (voice_frames + round(sr * 0.1)) * rate;
                        let covered = voice.covers(pos - 4096., pos + span + 4096.);
                        drop(voice);
                        if masked && gain > 0. && covered {
                            d.store.voice.borrow_mut().mask =
                                Mask::new(Some(vec![[pos, gain], [pos + voice_frames * rate, 0.]]));
                        } else if masked && gain > 0. {
                            let start = d.lanes[0];
                            d.store.voice.borrow_mut().mask = Mask::default();
                            if let Some(lane) = m
                                .armed
                                .as_mut()
                                .unwrap()
                                .lanes
                                .iter_mut()
                                .find(|l| l.deck == "A" && l.lane == 0)
                            {
                                lane.points = vec![[0., start], [round(sr * 0.15).max(1.), 0.]];
                            }
                        }
                        m.decks[a].voice_expected = masked;
                    }
                    if !m.swapped {
                        if let Some(b) = b {
                            m.swapped = true;
                            m.main = b;
                            m.events
                                .push(json!({"type":"swap","planId":id,"token":token}));
                        }
                    }
                }
            }
            "disableVocals" => {
                if m.decks[deck].token.as_deref() == Some(token) {
                    if m.armed.as_ref().is_some_and(|tr| {
                        tr.from_token == token
                            && (tr.vocal_a.is_some() || m.decks[deck].voice_expected)
                    }) {
                        m.retire_voice(deck);
                    }
                    let d = &mut m.decks[deck];
                    d.store.voice.borrow_mut().mask = Mask::default();
                    d.pending_vocal = None;
                    d.vocal_requested.clear();
                }
            }
            "resetVocals" => {
                let applied = !m.active && m.decks[deck].token.as_deref() == Some(token);
                if applied {
                    if m.armed
                        .as_ref()
                        .is_some_and(|tr| tr.from_token == token || tr.to_token == token)
                    {
                        m.disarm("vocal_generation_changed");
                    }
                    let d = &mut m.decks[deck];
                    d.store.voice.borrow_mut().reset(d.store.total);
                    d.pending_vocal = None;
                    d.vocal_requested.clear();
                    d.fit = Fit::default();
                    d.voice_expected = false;
                    d.echo_gate = 1.;
                    d.wsola.set_side(None);
                    m.voice_echo.reset();
                    m.echo.reset();
                }
                m.events.push(
                    json!({"type":"vocalsReset","deck":deck,"token":token,"applied":applied}),
                );
            }
            _ => return Err(format!("Unknown command: {cmd}")),
        }
        Ok(())
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        assert_eq!(l.len(), r.len());
        assert!(l.len() <= 512);
        if self.musical.borrow().paused {
            l.fill(0.);
            r.fill(0.);
            self.tick(l.len());
            return;
        }
        if self.playback.engaged() && l.len() > 128 {
            for (left, right) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
                if self.musical.borrow().paused {
                    left.fill(0.);
                    right.fill(0.);
                    continue;
                }
                self.playback.process(left, right);
                self.apply_master(left, right);
            }
        } else {
            self.playback.process(l, r);
            self.apply_master(l, r);
        }
        self.check_ended();
        self.tick(l.len());
    }
    fn apply_master(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.reverb.process(l, r);
        self.tone.process(l, r);
        let n = l.len();
        let dv = (self.volume_target - self.volume) / n as f64;
        let mut v = self.volume;
        for i in 0..n {
            if self.transport != self.transport_target {
                self.transport = if self.transport < self.transport_target {
                    (self.transport + self.transport_step).min(self.transport_target)
                } else {
                    (self.transport - self.transport_step).max(self.transport_target)
                };
            }
            let k = self.transport * v;
            l[i] = (l[i] as f64 * k) as f32;
            r[i] = (r[i] as f64 * k) as f32;
            self.silent = if self.transport == 0. && self.transport_target == 0. {
                self.silent + 1
            } else {
                0
            };
            v += dv;
        }
        self.volume = self.volume_target;
        self.limiter.process(l, r);
        for f in l.iter().chain(r.iter()) {
            self.peak = self.peak.max((*f as f64).abs());
        }
        if self.transport == 0.
            && self.transport_target == 0.
            && self.silent >= self.limiter.lookahead
        {
            self.musical.borrow_mut().paused = true;
        }
    }
    fn check_ended(&mut self) {
        let buffered = self.playback.buffered();
        let mut m = self.musical.borrow_mut();
        for i in 0..2 {
            let d = &m.decks[i];
            if !d.playing || d.token.is_none() || d.ended {
                continue;
            }
            if d.position() - buffered * d.ratio(m.clock) >= d.store.total as f64 {
                let is_a = m
                    .armed
                    .as_ref()
                    .is_some_and(|t| d.token.as_deref() == Some(&t.from_token));
                if m.active && is_a {
                    continue;
                }
                if !m.active && is_a {
                    if let Some(tr) = m.armed.take() {
                        m.events.push(json!({"type":"fallback","planId":tr.plan_id,"reason":"a_ended_before_transition"}));
                    }
                }
                let d = &mut m.decks[i];
                d.ended = true;
                d.playing = false;
                let token = d.token.clone();
                m.events
                    .push(json!({"type":"ended","deck":i,"token":token}));
            }
        }
    }
    fn tick(&mut self, n: usize) {
        self.since_tick += n;
        self.since_need += n;
        let mut m = self.musical.borrow_mut();
        if self.since_need as f64 >= self.sr * 0.25 {
            self.since_need = 0;
            m.request_all();
        }
        if self.since_tick < self.tick_frames {
            return;
        }
        self.since_tick = 0;
        let buffered = self.playback.buffered();
        let speed = self.playback.speed_ratio();
        let decks:Vec<_>=m.decks.iter().map(|d| { let pos=d.position();let mut c=pos.max(0.) as usize/CHUNK;while ((c*CHUNK) as i64)<d.store.total && d.store.chunks.contains_key(&c) { c+=1; }
            json!({"token":d.token,"position":(pos-buffered*d.ratio(m.clock)).max(0.),"totalFrames":d.store.total,"playing":d.playing,"starved":d.starved,"ratio":d.ratio(m.clock)*speed,"bufferedAhead":(c as f64*CHUNK as f64-pos).max(0.)}) }).collect();
        let tr = m
            .armed
            .as_ref()
            .map(|t| json!({"planId":t.plan_id,"t":m.t,"active":m.active,"late":m.late}));
        let event = json!({"type":"tick","clock":m.clock,"paused":m.paused,"main":m.main,"decks":decks,"transition":tr,"limiterDb":20.*self.limiter.min_gain.max(1e-9).log10(),"peak":self.peak});
        m.events.push(event);
        self.peak = 0.;
        self.limiter.min_gain = 1.;
    }
    pub fn take_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.musical.borrow_mut().events)
    }

    pub fn limiter_reduction_db(&self) -> f64 {
        -20. * self.limiter.min_gain.max(1e-9).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_commands_and_pcm_without_poisoning_the_transport() {
        let mut m = Mixer::new(48000).unwrap();
        assert!(Mixer::new(0).is_err());
        assert!(m
            .command(&json!({"cmd":"load","deck":2,"token":"T","totalFrames":100}))
            .is_err());
        assert!(m
            .command(&json!({"cmd":"load","deck":0,"token":"T","totalFrames":0}))
            .is_err());
        m.command(&json!({"cmd":"load","deck":0,"token":"T","totalFrames":1000,"gainDb":0}))
            .unwrap();
        assert!(m.command(&json!({"cmd":"feed","deck":0,"token":"T","chunk":u64::MAX,"L":"AAAAAA==","R":"AAAAAA=="})).is_err());
        let nan = STANDARD.encode(f32::NAN.to_le_bytes());
        assert!(m
            .command(&json!({"cmd":"feed","deck":0,"token":"T","chunk":0,"L":nan,"R":nan}))
            .is_err());
        let good = STANDARD.encode([0.1f32.to_le_bytes(); 1000].concat());
        m.command(&json!({"cmd":"feed","deck":0,"token":"T","chunk":0,"L":good,"R":good}))
            .unwrap();
        m.command(&json!({"cmd":"start","deck":0,"token":"T","frame":0}))
            .unwrap();
        let (mut l, mut r) = ([0f32; 128], [0f32; 128]);
        for _ in 0..10 {
            m.process(&mut l, &mut r);
            assert!(l
                .iter()
                .chain(r.iter())
                .all(|v| v.is_finite() && v.abs() <= 1.));
        }
        assert!(l.iter().any(|v| v.abs() > 0.01));
        m.command(&json!({"cmd":"pause","paused":true})).unwrap();
        for _ in 0..10 {
            m.process(&mut l, &mut r);
        }
        assert!(l.iter().chain(r.iter()).all(|v| *v == 0.));
    }
    #[test]
    fn file_feed_requires_current_token_and_complete_chunk() {
        let path = std::env::temp_dir().join(format!("mora-mixer-test-{}", std::process::id()));
        std::fs::write(&path, [0.25f32.to_le_bytes(), (-0.25f32).to_le_bytes()].concat()).unwrap();
        let mut m = Mixer::new(48000).unwrap();
        m.command(&json!({"cmd":"load","deck":0,"token":"new","totalFrames":1})).unwrap();
        let mut feed = json!({"cmd":"feedFile","deck":0,"token":"old","chunk":0,"path":path,"format":"f32le","frames":1});
        m.command(&feed).unwrap();
        assert!(m.musical.borrow().decks[0].store.chunks.is_empty());
        feed["token"] = json!("new");
        feed["frames"] = json!(2);
        assert!(m.command(&feed).is_err());
        feed["frames"] = json!(1);
        m.command(&feed).unwrap();
        assert_eq!(m.musical.borrow().decks[0].store.chunks[&0], (vec![0.25], vec![-0.25]));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn malformed_loop_cannot_overflow() {
        let mut store = Store::new(48000.);
        store.total = 480000;
        assert!(!store.set_loop(Some(Loop {
            start: i64::MIN,
            end: i64::MAX,
            until: i64::MAX,
            fade: 1,
            roll: vec![]
        })));
        assert!(!store.set_tape(Some(Tape {
            start: i64::MIN,
            end: i64::MAX,
            fade: 1
        })));
    }
}
