import Foundation

/// One sleeping producer, released by native audible-track changes, not by page timers.
final class NativePreparationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var upper: Int
    private var stopped = false
    private var waiter: (Int, CheckedContinuation<Bool, Never>)?
    init(index: Int) { upper = index + 2 }
    func advance(_ index: Int) {
        lock.lock(); upper = max(upper, index + 2)
        let wake = waiter.flatMap { $0.0 <= upper ? $0.1 : nil }
        if wake != nil { waiter = nil }; lock.unlock(); wake?.resume(returning: true)
    }
    func cancel() {
        lock.lock(); stopped = true; let wake = waiter?.1; waiter = nil; lock.unlock(); wake?.resume(returning: false)
    }
    func wait(_ index: Int) async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            if stopped { lock.unlock(); continuation.resume(returning: false) }
            else if index <= upper { lock.unlock(); continuation.resume(returning: true) }
            else { waiter = (index, continuation); lock.unlock() }
        }
    }
}

/// All expensive work happens here, outside the mixer/AVAudioEngine control queue.
/// The immutable handoff contains the known queue, so there is no WebView request
/// between songs. Signed addresses/credentials are memory-only and never logged.
final class NativeQueuePreparation: @unchecked Sendable {
    let ticket = NativePreparationTicket()
    let gate: NativePreparationGate
    private let lock = NSLock()
    private var cached: [String: Any] = ["state": "idle", "ready": 0, "remaining": 0]
    private var failureCount = 0
    var snapshot: [String: Any] { lock.lock(); defer { lock.unlock() }; return cached }
    init(index: Int) { gate = NativePreparationGate(index: index) }
    func cancel() { ticket.cancel(); gate.cancel() }
    private func state(_ code: String, ready: Int, remaining: Int, reason: String = "none") {
        lock.lock(); if code == "failed" { failureCount += 1 }
        cached = ["state": code, "ready": ready, "remaining": remaining, "reason": reason, "failedCount": failureCount]; lock.unlock()
    }
    func run(folder: URL, manifest: [String: Any], seed: [String: Any], script: String,
             allocate: @escaping @Sendable () async -> Int?,
             accept: @escaping @Sendable (Int, [String: Any]) async -> Bool,
             event: @escaping @Sendable (String, String) -> Void) async {
        guard let raw = manifest["items"] as? [[String: Any]], let from = manifest["from"] as? Int,
              let settings = manifest["settings"] as? [String: Any],
              let previous = manifest["previous"] as? [String: Any] else { return }
        let hosts = Set((raw + (manifest["loopItems"] as? [[String: Any]] ?? [])).compactMap { item -> String? in
            guard let source = item["source"] as? [String: Any], source["allowHTTP"] as? Bool == true,
                  let text = source["url"] as? String else { return nil }; return URL(string: text)?.host
        })
        let http = NativeMediaHTTP(allowedHTTPHosts: hosts), loader = NativeMediaLoader(http: http)
        defer { http.invalidate() }
        var produced = 0, processed = 0, consecutiveFailures = 0, at = from
        var batch = raw, cursor = 0
        let loop = manifest["loopItems"] as? [[String: Any]] ?? []
        var analyses: [String: [String: Any]] = [:]
        var before = previous, previousPCM = seed
        if let frames = seed["totalFrames"] as? Int { before["duration"] = Double(frames) / 48000 }
        do {
            let core = try NativePreparationCore(script: script)
            if before["mixingAllowed"] as? Bool == true && (before["analysis"] == nil || before["analysis"] is NSNull) {
                if let file = seed["file"] as? Int, let frames = seed["totalFrames"] as? Int {
                    state("analyzing", ready: produced, remaining: raw.count)
                    before["analysis"] = try analysis(core, folder: folder, file: file, frames: frames)
                }
            }
            while !ticket.cancelled {
                if cursor >= batch.count {
                    if loop.isEmpty { break }
                    batch = loop; cursor = 0
                }
                let item = batch[cursor]; cursor += 1
                processed += 1
                state("waiting", ready: produced, remaining: batch.count - cursor + 1)
                guard await gate.wait(at), !ticket.cancelled else { break }
                guard let fileKey = await allocate(), (0..<1_000_000).contains(fileKey),
                      let source = item["source"] as? [String: Any] else { throw NativeMediaLoader.Failure.source }
                let downloaded = folder.appendingPathComponent("\(UUID().uuidString).media")
                let pcm = folder.appendingPathComponent("\(fileKey).f32le")
                var committed = false, created = false
                do {
                    defer {
                        try? FileManager.default.removeItem(at: downloaded)
                        if created && !committed { try? FileManager.default.removeItem(at: pcm) }
                    }
                    state("downloading", ready: produced, remaining: max(0, batch.count - cursor + 1)); event("stage", "downloading")
                    let media = try await loader.load(source, to: downloaded, folder: folder, ticket: ticket)
                    state("decoding", ready: produced, remaining: max(0, batch.count - cursor + 1)); event("stage", "decoding")
                    let frames = try NativePCMDecoder.decode(media, to: pcm, sampleRate: 48000, cancelled: { self.ticket.cancelled })
                    created = true
                    guard !ticket.cancelled else { throw NativeMediaHTTP.Failure.cancelled }
                    var next = item
                    next["id"] = item["trackId"]; next["duration"] = Double(frames) / 48000
                    let trackId = item["trackId"] as? String ?? ""
                    if let analysis = analyses[trackId] { next["analysis"] = analysis }
                    if next["analysis"] == nil || next["analysis"] is NSNull {
                        if item["mixingAllowed"] as? Bool == true {
                            state("analyzing", ready: produced, remaining: max(0, batch.count - cursor + 1)); event("stage", "analyzing")
                            next["analysis"] = try analysis(core, folder: folder, file: fileKey, frames: frames)
                        } else { next["analysis"] = NSNull() }
                    }
                    if let analysis = next["analysis"] as? [String: Any] {
                        analyses[trackId] = analysis
                        if analyses.count > 64, let oldest = analyses.keys.first(where: { $0 != trackId }) { analyses.removeValue(forKey: oldest) }
                    }
                    before["id"] = before["trackId"]
                    before["analysis"] = before["analysis"] ?? NSNull()
                    state("planning", ready: produced, remaining: max(0, batch.count - cursor + 1))
                    let result = try core.plan(a: before, b: next, settings: settings, sampleRate: 48000)
                    var track: [String: Any] = ["file": fileKey, "totalFrames": frames,
                        "title": item["title"] ?? "", "artist": item["artist"] ?? "", "entryId": item["entryId"] ?? "",
                        "trackId": item["trackId"] ?? "", "gainDb": result["gainDb"] ?? 0]
                    if let transition = result["transition"] as? [String: Any],
                       let trigger = transition["triggerFrame"] as? Int, let entry = transition["entryFrame"] as? Int,
                       trigger < (previousPCM["totalFrames"] as? Int ?? 0), entry < frames {
                        track["transition"] = transition; track["plan"] = result["plan"]
                    }
                    if let artwork = item["artwork"] { track["artwork"] = artwork }
                    else if let text = item["coverUrl"] as? String, let url = URL(string: text) {
                        if let data = try? await http.data(url, limit: 2 * 1024 * 1024, ticket: ticket) {
                            track["artwork"] = ["base64": data.base64EncodedString()]
                        }
                    }
                    guard !ticket.cancelled else { throw NativeMediaHTTP.Failure.cancelled }
                    committed = await accept(at, track)
                    guard committed else {
                        if !ticket.cancelled { state("failed", ready: produced, remaining: batch.count - cursor, reason: "commit"); event("failed", "commit") }
                        break
                    }
                    before = next; previousPCM = track; at += 1; produced += 1; consecutiveFailures = 0
                    state("ready", ready: produced, remaining: batch.count - cursor); event("ready", "none")
                } catch {
                    if ticket.cancelled { break }
                    consecutiveFailures += 1
                    let code: String
                    switch error {
                    case NativeMediaHTTP.Failure.http(let status): code = "http_\(status)"
                    case NativeMediaHTTP.Failure.tooLarge, NativePCMDecoder.Failure.limit: code = "size_limit"
                    case NativeMediaLoader.Failure.encrypted: code = "encrypted"
                    case NativePreparationCore.Failure.analysis: code = "analysis"
                    default: code = "preparation"
                    }
                    state("failed", ready: produced, remaining: batch.count - cursor, reason: code); event("failed", code)
                    if consecutiveFailures >= 3 { break }
                }
            }
            if ticket.cancelled { state("cancelled", ready: produced, remaining: 0) }
            else if loop.isEmpty && cursor == batch.count { state("complete", ready: produced, remaining: 0) }
        } catch {
            if !ticket.cancelled { state("failed", ready: produced, remaining: raw.count - produced, reason: "analysis"); event("failed", "analysis") }
        }
    }
    private func analysis(_ core: NativePreparationCore, folder: URL, file: Int, frames: Int) throws -> [String: Any] {
        let source = folder.appendingPathComponent("\(file).f32le")
        let temporary = folder.appendingPathComponent("\(UUID().uuidString).analysis")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let length = try NativePCMDecoder.resample(source, from: 48000, to: temporary, sampleRate: 44100, cancelled: { self.ticket.cancelled })
        return try core.analyze(temporary, frames: length, ticket: ticket)
    }
}
