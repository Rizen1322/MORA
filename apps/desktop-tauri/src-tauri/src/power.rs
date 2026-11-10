use std::{ffi::c_void, sync::{mpsc, OnceLock, atomic::Ordering}, time::Duration};
use tauri::Manager;
use windows_sys::Win32::{System::{Power::{GetSystemPowerStatus, PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, SYSTEM_POWER_STATUS}, SystemInformation::GetTickCount64},
    UI::{Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO}, WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMSUSPEND}}};

static SUSPEND: OnceLock<mpsc::Sender<()>> = OnceLock::new();
unsafe extern "system" fn notification(_: *const c_void, event: u32, _: *const c_void) -> u32 {
    if event == PBT_APMSUSPEND { if let Some(tx) = SUSPEND.get() { let _ = tx.send(()); } }
    0
}
fn idle(now: u32, last: u32) -> bool { now.wrapping_sub(last) >= 120_000 }

pub fn start(app: tauri::AppHandle) -> usize {
    let (tx, rx) = mpsc::channel(); let _ = SUSPEND.set(tx);
    let mut registration: *mut c_void = std::ptr::null_mut();
    // Windows may retain the callback parameters until process shutdown.
    let parameters = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(notification), Context: std::ptr::null_mut() }));
    let status = unsafe { PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, (parameters as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS).cast(), &mut registration) };
    if status != 0 { eprintln!("power notification registration failed: {status}"); }
    std::thread::spawn(move || loop {
        let Some(state) = app.try_state::<super::Session>() else { return };
        if state.quitting.load(Ordering::Relaxed) { return; }
        let mut last = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        let mut power = SYSTEM_POWER_STATUS::default();
        let input_ok = unsafe { GetLastInputInfo(&mut last) } != 0;
        let power_ok = unsafe { GetSystemPowerStatus(&mut power) } != 0;
        let status = serde_json::json!({"type":"power", "idle":input_ok && idle(unsafe { GetTickCount64() } as u32, last.dwTime), "onBattery":!power_ok || power.ACLineStatus != 1});
        if let Ok(mut child) = state.child.try_lock() { if let Some(input) = child.stdin.as_mut() { use std::io::Write; let _ = writeln!(input, "{status}"); } }
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(()) => if let Ok(mut child) = state.child.try_lock() { if let Some(input) = child.stdin.as_mut() { use std::io::Write; let _ = input.write_all(b"{\"type\":\"suspend\"}\n"); } },
            Err(mpsc::RecvTimeoutError::Timeout) => {}, Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    });
    registration as usize
}
pub fn stop(registration: usize) {
    if registration != 0 { unsafe { PowerUnregisterSuspendResumeNotification(registration as isize); } }
}

#[cfg(test)]
mod tests {
    #[test] fn idle_threshold_handles_tick_wrap() {
        assert!(!super::idle(120_000, 1)); assert!(super::idle(120_000, 0));
        assert!(super::idle(120_000, u32::MAX - 10));
    }
}
