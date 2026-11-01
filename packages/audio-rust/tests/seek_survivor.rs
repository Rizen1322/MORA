use base64::{engine::general_purpose::STANDARD, Engine};
use mora_audio::{mixer::Mixer, source::CHUNK};
use serde_json::json;

#[test]
fn inactive_seek_stops_the_other_survivor_after_a_missed_transition_end() {
    for deck in 0..2 {
        let mut mixer = Mixer::new(48000).unwrap();
        let pcm: Vec<u8> = (0..CHUNK).flat_map(|_| 0.1_f32.to_le_bytes()).collect();
        let encoded = STANDARD.encode(pcm);
        for d in 0..2 {
            let token = format!("T{d}");
            mixer.command(&json!({"cmd":"load","deck":d,"token":token,"totalFrames":CHUNK,"gainDb":0})).unwrap();
            mixer.command(&json!({"cmd":"feed","deck":d,"token":token,"chunk":0,"L":encoded,"R":encoded})).unwrap();
        }
        mixer.command(&json!({"cmd":"start","deck":1-deck,"token":format!("T{}",1-deck),"frame":0})).unwrap();
        for _ in 0..32 { mixer.process(&mut [0.;128], &mut [0.;128]); }
        let events = mixer.take_events();
        let before = events.iter().rev().find(|e| e["type"] == "tick").unwrap();
        assert_eq!(before["decks"][1-deck]["playing"], true);
        assert!(before["transition"].is_null());
        mixer.command(&json!({"cmd":"seek","token":format!("T{deck}"),"frame":0})).unwrap();
        for _ in 0..128 { mixer.process(&mut [0.;128], &mut [0.;128]); }
        let events = mixer.take_events();
        let after = events.iter().rev().find(|e| e["type"] == "tick").unwrap();
        assert_eq!(after["decks"][deck]["playing"], true);
        assert_eq!(after["decks"][1-deck]["playing"], false, "Seek left two decks playing");
    }
}
