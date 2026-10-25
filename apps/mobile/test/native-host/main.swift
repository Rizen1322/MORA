import AVFoundation
import Foundation
import UIKit
import MediaPlayer

// Fixture-only app: deliberately has no WebView, Capacitor or page timers.
enum MoraPlaybackJournal {
    private static let lock = NSLock()
    private static var events: [[String: Any]] = []
    static func record(_ stage: String, _ fields: [String: Any] = [:]) {
        lock.lock(); events.append(["stage": stage, "fields": fields])
        if events.count > 100 { events.removeFirst() }; lock.unlock()
    }
    static var snapshot: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return events }
}

final class EngineCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AVAudioEngine?
    func create() -> AVAudioEngine { lock.lock(); defer { lock.unlock() }; let engine = AVAudioEngine(); value = engine; return engine }
    var latest: AVAudioEngine? { lock.lock(); defer { lock.unlock() }; return value }
}

@MainActor
final class HostCheck: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let engines = EngineCapture()
    private lazy var host = NativeMixHost(makeEngine: { [engines] in engines.create() })
    private var skip = false
    private var backgrounded = false
    private var seen: Set<Int> = []
    private var last: [String: Any] = [:]
    private var reportURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(skip ? "skip.json" : "natural.json")
    }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        skip = CommandLine.arguments.contains("--skip")
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = UIViewController()
        window.makeKeyAndVisible(); self.window = window
        Task { do { try await run() } catch { write("failed", reason: String(describing: error)) } }
        return true
    }
    private func call(_ operation: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in operation { continuation.resume(with: $0) } }
    }
    private func write(_ status: String, reason: String = "none") {
        let data: [String: Any] = ["status": status, "reason": reason, "indexes": seen.sorted(), "backgrounded": backgrounded,
            "state": last, "events": MoraPlaybackJournal.snapshot]
        if let bytes = try? JSONSerialization.data(withJSONObject: data) { try? bytes.write(to: reportURL, options: .atomic) }
    }
    enum Failure: Error { case check(String) }
    private func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.check(message) } }
    private func artworkRegressions(id: String, seed: [String: Any]) async throws {
        guard let argument = CommandLine.arguments.firstIndex(of: "--fixture-base") else { throw Failure.check("Missing cover fixture server") }
        let base = URL(string: CommandLine.arguments[argument + 1])!
        func request(_ path: String) async throws -> String {
            let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent(path))
            return String(data: data, encoding: .utf8) ?? ""
        }
        func startSeed() async throws {
            _ = try await call { host.start(id: id, config: ["sampleRate": 48000.0, "position": 0.0, "paused": true, "tracks": [seed]], completion: $0) }
        }
        for keepPrefix in [true, false] {
            try await startSeed()
            let reserved = try await call { host.reserveSources(id: id, count: 1, completion: $0) }
            let key = (reserved["keys"] as! [Int])[0]
            let wave = NativeProbeWave.make(track: 1, seconds: 3)
            _ = try await call { host.sourceAppend(id: id, key: key, offset: 0, base64: wave.base64EncodedString(), completion: $0) }
            let item: [String: Any] = ["file": key, "entryId": "cover-track", "trackId": "cover-track", "title": "Cover track",
                "duration": 3.0, "mixingAllowed": false, "coverUrl": base.appendingPathComponent("cover").absoluteString,
                "source": ["kind": "local", "file": key, "url": base.absoluteString, "allowHTTP": true]]
            _ = try await call { host.prepareQueue(id: id, manifest: ["from": 1, "items": [item], "settings": ["enabled": false],
                "previous": ["trackId": "long", "duration": 6.0, "mixingAllowed": false]], completion: $0) }
            for _ in 0..<100 {
                last = try await call { host.state($0) }
                let heldCovers = try await request("pending")
                if last["count"] as? Int == 2 && heldCovers == "1" { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            try require(last["count"] as? Int == 2, "A held cover blocked ready PCM")
            let pending = try await request("pending")
            try require(pending == "1", "Artwork regression did not start a held request")
            last = try await call { host.command("nexttrack", source: "fixture", completion: $0) }
            try require(last["artworkReady"] as? Bool == false, "Cover arrived before fixture release")
            if keepPrefix {
                // The new producer is empty, but the retained ready track still
                // owns its in-flight image lease from the previous producer.
                _ = try await call { host.prepareQueue(id: id, manifest: ["from": 2, "items": [], "settings": ["enabled": false],
                    "previous": ["trackId": "cover-track", "duration": 3.0, "mixingAllowed": false]], completion: $0) }
            } else { try await startSeed() }
            _ = try await request("release")
            for _ in 0..<40 {
                try await Task.sleep(nanoseconds: 20_000_000)
                last = try await call { host.state($0) }
                if keepPrefix && last["artworkReady"] as? Bool == true { break }
            }
            try require(last["artworkReady"] as? Bool == keepPrefix,
                keepPrefix ? "Manifest replacement lost a retained cover lease" : "A stale cover overwrote the new session")
        }
    }
    private func waitingConfigurationRegression(id: String, seed: [String: Any]) async throws {
        let argument = CommandLine.arguments.firstIndex(of: "--fixture-base")!
        let base = URL(string: CommandLine.arguments[argument + 1])!
        _ = try await call { host.start(id: id, config: ["sampleRate": 48000.0, "position": 5.7, "tracks": [seed]], completion: $0) }
        let item: [String: Any] = ["file": 99, "entryId": "held-audio", "trackId": "held-audio", "title": "Held audio", "duration": 1.0,
            "mixingAllowed": false, "source": ["kind": "direct", "url": base.appendingPathComponent("audio-wait").absoluteString, "allowHTTP": true]]
        _ = try await call { host.prepareQueue(id: id, manifest: ["from": 1, "items": [item], "settings": ["enabled": false],
            "previous": ["trackId": "long", "duration": 6.0, "mixingAllowed": false]], completion: $0) }
        for _ in 0..<100 {
            last = try await call { host.state($0) }
            if last["ended"] as? Bool == true { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try require(last["ended"] as? Bool == true, "Fixture did not end while awaiting audio")
        let (pending, _) = try await URLSession.shared.data(from: base.appendingPathComponent("audio-pending"))
        try require(String(data: pending, encoding: .utf8) == "1", "Fixture did not hold next audio")
        let stopped = engines.latest!
        stopped.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: stopped)
        _ = try await call { host.state($0) } // Drain the configuration notification before releasing the next file.
        _ = try await URLSession.shared.data(from: base.appendingPathComponent("audio-release"))
        for _ in 0..<100 {
            last = try await call { host.state($0) }
            if last["index"] as? Int == 1 && last["playing"] as? Bool == true { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try require(last["index"] as? Int == 1 && last["playing"] as? Bool == true,
            "Configuration change lost automatic continuation after waiting")
    }
    private func run() async throws {
        let begin = try await call { host.begin($0) }, id = begin["id"] as! String
        let frames = 3 * 48000
        let pcm = (0..<frames).flatMap { i -> [Float] in
            let value = Float(sin(Double(i) * 2 * .pi * 220 / 48000) * 0.1); return [value, value]
        }.withUnsafeBytes { Data($0) }
        for offset in stride(from: 0, to: pcm.count, by: 262144) {
            let data = pcm.subdata(in: offset..<min(pcm.count, offset + 262144))
            _ = try await call { host.append(id: id, track: 0, offset: offset, base64: data.base64EncodedString(), completion: $0) }
        }
        _ = try await call { host.start(id: id, config: ["sampleRate": 48000.0, "position": 0.0, "index": 0,
            "tracks": [["file": 0, "totalFrames": frames, "gainDb": 0.0, "entryId": "E0", "trackId": "T0", "title": "Track 0"]]], completion: $0) }
        // Production mirrors source leases after start(), which deliberately clears old leases.
        let reserved = try await call { host.reserveSources(id: id, count: 7, completion: $0) }
        let keys = reserved["keys"] as! [Int]
        let wav = NativeProbeWave.make(track: 1, seconds: 3)
        var items: [[String: Any]] = []
        for (i, key) in keys.enumerated() {
            _ = try await call { host.sourceAppend(id: id, key: key, offset: 0, base64: wav.base64EncodedString(), completion: $0) }
            items.append(["file": key, "entryId": "E\(i + 1)", "trackId": "T\(i + 1)", "title": "Track \(i + 1)",
                "artist": "Fixture", "duration": 3.0, "mixingAllowed": false, "source": ["kind": "local", "file": key]])
        }
        _ = try await call { host.prepareQueue(id: id, manifest: ["from": 1, "items": items, "settings": ["enabled": false],
            "previous": ["trackId": "T0", "duration": 3.0, "mixingAllowed": false]], completion: $0) }
        write("ready")
        // Public UIKit app switch; simctl launch of an already-running Settings
        // process doesn't reliably activate it. No page exists in this app.
        UIApplication.shared.open(URL(string: "https://example.invalid/mora-native-host-check")!, options: [:], completionHandler: nil)
        for _ in 0..<600 {
            if UIApplication.shared.applicationState == .background { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try require(UIApplication.shared.applicationState == .background, "Fixture never entered the background")
        backgrounded = true
        for _ in 0..<500 {
            last = try await call { host.state($0) }
            let index = last["index"] as? Int ?? -1, count = last["count"] as? Int ?? 0
            try require(last["failed"] as? Bool != true, "Native host failed")
            try require((last["duration"] as? Double ?? 0) == 3, "Duration disappeared")
            seen.insert(index)
            if index == 7 && (last["position"] as? Double ?? 0) > 0.1 { break }
            if skip && count > index + 1 {
                _ = try await call { host.command("nexttrack", source: "fixture", completion: $0) }
            }
            write("running")
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try require(seen.contains(7), "Native refill stopped after index \(seen.max() ?? -1)")
        _ = try await call { host.command("pause", source: "fixture", completion: $0) }
        last = try await call { host.command("seekto", time: 0.35, source: "fixture", completion: $0) }
        try require(abs((last["position"] as? Double ?? 0) - 0.35) < 0.02, "Native seek lost its position")
        // Pruning retains only the immediate predecessor. Going farther must
        // reject navigation without stopping or failing the working player.
        last = try await call { host.command("previoustrack", source: "fixture", completion: $0) }
        try require(last["index"] as? Int == 6, "Previous did not reach retained PCM")
        _ = try await call { host.command("play", source: "fixture", completion: $0) }
        var rejected = false
        do { _ = try await call { host.command("previoustrack", source: "fixture", completion: $0) } }
        catch { rejected = true }
        last = try await call { host.state($0) }
        try require(rejected && last["failed"] as? Bool == false && last["playing"] as? Bool == true
            && last["index"] as? Int == 6, "Unavailable Previous destroyed current playback")
        try require(!MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled, "Unavailable Previous stays enabled")
        // A six-second fresh seed permits the >3s restart-current behavior even
        // when there is no retained predecessor at all.
        let longPCM = pcm + pcm
        for offset in stride(from: 0, to: longPCM.count, by: 262144) {
            let data = longPCM.subdata(in: offset..<min(longPCM.count, offset + 262144))
            _ = try await call { host.append(id: id, track: 42, offset: offset, base64: data.base64EncodedString(), completion: $0) }
        }
        let seed: [String: Any] = ["file": 42, "totalFrames": frames * 2, "gainDb": 0.0, "entryId": "long", "trackId": "long", "title": "Long"]
        _ = try await call { host.start(id: id, config: ["sampleRate": 48000.0, "position": 4.0, "paused": true, "tracks": [seed]], completion: $0) }
        try require(MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled, "Restart-current is not available past 3s")
        last = try await call { host.command("previoustrack", source: "fixture", completion: $0) }
        try require(last["index"] as? Int == 0 && (last["position"] as? Double ?? -1) < 0.02, "Previous did not restart current")
        try await artworkRegressions(id: id, seed: seed)
        _ = try await call { host.command("play", source: "fixture", completion: $0) }
        _ = try await call { host.settings(["playback": ["speed": 0.8]], completion: $0) }
        try require((MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue == 0.8,
            "Now Playing did not publish DSP speed")
        _ = try await call { host.command("pause", source: "fixture", completion: $0) }
        try require((MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue == 0,
            "Paused Now Playing rate is not zero")
        last = try await call { host.command("seekto", time: 0.35, source: "fixture", completion: $0) }
        let beforeReset = engines.latest
        host.mediaReset()
        last = try await call { host.state($0) }
        try require(last["failed"] as? Bool == false && last["playing"] as? Bool == false
            && abs((last["position"] as? Double ?? 0) - 0.35) < 0.02, "Media reset lost the resumable queue")
        last = try await call { host.command("play", source: "fixture", completion: $0) }
        try require(last["playing"] as? Bool == true && last["failed"] as? Bool == false, "User Play did not recover after media reset")
        try require(engines.latest !== beforeReset, "Media reset reused its orphaned engine")
        // This injects the framework's stopped-engine notification semantics;
        // a physical Bluetooth/USB route switch remains a separate device check.
        let oldEngine = engines.latest!
        let beforeChange = last["position"] as? Double ?? 0
        oldEngine.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: oldEngine)
        try await Task.sleep(nanoseconds: 250_000_000)
        last = try await call { host.state($0) }
        try require(engines.latest !== oldEngine && last["playing"] as? Bool == true && last["failed"] as? Bool == false,
            "Configuration change did not rebuild/resume the graph")
        try require((last["position"] as? Double ?? 0) >= beforeChange - 0.1 && (last["position"] as? Double ?? 0) < beforeChange + 0.6,
            "Configuration change treated flushed buffers as audible")
        let unplugged = engines.latest!
        unplugged.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: unplugged)
        NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: AVAudioSession.sharedInstance(),
            userInfo: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue])
        try await Task.sleep(nanoseconds: 150_000_000)
        last = try await call { host.state($0) }
        try require(last["playing"] as? Bool == false && !unplugged.isRunning, "Unplug was overridden by configuration recovery")
        last = try await call { host.command("play", source: "fixture", completion: $0) }
        try require(last["playing"] as? Bool == true, "Play did not recover a paused configuration change")
        try await waitingConfigurationRegression(id: id, seed: seed)
        write("passed")
        _ = try await call { host.stop($0) }
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(HostCheck.self))
