import AVFoundation
import Foundation
import MediaPlayer

/// Experimental finite, fully prepared pair. All mutable engine/JSC/file state is
/// confined to work; the audio completion only dispatches a small notification.
final class NativeMixHost {
    private let work = DispatchQueue(label: "ru.mora.native-mix", qos: .userInitiated)
    private let lock = NSLock()
    private var cached: [String: Any] = ["active": false, "playing": false, "index": 0, "position": 0.0, "duration": 0.0]
    var snapshot: [String: Any] { lock.lock(); defer { lock.unlock() }; return cached }
    var active: Bool { snapshot["active"] as? Bool == true }
    private var folder: URL?
    private var id = ""
    private var bytes = [0, 0]
    private var config: [String: Any] = [:]
    private var tracks: [[String: Any]] = []
    private var script = ""
    private var renderer: NativeDSPRenderer?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var format: AVAudioFormat?
    private var epoch = 0
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
    private var preparing = false
    private var ownsSession = false
    private var failed = false
    private var underruns = 0
    private var maxRenderMs = 0.0
    private var lastLogFrame: Int64 = -1
    // Main queue only. Do not remove WebKit's or the baseline probe's targets.
    private var targets: [(MPRemoteCommand, Any)] = []
    private enum Failure: Error { case invalid, playback }
    typealias Reply = (Result<[String: Any], Error>) -> Void

    private var sr: Double { config["sampleRate"] as? Double ?? 48000 }
    private var files: [URL] { guard let folder else { return [] }; return [0, 1].map { folder.appendingPathComponent("\($0).f32le") } }
    private func reply(_ completion: @escaping Reply, _ result: Result<[String: Any], Error>) {
        DispatchQueue.main.async { completion(result) }
    }
    private func save() {
        let duration = tracks.indices.contains(index) ? (tracks[index]["totalFrames"] as? Double ?? 0) / sr : 0
        let state: [String: Any] = ["active": folder != nil, "playing": wantsPlaying && !failed,
            "preparing": preparing, "index": index, "position": position, "duration": duration,
            "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "underruns": underruns, "maxRenderMs": maxRenderMs, "failed": failed]
        var result = state
        if let plan = config["transition"] as? [String: Any], let start = plan["triggerFrame"] as? Double { result["transitionStart"] = start / sr }
        lock.lock(); cached = result; lock.unlock()
    }
    func begin(_ completion: @escaping Reply) {
        work.async {
            do {
                guard self.folder == nil else { throw Failure.invalid }
                let root = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent("MORA/native-mix", isDirectory: true)
                self.id = UUID().uuidString
                let folder = root.appendingPathComponent(self.id, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                self.folder = folder; self.bytes = [0, 0]; self.preparing = true; self.failed = false
                self.epoch += 1; self.save()
                self.reply(completion, .success(["id": self.id]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    func append(id: String, track: Int, offset: Int, base64: String, completion: @escaping Reply) {
        work.async {
            do {
                guard self.preparing, id == self.id, (0...1).contains(track), offset == self.bytes[track],
                      base64.count <= 400000, let data = Data(base64Encoded: base64), !data.isEmpty,
                      data.count <= 32768 * 8, data.count % 8 == 0,
                      self.bytes.reduce(0, +) + data.count <= 384 * 1024 * 1024 else { throw Failure.invalid }
                let url = self.files[track]
                if offset == 0 { guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw Failure.invalid } }
                let file = try FileHandle(forWritingTo: url)
                defer { try? file.close() }
                try file.seekToEnd(); try file.write(contentsOf: data)
                self.bytes[track] += data.count
                self.reply(completion, .success([:]))
            } catch { self.reply(completion, .failure(error)) }
        }
    }
    func start(id: String, config: [String: Any], completion: @escaping Reply) {
        work.async {
            do {
                guard self.preparing, id == self.id, let sr = config["sampleRate"] as? Double,
                      [44100.0, 48000.0].contains(sr), let tracks = config["tracks"] as? [[String: Any]], tracks.count == 2,
                      let position = config["position"] as? Double, position.isFinite, position >= 0 else { throw Failure.invalid }
                for i in 0...1 {
                    guard let count = tracks[i]["totalFrames"] as? Int, count > 0, count * 8 == self.bytes[i],
                          let gain = tracks[i]["gainDb"] as? Double, gain.isFinite, abs(gain) <= 36 else { throw Failure.invalid }
                }
                guard let url = Bundle.main.url(forResource: "native-mixer", withExtension: "js", subdirectory: "public") else { throw Failure.invalid }
                self.script = try String(contentsOf: url, encoding: .utf8)
                self.config = config; self.tracks = tracks
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [])
                try session.setActive(true); self.ownsSession = true
                self.format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)
                let engine = AVAudioEngine(), player = AVAudioPlayerNode()
                self.engine = engine; self.player = player
                engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: self.format)
                self.preparing = false; self.underruns = 0; self.maxRenderMs = 0
                try self.select(index: 0, position: position, playing: true)
                self.installTargets()
                self.reply(completion, .success(self.snapshot))
            } catch { self.fail(); self.reply(completion, .failure(error)) }
        }
    }
    private func select(index: Int, position: Double, playing: Bool) throws {
        epoch += 1; wantsPlaying = false
        player?.stop(); engine?.pause()
        pending = 0; rendered = 0; queued = 0; completed = 0; presented = 0; marks.removeAll(); done = false
        lastLogFrame = -1
        self.index = index; self.position = position
        var next = config; next["index"] = index; next["position"] = position
        renderer = try NativeDSPRenderer(script: script, files: files, config: next)
        wantsPlaying = playing
        try fill()
        if playing { try engine?.start(); player?.play() }
        publish("select")
    }
    private func fill() throws {
        guard let renderer, let format, let player else { throw Failure.playback }
        let generation = epoch
        while pending < 3 && !done {
            let began = ProcessInfo.processInfo.systemUptime
            let block = try autoreleasepool { try renderer.render() }
            maxRenderMs = max(maxRenderMs, (ProcessInfo.processInfo.systemUptime - began) * 1000)
            for event in block.events {
                MoraPlaybackJournal.record("native.mix.renderEvent", ["reason": event["type"] as? String ?? "unknown", "clock": rendered])
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
            if done && pending == 0 { wantsPlaying = false; player?.pause(); engine?.pause(); publish("ended"); return }
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
        let state = snapshot, generation = epoch
        let title = tracks.indices.contains(index) ? tracks[index]["title"] as? String ?? "MORA" : "MORA"
        let artist = tracks.indices.contains(index) ? tracks[index]["artist"] as? String ?? "" : ""
        let info: [String: Any] = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPersistentID: NSNumber(value: index + 1), MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position, MPNowPlayingInfoPropertyPlaybackRate: wantsPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0, MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index, MPNowPlayingInfoPropertyPlaybackQueueCount: 2]
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.snapshot["epoch"] as? Int == generation else { return }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled = (state["index"] as? Int ?? 0) < 1
        }
        MoraPlaybackJournal.record("native.mix.state", ["reason": reason, "seq": index, "position": position,
            "playing": wantsPlaying, "renderedFrames": rendered, "queuedFrames": queued, "presentedFrames": presented,
            "epoch": epoch, "maxRenderMs": maxRenderMs, "underruns": underruns])
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
    func command(_ action: String, time: Double? = nil, source: String, completion: @escaping Reply) {
        work.async {
            let id = UUID().uuidString
            MoraPlaybackJournal.record("native.mix.command", ["id": id, "action": action, "source": source])
            do {
                guard self.folder != nil, !self.preparing, !self.failed else { throw Failure.invalid }
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
                    guard self.index == 0 else { throw Failure.invalid }
                    try self.select(index: 1, position: 0, playing: self.wantsPlaying)
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
                    guard let self, self.active else { return .commandFailed }
                    let time = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                    MoraPlaybackJournal.record("native.mix.callback", ["action": action, "seekTime": time ?? -1])
                    self.command(action, time: time, source: "remote") { _ in }
                    return .success
                }
                self.targets.append((command, target))
            }
        }
    }
    func stop(_ completion: @escaping Reply) {
        work.async {
            self.epoch += 1; self.wantsPlaying = false; self.resumeAfterInterruption = false
            self.player?.stop(); self.engine?.stop(); self.renderer = nil
            do {
                if self.ownsSession { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); self.ownsSession = false }
                // folder is created only under our private cache with a native-generated UUID.
                if let folder = self.folder { try? FileManager.default.removeItem(at: folder) }
                self.folder = nil; self.preparing = false; self.engine = nil; self.player = nil
                self.marks.removeAll(); self.save()
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
