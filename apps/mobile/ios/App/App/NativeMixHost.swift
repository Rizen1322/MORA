import Accelerate
import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Native playback plus a cancellable preparation producer, independent of page timers.
/// Engine/file ownership is confined to work; analysis and downloads run off that queue.
final class NativeMixHost {
    static let shared = NativeMixHost()
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
    private var outputBufferCount = 5
    private var outputLatency = 0.0
    private var lastLogFrame: Int64 = -1
    private var nowPlaying: (key: String, position: Double, rate: Double, at: Double, row: Double)?
    private var prunedIndex = -1
    private var newestKey = -1
    private var preparation: NativeQueuePreparation?
    private var analysisWorker = NativeMixAnalysis()
    private var analysisSettings: [String: Any] = [:]
    /// The bundled planning script, kept for re-planning after a growing start.
    private var analysisScript = ""
    private var analysisPolicies: [String: Bool] = [:]
    private var artworkLoader = NativeQueueArtwork()
    private var sourceBytes: [Int: Int] = [:]
    private var sourceLinks: [URL: Int] = [:]
    private var pendingUploads: Set<Int> = []
    // Songs playing while they still decode, by file key: their downloads stop when the file is dropped.
    private var growing: [Int: NativePreparationTicket] = [:]
    private var preparedFileKey = 500000
    private var sourceKey = 0
    private var continueWhenPrepared = false
    // Absolute index that waiting Next presses aim for; a crossfade into the next song keeps it.
    private var skipTarget = -1
    private var pendingSkips: Int { max(0, skipTarget - index) }
    private var initialTicket: NativePreparationTicket?
    private var knownManifest: [String: Any]?
    private var identityAliases: [String: String] = [:]
    private var initialConfig: [String: Any] = [:]
    // Main queue only. Do not remove WebKit's or the baseline probe's targets.
    var onReaction: ((String, Int) -> Int)?
    var reactionState: ((String) -> Int)?
    private var controlRevision = 0
    private var targets: [(MPRemoteCommand, Any)] = []
    private var refillTask: UIBackgroundTaskIdentifier = .invalid // main queue only
    private var refillWaiting = false // one finite assertion per waiting interval
    // Levels for the page visualizer: computed only while the page listens, in the foreground and while playing.
    var onLevels: ((Double, [Double]) -> Void)? // called on work; the plugin hops to main
    var onNowPlaying: (@MainActor ([String: Any], Bool) -> Void)?
    private var levelsOn = false, foreground = true
    private var levelBlocks: [(start: Int64, left: Data, right: Data)] = [] // rendered blocks still near the audible frame
    private var levelTimer: DispatchSourceTimer?
    private lazy var levelMeter = NativeLevelMeter()
    private var levelObservers: [NSObjectProtocol] = []
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
        for observer in levelObservers { NotificationCenter.default.removeObserver(observer) }
        levelTimer?.cancel()
        initialTicket?.cancel(); preparation?.cancel(); analysisWorker.cancel(); artworkLoader.cancel()
    }

    private var sr: Double { config["sampleRate"] as? Double ?? 48000 }
    private var presentationDelay: Double {
        let delay = max(AVAudioSession.sharedInstance().outputLatency, player?.outputPresentationLatency ?? 0)
        return delay.isFinite ? max(0, min(8, delay)) : 0
    }
    private func file(_ key: Int) -> URL? { folder?.appendingPathComponent("\(key).f32le") }
    private static func key(_ track: [String: Any], _ i: Int) -> Int { track["file"] as? Int ?? i }
    private func available(_ index: Int) -> Bool {
        guard tracks.indices.contains(index), let url = file(Self.key(tracks[index], index)),
              let count = tracks[index]["totalFrames"] as? Int else { return false }
        return bytes[Self.key(tracks[index], index)] == count * 8 && FileManager.default.fileExists(atPath: url.path)
    }
    private var canGoBack: Bool { position > 3 ? available(index) : available(index - 1) }
    private var hasMoreQueue: Bool {
        guard tracks.indices.contains(index),
              knownManifest?["queueEntryId"] as? String == tracks[index]["entryId"] as? String else { return false }
        return knownManifest?["queueHasMore"] as? Bool == true || knownManifest?["queueWraps"] as? Bool == true
    }
    private var playbackRate: Double { wantsPlaying && !failed ? PlaybackSettings(config["playback"] as? [String: Any]).speed : 0 }
    private func reply(_ completion: @escaping Reply, _ result: Result<[String: Any], Error>) {
        DispatchQueue.main.async { completion(result) }
    }
    private func save() {
        let duration = tracks.indices.contains(index) ? NativeMixTimeline.duration(tracks[index], sampleRate: sr) : 0
        let state: [String: Any] = ["active": folder != nil, "playing": wantsPlaying && !failed,
            "preparing": preparing, "controlRevision": controlRevision, "index": index, "position": position, "duration": duration,
            "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "ownership": ownershipRevision, "underruns": underruns, "maxRenderMs": maxRenderMs, "failed": failed,
            "outputBufferCount": outputBufferCount, "outputLatency": outputLatency,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil, "count": tracks.count, "ended": ended,
            "waitingForPreparation": continueWhenPrepared && ended, "pendingSkips": pendingSkips,
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
    static func cleanupOrphanedSessions(keeping activeId: String? = nil) {
        guard let root = try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
            .appendingPathComponent("MORA/native-mix", isDirectory: true),
              let items = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return }
        for url in items where url.lastPathComponent != activeId {
            try? FileManager.default.removeItem(at: url)
        }
    }

    func begin(_ completion: @escaping Reply) {
        work.async {
            do {
                if self.folder != nil { self.reply(completion, .success(["id": self.id, "hasQueue": !self.tracks.isEmpty])); return }
                let root = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent("MORA/native-mix", isDirectory: true)
                self.id = UUID().uuidString
                let folder = root.appendingPathComponent(self.id, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: NativePreparationFiles.attributes)
                Self.cleanupOrphanedSessions(keeping: self.id)
                self.folder = folder; self.bytes = [:]; self.sourceBytes = [:]; self.sourceLinks = [:]; self.pendingUploads = []; self.preparedFileKey = 500000; self.sourceKey = 0
                self.preparing = true; self.failed = false
                self.knownManifest = nil; self.ownershipRevision += 1
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
            if let id = copy["trackId"] as? String, let next = identityAliases[id] { copy["trackId"] = next }
            copy.removeValue(forKey: "artworkHTTPHost"); copy.removeValue(forKey: "_analysisPolicy"); return copy
        }
    }
    private func artwork(_ track: [String: Any]) -> MPMediaItemArtwork? {
        guard let artwork = track["artwork"] as? [String: Any], let base64 = artwork["base64"] as? String else { return nil }
        return Self.artwork(NativeArtworkImage.decode(base64))
    }
    private static func artwork(_ image: CGImage?) -> MPMediaItemArtwork? {
        guard let image else { return nil }
        let thumbnail = UIImage(cgImage: image)
        return MPMediaItemArtwork(boundsSize: thumbnail.size) { requested in
            let size = CGSize(width: max(1, min(thumbnail.size.width, requested.width.isFinite ? requested.width : 512)),
                              height: max(1, min(thumbnail.size.height, requested.height.isFinite ? requested.height : 512)))
            if size == thumbnail.size { return thumbnail } // no redraw per lock-screen request
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
            // Decode on the loader's utility task, not on the render queue.
            let artwork = Self.artwork(NativeArtworkImage.decode(data))
            self?.work.async { [weak self] in
                guard let self, self.artworkLoader === loader, self.tracks.indices.contains(at),
                      Self.key(self.tracks[at], at) == file, self.tracks[at]["entryId"] as? String == entry else { return }
                self.artworks[at] = artwork
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
            bytes.removeValue(forKey: key); growing.removeValue(forKey: key)?.cancel()
        }
    }
    /// More PCM of a song that started while decoding; final fixes its length (and duration).
    private func grow(key: Int, frames: Int, final: Bool) {
        work.async { [weak self] in
            guard let self, self.growing[key] != nil else { return }
            if final { self.growing.removeValue(forKey: key) }
            guard let at = self.tracks.indices.first(where: { Self.key(self.tracks[$0], $0) == key }),
                  frames >= self.tracks[at]["totalFrames"] as? Int ?? 0 else { return }
            self.bytes[key] = frames * 8; self.tracks[at]["totalFrames"] = frames
            if final { self.tracks[at].removeValue(forKey: "growing"); self.tracks[at].removeValue(forKey: "estimatedFrames") }
            self.config["tracks"] = self.tracks
            self.renderer?.grow(file: key, frames: frames, final: final)
            if final {
                self.publish("grown"); MoraPlaybackJournal.record("native.preparation.grown", ["seq": at, "frames": frames])
                if at == self.index { self.replanAfterGrowth() }
            }
        }
    }
    /// A growing start hands the first future song over before the seed PCM is final: planning was skipped,
    /// so the first transition stayed the reserve crossfade. With the finished seed, plan it again.
    private func replanAfterGrowth(reason: String = "grownSeed") {
        guard let folder, tracks.indices.contains(index + 1), let manifest = knownManifest,
              !analysisScript.isEmpty, !analysisSettings.isEmpty else { return }
        let current = tracks[index], next = tracks[index + 1]
        guard current["growing"] as? Bool != true, next["growing"] as? Bool != true, available(index + 1) else { return }
        let plan = next["plan"] as? [String: Any] ?? [:]
        guard next["transition"] == nil || plan["method"] as? String == "fallback_crossfade" else { return }
        guard let entry = next["entryId"] as? String,
              let item = (manifest["items"] as? [[String: Any]])?.first(where: { $0["entryId"] as? String == entry }),
              let nextFile = next["file"] as? Int, file(nextFile) != nil,
              let seedFile = current["file"] as? Int, file(seedFile) != nil else { return }
        let at = index + 1
        var before = manifest["previous"] as? [String: Any] ?? [:]
        let seedId = current["trackId"] ?? before["trackId"] ?? ""
        before["id"] = seedId
        before["trackId"] = seedId
        if let seedEntry = current["entryId"] as? String, !seedEntry.isEmpty {
            before["entryId"] = seedEntry
            if let policy = analysisPolicies[seedEntry] { before["mixingAllowed"] = policy }
        }
        before["duration"] = Double(current["totalFrames"] as? Int ?? 0) / sr
        if before["mixingAllowed"] == nil { before["mixingAllowed"] = true }
        var nextItem = item
        nextItem["id"] = item["trackId"] ?? next["trackId"] ?? ""
        nextItem["duration"] = Double(next["totalFrames"] as? Int ?? 0) / sr
        guard before["mixingAllowed"] as? Bool == true || nextItem["mixingAllowed"] as? Bool == true else { return }
        let worker = analysisWorker
        worker.retain(Dictionary(uniqueKeysWithValues: tracks.enumerated().map { ($0.offset, Self.key($0.element, $0.offset)) }))
        worker.enqueue(folder: folder, before: before, previousPCM: current, next: nextItem, pcm: next, index: at,
                       script: analysisScript, settings: analysisSettings,
                       upgrade: { [weak self] at, track in self?.applyAnalysis(worker, at: at, track: track) },
                       event: { [weak self] _, reason in self?.recordAnalysis(worker, reason: reason) })
        MoraPlaybackJournal.record("native.preparation.replan", ["seq": at, "reason": reason])
    }
    func start(id: String, config: [String: Any], completion: @escaping Reply) {
        work.async { self.startOnQueue(id: id, config: config, completion: completion) }
    }
    private func startOnQueue(id: String, config: [String: Any], completion: @escaping Reply) {
            do {
                guard self.folder != nil, id == self.id, let sr = config["sampleRate"] as? Double,
                      [44100.0, 48000.0].contains(sr), let raw = config["tracks"] as? [[String: Any]], !raw.isEmpty,
                      let position = config["position"] as? Double, position.isFinite, position >= 0 else { throw Failure.invalid }
                let start = config["index"] as? Int ?? 0
                guard raw.indices.contains(start), self.engine == nil || sr == self.sr else { throw Failure.invalid }
                let metadata = try self.validated(raw, from: 0)
                self.initialTicket?.cancel(); self.initialTicket = nil; self.initialConfig = [:]; self.knownManifest = nil
                self.preparation?.cancel(); self.preparation = nil; self.continueWhenPrepared = false
                self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis(); self.analysisSettings = [:]; self.analysisPolicies = [:]
                self.artworkLoader.cancel(); self.artworkLoader = NativeQueueArtwork()
                if let folder = self.folder {
                    for key in self.sourceBytes.keys { try? FileManager.default.removeItem(at: folder.appendingPathComponent("source-\(key).media")) }
                    self.sourceBytes.removeAll(); self.sourceLinks.removeAll()
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
                self.reply(completion, .success(self.viewState()))
            } catch {
                // Invalid replacement data keeps the queue that is already playing.
                if case Failure.invalid = error, self.engine != nil {} else { self.fail() }
                self.reply(completion, .failure(error))
            }
    }
    /// The first song follows the same native loader/decoder as the future queue.
    /// No page callback is needed between download completion and audio start.
    func prepareStart(id: String, item: [String: Any], config: [String: Any], networkTimeout: TimeInterval? = nil, completion: @escaping Reply) {
        work.async {
            let gain = config["gainDb"] as? Double ?? 0
            guard id == self.id, let folder = self.folder,
                  config["sampleRate"] as? Double == 48000,
                  let position = config["position"] as? Double, position.isFinite, position >= 0,
                  let trackId = item["trackId"] as? String, !trackId.isEmpty,
                  let entryId = item["entryId"] as? String, !entryId.isEmpty,
                  let allowed = item["mixingAllowed"] as? Bool,
                  let source = item["source"] as? [String: Any], gain.isFinite, abs(gain) <= 36,
                  config["gainDb"] == nil || config["gainDb"] is Double, self.preparedFileKey < 999999 else {
                self.reply(completion, .failure(Failure.invalid)); return
            }
            NativeStationFiles.retainLocal(item, folder: folder)
            self.initialTicket?.cancel()
            let ticket = NativePreparationTicket(); self.initialTicket = ticket; self.initialConfig = config
            self.preparedFileKey += 1; let key = self.preparedFileKey
            let downloaded = folder.appendingPathComponent("\(UUID().uuidString).media")
            let pcm = folder.appendingPathComponent("\(key).f32le")
            let allowedHost = source["allowHTTP"] as? Bool == true ? (source["url"] as? String).flatMap { URL(string: $0)?.host } : nil
            let hosts = Set([allowedHost].compactMap { $0 })
            let replyOnce: Reply = {
                let lock = NSLock()
                var sent = false
                return { result in
                    lock.lock(); let first = !sent; sent = true; lock.unlock()
                    if first { completion(result) }
                }
            }()
            if let networkTimeout, !["local", "station"].contains(source["kind"] as? String ?? "") {
                self.work.asyncAfter(deadline: .now() + networkTimeout) { [weak self] in
                    guard let self, self.initialTicket === ticket else { return }
                    ticket.cancel()
                    self.initialTicket = nil; self.initialConfig = [:]
                    self.reply(replyOnce, .failure(NativeMediaHTTP.Failure.transport(URLError.timedOut.rawValue)))
                }
            }
            Task.detached(priority: .userInitiated) { [weak self] in
                let ownedHTTP = hosts.isEmpty ? nil : NativeMediaHTTP(allowedHTTPHosts: hosts)
                let http = ownedHTTP ?? NativeMediaHTTP.sharedHTTPS
                defer { ownedHTTP?.invalidate(); try? FileManager.default.removeItem(at: downloaded) }
                // On work: starts the prepared song; early starts it while it still decodes (it then grows).
                let begin: @Sendable (Int, Bool) -> Bool = { [weak self] frames, early in
                    guard let self else { return false }
                    let estimate = early ? NativeMixTimeline.estimatedFrames(item, decoded: frames) : frames
                    guard self.initialTicket === ticket, !ticket.cancelled, self.id == id, self.folder == folder,
                          frames > 0, estimate <= Int.max / 8,
                          self.bytes.values.reduce(0, +) + estimate * 8 <= 768 * 1024 * 1024 else {
                        if early { return false } // the finished file decides
                        try? FileManager.default.removeItem(at: pcm)
                        if self.initialTicket === ticket { self.initialTicket = nil; self.initialConfig = [:] }
                        self.reply(replyOnce, .failure(Failure.invalid)); return false
                    }
                    var next = self.initialConfig
                    if next["paused"] as? Bool != true {
                        // Explicit user tap to play clears stale interruption/reset flags.
                        self.interrupted = false; self.mediaResetPending = false
                    }
                    next["paused"] = next["paused"] as? Bool == true || self.interrupted || self.mediaResetPending
                    var track: [String: Any] = ["file": key, "totalFrames": frames, "gainDb": allowed ? next["gainDb"] as? Double ?? 0.0 : 0.0,
                        "trackId": trackId, "entryId": entryId, "title": item["title"] ?? "", "artist": item["artist"] ?? ""]
                    if early { track["growing"] = true; track["estimatedFrames"] = estimate }
                    if let artwork = item["artwork"] { track["artwork"] = artwork }
                    let previous = self.tracks.indices.contains(self.index) && self.available(self.index)
                        && self.tracks[self.index]["entryId"] as? String != entryId ? self.tracks[self.index] : nil
                    let oldArtwork = self.artworks.indices.contains(self.index) ? self.artworks[self.index] : nil
                    self.bytes[key] = frames * 8; self.pendingUploads.insert(key)
                    next["tracks"] = (previous.map { [$0] } ?? []) + [track]; next["index"] = previous == nil ? 0 : 1
                    self.initialTicket = nil; self.initialConfig = [:]
                    if early { self.growing[key] = ticket }
                    self.startOnQueue(id: id, config: next, completion: replyOnce)
                    if !self.failed, self.tracks.indices.contains(self.index), Self.key(self.tracks[self.index], self.index) == key {
                        if previous != nil { self.artworks[0] = oldArtwork }
                        var artworkTrack = track
                        if let cover = item["coverUrl"] { artworkTrack["coverUrl"] = cover }
                        if let host = URL(string: item["coverUrl"] as? String ?? "")?.host, hosts.contains(host) { artworkTrack["artworkHTTPHost"] = host }
                        self.requestArtwork(artworkTrack, at: self.index)
                        return true
                    } else if !self.tracks.enumerated().contains(where: { Self.key($0.element, $0.offset) == key }) {
                        self.bytes.removeValue(forKey: key); self.pendingUploads.remove(key); self.growing.removeValue(forKey: key)
                        try? FileManager.default.removeItem(at: pcm)
                    }
                    return false
                }
                do {
                    let (frames, owned) = try await NativeQueuePreparation.produce(source, loader: NativeMediaLoader(http: http),
                        folder: folder, downloaded: downloaded, pcm: pcm, ticket: ticket, early: { frames in
                            guard let self else { return false }
                            return await withCheckedContinuation { continuation in
                                self.work.async { continuation.resume(returning: begin(frames, true)) }
                            }
                        }, grow: { [weak self] frames, final in self?.grow(key: key, frames: frames, final: final) })
                    if !owned {
                        guard let self else { try? FileManager.default.removeItem(at: pcm); return }
                        self.work.async { _ = begin(frames, false) }
                    }
                } catch {
                    try? FileManager.default.removeItem(at: pcm)
                    self?.work.async { [weak self] in
                        guard let self else { return }
                        if self.initialTicket === ticket { self.initialTicket = nil; self.initialConfig = [:] }
                        self.reply(replyOnce, .failure(error))
                    }
                }
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
    func sourceFromDownload(id: String, key: Int? = nil, file: URL, completion: @escaping Reply) {
        work.async {
            do {
                guard self.id == id, let folder = self.folder else { throw Failure.invalid }
                if key == nil, let existing = self.sourceLinks[file] {
                    self.reply(completion, .success(["found": true, "key": existing]))
                    return
                }
                let destinationKey: Int
                if let key {
                    guard (0..<500000).contains(key) else { throw Failure.invalid }
                    destinationKey = key
                } else {
                    repeat { self.sourceKey += 1 } while self.sourceBytes[self.sourceKey] != nil && self.sourceKey < 500000
                    destinationKey = self.sourceKey
                    guard (0..<500000).contains(destinationKey) else { throw Failure.invalid }
                }
                let bytes = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard bytes > 0, bytes <= 128 * 1024 * 1024 else { throw Failure.invalid }
                let existingBytes = self.sourceBytes[destinationKey] ?? 0
                guard self.sourceBytes.values.reduce(0, +) - existingBytes + bytes <= 512 * 1024 * 1024 else { throw Failure.invalid }
                let target = folder.appendingPathComponent("source-\(destinationKey).media")
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.linkItem(at: file, to: target)
                self.sourceBytes[destinationKey] = bytes
                self.sourceLinks[file] = destinationKey
                self.reply(completion, .success(["found": true, "key": destinationKey]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    func remapTracks(_ mapping: [String: String], completion: @escaping Reply) {
        work.async {
            self.identityAliases = self.identityAliases.mapValues { mapping[$0] ?? $0 }
            self.identityAliases.merge(mapping) { _, new in new }
            func remap(_ item: [String: Any]) -> [String: Any] {
                var result = item
                if let id = item["trackId"] as? String, let next = mapping[id] { result["trackId"] = next }
                return result
            }
            self.tracks = self.tracks.map(remap); self.config["tracks"] = self.tracks
            if var manifest = self.knownManifest {
                for key in ["items", "loopItems"] { if let rows = manifest[key] as? [[String: Any]] { manifest[key] = rows.map(remap) } }
                if let previous = manifest["previous"] as? [String: Any] { manifest["previous"] = remap(previous) }
                self.knownManifest = manifest
            }
            if self.folder != nil { self.publish("merge") }
            self.reply(completion, .success([:]))
        }
    }
    /// Replaces the known future queue, then native playback callbacks release preparation permits.
    func prepareQueue(id: String, manifest incoming: [String: Any], completion: @escaping Reply) {
        work.async {
            do {
                let manifest = NativeMixTimeline.preservingTail(incoming, after: self.knownManifest,
                    currentEntryId: self.tracks.indices.contains(self.index) ? self.tracks[self.index]["entryId"] as? String : nil)
                guard id == self.id, let folder = self.folder, !self.tracks.isEmpty, !self.preparing, !self.failed,
                      let requestedFrom = manifest["from"] as? Int, requestedFrom > 0,
                      let items = manifest["items"] as? [[String: Any]], items.count <= 10000,
                      manifest["previous"] is [String: Any], manifest["settings"] is [String: Any],
                      let scriptURL = Bundle.main.url(forResource: "native-preparation", withExtension: "js", subdirectory: "public") else { throw Failure.invalid }
                let script = try self.preparationScript ?? String(contentsOf: scriptURL, encoding: .utf8)
                self.analysisScript = script
                for item in items {
                    guard let key = item["file"] as? Int, (0..<1_000_000).contains(key), item["source"] is [String: Any] else { throw Failure.invalid }
                }
                for item in items.prefix(50) { NativeStationFiles.retainLocal(item, folder: folder) }
                var configuration = manifest, future = items
                var previous = manifest["previous"] as! [String: Any]
                // A suspended page can send stale entries with a fresh native index.
                if let queueEntry = manifest["queueEntryId"] as? String {
                    guard queueEntry == (self.tracks[self.index]["entryId"] as? String), requestedFrom == self.index + 1 else { throw Failure.invalid }
                }
                guard let consumed = NativeMixTimeline.consumedPrefix(future, currentEntryId: self.tracks[self.index]["entryId"] as? String,
                    requestedFrom: requestedFrom, currentIndex: self.index) else { throw Failure.invalid }
                if consumed > 0 { previous = future[consumed - 1]; future.removeFirst(consumed) }
                var from = self.index + 1
                while !future.isEmpty, self.tracks.indices.contains(from),
                      future[0]["entryId"] as? String == self.tracks[from]["entryId"] as? String {
                    previous = future.removeFirst(); from += 1
                }
                configuration["from"] = from; configuration["items"] = future; configuration["previous"] = previous
                if !self.done, let renderer = self.renderer, !(try renderer.update(from: from, tracks: [])) { throw Failure.invalid }
                self.knownManifest = manifest
                self.preparation?.cancel(keepAnalysis: true)
                let settings = configuration["settings"] as! [String: Any]
                let settingsChanged = !NSDictionary(dictionary: self.analysisSettings).isEqual(to: settings)
                var policies: [String: Bool] = [:]
                for item in items + (manifest["loopItems"] as? [[String: Any]] ?? []) {
                    if let entry = item["entryId"] as? String { policies[entry] = item["mixingAllowed"] as? Bool == true }
                }
                let initial = manifest["previous"] as! [String: Any]
                if initial["trackId"] as? String == self.tracks[self.index]["trackId"] as? String,
                   let entry = self.tracks[self.index]["entryId"] as? String { policies[entry] = initial["mixingAllowed"] as? Bool == true }
                let policyChanged = policies.contains { self.analysisPolicies[$0.key] != nil && self.analysisPolicies[$0.key] != $0.value }
                self.analysisPolicies.merge(policies) { _, new in new }
                if settingsChanged || policyChanged {
                    self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis(); self.analysisSettings = settings
                }
                let analysis = self.analysisWorker
                if manifest["preservePendingSkip"] as? Bool != true { self.skipTarget = -1 } // A replacement manifest owns new navigation intent.
                let retained = manifest["retainedSources"] as? [Int] ?? []
                guard retained.count <= 20000, retained.allSatisfy({ (0..<500000).contains($0) }) else { throw Failure.invalid }
                var referenced = Set((items + (manifest["loopItems"] as? [[String: Any]] ?? [])).compactMap { item -> Int? in
                    guard let source = item["source"] as? [String: Any], source["kind"] as? String == "local" else { return nil }
                    return source["file"] as? Int
                })
                referenced.formUnion(retained)
                // A replacement owns these source leases; obsolete uploads stop counting
                // against the budget. Repeat/duplicate references keep their shared file.
                for key in self.sourceBytes.keys where !referenced.contains(key) {
                    try? FileManager.default.removeItem(at: folder.appendingPathComponent("source-\(key).media")); self.sourceBytes.removeValue(forKey: key)
                }
                self.sourceLinks = self.sourceLinks.filter { referenced.contains($0.value) }
                self.tracks = Array(self.tracks.prefix(from)); self.artworks = Array(self.artworks.prefix(from)); self.config["tracks"] = self.tracks
                analysis.retain(Dictionary(uniqueKeysWithValues: self.tracks.enumerated().map { ($0.offset, Self.key($0.element, $0.offset)) }))
                analysis.advance(self.index)
                if settingsChanged || policyChanged {
                    // Retained PCM may need a new plan after changing loudness or
                    // AutoMix settings. Reuse the content cache; do not download again.
                    var a = items.first(where: { $0["entryId"] as? String == self.tracks[self.index]["entryId"] as? String }) ?? (manifest["previous"] as! [String: Any])
                    if a["entryId"] == nil, let eid = self.tracks[self.index]["entryId"] { a["entryId"] = eid }
                    if a["id"] == nil, let tid = a["trackId"] ?? self.tracks[self.index]["trackId"] { a["id"] = tid }
                    for at in (self.index + 1)..<from {
                        guard let b = items.first(where: { $0["entryId"] as? String == self.tracks[at]["entryId"] as? String }) else { break }
                        analysis.enqueue(folder: folder, before: a, previousPCM: self.tracks[at - 1], next: b, pcm: self.tracks[at],
                                index: at, script: script, settings: settings,
                                upgrade: { [weak self] at, track in self?.applyAnalysis(analysis, at: at, track: track) },
                                event: { [weak self] _, reason in self?.recordAnalysis(analysis, reason: reason) })
                        a = b
                    }
                }
                if future.isEmpty && (manifest["loopItems"] as? [[String: Any]] ?? []).isEmpty {
                    self.preparation = nil; self.continueWhenPrepared = false; self.skipTarget = -1; self.prune(); self.publish("handoff"); self.reply(completion, .success(self.viewState())); return
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
                            self.work.async { continuation.resume(returning: self.commit(job, at: at, track: track, early: false)) }
                        }
                    }, early: { [weak self] at, track in
                        guard let self else { return false }
                        return await withCheckedContinuation { continuation in
                            self.work.async { continuation.resume(returning: self.commit(job, at: at, track: track, early: true)) }
                        }
                    }, grow: { [weak self] key, frames, final in
                        self?.grow(key: key, frames: frames, final: final)
                    }, upgrade: { [weak self] at, track in
                        self?.applyAnalysis(analysis, at: at, track: track)
                    }, event: { [weak self] kind, reason in
                        if kind == "analysis" { self?.recordAnalysis(analysis, reason: reason); return }
                        self?.work.async { [weak self] in
                            guard let self, self.preparation === job else { return }
                            if kind == "finished" && !job.hasRemaining {
                                // Failed sources left the target unreachable: land on the furthest prepared song.
                                if self.pendingSkips > 0 && self.tracks.count - 1 > self.index {
                                    do { try self.select(index: self.tracks.count - 1, position: 0, playing: self.wantsPlaying || self.continueWhenPrepared) }
                                    catch { self.fail(); return }
                                }
                                self.skipTarget = -1
                                // Nothing more will arrive: release the output held for it.
                                if self.ended && !self.hasMoreQueue { self.continueWhenPrepared = false; self.engine?.pause() }
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
    /// Appends a prepared song on work. An early (still decoding) song is taken only when playback
    /// waits for it; otherwise it finishes decoding first and arrives as a whole file.
    private func commit(_ job: NativeQueuePreparation, at: Int, track: [String: Any], early: Bool) -> Bool {
        guard preparation === job, !job.ticket.cancelled, at == tracks.count else { return false }
        let wanted = pendingSkips > 0 ? at >= skipTarget : done && ended && continueWhenPrepared
        if early && !wanted { return false }
        let key = Self.key(track, at)
        var appended = false
        do {
            guard let frames = track["totalFrames"] as? Int, let url = file(key),
                  let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int,
                  early ? size >= frames * 8 : size == frames * 8,
                  bytes.values.reduce(0, +) + (early ? track["estimatedFrames"] as? Int ?? frames : frames) * 8 <= 768 * 1024 * 1024 else { throw Failure.invalid }
            bytes[key] = frames * 8
            let added = try validated([track], from: at)
            if !done, let renderer, !(try renderer.update(from: at, tracks: added)) { throw Failure.invalid }
            tracks += added; config["tracks"] = tracks; artworks.append(artwork(track))
            requestArtwork(track, at: at)
            appended = true
            // First handoff after a growing start often plans before both analyses exist; record why.
            if let plan = added.first?["plan"] as? [String: Any] {
                MoraPlaybackJournal.record("native.preparation.plan", ["seq": at, "method": plan["method"] as? String ?? "",
                    "fallback": plan["fallbackReason"] as? String ?? "", "early": early])
            }
            if early { growing[key] = job.detach() }
            if wanted { try select(index: at, position: 0, playing: wantsPlaying || continueWhenPrepared) }
            else { publish("prepared") }
            if !early && at == index + 1 && tracks.indices.contains(index) && tracks[index]["growing"] as? Bool != true {
                replanAfterGrowth(reason: "committedAfterGrowth")
            }
            prune(); return true
        } catch {
            if appended {
                fail() // Metadata already owns the file; do not delete it underneath a renderer.
                return true
            }
            bytes.removeValue(forKey: key)
            MoraPlaybackJournal.record("native.preparation.failed", ["reason": early ? "earlyCommit" : "commit"])
            return false
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
            if let policies = track["_analysisPolicy"] as? [String: Bool],
               policies.contains(where: { self.analysisPolicies[$0.key] != $0.value }) {
                MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "policyMismatch"])
                return
            }
            let planMeta = track["plan"] as? [String: Any] ?? [:]
            let method = planMeta["method"] as? String ?? ""
            let fallback = planMeta["fallbackReason"] as? String ?? ""
            do {
                let checked = try self.validated([track], from: at)[0]
                if let renderer = self.renderer {
                    guard try renderer.upgrade(index: at, track: checked) else {
                        MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "pastHorizon", "method": method, "fallback": fallback]); return
                    }
                } else if at == self.index + 1,
                          let tr = checked["transition"] as? [String: Any], let trigger = tr["triggerFrame"] as? NSNumber,
                          trigger.doubleValue <= (self.position + 0.35) * self.sr {
                    MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "pastHorizon", "method": method, "fallback": fallback]); return
                }
                self.tracks[at] = checked; self.config["tracks"] = self.tracks
                self.publish("planReady")
                MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "applied", "method": method, "fallback": fallback])
            } catch { MoraPlaybackJournal.record("native.mix.plan", ["seq": at, "outcome": "rejected", "method": method, "fallback": fallback]) }
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
    func state(_ completion: @escaping Reply) { work.async { self.updatePosition(); self.save(); self.reply(completion, .success(self.viewState())) } }
    /// Native player sheet (Swift only): the view state with the queue and the current artwork.
    func playerState(_ completion: @escaping Reply) {
        work.async {
            self.updatePosition(); self.save()
            var value = self.viewState()
            value["upcoming"] = Array(self.tracks.dropFirst(self.index + 1))
            value["manifestItems"] = self.knownManifest?["items"] as? [[String: Any]] ?? []
            if self.artworks.indices.contains(self.index), let artwork = self.artworks[self.index] { value["artwork"] = artwork }
            self.reply(completion, .success(value))
        }
    }
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
            if self.initialTicket != nil {
                for key in ["tone", "preDb", "playback", "volume"] { if let value = values[key] { self.initialConfig[key] = value } }
                if let gain = values["gainDb"] as? Double, gain.isFinite, abs(gain) <= 36 { self.initialConfig["gainDb"] = gain }
            }
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
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); done = false; ended = false; levelBlocks.removeAll()
        lastLogFrame = -1
        self.index = index; self.position = position; self.blend = nil; self.skipTarget = -1; self.continueWhenPrepared = false
        var next = config; next["index"] = index; next["position"] = position
        guard let folder else { throw Failure.invalid }
        renderer = try NativeQueueRenderer(folder: folder, config: next)
        wantsPlaying = playing
        if engine != nil { try fill() }
        if playing { try startEngine(); player?.play() }
        let nextTr = tracks.indices.contains(index + 1) ? tracks[index + 1]["transition"] as? [String: Any] : nil
        MoraPlaybackJournal.record("native.mix.select", [
            "index": index,
            "armed": nextTr != nil,
            "triggerFrame": (nextTr?["triggerFrame"] as? NSNumber)?.intValue ?? -1,
            "swapFrame": (nextTr?["swapFrame"] as? NSNumber)?.intValue ?? -1,
        ])
        publish("select")
    }
    private func fill() throws {
        guard let renderer, let format, let player else { throw Failure.playback }
        let generation = epoch
        let session = AVAudioSession.sharedInstance()
        outputLatency = presentationDelay
        // Some car routes initially report zero before the first audio reaches the receiver.
        let bufferLatency = session.currentRoute.outputs.contains { $0.portType == .carAudio } ? max(2, outputLatency) : outputLatency
        outputBufferCount = NativeMixTimeline.outputBufferCount(sampleRate: sr, frames: 8192,
            latency: bufferLatency + max(0, session.ioBufferDuration))
        while pending < outputBufferCount && !done {
            let began = ProcessInfo.processInfo.systemUptime
            let block = try autoreleasepool { try renderer.render() }
            maxRenderMs = max(maxRenderMs, (ProcessInfo.processInfo.systemUptime - began) * 1000)
            for event in block.events {
                if event["type"] as? String == "starved" { underruns += 1 }
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
            if levelsOn { levelBlocks.append((rendered, block.left, block.right)) } // Data is copy-on-write: no copy
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
                if tracks.indices.contains(index + 1) {
                    let target = skipTarget // The natural advance is one step towards it.
                    do { try select(index: index + 1, position: 0, playing: true); skipTarget = target } catch { fail() }; return
                }
                continueWhenPrepared = preparation?.hasRemaining == true || hasMoreQueue
                wantsPlaying = false; ended = true; player?.pause()
                if continueWhenPrepared { holdOutput() } else { engine?.pause() }
                publish("ended"); return
            }
        }
        // Between ticks state() refreshes the snapshot on demand.
        if presented - lastLogFrame >= Int64(sr / 2) { publish("tick"); lastLogFrame = presented }
        // Keep the predecessor for interpolation; storage stays bounded by scheduled audio.
        if let keep = marks.lastIndex(where: { $0.frame < completed - 4096 }), keep > 0 { marks.removeFirst(keep) }
        if levelsOn { levelBlocks.removeAll { $0.start + Int64($0.left.count / 4) <= presented - Int64(NativeLevelMeter.n) } }
    }
    private func updatePosition() {
        var audible = completed
        if let player, let time = player.lastRenderTime, let played = player.playerTime(forNodeTime: time) {
            // Estimate between dataPlayedBack checkpoints; completion accounts for device latency.
            outputLatency = presentationDelay
            let estimated = played.sampleTime - Int64(outputLatency * sr)
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
        let artist = pendingSkips > 0 ? "Загрузка следующего трека…" : tracks.indices.contains(index) ? tracks[index]["artist"] as? String ?? "" : ""
        var info: [String: Any] = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPersistentID: NSNumber(value: index + 1), MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position, MPNowPlayingInfoPropertyPlaybackRate: playbackRate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0, MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index, MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count]
        if artworks.indices.contains(index), let artwork = artworks[index] { info[MPMediaItemPropertyArtwork] = artwork }
        let publishedInfo = info
        let publishedEntryId = tracks.indices.contains(index) ? tracks[index]["entryId"] as? String ?? "" : ""
        let publishedTrackId = tracks.indices.contains(index) ? tracks[index]["trackId"] as? String ?? "" : ""
        NativeStationFiles.updatePosition(entryId: publishedEntryId, trackId: publishedTrackId, position: position)
        let canAdvance = tracks.indices.contains(index + 1) || preparation?.hasRemaining == true || pendingSkips > 0
        let canReverse = canGoBack
        var event = state
        event["title"] = title; event["artist"] = artist; event["trackId"] = publishedTrackId
        event["currentTrack"] = ["title": title, "artist": artist, "trackId": publishedTrackId]
        event["artwork"] = publishedInfo[MPMediaItemPropertyArtwork]
        let finished = ended && !canAdvance && !continueWhenPrepared
        DispatchQueue.main.async { [weak self] in self?.onNowPlaying?(event, finished) }
        // A tick republishes Now Playing only on a visible change or clock drift (tempo
        // stretch, stall); its journal row is kept every 5 s otherwise.
        let key = "\(generation)|\(index)|\(title)|\(artist)|\(state["duration"] ?? 0)|\(playbackRate)|\(info[MPMediaItemPropertyArtwork] != nil)|\(tracks.count)|\(canAdvance)|\(canReverse)|\(state["waitingForPreparation"] ?? false)"
        let now = ProcessInfo.processInfo.systemUptime
        if reason == "tick", let sent = nowPlaying, sent.key == key,
           NativeMixTimeline.nowPlayingCurrent(sentPosition: sent.position, sentAt: sent.at, rate: sent.rate, position: position, now: now) {
            guard now - sent.row >= 5 else { return }
            nowPlaying?.row = now
        } else {
            nowPlaying = (key, position, playbackRate, now, now)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
                self.refillLease(waiting: state["waitingForPreparation"] as? Bool == true)
                MPNowPlayingInfoCenter.default().nowPlayingInfo = publishedInfo
                let reaction = self.reactionState?(publishedTrackId) ?? 0
                MPRemoteCommandCenter.shared().likeCommand.isActive = reaction > 0
                MPRemoteCommandCenter.shared().dislikeCommand.isActive = reaction < 0
                MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled = canAdvance
                MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled = canReverse
            }
        }
        let prep = state["preparation"] as? [String: Any] ?? [:]
        MoraPlaybackJournal.record("native.mix.state", ["reason": reason, "seq": index, "position": position, "duration": state["duration"] ?? 0,
            "playing": wantsPlaying, "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "maxRenderMs": maxRenderMs, "underruns": underruns,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil,
            "preparation": prep["state"] ?? "none", "ready": prep["ready"] ?? 0, "remaining": prep["remaining"] ?? 0,
            "gateUpper": prep["gateUpper"] ?? -1, "gateWaiting": prep["gateWaiting"] ?? -1, "stageSeconds": prep["stageSeconds"] ?? 0])
    }
    /// The page asks for levels only while its visualizer listens; off frees the blocks and the timer.
    func setLevels(_ on: Bool) {
        work.async {
            guard on != self.levelsOn else { return }
            self.levelsOn = on
            if on {
                let nc = NotificationCenter.default
                self.levelObservers = [
                    nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.work.async { self?.foreground = true; self?.updateLevelTimer() } },
                    nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.work.async { self?.foreground = false; self?.updateLevelTimer() } }]
                DispatchQueue.main.async { [weak self] in
                    let active = UIApplication.shared.applicationState == .active
                    self?.work.async { self?.foreground = active; self?.updateLevelTimer() }
                }
            } else {
                for o in self.levelObservers { NotificationCenter.default.removeObserver(o) }
                self.levelObservers = []; self.levelBlocks.removeAll()
            }
            self.updateLevelTimer()
        }
    }
    private func updateLevelTimer() {
        if levelsOn && foreground {
            guard levelTimer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: work) // ~20 Hz with leeway so wakeups coalesce
            timer.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(10))
            timer.setEventHandler { [weak self] in self?.levelTick() }
            timer.resume(); levelTimer = timer
        } else { levelTimer?.cancel(); levelTimer = nil }
    }
    /// Levels of the 2048 frames ending at the audible frame, from the blocks already rendered.
    private func levelTick() {
        guard levelsOn, foreground, wantsPlaying, engine?.isRunning == true, !levelBlocks.isEmpty, let onLevels else { return }
        updatePosition()
        let end = presented, start = end - Int64(NativeLevelMeter.n)
        var half: Float = 0.5
        let level = levelMeter.analyze(sampleRate: sr) { out in
            memset(out, 0, NativeLevelMeter.n * MemoryLayout<Float>.size)
            for b in levelBlocks {
                let lo = max(start, b.start), hi = min(end, b.start + Int64(b.left.count / 4))
                guard hi > lo else { continue }
                let from = Int(lo - b.start), at = Int(lo - start), count = vDSP_Length(hi - lo)
                b.left.withUnsafeBytes { l in b.right.withUnsafeBytes { r in
                    vDSP_vasm(l.assumingMemoryBound(to: Float.self).baseAddress! + from, 1, r.assumingMemoryBound(to: Float.self).baseAddress! + from, 1, &half, out + at, 1, count)
                } }
            }
        }
        onLevels(level.rms, level.bands)
    }
    private func fail() {
        initialTicket?.cancel(); initialTicket = nil; initialConfig = [:]
        preparation?.cancel(); preparation = nil; continueWhenPrepared = false; skipTarget = -1
        for ticket in growing.values { ticket.cancel() }; growing.removeAll()
        wantsPlaying = false; failed = true; knownManifest = nil; epoch += 1
        player?.stop(); engine?.pause(); renderer = nil
        save(); MoraPlaybackJournal.record("native.mix.failed")
        DispatchQueue.main.async { [weak self] in self?.onNowPlaying?([:], true) }
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
                guard self.folder != nil, !self.failed else { throw Failure.invalid }
                if let owner, owner != self.ownershipRevision { throw Failure.invalid }
                if self.initialTicket != nil, action == "pause" || action == "play" {
                    self.initialConfig["paused"] = action == "pause"
                    if self.preparing { self.save(); self.reply(completion, .success(self.snapshot)); return }
                }
                guard !self.preparing else { throw Failure.invalid }
                if source == "interruption" && self.mediaResetPending { throw Failure.invalid }
                if action != "like" && action != "dislike" { self.controlRevision += 1 }
                self.updatePosition()
                if source != "interruption" { self.resumeAfterInterruption = false }
                switch action {
                case "like", "dislike":
                    guard self.tracks.indices.contains(self.index), let trackId = self.tracks[self.index]["trackId"] as? String else { throw Failure.invalid }
                    DispatchQueue.main.async {
                        if let value = self.onReaction?(trackId, action == "like" ? 1 : -1) {
                            MPRemoteCommandCenter.shared().likeCommand.isActive = value > 0
                            MPRemoteCommandCenter.shared().dislikeCommand.isActive = value < 0
                        }
                    }
                case "pause": self.continueWhenPrepared = false; self.skipTarget = -1; self.wantsPlaying = false; self.player?.pause(); self.engine?.pause()
                case "play", "toggle":
                    if action == "toggle" && self.wantsPlaying {
                        self.continueWhenPrepared = false; self.skipTarget = -1
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
                                try self.startEngine(); self.holdOutput()
                            } else { try self.select(index: self.index, position: 0, playing: true) }
                        }
                        else if !wasPlaying { try self.select(index: self.index, position: self.position, playing: true) }
                        else { self.wantsPlaying = true; try self.fill(); try self.startEngine(); self.player?.play() }
                    }
                case "nexttrack":
                    if self.pendingSkips == 0 && self.tracks.indices.contains(self.index + 1) {
                        try self.select(index: self.index + 1, position: 0, playing: self.wantsPlaying || self.continueWhenPrepared)
                    } else {
                        // Keep the current audible track running until the target is ready; each press moves it one further.
                        // Stopping the engine here could suspend preparation in the background.
                        let skips = NativeMixTimeline.pendingSkips(self.pendingSkips, ahead: self.tracks.count - 1 - self.index,
                                                                   remaining: self.preparation?.remainingItems ?? 0)
                        guard skips > 0 else { throw Failure.invalid }
                        self.skipTarget = self.index + skips
                        self.preparation?.gate.advance(self.skipTarget)
                    }
                case "previoustrack":
                    let previous = self.position > 3 ? self.index : self.index - 1
                    guard self.available(previous) else { throw Failure.invalid }
                    try self.select(index: previous, position: 0, playing: self.wantsPlaying)
                case "seekto":
                    guard let time, time.isFinite else { throw Failure.invalid }
                    let limit = NativeMixTimeline.seekLimit(self.tracks[self.index], sampleRate: self.sr)
                    try self.select(index: self.index, position: max(0, min(limit, time)), playing: self.wantsPlaying)
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
            c.likeCommand.localizedTitle = "Нравится"
            c.dislikeCommand.localizedTitle = "Не нравится"
            c.skipForwardCommand.isEnabled = false; c.skipBackwardCommand.isEnabled = false
            c.seekForwardCommand.isEnabled = false; c.seekBackwardCommand.isEnabled = false
            let bindings: [(MPRemoteCommand, String)] = [(c.playCommand, "play"), (c.pauseCommand, "pause"), (c.togglePlayPauseCommand, "toggle"),
                (c.nextTrackCommand, "nexttrack"), (c.previousTrackCommand, "previoustrack"), (c.changePlaybackPositionCommand, "seekto"), (c.likeCommand, "like"), (c.dislikeCommand, "dislike")]
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
            self.initialTicket?.cancel(); self.initialTicket = nil; self.initialConfig = [:]; self.knownManifest = nil
            self.preparation?.cancel(); self.preparation = nil; self.continueWhenPrepared = false; self.skipTarget = -1
            for ticket in self.growing.values { ticket.cancel() }; self.growing.removeAll()
            self.analysisWorker.cancel(); self.analysisWorker = NativeMixAnalysis()
            self.artworkLoader.cancel(); self.artworkLoader = NativeQueueArtwork()
            DispatchQueue.main.async { [weak self] in self?.refillLease(waiting: false); self?.onNowPlaying?([:], true) }
            guard self.folder != nil || self.ownsSession else { self.reply(completion, .success(self.snapshot)); return }
            self.epoch += 1; self.wantsPlaying = false; self.resumeAfterInterruption = false
            self.discardGraph(); self.interrupted = false; self.mediaResetPending = false
            do {
                if self.ownsSession { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); self.ownsSession = false }
                // folder is created only under our private cache with a native-generated UUID.
                if let folder = self.folder { try? FileManager.default.removeItem(at: folder) }
                self.folder = nil; self.preparing = false; self.engine = nil; self.player = nil; self.bytes = [:]; self.sourceBytes = [:]; self.sourceLinks = [:]; self.newestKey = -1
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
            guard self.folder != nil, !self.tracks.isEmpty || self.initialTicket != nil else { return }
            if type == AVAudioSession.InterruptionType.began.rawValue {
                if self.initialTicket != nil { self.initialConfig["paused"] = true }
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
        // The mix host owns audio while it is active, so the plugin's own route log stays silent: record it here.
        let output = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "none"
        MoraPlaybackJournal.record("native.routeChange", ["reason": String(reason ?? 0), "route": output])
        if active && reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { command("pause", source: "route") { _ in } }
        else {
            work.async {
                guard self.folder != nil, self.wantsPlaying, self.engine?.isRunning == true else { return }
                do { try self.fill(); self.publish("routeBuffering") } catch { self.fail() }
            }
        }
    }
    func mediaReset() {
        work.async {
            guard self.folder != nil, !self.tracks.isEmpty || self.initialTicket != nil else { return }
            if self.initialTicket != nil { self.initialConfig["paused"] = true }
            self.wantsPlaying = false; self.resumeAfterInterruption = false; self.interrupted = false
            self.continueWhenPrepared = false; self.skipTarget = -1; self.mediaResetPending = true
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
    /// A track ended before its successor finished downloading. A paused engine lets iOS suspend
    /// the locked app, and the download freezes with it until the user opens the app again.
    /// The running engine (silent: nothing is scheduled) keeps the app alive for a bounded wait.
    private func holdOutput() {
        let generation = epoch
        work.asyncAfter(deadline: .now() + Self.holdSeconds) { [weak self] in
            guard let self, self.epoch == generation, self.ended, self.continueWhenPrepared else { return }
            self.engine?.pause(); MoraPlaybackJournal.record("native.mix.holdExpired"); self.publish("ended")
        }
    }
    static let holdSeconds: Double = 240
    private func endRefillLease() {
        guard refillTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(refillTask); refillTask = .invalid
    }
    private var sleepVolume: Float = 1
    func sleepGain(_ gain: Double) {
        guard gain.isFinite else { return }
        work.async {
            let value = Float(min(1, max(0, gain)))
            guard value != self.sleepVolume else { return }
            self.sleepVolume = value; self.engine?.mainMixerNode.outputVolume = value
        }
    }
    private func buildGraph() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true); ownsSession = true
        format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)
        let engine = makeEngine(), player = AVAudioPlayerNode()
        self.engine = engine; self.player = player
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = sleepVolume
        engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self, weak engine] _ in
            guard let engine else { return }; self?.configurationChanged(engine)
        }
    }
    private func startEngine() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true); ownsSession = true
        if engine == nil { try buildGraph() }
        do {
            try engine?.start()
        } catch {
            MoraPlaybackJournal.record("native.mix.engineRetry", ["error": error.localizedDescription])
            let savedContinue = continueWhenPrepared
            let savedWants = wantsPlaying
            let savedSkip = skipTarget
            discardGraph()
            guard let folder else { throw error }
            var next = config; next["index"] = index; next["position"] = position
            try buildGraph()
            renderer = savedContinue ? nil : try NativeQueueRenderer(folder: folder, config: next)
            continueWhenPrepared = savedContinue
            wantsPlaying = savedWants
            skipTarget = savedSkip
            if !savedContinue { try fill() }
            try engine?.start()
        }
    }
    private func discardGraph() {
        epoch += 1
        if let engineObserver { NotificationCenter.default.removeObserver(engineObserver); self.engineObserver = nil }
        player?.stop(); engine?.stop(); renderer = nil; player = nil; engine = nil; format = nil
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); blend = nil; levelBlocks.removeAll()
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
                    let target = self.skipTarget
                    try self.select(index: self.index, position: self.position, playing: true)
                    self.skipTarget = target; self.publish("configurationRecovered")
                }
                catch { self.fail() }
            }
        }
    }
}
