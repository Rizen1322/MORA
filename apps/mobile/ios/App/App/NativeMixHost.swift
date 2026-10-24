import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Native MORA playback of a queue of fully uploaded tracks. The page appends tracks
/// while it runs; the queue keeps playing (with its DJ transitions) while the page is
/// suspended. All mutable engine/JSC/file state is confined to work; the audio
/// completion only dispatches a small notification.
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
    // Main queue only. Do not remove WebKit's or the baseline probe's targets.
    private var targets: [(MPRemoteCommand, Any)] = []
    private enum Failure: Error { case invalid, playback }
    typealias Reply = (Result<[String: Any], Error>) -> Void

    private var sr: Double { config["sampleRate"] as? Double ?? 48000 }
    private func file(_ key: Int) -> URL? { folder?.appendingPathComponent("\(key).f32le") }
    private static func key(_ track: [String: Any], _ i: Int) -> Int { track["file"] as? Int ?? i }
    private func reply(_ completion: @escaping Reply, _ result: Result<[String: Any], Error>) {
        DispatchQueue.main.async { completion(result) }
    }
    private func save() {
        let duration = tracks.indices.contains(index) ? (tracks[index]["totalFrames"] as? Double ?? 0) / sr : 0
        let state: [String: Any] = ["active": folder != nil, "playing": wantsPlaying && !failed,
            "preparing": preparing, "index": index, "position": position, "duration": duration,
            "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "ownership": ownershipRevision, "underruns": underruns, "maxRenderMs": maxRenderMs, "failed": failed,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil, "count": tracks.count, "ended": ended,
            "entryId": tracks.indices.contains(index) ? tracks[index]["entryId"] as? String ?? "" : ""]
        var result = state
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
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                self.folder = folder; self.bytes = [:]; self.preparing = true; self.failed = false
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
                if offset == 0 { guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw Failure.invalid } }
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
            var copy = track; copy.removeValue(forKey: "artwork"); copy.removeValue(forKey: "coverUrl"); return copy
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
    /// Keeps the files of the previous, audible and upcoming tracks; older ones cannot be selected again.
    /// A file uploaded after every queued one may still be on its way into the queue and is kept.
    private func prune() {
        prunedIndex = index
        let keys = tracks.enumerated().map { Self.key($0.element, $0.offset) }
        newestKey = max(newestKey, keys.max() ?? -1)
        let used = Set(keys.enumerated().filter { $0.offset >= index - 1 }.map { $0.element })
        for key in bytes.keys where !used.contains(key) && key <= newestKey {
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
                self.artworks = raw.map { self.artwork($0) }
                self.config = config; self.config["tracks"] = metadata; self.tracks = metadata
                if self.engine == nil {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.playback, mode: .default, options: [])
                    try session.setActive(true); self.ownsSession = true
                    self.format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)
                    let engine = AVAudioEngine(), player = AVAudioPlayerNode()
                    self.engine = engine; self.player = player
                    engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: self.format)
                    self.underruns = 0; self.maxRenderMs = 0
                }
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
            self.reply(completion, .success(self.snapshot))
        }
    }
    private func select(index: Int, position: Double, playing: Bool) throws {
        epoch += 1; wantsPlaying = false
        player?.stop(); engine?.pause()
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); done = false; ended = false
        lastLogFrame = -1
        self.index = index; self.position = position
        var next = config; next["index"] = index; next["position"] = position
        guard let folder else { throw Failure.invalid }
        renderer = try NativeQueueRenderer(folder: folder, config: next)
        wantsPlaying = playing
        try fill()
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
            marks.append(contentsOf: block.marks.map { NativeMixMark(frame: rendered + $0.frame, index: $0.index, position: $0.position) })
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
        pending = max(0, pending - 1); completed = max(completed, end)
        updatePosition()
        if wantsPlaying {
            if pending == 0 && !done { underruns += 1; MoraPlaybackJournal.record("native.mix.starved") }
            do { try fill() } catch { fail(); return }
            if done && pending == 0 {
                // The page appended a track after the renderer finished: continue without a blend.
                if tracks.indices.contains(index + 1) { do { try select(index: index + 1, position: 0, playing: true) } catch { fail() }; return }
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
        let a = marks[at]; index = a.index; position = a.position
        if at + 1 < marks.count {
            let b = marks[at + 1]
            if b.index == a.index && b.frame > a.frame {
                position += (b.position - a.position) * Double(presented - a.frame) / Double(b.frame - a.frame)
            }
        }
        position = max(0, min(position, (tracks[index]["totalFrames"] as? Double ?? 0) / sr))
    }
    private func publish(_ reason: String) {
        updatePosition(); save()
        if index != prunedIndex { prune() }
        let state = snapshot, generation = epoch
        let title = tracks.indices.contains(index) ? tracks[index]["title"] as? String ?? "MORA" : "MORA"
        let artist = tracks.indices.contains(index) ? tracks[index]["artist"] as? String ?? "" : ""
        var info: [String: Any] = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPersistentID: NSNumber(value: index + 1), MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position, MPNowPlayingInfoPropertyPlaybackRate: wantsPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0, MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index, MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count]
        if artworks.indices.contains(index), let artwork = artworks[index] { info[MPMediaItemPropertyArtwork] = artwork }
        let publishedInfo = info
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = publishedInfo
            MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled = (state["index"] as? Int ?? 0) + 1 < (state["count"] as? Int ?? 0)
        }
        MoraPlaybackJournal.record("native.mix.state", ["reason": reason, "seq": index, "position": position,
            "playing": wantsPlaying, "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "maxRenderMs": maxRenderMs, "underruns": underruns,
            "artworkReady": artworks.indices.contains(index) && artworks[index] != nil])
    }
    private func fail() {
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
                if let owner, owner != self.ownershipRevision { throw Failure.invalid }
                self.updatePosition()
                if source != "interruption" { self.resumeAfterInterruption = false }
                switch action {
                case "pause": self.wantsPlaying = false; self.player?.pause(); self.engine?.pause()
                case "play", "toggle":
                    if action == "toggle" && self.wantsPlaying {
                        self.wantsPlaying = false; self.player?.pause(); self.engine?.pause()
                    } else {
                        try AVAudioSession.sharedInstance().setActive(true)
                        if self.done && self.pending == 0 { try self.select(index: self.index, position: 0, playing: true) }
                        else { self.wantsPlaying = true; try self.fill(); try self.engine?.start(); self.player?.play() }
                    }
                case "nexttrack":
                    guard self.tracks.indices.contains(self.index + 1) else { throw Failure.invalid }
                    try self.select(index: self.index + 1, position: 0, playing: self.wantsPlaying)
                case "previoustrack":
                    try self.select(index: self.position > 3 ? self.index : max(0, self.index - 1), position: 0, playing: self.wantsPlaying)
                case "seekto":
                    guard let time, time.isFinite else { throw Failure.invalid }
                    let duration = (self.tracks[self.index]["totalFrames"] as? Double ?? 0) / self.sr
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
                command.isEnabled = true
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
            guard self.folder != nil || self.ownsSession else { self.reply(completion, .success(self.snapshot)); return }
            self.epoch += 1; self.wantsPlaying = false; self.resumeAfterInterruption = false
            self.player?.stop(); self.engine?.stop(); self.renderer = nil
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
            if type == AVAudioSession.InterruptionType.began.rawValue {
                self.resumeAfterInterruption = self.wantsPlaying; self.wantsPlaying = false
                self.player?.pause(); self.engine?.pause(); self.publish("interruption")
            } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                let resume = self.resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
                self.resumeAfterInterruption = false
                if resume { self.command("play", source: "interruption") { _ in } }
            }
        }
    }
    func routeChange(_ notification: Notification) {
        let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { command("pause", source: "route") { _ in } }
    }
    func mediaReset() { work.async { if self.folder != nil { self.fail() } } }
}
