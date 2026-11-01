use crate::{mixer::Mixer, source::CHUNK};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

struct Pcm {
    left: Vec<u8>,
    right: Vec<u8>,
    vocals: Option<Box<Pcm>>,
}
impl Pcm {
    fn parse(v: &Value) -> Result<Self, String> {
        let decode = |key: &str| -> Result<Vec<u8>, String> {
            let raw = v[key].as_str().ok_or("Missing render PCM")?;
            let bytes = STANDARD.decode(raw).map_err(|_| "Invalid render PCM")?;
            if bytes.is_empty()
                || bytes.len() % 4 != 0
                || bytes
                    .chunks_exact(4)
                    .any(|v| !f32::from_le_bytes(v.try_into().unwrap()).is_finite())
            {
                return Err("Invalid render PCM".into());
            }
            Ok(bytes)
        };
        let left = decode("L")?;
        let right = decode("R")?;
        if left.len() != right.len() {
            return Err("Mismatched stereo PCM".into());
        }
        let vocals = if v["vocals"].is_null() {
            None
        } else {
            Some(Box::new(Self::parse(&v["vocals"])?))
        };
        if vocals.as_ref().is_some_and(|v| v.left.len() != left.len()) {
            return Err("vocal PCM must match the original frame count".into());
        }
        Ok(Self {
            left,
            right,
            vocals,
        })
    }
    fn feed(&self, m: &mut Mixer, deck: usize, chunk: usize, vocal: bool) -> Result<(), String> {
        let pcm = if vocal {
            let Some(p) = self.vocals.as_ref() else {
                return Ok(());
            };
            p.as_ref()
        } else {
            self
        };
        let from = chunk.checked_mul(CHUNK * 4).ok_or("Invalid render chunk")?;
        if from >= pcm.left.len() {
            return Ok(());
        }
        let to = (from + CHUNK * 4).min(pcm.left.len());
        m.command(&json!({"cmd":if vocal {"feedVocal"}else{"feed"},"deck":deck,"token":if deck==0 {"A"}else{"B"},"chunk":chunk,"L":STANDARD.encode(&pcm.left[from..to]),"R":STANDARD.encode(&pcm.right[from..to])}))
    }
}

/// Offline previews and technical finalist checks use the same native mixer as playback.
pub fn render(v: &Value) -> Result<Value, String> {
    let sr = v["sampleRate"]
        .as_u64()
        .filter(|n| *n <= u32::MAX as u64)
        .ok_or("Invalid render sample rate")? as u32;
    let frames = v["frames"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= sr as u64 * 180)
        .ok_or("Invalid render length")? as usize;
    let speed = v["speed"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or("Invalid render speed")?;
    let sources = [Pcm::parse(&v["a"])?, Pcm::parse(&v["b"])?];
    let mut m = Mixer::new(sr)?;
    if !v["playback"].is_null() {
        m.command(&json!({"cmd":"playback","settings":v["playback"]}))?;
    }
    for (deck, pcm) in sources.iter().enumerate() {
        m.command(&json!({"cmd":"load","deck":deck,"token":if deck==0 {"A"}else{"B"},"totalFrames":pcm.left.len()/4,"gainDb":v[if deck==0 {"gainA"}else{"gainB"}],"cueFrame":if deck==0 {0.}else{v["armed"]["entryFrame"].as_f64().unwrap_or(0.)}}))?;
        for chunk in 0..pcm.left.len().div_ceil(CHUNK * 4) {
            pcm.feed(&mut m, deck, chunk, false)?;
            if pcm.vocals.is_some() {
                pcm.feed(&mut m, deck, chunk, true)?;
            }
        }
    }
    m.command(&json!({"cmd":"start","deck":0,"token":"A","frame":v["startFrame"]}))?;
    m.command(&json!({"cmd":"arm","transition":v["armed"]}))?;
    let mut pending = m.take_events();
    let mut events = Vec::new();
    let (mut left, mut right) = (
        Vec::with_capacity(frames * 4),
        Vec::with_capacity(frames * 4),
    );
    let (mut peak, mut reduction) = (0f64, 0f64);
    let mut underruns = 0;
    let mut start_frame = -1.;
    for off in (0..frames).step_by(512) {
        for event in pending.drain(..) {
            if event["type"] == "need" {
                let deck = event["deck"].as_u64().ok_or("Invalid refill deck")? as usize;
                if deck > 1 {
                    return Err("Invalid refill deck".into());
                }
                for chunk in event["chunks"].as_array().ok_or("Invalid refill chunks")? {
                    sources[deck].feed(
                        &mut m,
                        deck,
                        chunk.as_u64().ok_or("Invalid refill chunk")? as usize,
                        event["part"] == "vocals",
                    )?;
                }
            } else if event["type"] == "tick" {
                reduction = reduction.max(-event["limiterDb"].as_f64().unwrap_or(0.));
            } else {
                if event["type"] == "underrun" {
                    underruns += 1;
                }
                events.push(event);
            }
        }
        let n = (frames - off).min(512);
        let (mut l, mut r) = ([0f32; 512], [0f32; 512]);
        m.process(&mut l[..n], &mut r[..n]);
        reduction = reduction.max(m.limiter_reduction_db());
        for i in 0..n {
            peak = peak.max((l[i] as f64).abs()).max((r[i] as f64).abs());
            left.extend(l[i].to_le_bytes());
            right.extend(r[i].to_le_bytes());
        }
        pending = m.take_events();
        for e in &pending {
            if e["type"] == "transitionStart" && start_frame < 0. {
                start_frame =
                    (e["clock"].as_f64().ok_or("Invalid transition clock")? / speed + 0.5).floor();
            }
        }
    }
    for event in pending {
        if event["type"] == "need" {
            continue;
        }
        if event["type"] == "tick" {
            reduction = reduction.max(-event["limiterDb"].as_f64().unwrap_or(0.));
            continue;
        }
        if event["type"] == "underrun" {
            underruns += 1;
        }
        events.push(event);
    }
    let reduction = if reduction == 0. { 0. } else { reduction };
    if v["measure"] == true {
        let decode = |bytes: &[u8]| {
            bytes
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect::<Vec<_>>()
        };
        return Ok(crate::render_metrics::metrics(
            &v["plan"],
            sr,
            &decode(&left),
            &decode(&right),
            start_frame as i64,
            reduction,
            underruns,
        ));
    }
    Ok(
        json!({"L":STANDARD.encode(left),"R":STANDARD.encode(right),"sampleRate":sr,"transitionStartFrame":start_frame,"events":events,"metrics":{"peak":peak,"maxLimiterReductionDb":reduction,"underruns":underruns}}),
    )
}
