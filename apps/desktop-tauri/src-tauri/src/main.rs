#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secrets;
mod profile;
mod power;
use serde_json::{json, Value};
use std::{env, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc, Mutex}, time::{Duration, Instant}};
use std::os::windows::process::CommandExt;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri::{menu::MenuBuilder, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};
use tauri_plugin_dialog::DialogExt;

struct Session { child: Mutex<Child>, close_to_tray: Mutex<bool>, compact: Mutex<Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>>, profile: PathBuf, data_dir: PathBuf, resources: PathBuf, token: String, pcm: String, port: u16, quitting: AtomicBool, maintenance: AtomicBool, power: AtomicUsize, prefs: Mutex<Value> }
struct Maintenance<'a>(&'a AtomicBool);
impl Drop for Maintenance<'_> { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
fn save_preferences(state: &Session, key: &str, value: Value) -> Result<(), String> {
    let mut prefs = state.prefs.lock().unwrap();
    prefs[key] = value;
    let target = state.profile.join("tauri-window.json");
    let temporary = state.profile.join("tauri-window.json.tmp");
    fs::write(&temporary, serde_json::to_vec(&*prefs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, target).map_err(|e| e.to_string())
}
fn save_window(window: &tauri::WebviewWindow) {
    let state = window.state::<Session>();
    if state.compact.lock().unwrap().is_some() || window.is_minimized().unwrap_or(true) { return; }
    let maximized = window.is_maximized().unwrap_or(false);
    let bounds = if maximized { state.prefs.lock().unwrap()["window"].clone() } else {
        match (window.outer_position(), window.outer_size()) {
            (Ok(p), Ok(s)) => json!({"x":p.x,"y":p.y,"width":s.width,"height":s.height}), _ => return,
        }
    };
    if bounds.is_object() { let mut bounds = bounds; bounds["maximized"] = json!(maximized); let _ = save_preferences(&state, "window", bounds); }
}
fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32]; getrandom::fill(&mut bytes).map_err(|_| "random generator failed")?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
fn recover_data_dir(data: &Path) -> Result<(), String> {
    let mut name = data.as_os_str().to_os_string(); name.push(".importing"); let staging = PathBuf::from(name);
    if staging.exists() && !data.exists() {
        if !staging.join(".import-complete").is_file() { return Err("Найдена незавершённая копия медиатеки; файлы сохранены для восстановления".into()); }
        fs::rename(&staging, data).map_err(|e| format!("Не удалось восстановить медиатеку: {e}"))?;
        let _ = fs::remove_file(data.join(".import-complete"));
    }
    Ok(())
}
fn future_path(path: &Path) -> Result<PathBuf, String> {
    let mut current = if path.is_absolute() { path.to_path_buf() } else { env::current_dir().map_err(|e| e.to_string())?.join(path) };
    let mut tail = Vec::new();
    while !current.exists() {
        tail.push(current.file_name().ok_or("Некорректная папка")?.to_os_string());
        if !current.pop() { return Err("Некорректная папка".into()); }
    }
    let mut result = fs::canonicalize(current).map_err(|e| e.to_string())?;
    for component in tail.iter().rev() { result.push(component); }
    Ok(PathBuf::from(result.to_string_lossy().to_lowercase()))
}
fn import_paths_overlap(source: &Path, data: &Path) -> Result<bool, String> {
    let mut name = data.as_os_str().to_os_string(); name.push(".importing");
    let source = future_path(source)?; let data = future_path(data)?; let staging = future_path(&PathBuf::from(name))?;
    Ok(source.starts_with(&data) || data.starts_with(&source) || source.starts_with(&staging) || staging.starts_with(&source))
}
fn spawn_backend(profile: &Path, resources: &Path, token: &str, pcm: &str, port: u16) -> Result<(Child, u16, bool), String> {
    let node = env::var_os("AUTOMIX_NODE_PATH").map(PathBuf::from).unwrap_or_else(|| resources.join("node/node.exe"));
    let entry = env::var_os("AUTOMIX_BACKEND_ENTRY").map(PathBuf::from).unwrap_or_else(|| resources.join("backend/tauri-backend.mjs"));
    let network = env::var_os("AUTOMIX_NETWORK_RUST").map(PathBuf::from).unwrap_or_else(|| resources.join("network/mora-network.exe"));
    let old: Value = fs::read(profile.join("desktop.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let data = old["dataDir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| profile.join("data"));
    recover_data_dir(&data)?;
    let key = secrets::secret_key(profile)?;
    let mut command = Command::new(node);
    command.arg(entry).env_remove("HOST").env_remove("PORT").env_remove("ACCESS_TOKEN").env_remove("ELECTRON_RUN_AS_NODE")
        .env("AUTOMIX_PROFILE_DIR", profile).env("AUTOMIX_DATA_DIR", &data).env("AUTOMIX_ROOT", resources)
        .env("AUTOMIX_DESKTOP", "1").env("AUTOMIX_WEB_DIST", resources.join("web"))
        .env("AUTOMIX_ANALYSIS_WORKER", resources.join("backend/analysisWorker.mjs"))
        .env("AUTOMIX_RUST_CORE", resources.join("audio/mora-audio.exe")).env("AUTOMIX_NETWORK_RUST", network)
        .env("AUTOMIX_VERSION", env!("CARGO_PKG_VERSION"))
        .env("AUTOMIX_DECODER_RUST", resources.join("decoder/mora-decode.exe"))
        .env("FFMPEG_PATH", resources.join("ffmpeg/ffmpeg.exe")).env("FFPROBE_PATH", resources.join("ffmpeg/ffprobe.exe"))
        .env("YTDLP_PATH", resources.join("yt-dlp/yt-dlp.exe")).env("STEMS_PYTHON", "")
        .env("AUTOMIX_LAUNCH_TOKEN", token).env("AUTOMIX_DESKTOP_PCM_TOKEN", pcm).env("AUTOMIX_SECRET_KEY", key)
        .env("AUTOMIX_PORT", port.to_string()).env("AUTOMIX_KEEP_PORT", if port == 0 { "0" } else { "1" })
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| format!("backend launch: {e}"))?;
    let stdout = child.stdout.take().ok_or("backend output unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(value) = line.strip_prefix("MORA_BACKEND ") {
            if let Ok(message) = serde_json::from_str::<Value>(value) { let _ = tx.send(message); }
        }
    });
    let message = match rx.recv_timeout(Duration::from_secs(90)) { Ok(v) => v, Err(_) => { let _ = child.kill(); return Err("backend startup timed out".into()); } };
    let port = message["port"].as_u64().and_then(|n| u16::try_from(n).ok()).filter(|n| *n != 0);
    if message["type"] != "ready" || port.is_none() { let _ = child.kill(); return Err(format!("backend startup failed: {}", message["message"])); }
    Ok((child, port.unwrap(), message["recovery"].as_bool().unwrap_or(false)))
}
fn stop_child(child: &mut Child, preserve: bool) {
    if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(if preserve { b"{\"type\":\"restart\"}\n" } else { b"{\"type\":\"shutdown\"}\n" }); }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline { if matches!(child.try_wait(), Ok(Some(_))) { return; } std::thread::sleep(Duration::from_millis(50)); }
    let _ = child.kill(); let _ = child.wait();
}
fn launch_update(child: &mut Child, installer: &Path, recover: impl FnOnce(&mut Child) -> Result<(), String>) -> Result<(), String> {
    stop_child(child, true);
    if let Err(error) = Command::new(installer).args(["--updated", "/S", "--force-run"]).spawn() {
        let message = format!("Не удалось запустить установщик: {error}");
        recover(child).map_err(|error| format!("{message}. Не удалось восстановить сервис: {error}"))?;
        return Err(message);
    }
    Ok(())
}
fn restart_child(state: &Session, stop: bool) -> Result<(), String> {
    let mut child = state.child.lock().unwrap();
    if state.maintenance.load(Ordering::Acquire) { return Err("Дождитесь окончания переноса медиатеки".into()); }
    if stop { stop_child(&mut child, true); }
    else if !matches!(child.try_wait(), Ok(Some(_))) { return Ok(()); }
    let (mut replacement, _, recovery) = spawn_backend(&state.profile, &state.resources, &state.token, &state.pcm, state.port)?;
    if stop && recovery {
        if let Some(stdin) = replacement.stdin.as_mut() { let _ = writeln!(stdin, "{}", json!({"type":"recovery", "restore":true})); }
    } else { offer_recovery(&mut replacement, recovery); }
    *child = replacement; Ok(())
}
fn offer_recovery(child: &mut Child, recovery: bool) {
    if recovery && env::var_os("AUTOMIX_TEST").is_none() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_YESNO, MB_ICONQUESTION, MB_DEFBUTTON2, IDYES, IDNO};
        let message: Vec<u16> = "Восстановить очередь и позицию после неожиданного завершения?\0".encode_utf16().collect();
        let title: Vec<u16> = "Восстановление MORA\0".encode_utf16().collect();
        let answer = unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) };
        if answer == IDYES || answer == IDNO {
            if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{}", json!({"type":"recovery", "restore":answer == IDYES})); }
        }
    }
}
fn validate_export(contents: &str) -> Result<(), String> {
    if contents.len() > 128 * 1024 * 1024 { return Err("Экспорт превышает 128 МБ".into()); }
    serde_json::from_str::<Value>(contents).map(|_| ()).map_err(|_| "Некорректный JSON экспорта".into())
}
#[tauri::command]
async fn desktop_action(window: tauri::WebviewWindow, state: tauri::State<'_, Session>, action: String, value: Option<Value>) -> Result<Value, String> {
    match action.as_str() {
        "save-export" => {
            let data = value.ok_or("Нет данных экспорта")?;
            let contents = data["contents"].as_str().ok_or("Некорректный экспорт")?;
            validate_export(contents)?;
            let name = match data["name"].as_str() { Some("MORA-playlist.json") => "MORA-playlist.json", _ => "MORA-playlists.json" };
            let selected = window.app_handle().dialog().file().set_title("Сохранить плейлисты").set_file_name(name).add_filter("JSON", &["json"]).blocking_save_file();
            let Some(file) = selected else { return Ok(json!(false)); };
            let path = file.into_path().map_err(|_| "Не удалось выбрать файл")?;
            fs::write(path, contents).map_err(|e| format!("Не удалось сохранить файл: {e}"))?;
            Ok(json!(true))
        }
        "window-drag" => { window.start_dragging().map_err(|e| e.to_string())?; Ok(Value::Null) }
        "window-minimize" => { window.minimize().map_err(|e| e.to_string())?; Ok(Value::Null) }
        "window-maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() }.map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window-close" => { window.close().map_err(|e| e.to_string())?; Ok(Value::Null) }
        "close-to-tray" => {
            let enabled = value.and_then(|v| v.as_bool()).ok_or("invalid setting")?;
            save_preferences(&state, "closeToTray", json!(enabled))?;
            *state.close_to_tray.lock().unwrap() = enabled; Ok(json!({"closeToTray":enabled}))
        }
        "window-settings" => Ok(json!({"closeToTray":*state.close_to_tray.lock().unwrap(),"compact":state.compact.lock().unwrap().is_some(),"decorated":window.is_decorated().unwrap_or(true),"maximized":window.is_maximized().unwrap_or(false),"minimized":window.is_minimized().unwrap_or(false)})),
        "pick-folder" => {
            let selected = window.app_handle().dialog().file().set_title("Папка с музыкой").blocking_pick_folder();
            Ok(selected.and_then(|v| v.into_path().ok()).map(|p| json!(p.to_string_lossy())).unwrap_or(Value::Null))
        }
        "open-data-folder" => {
            Command::new("explorer.exe").arg(&state.data_dir).spawn().map_err(|e| e.to_string())?;
            Ok(json!(""))
        }
        "install-update" => {
            if state.maintenance.load(Ordering::Acquire) { return Err("Дождитесь окончания переноса медиатеки".into()); }
            let directory = state.profile.join("app-updates");
            let pending: Value = serde_json::from_slice(&fs::read(directory.join("pending.json")).map_err(|_| "Обновление не скачано")?).map_err(|_| "Обновление не скачано")?;
            // The backend verified sha512 against the release feed; only a plain installer name inside app-updates is accepted.
            let name = pending["file"].as_str().filter(|n| n.len() > 15 && n.starts_with("MORA-Setup-") && n.ends_with(".exe") && n[11..n.len() - 4].chars().all(|c| c.is_ascii_digit() || c == '.')).ok_or("Некорректное обновление")?;
            let installer = directory.join(name);
            if !installer.is_file() { return Err("Обновление не скачано".into()); }
            if state.maintenance.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("Дождитесь окончания переноса медиатеки".into()); }
            let _guard = Maintenance(&state.maintenance);
            launch_update(&mut state.child.lock().unwrap(), &installer, |child| {
                let (mut replacement, _, recovery) = spawn_backend(&state.profile, &state.resources, &state.token, &state.pcm, state.port)?;
                if recovery { if let Some(stdin) = replacement.stdin.as_mut() { let _ = writeln!(stdin, "{}", json!({"type":"recovery", "restore":true})); } }
                *child = replacement; Ok(())
            })?;
            state.quitting.store(true, Ordering::Release);
            window.app_handle().exit(0); Ok(Value::Null)
        }
        "restart-backend" => { restart_child(&state, true)?; Ok(Value::Null) }
        "import-library" => {
            let selected = window.app_handle().dialog().file().set_title("Папка медиатеки (с automix.sqlite)").blocking_pick_folder();
            let Some(source) = selected.and_then(|v| v.into_path().ok()) else { return Ok(json!({"status":"cancelled"})) };
            if !source.join("automix.sqlite").is_file() { return Ok(json!({"status":"error", "message":"В папке нет automix.sqlite"})); }
            if import_paths_overlap(&source, &state.data_dir)? { return Ok(json!({"status":"error", "message":"Папки исходной и текущей медиатеки пересекаются"})); }
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_YESNO, MB_ICONQUESTION, MB_DEFBUTTON2, IDYES};
            let description = format!("Перенести медиатеку из {}?\n\nИсходная папка не изменится, текущая медиатека будет сохранена резервной копией. На время переноса музыка остановится.\0", source.display());
            let description: Vec<u16> = description.encode_utf16().collect(); let title: Vec<u16> = "Импорт медиатеки\0".encode_utf16().collect();
            if unsafe { MessageBoxW(std::ptr::null_mut(), description.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) } != IDYES { return Ok(json!({"status":"cancelled"})); }
            let source_key = source.parent().and_then(|parent| secrets::read_existing_key(parent).ok().flatten());
            let destination_key = secrets::read_existing_key(&state.profile)?.ok_or("Ключ текущей медиатеки недоступен")?;
            if state.maintenance.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("Перенос уже выполняется".into()); }
            let _guard = Maintenance(&state.maintenance);
            let mut child = state.child.lock().unwrap(); stop_child(&mut child, false);
            let node = env::var_os("AUTOMIX_NODE_PATH").map(PathBuf::from).unwrap_or_else(|| state.resources.join("node/node.exe"));
            let mut worker = Command::new(node).arg(state.resources.join("backend/import.mjs")).arg(&source).arg(&state.data_dir)
                .env_remove("AUTOMIX_SECRET_KEY").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000).spawn();
            let mut result = json!({"status":"error", "message":"Не удалось запустить импорт"});
            if let Ok(worker) = worker.as_mut() {
                if let Some(mut stdin) = worker.stdin.take() { let _ = writeln!(stdin, "{}", json!({"source": source_key, "destination": destination_key})); }
                if let Some(stdout) = worker.stdout.take() {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Ok(message) = serde_json::from_str::<Value>(&line) {
                            match message["type"].as_str() {
                                Some("progress") => if let (Some(done), Some(total)) = (message["done"].as_u64(), message["total"].as_u64()) {
                                    let _ = window.eval(format!("window.__moraImportProgress?.({{done:{done},total:{total}}})"));
                                },
                                Some("done") => result = json!({"status":"done"}),
                                Some("error") => result = json!({"status":"error", "message":message["message"].as_str().unwrap_or("Ошибка импорта")}), _ => {}
                            }
                        }
                    }
                }
                if !matches!(worker.wait(), Ok(status) if status.success()) && result["status"] == "done" { result = json!({"status":"error", "message":"Импорт прерван"}); }
            }
            match spawn_backend(&state.profile, &state.resources, &state.token, &state.pcm, state.port) {
                Ok((replacement, _, _)) => *child = replacement,
                Err(error) => return Err(format!("Импорт завершён, но сервис не запустился: {error}")),
            }
            Ok(result)
        }
        "compact" => {
            let value = value.ok_or("invalid compact setting")?; let on = value["on"].as_bool().ok_or("invalid compact setting")?; let top = value["onTop"].as_bool().unwrap_or(true);
            if on {
                let enter = { let mut previous = state.compact.lock().unwrap(); if previous.is_none() {
                    *previous = Some((window.outer_position().map_err(|e| e.to_string())?, window.outer_size().map_err(|e| e.to_string())?)); true
                } else { false } };
                if enter { window.set_min_size(Some(tauri::LogicalSize::new(320.0, 150.0))).map_err(|e| e.to_string())?; window.set_size(tauri::LogicalSize::new(420.0, 176.0)).map_err(|e| e.to_string())?; }
            } else {
                let previous = state.compact.lock().unwrap().take();
                if let Some((position, size)) = previous { window.set_size(size).map_err(|e| e.to_string())?; window.set_position(position).map_err(|e| e.to_string())?; window.set_min_size(Some(tauri::LogicalSize::new(960.0, 680.0))).map_err(|e| e.to_string())?; }
            }
            window.set_always_on_top(on && top).map_err(|e| e.to_string())?; Ok(json!({"on":on,"onTop":top}))
        }
        "overlay" => Ok(json!({"transparent": value.and_then(|v| v.as_bool()).unwrap_or(false)})),
        "player-state" => {
            if let (Some(value), Some(tray)) = (value, window.app_handle().tray_by_id("mora")) {
                let title: String = value["title"].as_str().unwrap_or("").chars().take(40).collect();
                let artist: String = value["artist"].as_str().unwrap_or("").chars().take(15).collect();
                let tooltip = if title.is_empty() { "MORA".into() } else if artist.is_empty() { format!("MORA — {title}") } else { format!("MORA — {title} — {artist}") };
                let _ = tray.set_tooltip(Some(tooltip));
            }
            Ok(Value::Null)
        },
        _ => Err("Недоступная команда".into()),
    }
}
#[cfg(test)]
mod tests {
    use std::os::windows::process::CommandExt;
    #[test]
    fn export_allows_more_than_16_mib_and_rejects_more_than_128_mib() {
        let valid = format!("\"{}\"", "x".repeat(16 * 1024 * 1024));
        assert!(super::validate_export(&valid).is_ok());
        assert_eq!(super::validate_export(&" ".repeat(128 * 1024 * 1024 + 1)).unwrap_err(), "Экспорт превышает 128 МБ");
        assert_eq!(super::validate_export("{").unwrap_err(), "Некорректный JSON экспорта");
    }
    #[test]
    fn installer_launch_failure_recovers_backend() {
        let mut child = std::process::Command::new("cmd.exe").args(["/C", "exit", "0"])
            .stdin(std::process::Stdio::piped()).creation_flags(0x08000000).spawn().unwrap();
        let missing = std::env::temp_dir().join(format!("mora-missing-installer-{}.exe", super::random_hex().unwrap()));
        let mut recovered = false;
        let error = super::launch_update(&mut child, &missing, |stopped| {
            assert!(stopped.try_wait().unwrap().is_some());
            recovered = true; Ok(())
        }).unwrap_err();
        assert!(error.starts_with("Не удалось запустить установщик:"));
        assert!(recovered);
    }
}
fn set_webview_visible(window: &tauri::WebviewWindow, visible: bool) {
    let _ = window.with_webview(move |webview| unsafe { let _ = webview.controller().SetIsVisible(visible); });
}
fn show_window(window: &tauri::WebviewWindow) {
    set_webview_visible(window, true);
    let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
}
fn main() {
    let profile = env::var_os("AUTOMIX_PROFILE_DIR").map(PathBuf::from).unwrap_or_else(|| profile::choose(&PathBuf::from(env::var_os("LOCALAPPDATA").unwrap_or_default())).expect("existing profile unavailable"));
    fs::create_dir_all(&profile).expect("profile unavailable");
    let mut context = tauri::generate_context!();
    if env::var_os("AUTOMIX_TEST").is_some() {
        use std::hash::{Hash, Hasher};
        let mut key = std::collections::hash_map::DefaultHasher::new();
        profile.hash(&mut key);
        // Disposable smoke profiles must not share the installed application's instance mutex.
        context.config_mut().identifier.push_str(&format!(".test.{:x}", key.finish()));
    }
    let resources = env::var_os("AUTOMIX_RESOURCES_DIR").map(PathBuf::from).unwrap_or_else(|| env::current_exe().unwrap().parent().unwrap().join("resources"));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if env::var_os("AUTOMIX_TEST").is_none() { if let Some(w) = app.get_webview_window("main") { show_window(&w); } }
        }))
        .invoke_handler(tauri::generate_handler![desktop_action])
        .setup(move |app| {
    let token = random_hex().map_err(std::io::Error::other)?; let pcm = random_hex().map_err(std::io::Error::other)?;
    let (mut child, port, recovery) = spawn_backend(&profile, &resources, &token, &pcm, 0).map_err(std::io::Error::other)?;
    offer_recovery(&mut child, recovery);
    let initial: Value = fs::read(profile.join("desktop.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut saved: Value = fs::read(profile.join("tauri-window.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}));
    if !saved.is_object() { saved = json!({}); }
    if saved["window"].is_null() && initial["window"].is_object() { saved["window"] = initial["window"].clone(); }
    let close_to_tray = saved["closeToTray"].as_bool().or_else(|| initial["closeToTray"].as_bool()).unwrap_or(true);
    let data_dir = initial["dataDir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| profile.join("data"));
    app.manage(Session { child: Mutex::new(child), close_to_tray: Mutex::new(close_to_tray), compact: Mutex::new(None), profile: profile.clone(), data_dir, resources: resources.clone(), token: token.clone(), pcm, port, quitting: AtomicBool::new(false), maintenance: AtomicBool::new(false), power: AtomicUsize::new(0), prefs: Mutex::new(saved.clone()) });
    let power = power::start(app.handle().clone()); app.state::<Session>().power.store(power, Ordering::Relaxed);
            let origin = format!("http://127.0.0.1:{port}");
            let script = include_str!("../../bridge.js").replace("__MORA_ACCESS_TOKEN__", &token).replace("__MORA_PORT__", &port.to_string()).replace("__MORA_VERSION__", env!("CARGO_PKG_VERSION"));
            let trusted = origin.clone();
            let hidden = env::var_os("AUTOMIX_TEST").is_some();
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("{origin}/").parse()?))
                .title("MORA").decorations(false).inner_size(1280.0, 820.0).min_inner_size(960.0, 680.0).visible(!hidden)
                .data_directory(profile.join("webview2")).initialization_script(script)
                // Tauri's native file-drop handler swallows HTML5 drag-and-drop in WebView2 (queue, playlists).
                .disable_drag_drop_handler()
                .on_navigation(move |url| url.origin().ascii_serialization() == trusted);
            if hidden {
                if let Ok(args) = env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") { builder = builder.additional_browser_args(&args); }
            }
            let window = builder.build()?;
            // WebView2 defaults are browser-like: link preview in the corner, Back/Reload/Print menu and
            // Ctrl+R/Ctrl+P/Alt+Left/F5. Editing keys (Ctrl+C/V) and the page's own menus are unaffected.
            let _ = window.with_webview(|webview| unsafe {
                if let Ok(settings) = webview.controller().CoreWebView2().and_then(|core| core.Settings()) {
                    let _ = settings.SetIsStatusBarEnabled(false);
                    let _ = settings.SetAreDefaultContextMenusEnabled(false);
                    if let Ok(settings) = windows_core::Interface::cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3>(&settings) {
                        let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                }
            });
            if hidden { set_webview_visible(&window, false); }
            let bounds = &saved["window"];
            if let (Some(x), Some(y), Some(width), Some(height)) = (bounds["x"].as_i64(), bounds["y"].as_i64(), bounds["width"].as_u64(), bounds["height"].as_u64()) {
                if (-100000..=100000).contains(&x) && (-100000..=100000).contains(&y) && (960..=8192).contains(&width) && (680..=8192).contains(&height) {
                    let visible = window.available_monitors().unwrap_or_default().iter().any(|m| {
                        let p = m.position(); let s = m.size();
                        x < i64::from(p.x) + i64::from(s.width) && y < i64::from(p.y) + i64::from(s.height) && x + width as i64 > i64::from(p.x) && y + height as i64 > i64::from(p.y)
                    });
                    if visible { let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32)); let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32)); }
                }
            }
            if bounds["maximized"].as_bool() == Some(true) { let _ = window.maximize(); }
            if !hidden {
                let menu = MenuBuilder::new(app).text("toggle", "Слушать / пауза").text("next", "Следующий трек")
                    .text("prev", "Предыдущий трек").separator().text("show", "Открыть MORA").text("quit", "Выйти").build()?;
                let mut tray = TrayIconBuilder::with_id("mora").menu(&menu).show_menu_on_left_click(false).tooltip("MORA")
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => { if let Some(w) = app.get_webview_window("main") { show_window(&w); } },
                        "quit" => app.exit(0),
                        action @ ("toggle" | "next" | "prev") => {
                            let session = app.state::<Session>(); let mut child = session.child.lock().unwrap();
                            if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{}", json!({"type":"transport","command":action})); }
                        }, _ => {}
                    }).on_tray_icon_event(|tray, event| {
                        if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                            if let Some(w) = tray.app_handle().get_webview_window("main") { show_window(&w); }
                        }
                    });
                if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
                tray.build(app)?;
            }
            let w = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    save_window(&w);
                    if *w.state::<Session>().close_to_tray.lock().unwrap() { api.prevent_close(); set_webview_visible(&w, false); let _ = w.hide(); }
                },
                WindowEvent::Resized(_) => { set_webview_visible(&w, w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)); save_window(&w); },
                WindowEvent::Moved(_) => save_window(&w), _ => {}
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut crashes: Vec<Instant> = Vec::new();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let Some(state) = handle.try_state::<Session>() else { return };
                    if state.quitting.load(Ordering::Relaxed) { return; }
                    if state.maintenance.load(Ordering::Acquire) { continue; }
                    let exited = matches!(state.child.lock().unwrap().try_wait(), Ok(Some(_)));
                    if !exited { continue; }
                    let now = Instant::now(); crashes.retain(|at| now.duration_since(*at) < Duration::from_secs(300)); crashes.push(now);
                    if crashes.len() > 3 { return; }
                    std::thread::sleep(Duration::from_secs(crashes.len() as u64));
                    if state.quitting.load(Ordering::Relaxed) { return; }
                    if let Err(error) = restart_child(&state, false) { eprintln!("backend restart: {error}"); }
                }
            });
            println!("MORA_TAURI_READY {port}"); Ok(())
        }).build(context).expect("Tauri startup failed");
    app.run(|handle, event| if let tauri::RunEvent::ExitRequested { .. } = event {
        if let Some(state) = handle.try_state::<Session>() { state.quitting.store(true, Ordering::Relaxed); }
    } else if let tauri::RunEvent::Exit = event {
        let Some(state) = handle.try_state::<Session>() else { return }; let mut child = state.child.lock().unwrap();
        power::stop(state.power.swap(0, Ordering::Relaxed));
        stop_child(&mut child, false);
    });
}
