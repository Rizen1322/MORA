// A separate process keeps WinRT and its window/message loop out of the audio callback.
#[cfg(windows)]
mod native {
    use serde::Deserialize;
    use serde_json::json;
    use std::{io::{self, BufRead, Read, Write}, sync::mpsc};
    use windows::{core::{factory, w, HSTRING, Result}, Foundation::{TimeSpan, TypedEventHandler},
        Media::{MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButton,
            SystemMediaTransportControlsButtonPressedEventArgs, PlaybackPositionChangeRequestedEventArgs,
            SystemMediaTransportControlsTimelineProperties}, Storage::{StorageFile, Streams::RandomAccessStreamReference},
        Win32::{Foundation::{HWND, WPARAM, LPARAM}, System::{Com::{CoInitializeEx, COINIT_MULTITHREADED}, WinRT::ISystemMediaTransportControlsInterop},
            UI::{Shell::SetCurrentProcessExplicitAppUserModelID, WindowsAndMessaging::*}}};

    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    pub struct State { pub title: String, pub artist: String, pub album: String, pub artwork: String,
        pub status: String, pub position: f64, pub duration: f64, pub rate: f64 }

    fn emit(value: serde_json::Value) { let mut out = io::stdout().lock(); let _ = writeln!(out, "{value}"); let _ = out.flush(); }
    fn time(seconds: f64) -> TimeSpan { TimeSpan { Duration: (seconds.max(0.) * 10_000_000.) as i64 } }
    fn update(smtc: &SystemMediaTransportControls, state: &State, previous: &mut String) -> Result<()> {
        if !state.position.is_finite() || !state.duration.is_finite() || !state.rate.is_finite() { return Ok(()); }
        let enabled = !state.title.is_empty();
        smtc.SetIsEnabled(enabled)?;
        if !enabled { smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed)?; return Ok(()); }
        let key = format!("{}\0{}\0{}\0{}", state.title, state.artist, state.album, state.artwork);
        if &key != previous {
            let display = smtc.DisplayUpdater()?;
            display.ClearAll()?;
            display.SetType(MediaPlaybackType::Music)?;
            let music = display.MusicProperties()?;
            music.SetTitle(&HSTRING::from(&state.title))?;
            music.SetArtist(&HSTRING::from(&state.artist))?;
            music.SetAlbumTitle(&HSTRING::from(&state.album))?;
            if !state.artwork.is_empty() {
                // The host supplies only its own validated, size-bounded thumbnail file.
                if let Ok(file) = StorageFile::GetFileFromPathAsync(&HSTRING::from(&state.artwork)).and_then(|op| op.get()) {
                    if let Ok(reference) = RandomAccessStreamReference::CreateFromFile(&file) { let _ = display.SetThumbnail(&reference); }
                }
            }
            display.Update()?;
            *previous = key;
        }
        smtc.SetPlaybackStatus(match state.status.as_str() { "playing" => MediaPlaybackStatus::Playing,
            "buffering" => MediaPlaybackStatus::Changing, "paused" => MediaPlaybackStatus::Paused, _ => MediaPlaybackStatus::Stopped })?;
        smtc.SetPlaybackRate(state.rate.clamp(0., 4.))?;
        let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
        timeline.SetStartTime(time(0.))?;
        timeline.SetEndTime(time(state.duration))?;
        timeline.SetMinSeekTime(time(0.))?;
        timeline.SetMaxSeekTime(time(state.duration))?;
        timeline.SetPosition(time(state.position.min(state.duration)))?;
        smtc.UpdateTimelineProperties(&timeline)
    }

    pub fn run() -> Result<()> { unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        SetCurrentProcessExplicitAppUserModelID(w!("ru.mora.desktop"))?;
        // GetForWindow requires a top-level window belonging to this process.
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), w!("MORA"), WS_OVERLAPPED,
            0, 0, 0, 0, None, None, None, None);
        if hwnd.0 == 0 { return Err(windows::core::Error::from_win32()); }
        let interop: ISystemMediaTransportControlsInterop = factory::<SystemMediaTransportControls, _>()?;
        let smtc: SystemMediaTransportControls = interop.GetForWindow(hwnd)?;
        smtc.SetIsPlayEnabled(true)?; smtc.SetIsPauseEnabled(true)?;
        smtc.SetIsNextEnabled(true)?; smtc.SetIsPreviousEnabled(true)?; smtc.SetIsStopEnabled(true)?;
        smtc.SetIsEnabled(false)?;
        let button = smtc.ButtonPressed(&TypedEventHandler::new(|_, args: &Option<SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(args) = args { let cmd = match args.Button()? {
                SystemMediaTransportControlsButton::Play => "play", SystemMediaTransportControlsButton::Pause | SystemMediaTransportControlsButton::Stop => "pause",
                SystemMediaTransportControlsButton::Next => "next", SystemMediaTransportControlsButton::Previous => "prev", _ => return Ok(()) };
                emit(json!({"type":"command","command":cmd})); }
            Ok(())
        }))?;
        let seek = smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(|_, args: &Option<PlaybackPositionChangeRequestedEventArgs>| {
            if let Some(args) = args { emit(json!({"type":"seek","position":args.RequestedPlaybackPosition()?.Duration as f64 / 10_000_000.})); }
            Ok(())
        }))?;
        let (send, receive) = mpsc::sync_channel(16);
        let handle = hwnd.0;
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                let mut line = Vec::new();
                // Bounded before allocation, even if the parent writes a malformed line.
                match input.by_ref().take(16 * 1024 + 1).read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(n) if n > 16 * 1024 => break,
                    _ => {}
                }
                if send.send(line).is_err() { return; }
                let _ = PostMessageW(HWND(handle), WM_APP, WPARAM(0), LPARAM(0));
            }
            let _ = PostMessageW(HWND(handle), WM_CLOSE, WPARAM(0), LPARAM(0));
        });
        emit(json!({"type":"ready"}));
        let mut msg = MSG::default(); let mut previous = String::new();
        loop {
            let result = GetMessageW(&mut msg, None, 0, 0).0;
            if result <= 0 || msg.message == WM_CLOSE { break; }
            if msg.message == WM_APP {
                while let Ok(line) = receive.try_recv() {
                    let state: State = serde_json::from_slice(&line).map_err(|_| windows::core::Error::from_win32())?;
                    update(&smtc, &state, &mut previous)?;
                }
            } else { TranslateMessage(&msg); DispatchMessageW(&msg); }
        }
        let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        let _ = smtc.SetIsEnabled(false);
        let _ = smtc.RemoveButtonPressed(button); let _ = smtc.RemovePlaybackPositionChangeRequested(seek);
        let _ = DestroyWindow(hwnd);
        Ok(())
    }}
}

fn main() {
    #[cfg(windows)]
    if let Err(error) = native::run() { eprintln!("SMTC: {error}"); std::process::exit(1); }
}
