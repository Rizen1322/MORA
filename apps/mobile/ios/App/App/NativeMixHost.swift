import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Native playback plus a cancellable preparation producer, independent of page timers.
/// Engine/file ownership is confined to work; analysis and downloads run off that queue.
final class NativeMixHost {
    private let work = DispatchQueue(label: "ru.mora.native-mix", qos: .userInitiated)
    private let lock = NSLock()
    private var cached: [String: Any] = ["active": false, "playing": false, "index": 0, "position": 0.0, "duration": 0.0]
    var snapshot: [String: Any] { lock.lock(); defer { lock.unlock() }; return cached }
    var active: Bool { snapshot["active"] as? Bool == true }
    private var folder: URL?
    private var id = ""
    private var bytes: [Int: Int] = [:]
    private var config: [String: Any] = [:]
    private var tracks: [[String: Any]] = []
    private var artworks: [MPMediaItemArtwork?] = []
    private var renderer: NativeQueueRenderer?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var format: AVAudioFormat?
    private let makeEngine: () -> AVAudioEngine
    private let preparationScript: String?
    private var engineObserver: NSObjectProtocol?
    private var sessionObservers: [NSObjectProtocol] = []
    private var interrupted = false
    private var mediaResetPending = false
    private var epoch = 0
    private var ownershipRevision = 0
    private var pending = 0
    private var rendered: Int64 = 0
    private var queued: Int64 = 0
    private var completed: Int64 = 0
    private var presented: Int64 = 0
    private var marks: [NativeMixMark] = []
    private var index = 0
    private var position = 0.0
    private var blend: NativeMixBlend?
    private var wantsPlaying = false
    private var resumeAfterInterruption = false
    private var done = false
    private var ended = false
    private var preparing = false
    private var ownsSession = false
    private var failed = false
    private var underruns = 0
    private var maxRenderMs = 0.0
    private var lastLogFrame: Int64 = -1
    private var prunedIndex = -1
    private var newestKey = -1
    private var preparation: NativeQueuePreparation?
    private var analysisWorker = NativeMixAnalysis()
    private var analysisSettings: [String: Any] = [:]
    private var artworkLoader = NativeQueueArtwork()
    private var sourceBytes: [Int: Int] = [:]
    private var pendingUploads: Set<Int> = []
    private var preparedFileKey = 500000
    private var sourceKey = 0
    private var continueWhenPrepared = false
    private var nextWhenPrepared = false
    // Main queue only. Do not remove WebKit's or the baseline probe's targets.
    private var targets: [(MPRemoteCommand, Any)] = []
    private var refillTask: UIBackgroundTaskIdentifier = .invalid // main queue only
    private var refillWaiting = false // one finite assertion per waiting interval
    private enum Failure: Error { case invalid, playback }
    typealias Reply = (Result<[String: Any], Error>) -> Void

    init(makeEngine: @escaping () -> AVAudioEngine = { AVAudioEngine() }, preparationScript: String? = nil) {
        self.makeEngine = makeEngine
        self.preparationScript = preparationScript
        // Observe directly, without a main-queue hop: engine reconfiguration,
        // interruption and unplug intent must be serialized together on work.
        let nc = NotificationCenter.default, session = AVAudioSession.sharedInstance()
        sessionObservers = [
            nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] in self?.interruption($0) },
            nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] in self?.routeChange($0) },
            nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in self?.mediaReset() }
        ]
    }
    deinit {
        for observer in sessionObservers { NotificationCenter.default.removeObserver(observer) }
        if let engineObserver { NotificationCenter.default.removeObserver(engineObserver) }
        preparation?.cancel(); analysisWorker.cancel(); artworkLoader.cancel()
    }

    private var sr: Double { config["sampleRate"] as? Double ?? 48000 }
    private func file(_ key: Int) -> URL? { folder?.appendingPathComponent("\(key).f32le") }
    private static func key(_ track: [String: Any], _ i: Int) -> Int { track["file"] as? Int ?? i }
    private func available(_ index: Int) -> Bool {
        guard tracks.indices.contains(index), let url = file(Self.key(tracks[index], index)),
              let count = tracks[index]["totalFrames"] as? Int else { return false }
        return bytes[Self.key(tracks[index], index)] == count * 8 && FileManager.default.fileExists(atPath: url.path)
    }
    private var canGoBack: Bool { position > 3 ? available(index) : available(index - 1) }
    private var playbackRate: Double { wantsPlaying && !failed ? PlaybackSettings(config["playback"] as? [String: Any]).speed : 0 }
    private func reply(_ completion: @escaping Reply, _ result: Result<[String: Any], Error>) {
        DispatchQueue.main.async { completion(result) }
    }
    private func save() {
        let duration = tracks.indices.contains(index) ? NativeMixTimeline.duration(tracks[index], sampleRate: sr) : 0
        let state: [String: Any] = ["active": folder != nil, "playing": wantsPlaying && !failed,
            "preparing": preparing, "index": index, "position": position, "duration": duration,
            "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "ownership": ownershipRevision, "underruns": underruns, "maxRenderMs": maxRenderMs, "failed": failed,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil, "count": tracks.count, "ended": ended,
            "waitingForPreparation": continueWhenPrepared && ended, "pendingNext": nextWhenPrepared,
            "entryId": tracks.indices.contains(index) ? tracks[index]["entryId"] as? String ?? "" : ""]
        var result = state
        result["stateSavedAt"] = Date().timeIntervalSince1970
        result["stateSavedUptime"] = ProcessInfo.processInfo.systemUptime
        if let blend { result["blend"] = ["index": blend.index, "progress": blend.progress] }
        else { result["blend"] = NSNull() }
        if let preparation { result["preparation"] = preparation.snapshot }
        if tracks.indices.contains(index + 1), let plan = tracks[index + 1]["transition"] as? [String: Any],
           let start = plan["triggerFrame"] as? Double { result["transitionStart"] = start / sr }
        lock.lock(); cached = result; lock.unlock()
    }
    func begin(_ completion: @escaping Reply) {
        work.async {
            do {
                if self.folder != nil { self.reply(completion, .success(["id": self.id])); return }
                let root = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent("MORA/native-mix", isDirectory: true)
                self.id = UUID().uuidString
                let folder = root.appendingPathComponent(self.id, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: NativePreparationFiles.attributes)
                self.folder = folder; self.bytes = [:]; self.sourceBytes = [:]; self.pendingUploads = []; self.preparedFileKey = 500000; self.sourceKey = 0
                self.preparing = true; self.failed = false
                self.ownershipRevision += 1
                self.epoch += 1; self.save()
                self.reply(completion, .success(["id": self.id]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    func append(id: String, track: Int, offset: Int, base64: String, completion: @escaping Reply) {
        work.async {
            do {
                guard self.folder != nil, id == self.id, (0..<1_000_000).contains(track), offset == self.bytes[track, default: 0],
                      base64.count <= 400000, let data = Data(base64Encoded: base64), !data.isEmpty,
                      data.count <= 32768 * 8, data.count % 8 == 0,
                      self.bytes.values.reduce(0, +) + data.count <= 768 * 1024 * 1024, let url = self.file(track) else { throw Failure.invalid }
                if offset == 0 {
                    guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: NativePreparationFiles.attributes) else { throw Failure.invalid }
                    self.pendingUploads.insert(track)
                }
                let file = try FileHandle(forWritingTo: url)
                defer { try? file.close() }
                try file.seekToEnd(); try file.write(contentsOf: data)
                self.bytes[track, default: 0] += data.count
                self.reply(completion, .success([:]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    private func validated(_ tracks: [[String: Any]], from: Int) throws -> [[String: Any]] {
        guard tracks.count + from <= 10_000 else { throw Failure.invalid }
        return try tracks.enumerated().map { offset, track in
            guard let count = track["totalFrames"] as? Int, count > 0, count * 8 == bytes[Self.key(track, from + offset)],
                  let gain = track["gainDb"] as? Double, gain.isFinite, abs(gain) <= 36 else { throw Failure.invalid }
            // Keep encoded images/URLs out of the DSP context, including on seek/skip.
            var copy = track; copy.removeValue(forKey: "artwork"); copy.removeValue(forKey: "coverUrl")
            copy.removeValue(forKey: "artworkHTTPHost"); return copy
        }
    }
    private func artwork(_ track: [String: Any]) -> MPMediaItemArtwork? {
        guard let artwork = track["artwork"] as? [String: Any], let base64 = artwork["base64"] as? String,
              let image = NativeArtworkImage.decode(base64) else { return nil }
        let thumbnail = UIImage(cgImage: image)
        return MPMediaItemArtwork(boundsSize: thumbnail.size) { requested in
            let size = CGSize(width: max(1, min(thumbnail.size.width, requested.width.isFinite ? requested.width : 512)),
                              height: max(1, min(thumbnail.size.height, requested.height.isFinite ? requested.height : 512)))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { _ in
                thumbnail.draw(in: CGRect(origin: .zero, size: size))
            }
        }
    }
    private func requestArtwork(_ track: [String: Any], at: Int) {
        guard track["artwork"] == nil, let text = track["coverUrl"] as? String, let url = URL(string: text) else { return }
        let loader = artworkLoader, file = Self.key(track, at), entry = track["entryId"] as? String
        let hosts = Set([track["artworkHTTPHost"] as? String].compactMap { $0 })
        loader.load(url, hosts: hosts, index: at, file: file) { [weak self] at, file, data in
            self?.work.async { [weak self] in
                guard let self, self.artworkLoader === loader, self.tracks.indices.contains(at),
                      Self.key(self.tracks[at], at) == file, self.tracks[at]["entryId"] as? String == entry else { return }
                self.artworks[at] = self.artwork(["artwork": ["base64": data.base64EncodedString()]])
                if at == self.index { self.publish("artwork") }
            }
        }
    }
    /// Keeps the files of the previous, audible and upcoming tracks; older ones cannot be selected again.
    /// A file uploaded after every queued one may still be on its way into the queue and is kept.
    private func prune() {
        prunedIndex = index
        let keys = tracks.enumerated().map { Self.key($0.element, $0.offset) }
        newestKey = max(newestKey, keys.max() ?? -1)
        let used = Set(keys.enumerated().filter { $0.offset >= index - 1 }.map { $0.element })
        for key in bytes.keys where !used.contains(key) && !pendingUploads.contains(key) {
            if let url = file(key) { try? FileManager.default.removeItem(at: url) }
            bytes.removeValue(forKey: key)
        }
    }
    func start(id: String, config: [String: Any], completion: @escaping Reply) {
        work.async {
            do {
                guard self.folder != nil, id == self.id, let sr = config["sampleRate"] as? Double,
                      [44100.0, 48000.0].contains(sr), let raw = config["tracks"] as? [[String: Any]], !raw.isEmpty,
                      let position = config["position"] as? Double, position.isFinite, position >= 0 else { throw Failure.invalid }
                let start = config["index"] as? Int ?? 0
                guard raw.indices.contains(start), self.engine == nil || sr == self.sr else { throw Failure.invalid }
                let metadata = try self.validated(raw, from: 0)
                self.preparation?.cancel(); self.preparation = nil; self.continueWhenPrepared = false
                self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis(); self.analysisSettings = [:]
                self.artworkLoader.cancel(); self.artworkLoader = NativeQueueArtwork()
                if let folder = self.folder {
                    for key in self.sourceBytes.keys { try? FileManager.default.removeItem(at: folder.appendingPathComponent("source-\(key).media")) }
                    self.sourceBytes.removeAll()
                }
                self.artworks = raw.map { self.artwork($0) }
                self.config = config; self.config["tracks"] = metadata; self.tracks = metadata
                for (i, track) in metadata.enumerated() { self.pendingUploads.remove(Self.key(track, i)) }
                self.mediaResetPending = false
                if self.engine == nil { try self.buildGraph(); self.underruns = 0; self.maxRenderMs = 0 }
                self.preparing = false; self.failed = false
                try self.select(index: start, position: position, playing: config["paused"] as? Bool != true)
                self.prune()
                if self.targets.isEmpty { self.installTargets() }
                self.reply(completion, .success(self.snapshot))
            } catch {
                // Invalid replacement data keeps the queue that is already playing.
                if case Failure.invalid = error, self.engine != nil {} else { self.fail() }
                self.reply(completion, .failure(error))
            }
        }
    }
    func sourceAppend(id: String, key: Int, offset: Int, base64: String, completion: @escaping Reply) {
        work.async {
            do {
                guard id == self.id, let folder = self.folder, (0..<1_000_000).contains(key),
                      offset == self.sourceBytes[key, default: 0], base64.count <= 400000,
                      let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= 262144,
                      offset + data.count <= 128 * 1024 * 1024,
                      self.sourceBytes.values.reduce(0, +) + data.count <= 512 * 1024 * 1024 else { throw Failure.invalid }
                let url = folder.appendingPathComponent("source-\(key).media")
                if offset == 0 { guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: NativePreparationFiles.attributes) else { throw Failure.invalid } }
                let file = try FileHandle(forWritingTo: url); defer { try? file.close() }
                try file.seekToEnd(); try file.write(contentsOf: data); self.sourceBytes[key, default: 0] += data.count
                self.reply(completion, .success([:]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    func reserveSources(id: String, count: Int, completion: @escaping Reply) {
        work.async {
            guard id == self.id, self.folder != nil, count >= 0, count <= 1000, self.sourceKey + count < 500000 else { self.reply(completion, .failure(Failure.invalid)); return }
            let first = self.sourceKey; self.sourceKey += count
            self.reply(completion, .success(["keys": (first..<self.sourceKey).map { $0 }]))
        }
    }
    /// Replaces the known future queue, then native playback callbacks release preparation permits.
    func prepareQueue(id: String, manifest: [String: Any], completion: @escaping Reply) {
        work.async {
            do {
                guard id == self.id, let folder = self.folder, !self.tracks.isEmpty, !self.preparing, !self.failed,
                      let requestedFrom = manifest["from"] as? Int, requestedFrom > 0,
                      let items = manifest["items"] as? [[String: Any]], items.count <= 1000,
                      manifest["previous"] is [String: Any], manifest["settings"] is [String: Any],
                      let scriptURL = Bundle.main.url(forResource: "native-preparation", withExtension: "js", subdirectory: "public") else { throw Failure.invalid }
                let script = try self.preparationScript ?? String(contentsOf: scriptURL, encoding: .utf8)
                for item in items {
                    guard let key = item["file"] as? Int, (0..<1_000_000).contains(key), item["source"] is [String: Any] else { throw Failure.invalid }
                }
                var configuration = manifest, future = items
                var previous = manifest["previous"] as! [String: Any]
                // Address resolution can outlive a blend. Rebase on the track actually heard now.
                if requestedFrom <= self.index {
                    let current = self.tracks[self.index]["entryId"] as? String
                    guard let consumed = future.firstIndex(where: { ($0["entryId"] as? String) == current }) else { throw Failure.invalid }
                    previous = future[consumed]; future.removeFirst(consumed + 1)
                }
                var from = self.index + 1
                while !future.isEmpty, self.tracks.indices.contains(from),
                      future[0]["entryId"] as? String == self.tracks[from]["entryId"] as? String {
                    previous = future.removeFirst(); from += 1
                }
                configuration["from"] = from; configuration["items"] = future; configuration["previous"] = previous
                if !self.done, let renderer = self.renderer, !(try renderer.update(from: from, tracks: [])) { throw Failure.invalid }
                self.preparation?.cancel(keepAnalysis: true)
                let settings = configuration["settings"] as! [String: Any]
                let settingsChanged = !NSDictionary(dictionary: self.analysisSettings).isEqual(to: settings)
                if settingsChanged {
                    self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis(); self.analysisSettings = settings
                }
                let analysis = self.analysisWorker
                self.nextWhenPrepared = false // A replacement manifest owns new navigation intent.
                let referenced = Set((items + (manifest["loopItems"] as? [[String: Any]] ?? [])).compactMap { item -> Int? in
                    guard let source = item["source"] as? [String: Any], source["kind"] as? String == "local" else { return nil }
                    return source["file"] as? Int
                })
                // A replacement owns these source leases; obsolete uploads stop counting
                // against the budget. Repeat/duplicate references keep their shared file.
                for key in self.sourceBytes.keys where !referenced.contains(key) {
                    try? FileManager.default.removeItem(at: folder.appendingPathComponent("source-\(key).media")); self.sourceBytes.removeValue(forKey: key)
                }
                self.tracks = Array(self.tracks.prefix(from)); self.artworks = Array(self.artworks.prefix(from)); self.config["tracks"] = self.tracks
                analysis.retain(Dictionary(uniqueKeysWithValues: self.tracks.enumerated().map { ($0.offset, Self.key($0.element, $0.offset)) }))
                analysis.advance(self.index)
                if settingsChanged {
                    // Retained PCM may need a new plan after changing loudness or
                    // AutoMix settings. Reuse the content cache; do not download again.
                    var a = items.first(where: { $0["entryId"] as? String == self.tracks[self.index]["entryId"] as? String }) ?? (manifest["previous"] as! [String: Any])
                    for at in (self.index + 1)..<from {
                        guard let b = items.first(where: { $0["entryId"] as? String == self.tracks[at]["entryId"] as? String }) else { break }
                        if a["mixingAllowed"] as? Bool == true || b["mixingAllowed"] as? Bool == true {
                            analysis.enqueue(folder: folder, before: a, previousPCM: self.tracks[at - 1], next: b, pcm: self.tracks[at],
                                index: at, script: script, settings: settings,
                                upgrade: { [weak self] at, track in self?.applyAnalysis(analysis, at: at, track: track) },
                                event: { [weak self] _, reason in self?.recordAnalysis(analysis, reason: reason) })
                        }
                        a = b
                    }
                }
                if future.isEmpty && (manifest["loopItems"] as? [[String: Any]] ?? []).isEmpty {
                    self.preparation = nil; self.continueWhenPrepared = false; self.nextWhenPrepared = false; self.prune(); self.publish("handoff"); self.reply(completion, .success(self.viewState())); return
                }
                let job = NativeQueuePreparation(index: self.index, remaining: future.count,
                    loopCount: (manifest["loopItems"] as? [[String: Any]] ?? []).count, analysis: self.analysisWorker); self.preparation = job
                let seed = self.tracks[from - 1]
                self.prune(); self.publish("handoff")
                MoraPlaybackJournal.record("native.preparation.handoff", ["from": from, "count": items.count])
                Task.detached(priority: .utility) { [weak self] in
                    await job.run(folder: folder, manifest: configuration, seed: seed, script: script, allocate: { [weak self] in
                        guard let self else { return nil }
                        return await withCheckedContinuation { continuation in
                            self.work.async {
                                guard self.preparation === job, !job.ticket.cancelled, self.preparedFileKey < 999999 else { continuation.resume(returning: nil); return }
                                self.preparedFileKey += 1; continuation.resume(returning: self.preparedFileKey)
                            }
                        }
                    }, accept: { [weak self] at, track in
                        guard let self else { return false }
                        return await withCheckedContinuation { continuation in
                            self.work.async {
                                guard self.preparation === job, !job.ticket.cancelled, at == self.tracks.count else { continuation.resume(returning: false); return }
                                let key = Self.key(track, at)
                                var appended = false
                                do {
                                    guard let frames = track["totalFrames"] as? Int, let url = self.file(key),
                                          (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) == frames * 8,
                                          self.bytes.values.reduce(0, +) + frames * 8 <= 768 * 1024 * 1024 else { throw Failure.invalid }
                                    self.bytes[key] = frames * 8
                                    let added = try self.validated([track], from: at)
                                    if !self.done, let renderer = self.renderer, !(try renderer.update(from: at, tracks: added)) { throw Failure.invalid }
                                    self.tracks += added; self.config["tracks"] = self.tracks; self.artworks.append(self.artwork(track))
                                    self.requestArtwork(track, at: at)
                                    appended = true
                                    if self.nextWhenPrepared || (self.done && self.ended && self.continueWhenPrepared) {
                                        try self.select(index: at, position: 0, playing: self.wantsPlaying || self.continueWhenPrepared)
                                    }
                                    else { self.publish("prepared") }
                                    self.prune(); continuation.resume(returning: true)
                                } catch {
                                    if appended {
                                        self.fail() // Metadata already owns the file; do not delete it underneath a renderer.
                                        continuation.resume(returning: true); return
                                    }
                                    self.bytes.removeValue(forKey: key)
                                    MoraPlaybackJournal.record("native.preparation.failed", ["reason": "commit"])
                                    continuation.resume(returning: false)
                                }
                            }
                        }
                    }, upgrade: { [weak self] at, track in
                        self?.applyAnalysis(analysis, at: at, track: track)
                    }, event: { [weak self] kind, reason in
                        if kind == "analysis" { self?.recordAnalysis(analysis, reason: reason); return }
                        self?.work.async { [weak self] in
                            guard let self, self.preparation === job else { return }
                            if kind == "finished" && !job.hasRemaining {
                                self.nextWhenPrepared = false
                                if self.ended { self.continueWhenPrepared = false }
                            }
                            if ["ready", "failed", "finished"].contains(kind) { self.publish("preparation") }
                            else { self.save() }
                            var fields: [String: Any] = ["reason": reason]
                            if kind == "analysis" { fields["analysis"] = job.analysis.snapshot }
                            fields["jobId"] = job.snapshot["jobId"]
                            MoraPlaybackJournal.record("native.preparation.\(kind)", fields)
                        }
                    })
                }
                self.reply(completion, .success(self.viewState()))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    private func recordAnalysis(_ worker: NativeMixAnalysis, reason: String) {
        work.async { [weak self] in
            guard let self, self.analysisWorker === worker else { return }
            self.save()
            MoraPlaybackJournal.record("native.preparation.analysis", ["reason": reason, "analysis": worker.snapshot])
        }
    }
    private func applyAnalysis(_ worker: NativeMixAnalysis, at: Int, track: [String: Any]) {
        work.async { [weak self] in
            guard let self, self.analysisWorker === worker, at > self.index, self.tracks.indices.contains(at),
                  track["entryId"] as? String == self.tracks[at]["entryId"] as? String,
                  Self.key(track, at) == Self.key(self.tracks[at], at), self.available(at) else { return }
            do {
                let checked = try self.validated([track], from: at)[0]
                if let renderer = self.renderer {
                    guard try renderer.upgrade(index: at, track: checked) else {
                        MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "pastHorizon"]); return
                    }
                } else if at == self.index + 1,
                          let tr = checked["transition"] as? [String: Any], let trigger = tr["triggerFrame"] as? NSNumber,
                          trigger.doubleValue <= (self.position + 0.35) * self.sr { return }
                self.tracks[at] = checked; self.config["tracks"] = self.tracks
                self.publish("planReady")
                MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "applied"])
            } catch { MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "rejected"]) }
        }
    }
    private func viewState() -> [String: Any] {
        var result = snapshot
        result["analysis"] = analysisWorker.snapshot
        if let preparation { result["preparation"] = preparation.snapshot }
        if tracks.indices.contains(index) { result["currentTrack"] = tracks[index] }
        if tracks.indices.contains(index + 1) { result["nextTrack"] = tracks[index + 1] }
        return result
    }
    func state(_ completion: @escaping Reply) { work.async { self.reply(completion, .success(self.viewState())) } }
    func diagnosticState(_ completion: @escaping Reply) {
        work.async {
            let previous = self.snapshot["stateSavedAt"]
            self.updatePosition(); self.save()
            var value = self.viewState()
            value["lastStateSavedAt"] = previous
            value["snapshotCapturedAt"] = Date().timeIntervalSince1970
            self.reply(completion, .success(value))
        }
    }
    func update(id: String, from: Int, tracks raw: [[String: Any]], completion: @escaping Reply) {
        work.async {
            do {
                guard self.folder != nil, !self.preparing, !self.failed, id == self.id,
                      from > self.index, from <= self.tracks.count else { throw Failure.invalid }
                let added = try self.validated(raw, from: from)
                let next = Array(self.tracks.prefix(from)) + added
                // An exhausted renderer is replaced by select() below.
                if !self.done, let renderer = self.renderer {
                    guard try renderer.update(from: from, tracks: added) else { throw Failure.invalid }
                }
                self.tracks = next; self.config["tracks"] = next
                for (i, track) in added.enumerated() { self.pendingUploads.remove(Self.key(track, from + i)) }
                self.artworks = Array(self.artworks.prefix(from)) + raw.map { self.artwork($0) }
                self.prune()
                MoraPlaybackJournal.record("native.mix.update", ["from": from, "count": next.count])
                if self.done && self.ended && self.tracks.indices.contains(self.index + 1) {
                    try self.select(index: self.index + 1, position: 0, playing: true)
                } else { self.publish("update") }
                self.reply(completion, .success(self.snapshot))
            } catch {
                switch error { case Failure.invalid: break; default: self.fail() }
                self.reply(completion, .failure(error))
            }
        }
    }
    /// Speed/pitch, tone and volume change live and carry over to later selects.
    func settings(_ values: [String: Any], completion: @escaping Reply) {
        work.async {
            for key in ["tone", "preDb", "playback", "volume"] { if let value = values[key] { self.config[key] = value } }
            self.renderer?.apply(values)
            self.publish("settings")
            self.reply(completion, .success(self.snapshot))
        }
    }
    private func select(index: Int, position: Double, playing: Bool) throws {
        // Reject unavailable navigation before stopping the audible graph.
        guard available(index) else { throw Failure.invalid }
        if engine == nil && playing && !interrupted && !mediaResetPending { try buildGraph() }
        epoch += 1; wantsPlaying = false
        player?.stop(); engine?.pause()
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); done = false; ended = false
        lastLogFrame = -1
        self.index = index; self.position = position; self.blend = nil; self.nextWhenPrepared = false; self.continueWhenPrepared = false
        var next = config; next["index"] = index; next["position"] = position
        guard let folder else { throw Failure.invalid }
        renderer = try NativeQueueRenderer(folder: folder, config: next)
        wantsPlaying = playing
        if engine != nil { try fill() }
        if playing { try engine?.start(); player?.play() }
        publish("select")
    }
    private func fill() throws {
        guard let renderer, let format, let player else { throw Failure.playback }
        let generation = epoch
        while pending < 8 && !done {
            let began = ProcessInfo.processInfo.systemUptime
            let block = try autoreleasepool { try renderer.render() }
            maxRenderMs = max(maxRenderMs, (ProcessInfo.processInfo.systemUptime - began) * 1000)
            for event in block.events {
                MoraPlaybackJournal.record("native.mix.renderEvent", ["kind": event["type"] as? String ?? "unknown",
                    "reason": event["reason"] as? String ?? "none", "late": event["late"] as? Bool ?? false, "clock": rendered])
            }
            done = block.done
            guard block.frames > 0 else { break }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(block.frames)),
                  let channels = buffer.floatChannelData else { throw Failure.playback }
            buffer.frameLength = AVAudioFrameCount(block.frames)
            block.left.withUnsafeBytes { if let base = $0.baseAddress { memcpy(channels[0], base, $0.count) } }
            block.right.withUnsafeBytes { if let base = $0.baseAddress { memcpy(channels[1], base, $0.count) } }
            marks.append(contentsOf: block.marks.map { NativeMixMark(frame: rendered + $0.frame, index: $0.index, position: $0.position, blend: $0.blend) })
            rendered += Int64(block.frames)
            let end = rendered
            pending += 1; queued = rendered
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                self?.work.async { [weak self] in self?.played(generation: generation, end: end) }
            }
        }
    }
    private func played(generation: Int, end: Int64) {
        guard generation == epoch, folder != nil, !failed else { return }
        // A configuration change can flush scheduled buffers. Those callbacks
        // are not evidence of audible progress; the observer restores from the
        // last heard position and invalidates this epoch.
        if engine?.isRunning != true { return }
        pending = max(0, pending - 1); completed = max(completed, end)
        updatePosition()
        if wantsPlaying {
            if pending == 0 && !done { underruns += 1; MoraPlaybackJournal.record("native.mix.starved") }
            do { try fill() } catch { fail(); return }
            if done && pending == 0 {
                // The page appended a track after the renderer finished: continue without a blend.
                if tracks.indices.contains(index + 1) { do { try select(index: index + 1, position: 0, playing: true) } catch { fail() }; return }
                continueWhenPrepared = preparation?.hasRemaining == true
                wantsPlaying = false; ended = true; player?.pause(); engine?.pause(); publish("ended"); return
            }
        }
        if presented - lastLogFrame >= Int64(sr / 2) { publish("tick"); lastLogFrame = presented }
        else { save() }
        // Keep the predecessor for interpolation; storage stays bounded by scheduled audio.
        if let keep = marks.lastIndex(where: { $0.frame < completed - 4096 }), keep > 0 { marks.removeFirst(keep) }
    }
    private func updatePosition() {
        var audible = completed
        if let player, let time = player.lastRenderTime, let played = player.playerTime(forNodeTime: time) {
            // Estimate between dataPlayedBack checkpoints; completion accounts for device latency.
            let estimated = played.sampleTime - Int64(AVAudioSession.sharedInstance().outputLatency * sr)
            audible = max(completed, estimated)
        }
        presented = max(presented, min(queued, max(0, audible)))
        guard let at = marks.lastIndex(where: { $0.frame <= presented }) else { return }
        let a = marks[at]; index = a.index; position = a.position; blend = a.blend
        if at + 1 < marks.count {
            let b = marks[at + 1]
            if b.index == a.index && b.frame > a.frame {
                position += (b.position - a.position) * Double(presented - a.frame) / Double(b.frame - a.frame)
            }
            if let from = a.blend, let to = b.blend, from.index == to.index, b.frame > a.frame {
                blend = NativeMixBlend(index: from.index, progress: from.progress + (to.progress - from.progress) * Double(presented - a.frame) / Double(b.frame - a.frame))
            }
        }
        position = max(0, min(position, NativeMixTimeline.duration(tracks[index], sampleRate: sr)))
    }
    private func publish(_ reason: String) {
        updatePosition()
        analysisWorker.retain(Dictionary(uniqueKeysWithValues: tracks.enumerated().map { ($0.offset, Self.key($0.element, $0.offset)) }))
        analysisWorker.advance(index); save()
        preparation?.gate.advance(index)
        if index != prunedIndex { prune() }
        let state = snapshot, generation = epoch
        let title = tracks.indices.contains(index) ? tracks[index]["title"] as? String ?? "MORA" : "MORA"
        let artist = tracks.indices.contains(index) ? tracks[index]["artist"] as? String ?? "" : ""
        var info: [String: Any] = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPersistentID: NSNumber(value: index + 1), MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position, MPNowPlayingInfoPropertyPlaybackRate: playbackRate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0, MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index, MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count]
        if artworks.indices.contains(index), let artwork = artworks[index] { info[MPMediaItemPropertyArtwork] = artwork }
        let publishedInfo = info
        let canAdvance = tracks.indices.contains(index + 1) || preparation?.hasRemaining == true
        let canReverse = canGoBack
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
            self.refillLease(waiting: state["waitingForPreparation"] as? Bool == true)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = publishedInfo
            MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled = canAdvance
            MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled = canReverse
        }
        let prep = state["preparation"] as? [String: Any] ?? [:]
        MoraPlaybackJournal.record("native.mix.state", ["reason": reason, "seq": index, "position": position, "duration": state["duration"] ?? 0,
            "playing": wantsPlaying, "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "maxRenderMs": maxRenderMs, "underruns": underruns,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil,
            "preparation": prep["state"] ?? "none", "ready": prep["ready"] ?? 0, "remaining": prep["remaining"] ?? 0,
            "gateUpper": prep["gateUpper"] ?? -1, "gateWaiting": prep["gateWaiting"] ?? -1, "stageSeconds": prep["stageSeconds"] ?? 0])
    }
    private func fail() {
        preparation?.cancel(); preparation = nil; continueWhenPrepared = false; nextWhenPrepared = false
        wantsPlaying = false; failed = true; epoch += 1
        player?.stop(); engine?.pause(); renderer = nil
        save(); MoraPlaybackJournal.record("native.mix.failed")
        let generation = epoch
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }
    }
    func command(_ action: String, time: Double? = nil, source: String, id commandId: String? = nil,
                 owner: Int? = nil, completion: @escaping Reply) {
        work.async {
            let id = commandId ?? UUID().uuidString
            MoraPlaybackJournal.record("native.mix.command", ["id": id, "action": action, "source": source])
            do {
                guard self.folder != nil, !self.preparing, !self.failed else { throw Failure.invalid }
                if source == "interruption" && self.mediaResetPending { throw Failure.invalid }
                if let owner, owner != self.ownershipRevision { throw Failure.invalid }
                self.updatePosition()
                if source != "interruption" { self.resumeAfterInterruption = false }
                switch action {
                case "pause": self.continueWhenPrepared = false; self.wantsPlaying = false; self.player?.pause(); self.engine?.pause()
                case "play", "toggle":
                    if action == "toggle" && self.wantsPlaying {
                        self.continueWhenPrepared = false
                        self.wantsPlaying = false; self.player?.pause(); self.engine?.pause()
                    } else {
                        let wasPlaying = self.wantsPlaying
                        try AVAudioSession.sharedInstance().setActive(true)
                        self.mediaResetPending = false
                        if self.engine == nil {
                            try self.buildGraph()
                            let at = self.ended && self.tracks.indices.contains(self.index + 1) ? self.index + 1 : self.index
                            try self.select(index: at, position: self.ended ? 0 : self.position, playing: true)
                            break
                        }
                        if self.done && self.pending == 0 {
                            if self.tracks.indices.contains(self.index + 1) { try self.select(index: self.index + 1, position: 0, playing: true) }
                            else if self.preparation?.hasRemaining == true {
                                self.continueWhenPrepared = true; self.wantsPlaying = false
                            } else { try self.select(index: self.index, position: 0, playing: true) }
                        }
                        else if !wasPlaying { try self.select(index: self.index, position: self.position, playing: true) }
                        else { self.wantsPlaying = true; try self.fill(); try self.engine?.start(); self.player?.play() }
                    }
                case "nexttrack":
                    if self.tracks.indices.contains(self.index + 1) {
                        try self.select(index: self.index + 1, position: 0, playing: self.wantsPlaying || self.continueWhenPrepared)
                    } else if self.preparation?.hasRemaining == true {
                        // Keep the current audible track running until its replacement is ready.
                        // Stopping the engine here could suspend preparation in the background.
                        self.nextWhenPrepared = true
                        self.preparation?.gate.advance(self.index + 1)
                    } else { throw Failure.invalid }
                case "previoustrack":
                    let previous = self.position > 3 ? self.index : self.index - 1
                    guard self.available(previous) else { throw Failure.invalid }
                    try self.select(index: previous, position: 0, playing: self.wantsPlaying)
                case "seekto":
                    guard let time, time.isFinite else { throw Failure.invalid }
                    let duration = NativeMixTimeline.duration(self.tracks[self.index], sampleRate: self.sr)
                    try self.select(index: self.index, position: max(0, min(max(0, duration - 0.001), time)), playing: self.wantsPlaying)
                default: throw Failure.invalid
                }
                self.publish(action)
                MoraPlaybackJournal.record("native.mix.applied", ["id": id, "outcome": "accepted"])
                self.reply(completion, .success(self.snapshot))
            } catch {
                // Invalid commands do not destroy playback; renderer failures must not resume stale buffers.
                switch error { case Failure.invalid: break; default: self.fail() }
                MoraPlaybackJournal.record("native.mix.applied", ["id": id, "outcome": "rejected"])
                self.reply(completion, .failure(error))
            }
        }
    }
    private func installTargets() {
        let generation = epoch
        let owner = ownershipRevision
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
            let c = MPRemoteCommandCenter.shared()
            c.skipForwardCommand.isEnabled = false; c.skipBackwardCommand.isEnabled = false
            c.seekForwardCommand.isEnabled = false; c.seekBackwardCommand.isEnabled = false
            let bindings: [(MPRemoteCommand, String)] = [(c.playCommand, "play"), (c.pauseCommand, "pause"), (c.togglePlayPauseCommand, "toggle"),
                (c.nextTrackCommand, "nexttrack"), (c.previousTrackCommand, "previoustrack"), (c.changePlaybackPositionCommand, "seekto")]
            for (command, action) in bindings {
                if action != "nexttrack" && action != "previoustrack" { command.isEnabled = true }
                let target = command.addTarget { [weak self] event in
                    guard let self, self.active, self.snapshot["ownership"] as? Int == owner else { return .commandFailed }
                    let time = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                    let id = UUID().uuidString
                    MoraPlaybackJournal.record("native.mix.callback", ["id": id, "action": action, "seekTime": time ?? -1])
                    self.command(action, time: time, source: "remote", id: id, owner: owner) { _ in }
                    return .success
                }
                self.targets.append((command, target))
            }
        }
    }
    func stop(_ completion: @escaping Reply) {
        work.async {
            self.preparation?.cancel(); self.preparation = nil; self.continueWhenPrepared = false; self.nextWhenPrepared = false
            self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis()
            self.artworkLoader.cancel(); self.artworkLoader = NativeQueueArtwork()
            DispatchQueue.main.async { [weak self] in self?.refillLease(waiting: false) }
            guard self.folder != nil || self.ownsSession else { self.reply(completion, .success(self.snapshot)); return }
            self.epoch += 1; self.wantsPlaying = false; self.resumeAfterInterruption = false
            self.discardGraph(); self.interrupted = false; self.mediaResetPending = false
            do {
                if self.ownsSession { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); self.ownsSession = false }
                // folder is created only under our private cache with a native-generated UUID.
                if let folder = self.folder { try? FileManager.default.removeItem(at: folder) }
                self.folder = nil; self.preparing = false; self.engine = nil; self.player = nil; self.bytes = [:]; self.newestKey = -1
                self.marks.removeAll(); self.artworks.removeAll(); self.tracks.removeAll(); self.config = [:]; self.save()
                DispatchQueue.main.async {
                    for (command, target) in self.targets { command.isEnabled = false; command.removeTarget(target) }
                    self.targets.removeAll(); MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
                    MoraPlaybackJournal.record("native.mix.stop"); completion(.success(self.snapshot))
                }
            } catch { self.save(); self.reply(completion, .failure(error)) }
        }
    }
    func interruption(_ notification: Notification) {
        let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
        let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
        work.async {
            guard self.folder != nil, !self.tracks.isEmpty else { return }
            if type == AVAudioSession.InterruptionType.began.rawValue {
                self.interrupted = true
                self.resumeAfterInterruption = self.wantsPlaying || self.continueWhenPrepared; self.wantsPlaying = false; self.continueWhenPrepared = false
                self.player?.pause(); self.engine?.pause(); self.publish("interruption")
            } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                self.interrupted = false
                let resume = !self.mediaResetPending && self.resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
                self.resumeAfterInterruption = false
                if resume { self.command("play", source: "interruption") { _ in } }
            }
        }
    }
    func routeChange(_ notification: Notification) {
        let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
        if active && reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { command("pause", source: "route") { _ in } }
    }
    func mediaReset() {
        work.async {
            guard self.folder != nil, !self.tracks.isEmpty else { return }
            self.wantsPlaying = false; self.resumeAfterInterruption = false; self.interrupted = false
            self.continueWhenPrepared = false; self.nextWhenPrepared = false; self.mediaResetPending = true
            self.discardGraph(); self.ownsSession = false
            self.publish("mediaReset") // Preserve the queue; only a subsequent user Play activates audio.
        }
    }
    /// A short, best-effort window for a download already in progress at EOF.
    /// It does not keep silent audio running or promise an iOS execution quota.
    private func refillLease(waiting: Bool) {
        if !waiting { refillWaiting = false; endRefillLease(); return }
        guard !refillWaiting else { return }; refillWaiting = true
        refillTask = UIApplication.shared.beginBackgroundTask(withName: "MORA finish next audio") { [weak self] in self?.endRefillLease() }
        let task = refillTask
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.refillTask == task else { return }; self.endRefillLease()
        }
    }
    private func endRefillLease() {
        guard refillTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(refillTask); refillTask = .invalid
    }
    private func buildGraph() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true); ownsSession = true
        format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)
        let engine = makeEngine(), player = AVAudioPlayerNode()
        self.engine = engine; self.player = player
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self, weak engine] _ in
            guard let engine else { return }; self?.configurationChanged(engine)
        }
    }
    private func discardGraph() {
        epoch += 1
        if let engineObserver { NotificationCenter.default.removeObserver(engineObserver); self.engineObserver = nil }
        player?.stop(); engine?.stop(); renderer = nil; player = nil; engine = nil; format = nil
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); blend = nil
        // Completion belongs to the queue, not the discarded graph. Preserve it
        // while an ended track waits for the producer to deliver its successor.
        lastLogFrame = -1
    }
    private func configurationChanged(_ changed: AVAudioEngine) {
        work.async {
            guard self.folder != nil, self.engine === changed, !changed.isRunning else { return }
            self.discardGraph()
            self.publish("configuration")
            let generation = self.epoch
            // Coalesce related route/interruption notifications before deciding
            // whether playback is still wanted. Unplug/Pause always wins.
            self.work.asyncAfter(deadline: .now() + 0.05) {
                guard self.epoch == generation, self.wantsPlaying, !self.interrupted, !self.mediaResetPending else { return }
                do {
                    let pendingNext = self.nextWhenPrepared
                    try self.select(index: self.index, position: self.position, playing: true)
                    self.nextWhenPrepared = pendingNext; self.publish("configurationRecovered")
                }
                catch { self.fail() }
            }
        }
    }
}
