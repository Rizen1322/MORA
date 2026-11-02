#![cfg(windows)]
use std::{io::{BufRead, BufReader, Write}, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
use base64::Engine;
use serde_json::{json, Value};
use windows::{Media::Control::{GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus},
    Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED}};

struct Helper(Child);
impl Drop for Helper { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

#[test]
fn windows_session_metadata_timeline_buttons_artwork_and_cleanup() {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap(); }
    let mut helper = Helper(Command::new(env!("CARGO_BIN_EXE_mora-smtc"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap());
    let stdout = helper.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || { for line in BufReader::new(stdout).lines() { if let Ok(line) = line { let _ = send.send(line); } } });
    assert_eq!(serde_json::from_str::<Value>(&receive.recv_timeout(Duration::from_secs(8)).unwrap()).unwrap()["type"], "ready");
    let artwork = std::env::temp_dir().join(format!("mora-smtc-test-{}.png", std::process::id()));
    let image = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap();
    std::fs::write(&artwork, image).unwrap();
    let title = format!("MORA SMTC integration {}", std::process::id());
    let mut state = json!({"title":title,"artist":"SMTC artist","album":"SMTC album","artwork":artwork.to_str().unwrap(),
        "status":"playing","position":12.5,"duration":120.,"rate":1.});
    writeln!(helper.0.stdin.as_mut().unwrap(), "{state}").unwrap();
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().unwrap().get().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let session = loop {
        let mut found = None;
        let sessions = manager.GetSessions().unwrap();
        for i in 0..sessions.Size().unwrap() {
            let session = sessions.GetAt(i).unwrap();
            let properties = session.TryGetMediaPropertiesAsync().unwrap().get().unwrap();
            let artwork_ready = properties.Thumbnail().and_then(|reference| reference.OpenReadAsync()?.get()?.Size()).is_ok_and(|size| size > 0);
            let timeline_ready = session.GetTimelineProperties().is_ok_and(|timeline| timeline.EndTime().is_ok_and(|time| time.Duration == 1_200_000_000));
            if properties.Title().unwrap().to_string() == title && artwork_ready && timeline_ready
                && session.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap() == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
                found = Some(session); break;
            }
        }
        if let Some(session) = found { break session; }
        assert!(Instant::now() < deadline, "Native SMTC session was not visible to Windows");
        std::thread::sleep(Duration::from_millis(100));
    };
    let properties = session.TryGetMediaPropertiesAsync().unwrap().get().unwrap();
    assert_eq!(session.SourceAppUserModelId().unwrap().to_string(), "ru.mora.desktop");
    assert_eq!(properties.Artist().unwrap().to_string(), "SMTC artist");
    assert_eq!(properties.AlbumTitle().unwrap().to_string(), "SMTC album");
    assert!(properties.Thumbnail().unwrap().OpenReadAsync().unwrap().get().unwrap().Size().unwrap() > 0);
    let timeline = session.GetTimelineProperties().unwrap();
    assert_eq!(timeline.EndTime().unwrap().Duration, 1_200_000_000);
    assert_eq!(timeline.Position().unwrap().Duration, 125_000_000);
    assert_eq!(session.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap(), GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);
    assert!(session.TryPauseAsync().unwrap().get().unwrap());
    let event: Value = serde_json::from_str(&receive.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert_eq!(event, json!({"type":"command","command":"pause"}));
    // A Windows command must leave the reported playback state unchanged until the audio owner confirms it.
    assert_eq!(session.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap(), GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);
    state["status"] = json!("paused");
    writeln!(helper.0.stdin.as_mut().unwrap(), "{state}").unwrap();
    for (sent, expected) in [(session.TryPlayAsync().unwrap().get().unwrap(), "play"),
        (session.TrySkipNextAsync().unwrap().get().unwrap(), "next"),
        (session.TrySkipPreviousAsync().unwrap().get().unwrap(), "prev")] {
        assert!(sent);
        let event: Value = serde_json::from_str(&receive.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert_eq!(event, json!({"type":"command","command":expected}));
    }
    assert!(session.TryChangePlaybackPositionAsync(300_000_000).unwrap().get().unwrap());
    let event: Value = serde_json::from_str(&receive.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert_eq!(event, json!({"type":"seek","position":30.}));
    helper.0.stdin.take();
    let deadline = Instant::now() + Duration::from_secs(3);
    while helper.0.try_wait().unwrap().is_none() { assert!(Instant::now() < deadline, "Helper did not exit on parent EOF"); std::thread::sleep(Duration::from_millis(20)); }
    let _ = std::fs::remove_file(artwork);
}
