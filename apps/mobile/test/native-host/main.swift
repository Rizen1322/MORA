import AVFoundation
import Foundation
import UIKit

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

@MainActor
final class HostCheck: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let host = NativeMixHost()
    private var skip = false
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
        let data: [String: Any] = ["status": status, "reason": reason, "indexes": seen.sorted(),
            "state": last, "events": MoraPlaybackJournal.snapshot]
        if let bytes = try? JSONSerialization.data(withJSONObject: data) { try? bytes.write(to: reportURL, options: .atomic) }
    }
    enum Failure: Error { case check(String) }
    private func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.check(message) } }
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
        write("ready") // Runner moves this app to the background now.
        for _ in 0..<200 {
            if UIApplication.shared.applicationState == .background { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try require(UIApplication.shared.applicationState == .background, "Fixture never entered the background")
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
        write("passed")
        _ = try await call { host.stop($0) }
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(HostCheck.self))
