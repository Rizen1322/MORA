// The echo-out tail is a mixer-wide effect: it must keep ringing after the transition ends and after
// the controller retires deck A (unload) and loads the next song into it, as the desktop host does.
use base64::{engine::general_purpose::STANDARD, Engine};
use mora_audio::{mixer::Mixer, source::CHUNK};
use serde_json::json;

const SR: usize = 48000;

#[test]
fn soft_echo_feedback_reaches_the_ring_and_stays_capped() {
    let render = |feedback| {
        let mut echo = mora_audio::dsp::Echo::new(SR as f64);
        let mut input = vec![0.; 4096];
        let mut output = vec![0.; 4096];
        input[0] = 0.5;
        echo.configure(512., feedback);
        echo.process(&input, &input, &mut output, &mut vec![0.; 4096]);
        output
    };
    assert_ne!(render(0.78), render(0.75));
    assert_eq!(render(1.), render(0.85));
}

fn run(retire: bool) -> Vec<f32> {
    let mut m = Mixer::new(SR as u32).unwrap();
    let frames = 6 * SR;
    let tone: Vec<f32> = (0..frames).map(|i| 0.2 * (i as f32 * 440. * std::f32::consts::TAU / SR as f32).sin()).collect();
    let silence = vec![0f32; frames];
    for (deck, pcm) in [(0usize, &tone), (1, &silence)] {
        let token = if deck == 0 { "A" } else { "B" };
        m.command(&json!({"cmd":"load","deck":deck,"token":token,"totalFrames":frames,"gainDb":0})).unwrap();
        for (chunk, part) in pcm.chunks(CHUNK).enumerate() {
            let data = STANDARD.encode(part.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
            m.command(&json!({"cmd":"feed","deck":deck,"token":token,"chunk":chunk,"L":data,"R":data})).unwrap();
        }
    }
    let f = |s: f64| (s * SR as f64).round();
    let (swap, d) = (1., 3.);
    m.command(&json!({"cmd":"start","deck":0,"token":"A","frame":0})).unwrap();
    m.command(&json!({"cmd":"arm","transition":{
        "planId":"echo","method":"echo_out","fromToken":"A","toToken":"B","triggerFrame":f(1.),"entryFrame":0,
        "durationFrames":f(d),"gapFrames":0,"swapFrame":f(swap),"bDelayFrames":f(swap),"tempoB":[[0,1]],
        "echoDelayFrames":f(0.3),"echoFeedback":0.65,
        "lanes":[
            {"deck":"A","lane":0,"points":[[0,1],[f(swap - 0.03),1],[f(swap),0],[f(d),0]]},
            {"deck":"A","lane":4,"points":[[0,0],[f(swap - 0.4),0],[f(swap - 0.05),0.9],[f(swap),0.9],[f(swap + 0.02),0],[f(d),0]]},
            {"deck":"B","lane":0,"points":[[0,0],[f(0.02),1],[f(d - swap),1]]}]}})).unwrap();
    let mut out = Vec::new();
    let mut ended_at: Option<usize> = None;
    let mut retired = false;
    while out.len() < 6 * SR {
        let (mut l, mut r) = ([0f32; 512], [0f32; 512]);
        m.process(&mut l, &mut r);
        out.extend_from_slice(&l);
        if m.take_events().iter().any(|e| e["type"] == "transitionEnd") { ended_at = Some(out.len()); }
        // the desktop host retires A 50 ms after transitionEnd and loads the next song into that deck
        if retire && !retired && ended_at.is_some_and(|e| out.len() >= e + SR / 20) {
            m.command(&json!({"cmd":"unload","deck":0})).unwrap();
            m.command(&json!({"cmd":"load","deck":0,"token":"C","totalFrames":frames,"gainDb":0})).unwrap();
            retired = true;
        }
    }
    assert!(ended_at.is_some(), "transition must end");
    out
}

#[test]
fn echo_tail_rings_after_the_cut_and_survives_deck_retirement() {
    let plain = run(false);
    let retired = run(true);
    let rms = |x: &[f32], a: f64, b: f64| {
        let s = &x[(a * SR as f64) as usize..(b * SR as f64) as usize];
        (s.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / s.len() as f64).sqrt()
    };
    // the cut is at 2.0 s output (trigger 1 s + swap 1 s); B is silent, so this is A's echo alone
    let before = rms(&plain, 0.5, 0.9);
    let tail = rms(&plain, 2.05, 2.6);
    assert!(tail > before * 0.1, "echo tail must be audible after the cut: {tail} vs {before}");
    // after the transition (ends at 4 s) the ring still decays smoothly, retirement or not
    assert!(rms(&plain, 4.1, 4.4) > 0.);
    assert_eq!(plain, retired, "unloading/reloading deck A must not cut the echo tail");
}
