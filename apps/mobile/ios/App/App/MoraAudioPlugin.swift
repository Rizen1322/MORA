import AVFoundation
import Capacitor
import MediaPlayer
import Security
import UIKit
import WebKit
import Darwin

/// Web view for MORA: inline WebAudio without a tap per sound, and the MoraAudio plugin.
class MoraBridgeViewController: CAPBridgeViewController {
    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // WebKit can mute a hidden page's audio. This preference is not public API: it is set
        // only when this WebKit has it, for a personally installed build (not for App Store review).
        if config.preferences.responds(to: NSSelectorFromString("_setRequiresPageVisibilityToPlayAudio:")) {
            config.preferences.setValue(false, forKey: "requiresPageVisibilityToPlayAudio")
        }
        return config
    }

    override open var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MoraAudioPlugin())
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        webView?.isOpaque = false
        webView?.backgroundColor = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
    }
}

/// WebKit owns metadata. Native navigation is installed only for the explicit
/// diagnostic split route; the default route leaves WebKit targets untouched.
@objc(MoraAudioPlugin)
public class MoraAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MoraAudioPlugin"
    public let jsName = "MoraAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setRemoteNavigation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "power", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diagnosticsTest", returnType: CAPPluginReturnPromise),
    ]

    private var playing = false
    private var webAudioSession = false
    private var resumeAfterInterruption = false
    private var remoteCommands: [(MPRemoteCommand, Any)] = []
    private var navigationSignature = ""
    private var navigationRoute = "webkit"
    private var navigationEpoch = 0

    override public func load() {
        MoraPlaybackJournal.record("native.load")
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        nc.addObserver(self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
        nc.addObserver(self, selector: #selector(routeChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
        nc.addObserver(self, selector: #selector(mediaReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
        // Heat and Low Power Mode: the web side stills animations and defers optional work (Apple's
        // thermal guidance: from "serious" on, reduce CPU/GPU use, screen updates and animations).
        nc.addObserver(self, selector: #selector(powerChanged(_:)), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(powerChanged(_:)), name: .NSProcessInfoPowerStateDidChange, object: nil)
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
                     UIApplication.willEnterForegroundNotification, UIApplication.didBecomeActiveNotification] {
            nc.addObserver(self, selector: #selector(lifecycle(_:)), name: name, object: nil)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        for (command, target) in remoteCommands { command.removeTarget(target) }
    }

    private func send(_ action: String, seekTime: Double? = nil, id: String? = nil, source: String = "notification", routeEpoch: Int? = nil) {
        var data: [String: Any] = ["action": action]
        if MoraPlaybackJournal.enabled {
            let commandId = id ?? UUID().uuidString
            data["id"] = commandId
            data["source"] = source
            MoraPlaybackJournal.record("native.send", ["id": commandId, "action": action, "source": source])
        }
        if let seekTime { data["seekTime"] = seekTime }
        if let routeEpoch { data["routeEpoch"] = routeEpoch }
        notifyListeners("command", data: data)
    }

    private func registerNavigation() {
        let epoch = navigationEpoch
        let center = MPRemoteCommandCenter.shared()
        let bindings: [(MPRemoteCommand, String)] = [
            (center.nextTrackCommand, "nexttrack"),
            (center.previousTrackCommand, "previoustrack"),
            (center.changePlaybackPositionCommand, "seekto"),
            (center.skipForwardCommand, "seekforward"),
            (center.skipBackwardCommand, "seekbackward"),
        ]
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.preferredIntervals = [10]
        for (command, action) in bindings {
            command.isEnabled = false
            let target = command.addTarget { [weak self] event in
                guard self?.navigationRoute == "native" else { return .commandFailed }
                let time = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                if action == "seekto", time == nil || time?.isFinite != true { return .commandFailed }
                let id = UUID().uuidString
                MoraPlaybackJournal.record("native.remote.callback", ["id": id, "action": action, "seekTime": time ?? -1])
                DispatchQueue.main.async { [weak self] in self?.send(action, seekTime: time, id: id, source: "remote", routeEpoch: epoch) }
                return .success
            }
            remoteCommands.append((command, target))
        }
    }

    @objc func setRemoteNavigation(_ call: CAPPluginCall) {
        let actions = Set(call.getArray("actions", String.self) ?? [])
        let seekable = call.getBool("seekable") ?? false
        let route = call.getString("route") ?? "native" // Compatibility with the previous JS shell.
        let epoch = call.getInt("epoch") ?? 0
        guard route == "webkit" || route == "native" else { call.reject("Unknown route"); return }
        DispatchQueue.main.async {
            if epoch < self.navigationEpoch { call.resolve(); return }
            self.navigationEpoch = epoch
            self.navigationRoute = route
            if route == "webkit" {
                // Remove only our own registrations. Do not write command-center
                // flags on cold WebKit startup: WebKit manages its own capabilities.
                for (command, target) in self.remoteCommands {
                    command.isEnabled = false; command.removeTarget(target)
                }
                self.remoteCommands.removeAll()
                self.navigationSignature = ""
                MoraPlaybackJournal.record("native.navigation.route", ["route": route])
                call.resolve(); return
            }
            if self.remoteCommands.isEmpty { self.registerNavigation() }
            let signature = actions.sorted().joined(separator: ".") + "." + String(seekable)
            if signature != self.navigationSignature {
                self.navigationSignature = signature
                MoraPlaybackJournal.record("native.navigation", ["action": actions.sorted().joined(separator: "."), "seekable": seekable, "route": route])
            }
            let center = MPRemoteCommandCenter.shared()
            center.nextTrackCommand.isEnabled = actions.contains("nexttrack")
            center.previousTrackCommand.isEnabled = actions.contains("previoustrack")
            center.changePlaybackPositionCommand.isEnabled = seekable && actions.contains("seekto")
            center.skipForwardCommand.isEnabled = seekable && actions.contains("seekforward")
            center.skipBackwardCommand.isEnabled = seekable && actions.contains("seekbackward")
            call.resolve()
        }
    }

    @objc func setPlaybackState(_ call: CAPPluginCall) {
        let wasPlaying = playing
        let effectivePlaying = call.getBool("playing") ?? playing
        // Preserve intent across context suspension so an interruption ending
        // with shouldResume can still restore a previously playing track.
        playing = call.getBool("intentPlaying") ?? effectivePlaying
        webAudioSession = call.getBool("webAudioSession") ?? webAudioSession
        MoraPlaybackJournal.record("native.playbackState", ["playing": effectivePlaying, "intentPlaying": playing, "webAudioSession": webAudioSession])
        // WebKit owns navigator.audioSession. Re-activating its session from another
        // process while it starts playback can interrupt the sound we just started.
        if playing && !wasPlaying && !webAudioSession { MoraAudioSession.activate() }
        call.resolve()
    }

    private func powerState() -> [String: Any] {
        let p = ProcessInfo.processInfo
        return ["thermal": p.thermalState.rawValue, "lowPower": p.isLowPowerModeEnabled]
    }

    @objc func power(_ call: CAPPluginCall) {
        call.resolve(powerState())
    }

    /// Key that seals provider tokens in the library database (AES-GCM in the web worker).
    @objc func secretKey(_ call: CAPPluginCall) {
        if let key = MoraKeychain.secretKey() { call.resolve(["key": key]) }
        else { call.reject("Keychain недоступен") }
    }

    @objc private func powerChanged(_ n: Notification) {
        notifyListeners("power", data: powerState())
    }

    @objc private func interruption(_ n: Notification) {
        MoraPlaybackJournal.record("native.interruption", ["seq": n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0,
            "reason": String(n.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt ?? 0),
            "paused": n.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool ?? false])
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            // "The app was suspended" is not a real interruption (Apple: ignore it); pausing on it
            // is what stopped playback by itself. Only a genuine one (call, Siri, alarm) pauses.
            if n.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool == true { return }
            if #available(iOS 16.0, *),
               let r = n.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
               AVAudioSession.InterruptionReason(rawValue: r) == .appWasSuspended { return }
            resumeAfterInterruption = playing
            send("pause")
        case .ended:
            let opts = AVAudioSession.InterruptionOptions(rawValue: n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if resumeAfterInterruption && opts.contains(.shouldResume) {
                if !webAudioSession { MoraAudioSession.activate() }
                send("play")
            }
            resumeAfterInterruption = false
        @unknown default:
            break
        }
    }

    @objc private func routeChange(_ n: Notification) {
        MoraPlaybackJournal.record("native.routeChange", ["reason": String(n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0)])
        guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        // headphones unplugged / Bluetooth gone: pause instead of playing out loud
        if reason == .oldDeviceUnavailable && playing { send("pause") }
    }

    @objc private func mediaReset(_ n: Notification) {
        MoraPlaybackJournal.record("native.mediaReset")
        if playing {
            if !webAudioSession { MoraAudioSession.activate() }
            send("play")
        }
    }

    @objc private func lifecycle(_ n: Notification) {
        MoraPlaybackJournal.record("native.lifecycle", ["reason": n.name.rawValue])
        if n.name == UIApplication.didEnterBackgroundNotification { MoraPlaybackJournal.flush() }
    }

    @objc func diagnosticsInfo(_ call: CAPPluginCall) { call.resolve(["enabled": MoraPlaybackJournal.enabled]) }
    @objc func diagnosticsRecord(_ call: CAPPluginCall) {
        MoraPlaybackJournal.record(call.getString("stage") ?? "invalid", call.getObject("fields") ?? [:])
        call.resolve()
    }
    @objc func diagnosticsClear(_ call: CAPPluginCall) { MoraPlaybackJournal.clear(); call.resolve() }
    @objc func diagnosticsReport(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(MoraPlaybackJournal.report()) }
    }
    @objc func diagnosticsShare(_ call: CAPPluginCall) {
        guard MoraPlaybackJournal.enabled else { call.reject("Diagnostics disabled"); return }
        DispatchQueue.main.async {
            do {
                let data = try JSONSerialization.data(withJSONObject: MoraPlaybackJournal.report(), options: [.prettyPrinted, .sortedKeys])
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("MORA-playback-diagnostics.json")
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                guard let vc = self.bridge?.viewController, vc.presentedViewController == nil else { call.reject("Share unavailable"); return }
                let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                sheet.popoverPresentationController?.sourceView = vc.view
                sheet.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                vc.present(sheet, animated: true) { call.resolve() }
            } catch { call.reject("Report export failed") }
        }
    }
    @objc func diagnosticsTest(_ call: CAPPluginCall) {
        guard MoraPlaybackJournal.enabled, let action = call.getString("action"),
              ["play", "pause", "nexttrack", "previoustrack", "seekto", "seekforward", "seekbackward"].contains(action) else {
            call.reject("Diagnostic action unavailable"); return
        }
        let time = call.getDouble("seekTime")
        if action == "seekto", time == nil || time?.isFinite != true { call.reject("Invalid seek time"); return }
        DispatchQueue.main.async {
            let id = UUID().uuidString
            MoraPlaybackJournal.record("native.test", ["id": id, "action": action])
            self.send(action, seekTime: time, id: id, source: "test")
            call.resolve()
        }
    }
}

/// Private, bounded journal. It never reads the media library or any credentials.
/// Remote callbacks and JS delivery have separate entries: success from MPRemoteCommand
/// only means that its callback accepted the event, not that WebContent received it.
enum MoraPlaybackJournal {
    static let enabled = Bundle.main.object(forInfoDictionaryKey: "MoraPlaybackDiagnostics") as? Bool == true
    private static let queue = DispatchQueue(label: "ru.mora.playback-diagnostics")
    private static let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("MORA/playback-diagnostics.json")
    private static var events: [[String: Any]] = {
        guard enabled, let data = try? Data(contentsOf: url), data.count <= 1_000_000,
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return Array(rows.suffix(1200))
    }()
    private static var write: DispatchWorkItem?
    private static let numeric: Set<String> = ["seq", "position", "seekTime", "clock", "peak", "monotonicMs", "duration", "rate"]
    private static let flags: Set<String> = ["paused", "starved", "hidden", "allowed", "playing", "intentPlaying", "webAudioSession", "seekable", "node"]
    private static let codes: Set<String> = ["id", "action", "command", "status", "context", "source", "reason", "outcome", "route", "kind", "mediaState"]

    static func record(_ stage: String, _ fields: [String: Any] = [:]) {
        guard enabled, stage.range(of: "^[a-zA-Z0-9_.-]{1,64}$", options: .regularExpression) != nil else { return }
        var row: [String: Any] = ["stage": stage, "time": Date().timeIntervalSince1970, "uptime": ProcessInfo.processInfo.systemUptime]
        for (key, value) in fields {
            if numeric.contains(key), let number = value as? NSNumber, number.doubleValue.isFinite { row[key] = number }
            if flags.contains(key), let flag = value as? Bool { row[key] = flag }
            if codes.contains(key), let code = value as? String,
               code.range(of: "^[a-zA-Z0-9_.-]{1,80}$", options: .regularExpression) != nil { row[key] = code }
        }
        let safe = row
        queue.async {
            events.append(safe)
            if events.count > 1200 { events.removeFirst(events.count - 1200) }
            // Flush at most twice a second even during a command burst.
            if write == nil {
                let job = DispatchWorkItem { persist(); write = nil }
                write = job
                queue.asyncAfter(deadline: .now() + 0.5, execute: job)
            }
        }
    }
    private static func persist() {
        guard let data = try? JSONSerialization.data(withJSONObject: events) else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { /* A diagnostic write must never interrupt music playback. */ }
    }
    static func flush() { guard enabled else { return }; queue.sync { persist() } }
    static func clear() { guard enabled else { return }; queue.sync { events = []; persist() } }
    // Called on the main queue to read UIKit state safely; the journal itself is serialized.
    static func report() -> [String: Any] {
        guard enabled else { return ["enabled": false] }
        let session = AVAudioSession.sharedInstance(), bundle = Bundle.main
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(1, size))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return ["schema": 2, "enabled": true, "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "",
            "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") ?? "", "sdk": bundle.object(forInfoDictionaryKey: "DTSDKName") ?? "",
            "os": ProcessInfo.processInfo.operatingSystemVersionString, "machine": String(cString: machine),
            "appState": UIApplication.shared.applicationState.rawValue, "category": session.category.rawValue,
            "mode": session.mode.rawValue, "sampleRate": session.sampleRate, "ioBufferDuration": session.ioBufferDuration,
            "outputLatency": session.outputLatency, "outputs": session.currentRoute.outputs.map { $0.portType.rawValue },
            "nativeSessionActive": "unknown", "capacity": 1200,
            "remoteEnabled": ["next": MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled,
                "previous": MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled,
                "seek": MPRemoteCommandCenter.shared().changePlaybackPositionCommand.isEnabled],
            "events": queue.sync { events }]
    }
}

enum MoraKeychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ru.mora.secrets",
        kSecAttrAccount as String: "library-key",
    ]

    /// 32 random bytes as hex, created once. This device only, readable after the first unlock:
    /// a locked phone playing in the background can still open the library.
    static func secretKey() -> String? {
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return data.map { String(format: "%02x", $0) }.joined()
        }
        // Only a key that does not exist is created: a locked keychain must never replace it
        // (the tokens sealed with the old one would be lost).
        guard status == errSecItemNotFound else { return nil }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        var add = query
        add[kSecValueData as String] = Data(bytes)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

enum MoraAudioSession {
    private static let queue = DispatchQueue(label: "ru.mora.audio-session")
    /// Music app: plays with the screen locked, ignores the silent switch, AirPlay/Bluetooth allowed.
    /// Off the main thread: setActive can block the UI (Xcode warns "can lead to UI unresponsiveness").
    static func activate() {
        MoraPlaybackJournal.record("native.session.request")
        queue.async {
            let s = AVAudioSession.sharedInstance()
            do {
                // Same configuration WebKit applies for navigator.audioSession.type = 'playback':
                // a different policy here made the two re-configure (and interrupt) each other.
                if s.category != .playback || s.mode != .default || s.routeSharingPolicy != .default {
                    try s.setCategory(.playback, mode: .default, policy: .default, options: [])
                }
                try s.setActive(true)
                MoraPlaybackJournal.record("native.session.activated")
            } catch {
                MoraPlaybackJournal.record("native.session.failed")
                NSLog("[MORA] audio session: \(error)")
            }
        }
    }
}
