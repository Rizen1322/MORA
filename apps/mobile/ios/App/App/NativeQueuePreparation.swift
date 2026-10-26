import AVFoundation
import Foundation
import CryptoKit

/// One sleeping producer, released by native audible-track changes, not by page timers.
final class NativePreparationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var upper: Int
    private var stopped = false
    private var waiter: (Int, CheckedContinuation<Bool, Never>)?
    var snapshot: [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return ["gateUpper": upper, "gateWaiting": waiter?.0 ?? -1]
    }
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
    let analysis: NativeMixAnalysis
    private let jobId = UUID().uuidString
    private let lock = NSLock()
    private var cached: [String: Any] = ["state": "idle", "ready": 0, "remaining": 0]
    private var failureCount = 0
    private var running = true
    private var repeats = false
    private var updated = ProcessInfo.processInfo.systemUptime
    var snapshot: [String: Any] {
        lock.lock(); var result = cached; result["running"] = running
        result["hasMore"] = running && ((cached["remaining"] as? Int ?? 0) > 0 || repeats)
        result["stageSeconds"] = max(0, ProcessInfo.processInfo.systemUptime - updated); lock.unlock()
        result["jobId"] = jobId; result["analysis"] = analysis.snapshot
        for (key, value) in gate.snapshot { result[key] = value }; return result
    }
    var hasRemaining: Bool { !ticket.cancelled && snapshot["hasMore"] as? Bool == true }
    init(index: Int, remaining: Int = 0, loopCount: Int = 0, analysis: NativeMixAnalysis = NativeMixAnalysis()) {
        self.analysis = analysis
        gate = NativePreparationGate(index: index); repeats = loopCount > 0
        cached = ["state": "starting", "ready": 0, "remaining": max(remaining, loopCount)]
    }
    func cancel(keepAnalysis: Bool = false) { ticket.cancel(); gate.cancel(); if !keepAnalysis { analysis.cancel() } }
    private func state(_ code: String, ready: Int, remaining: Int, reason: String = "none") {
        lock.lock(); updated = ProcessInfo.processInfo.systemUptime; if code == "failed" { failureCount += 1 }
        cached = ["state": code, "ready": ready, "remaining": remaining, "reason": reason, "failedCount": failureCount]; lock.unlock()
    }
    func run(folder: URL, manifest: [String: Any], seed: [String: Any], script: String,
             allocate: @escaping @Sendable () async -> Int?,
             accept: @escaping @Sendable (Int, [String: Any]) async -> Bool,
             upgrade: @escaping @Sendable (Int, [String: Any]) -> Void = { _, _ in },
             event: @escaping @Sendable (String, String) -> Void) async {
        defer { finished(); event("finished", "none") }
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
        configure(remaining: raw.count, loopCount: loop.count)
        var before = previous, previousPCM = seed
        if let frames = seed["totalFrames"] as? Int { before["duration"] = Double(frames) / 48000 }
        do {
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
                    var track: [String: Any] = ["file": fileKey, "totalFrames": frames,
                        "title": item["title"] ?? "", "artist": item["artist"] ?? "", "entryId": item["entryId"] ?? "",
                        "trackId": item["trackId"] ?? "", "gainDb": 0.0]
                    if let artwork = item["artwork"] { track["artwork"] = artwork }
                    else if let text = item["coverUrl"] as? String, let url = URL(string: text) {
                        track["coverUrl"] = text
                        if let host = url.host, hosts.contains(host) { track["artworkHTTPHost"] = host }
                    }
                    guard !ticket.cancelled else { throw NativeMediaHTTP.Failure.cancelled }
                    committed = await accept(at, track)
                    guard committed else {
                        if !ticket.cancelled { state("failed", ready: produced, remaining: batch.count - cursor, reason: "commit"); event("failed", "commit") }
                        break
                    }
                    // PCM readiness never waits for seed/candidate MIR or planning.
                    // Analysis has its own bounded serial executor and pinned file leases.
                    if !ticket.cancelled && (before["mixingAllowed"] as? Bool == true || next["mixingAllowed"] as? Bool == true) {
                        analysis.enqueue(folder: folder, before: before, previousPCM: previousPCM,
                                         next: next, pcm: track, index: at, script: script, settings: settings,
                                         upgrade: upgrade, event: event)
                    }
                    before = next; previousPCM = track; at += 1; produced += 1; consecutiveFailures = 0
                    state("ready", ready: produced, remaining: batch.count - cursor); event("ready", "none")
                } catch {
                    if ticket.cancelled { break }
                    consecutiveFailures += 1
                    let code: String
                    switch error {
                    case NativeMediaHTTP.Failure.http(let status): code = "http_\(status)"
                    case NativeMediaHTTP.Failure.transport(let status): code = "network_\(status)"
                    case NativeMediaHTTP.Failure.tooLarge, NativePCMDecoder.Failure.limit: code = "size_limit"
                    case NativeMediaLoader.Failure.encrypted: code = "encrypted"
                    case NativePreparationCore.Failure.analysis: code = "analysis"
                    default:
                        let native = error as NSError
                        code = [AVFoundationErrorDomain, NSOSStatusErrorDomain].contains(native.domain) ? "decode_\(native.code)" : "preparation"
                    }
                    state("failed", ready: produced, remaining: batch.count - cursor, reason: code); event("failed", code)
                    if consecutiveFailures >= 3 { break }
                }
            }
            if ticket.cancelled { state("cancelled", ready: produced, remaining: 0) }
            else if loop.isEmpty && cursor == batch.count { state("complete", ready: produced, remaining: 0) }
        } catch {
            if !ticket.cancelled { state("failed", ready: produced, remaining: max(0, raw.count - processed), reason: "analysis"); event("failed", "analysis") }
        }
    }
    private func finished() { lock.lock(); running = false; lock.unlock() }
    private func configure(remaining: Int, loopCount: Int) {
        lock.lock(); repeats = loopCount > 0; cached["remaining"] = max(remaining, loopCount); lock.unlock()
    }

}

/// MIR has no dependency edge back into the PCM producer. One executor also
/// prevents cancelled, synchronous JS calls from running concurrently on new VMs.
final class NativeMixAnalysis: @unchecked Sendable {
    private static let executor = DispatchQueue(label: "ru.mora.mir", qos: .utility)
    // Accessed only on executor. Script identity versions the content-addressed cache.
    private static var core: NativePreparationCore?
    private static var scriptKey = ""
    private static var cache: [String: [String: Any]] = [:]
    private static var cacheOrder: [String] = []
    private let lock = NSLock()
    private var pending: [Request] = []
    private var active: Request?
    private var stopped = false
    private var audible = -1
    private var allowedFiles: [Int: Int]?
    private var cached: [String: Any] = ["state": "idle"]
    private var updated = ProcessInfo.processInfo.systemUptime
    var snapshot: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var result = cached; result["queued"] = pending.count
        result["stageSeconds"] = max(0, ProcessInfo.processInfo.systemUptime - updated)
        return result
    }
    private final class Source {
        let value: [String: Any], url: URL, frames: Int
        init(folder: URL, value: [String: Any], pcm: [String: Any]) throws {
            guard let file = pcm["file"] as? Int, let frames = pcm["totalFrames"] as? Int else { throw NativePreparationCore.Failure.analysis }
            self.frames = frames
            // Never retain source URLs or credentials in the analysis queue/cache.
            self.value = ["id": value["trackId"] ?? "", "duration": Double(frames) / 48000,
                          "mixingAllowed": value["mixingAllowed"] ?? false, "analysis": value["analysis"] ?? NSNull()]
            url = folder.appendingPathComponent("\(UUID().uuidString).mir-pcm")
            // A private hard link pins the PCM independently of playback pruning.
            try FileManager.default.linkItem(at: folder.appendingPathComponent("\(file).f32le"), to: url)
        }
        deinit { try? FileManager.default.removeItem(at: url) }
    }
    private final class Request: @unchecked Sendable {
        let id = UUID().uuidString, ticket = NativePreparationTicket()
        let a: Source, b: Source, index: Int, script: String, settings: [String: Any], pcm: [String: Any]
        let upgrade: @Sendable (Int, [String: Any]) -> Void
        let event: @Sendable (String, String) -> Void
        init(a: Source, b: Source, index: Int, script: String, settings: [String: Any], pcm: [String: Any],
             upgrade: @escaping @Sendable (Int, [String: Any]) -> Void, event: @escaping @Sendable (String, String) -> Void) {
            self.a = a; self.b = b; self.index = index; self.script = script; self.settings = settings
            self.pcm = pcm; self.upgrade = upgrade; self.event = event
        }
    }
    func cancel() {
        lock.lock(); stopped = true; active?.ticket.cancel(); pending.removeAll(); lock.unlock()
    }
    func advance(_ index: Int) {
        lock.lock(); audible = max(audible, index)
        if let active, active.index <= audible { active.ticket.cancel() }
        pending.removeAll { $0.index <= audible }; lock.unlock()
    }
    func retain(_ files: [Int: Int]) {
        lock.lock(); allowedFiles = files
        if let active, files[active.index] != active.pcm["file"] as? Int { active.ticket.cancel() }
        pending.removeAll { files[$0.index] != $0.pcm["file"] as? Int }
        lock.unlock()
    }
    func enqueue(folder: URL, before: [String: Any], previousPCM: [String: Any], next: [String: Any], pcm: [String: Any],
                 index: Int, script: String, settings: [String: Any],
                 upgrade: @escaping @Sendable (Int, [String: Any]) -> Void, event: @escaping @Sendable (String, String) -> Void) {
        do {
            let request = try Request(a: Source(folder: folder, value: before, pcm: previousPCM),
                b: Source(folder: folder, value: next, pcm: pcm), index: index, script: script, settings: settings,
                pcm: pcm, upgrade: upgrade, event: event)
            lock.lock()
            guard !stopped, index > audible, allowedFiles == nil || allowedFiles?[index] == pcm["file"] as? Int else { lock.unlock(); return }
            guard !(active?.index == index && active?.pcm["file"] as? Int == pcm["file"] as? Int),
                  !pending.contains(where: { $0.index == index && $0.pcm["file"] as? Int == pcm["file"] as? Int }) else { lock.unlock(); return }
            // At most one active and two pending pairs. Newer playback windows
            // evict obsolete queued work rather than accumulating PCM leases.
            pending.append(request)
            if pending.count > 2 { pending.removeFirst() }
            let begin = active == nil
            if begin { active = pending.removeFirst() }
            let first = active; lock.unlock()
            if begin, let first { schedule(first) }
        } catch { event("fallback", "analysisLease") }
    }
    private func stage(_ name: String, _ request: Request, role: String = "pair") {
        lock.lock(); updated = ProcessInfo.processInfo.systemUptime
        cached = ["state": name, "jobId": request.id, "toIndex": request.index, "role": role]
        lock.unlock(); request.event("analysis", name)
    }
    private func schedule(_ request: Request) {
        stage("queued", request)
        Self.executor.async { [self] in
            defer {
                lock.lock(); active = nil
                let next = !stopped && !pending.isEmpty ? pending.removeFirst() : nil
                active = next; lock.unlock()
                if let next { schedule(next) }
            }
            do {
                if request.ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
                stage("initializing", request)
                let scriptKey = SHA256.hash(data: Data(request.script.utf8)).map { String(format: "%02x", $0) }.joined()
                if Self.core == nil || Self.scriptKey != scriptKey {
                    Self.core = try NativePreparationCore(script: request.script); Self.scriptKey = scriptKey
                }
                guard let core = Self.core else { throw NativePreparationCore.Failure.script }
                var a = request.a.value, b = request.b.value
                a["analysis"] = try analyze(request.a, core: core, scriptKey: scriptKey, request: request, role: "seed")
                b["analysis"] = try analyze(request.b, core: core, scriptKey: scriptKey, request: request, role: "candidate")
                if request.ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
                stage("planning", request)
                let result = try core.plan(a: a, b: b, settings: request.settings, sampleRate: 48000)
                if request.ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
                var track = request.pcm; track["gainDb"] = result["gainDb"] ?? 0.0
                if let tr = result["transition"] as? [String: Any], let trigger = tr["triggerFrame"] as? Int,
                   let entry = tr["entryFrame"] as? Int, trigger < request.a.frames, entry < request.b.frames {
                    track["transition"] = tr; track["plan"] = result["plan"]
                }
                request.upgrade(request.index, track)
                stage("complete", request)
            } catch {
                stage(request.ticket.cancelled ? "cancelled" : "fallback", request)
            }
        }
    }
    private func analyze(_ source: Source, core: NativePreparationCore, scriptKey: String, request: Request, role: String) throws -> Any {
        guard source.value["mixingAllowed"] as? Bool == true else { return NSNull() }
        if let ready = source.value["analysis"] as? [String: Any], ready["version"] as? String == core.analyzerVersion { return ready }
        stage("fingerprint", request, role: role)
        let file = try FileHandle(forReadingFrom: source.url)
        defer { try? file.close() }
        var digest = SHA256()
        while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty {
            if request.ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
            digest.update(data: data)
        }
        let key = scriptKey + digest.finalize().map { String(format: "%02x", $0) }.joined()
        if let ready = Self.cache[key] { stage("cacheHit", request, role: role); return ready }
        stage("resampling", request, role: role)
        let temporary = source.url.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).mir-44100")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let frames = try NativePCMDecoder.resample(source.url, from: 48000, to: temporary, sampleRate: 44100, cancelled: { request.ticket.cancelled })
        stage("analyzing", request, role: role)
        let result = try core.analyze(temporary, frames: frames, ticket: request.ticket) { [self] name in stage(name, request, role: role) }
        if request.ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
        Self.cache[key] = result; Self.cacheOrder.append(key)
        if Self.cacheOrder.count > 32 { Self.cache.removeValue(forKey: Self.cacheOrder.removeFirst()) }
        return result
    }
}

/// Session-owned: replacing a preparation manifest keeps artwork requests for
/// retained PCM alive. The host checks the entry/file identity before applying it.
final class NativeQueueArtwork: @unchecked Sendable {
    private let ticket = NativePreparationTicket()
    private let lock = NSLock()
    private var pendingArtwork = 0
    private struct ArtworkRequest: Sendable {
        let url: URL, hosts: Set<String>, index: Int, file: Int
        let accept: @Sendable (Int, Int, Data) -> Void
    }
    private var deferredArtwork: [ArtworkRequest] = []
    func cancel() {
        ticket.cancel()
        lock.lock(); deferredArtwork.removeAll(); lock.unlock()
    }
    /// Optional images never block the sequential audio producer. Bound both the
    /// number of in-flight images and their lifetime, including very fast skips.
    func load(_ url: URL, hosts: Set<String>, index: Int, file: Int,
                             accept: @escaping @Sendable (Int, Int, Data) -> Void) {
        lock.lock()
        guard !ticket.cancelled else { lock.unlock(); return }
        let request = ArtworkRequest(url: url, hosts: hosts, index: index, file: file, accept: accept)
        if pendingArtwork >= 2 {
            // The gate permits current + two upcoming songs. Keep that latest
            // window rather than accumulating the covers of rapidly skipped songs.
            deferredArtwork.append(request)
            if deferredArtwork.count > 3 { deferredArtwork.removeFirst() }
            lock.unlock(); return
        }
        pendingArtwork += 1; lock.unlock()
        startArtwork(request)
    }
    private func startArtwork(_ request: ArtworkRequest) {
        Task.detached(priority: .utility) {
            let http = NativeMediaHTTP(allowedHTTPHosts: request.hosts, timeout: 8)
            defer { http.invalidate(); self.artworkFinished() }
            if let data = try? await http.data(request.url, limit: 2 * 1024 * 1024, ticket: self.ticket), !self.ticket.cancelled {
                request.accept(request.index, request.file, data)
            }
        }
    }
    private func artworkFinished() {
        lock.lock(); pendingArtwork -= 1
        let next = !ticket.cancelled && !deferredArtwork.isEmpty ? deferredArtwork.removeFirst() : nil
        if next != nil { pendingArtwork += 1 }; lock.unlock()
        if let next { startArtwork(next) }
    }
}
