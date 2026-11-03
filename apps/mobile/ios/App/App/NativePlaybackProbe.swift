import AVFoundation
import MediaPlayer
import UIKit

/// Diagnostic baseline only. Two finite, audible WAVs run without WebContent,
/// server, network, AudioContext or JS callbacks. It does not implement AutoMix.
final class NativePlaybackProbe: NSObject, AVAudioPlayerDelegate {
    private(set) var active = false
    private var player: AVAudioPlayer?
    private var files: [URL] = []
    private var index = 0
    private var revision = 0
    private var wantsPlaying = false
    private var resumeAfterInterruption = false
    private var timer: Timer?
    private var targets: [(MPRemoteCommand, Any)] = []
    private let work = DispatchQueue(label: "ru.mora.native-probe")
    private var ownsSession = false // Access only on work, including release retries.
    private enum Failure: Error { case cancelled, playback }

    var snapshot: [String: Any] {
        ["active": active, "playing": player?.isPlaying ?? false, "index": index,
         "position": player?.currentTime ?? 0, "duration": player?.duration ?? 0,
         "commandAvailability": [
            "next": MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled,
            "previous": MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled,
            "position": MPRemoteCommandCenter.shared().changePlaybackPositionCommand.isEnabled,
            "skipForward": MPRemoteCommandCenter.shared().skipForwardCommand.isEnabled,
            "skipBackward": MPRemoteCommandCenter.shared().skipBackwardCommand.isEnabled]]
    }

    func start(_ completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if active { completion(.success(snapshot)); return }
        revision += 1
        let intent = revision
        work.async {
            do {
                let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("MORA/native-probe-v1", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var urls: [URL] = []
                for i in 0..<2 {
                    let file = folder.appendingPathComponent("melody-\(i).wav")
                    let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
                    if size != 44 + 90 * NativeProbeWave.sampleRate * 2 {
                        try NativeProbeWave.make(track: i).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    }
                    urls.append(file)
                }
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .default, options: [])
                try AVAudioSession.sharedInstance().setActive(true)
                self.ownsSession = true
                let prepared = urls
                DispatchQueue.main.async {
                    guard self.revision == intent else { completion(.failure(Failure.cancelled)); return }
                    do {
                        self.files = prepared; self.active = true; self.wantsPlaying = true
                        self.registerCommands()
                        try self.select(0, playing: true)
                        self.publish("start")
                        completion(.success(self.snapshot))
                    } catch { completion(.failure(error)) }
                }
            } catch { DispatchQueue.main.async { completion(.failure(error)) } }
        }
    }

    func stop(_ completion: @escaping (Bool) -> Void) {
        revision += 1; wantsPlaying = false; resumeAfterInterruption = false
        timer?.invalidate(); timer = nil; player?.stop(); player = nil
        for (command, target) in targets { command.isEnabled = false; command.removeTarget(target) }
        targets.removeAll()
        if active { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        active = false
        MoraPlaybackJournal.record("native.probe.stop")
        work.async {
            guard self.ownsSession else { DispatchQueue.main.async { completion(true) }; return }
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                self.ownsSession = false
                DispatchQueue.main.async { completion(true) }
            } catch {
                MoraPlaybackJournal.record("native.probe.sessionFailed")
                DispatchQueue.main.async { completion(false) }
            }
        }
    }

    private func select(_ next: Int, playing: Bool) throws {
        guard files.count == 2 else { throw Failure.playback }
        player?.stop()
        let audio = try AVAudioPlayer(contentsOf: files[next])
        audio.delegate = self
        guard audio.prepareToPlay() else { throw Failure.playback }
        index = next; player = audio
        if playing && !audio.play() { throw Failure.playback }
        updateTimer()
    }

    private func updateTimer() {
        timer?.invalidate(); timer = nil
        if player?.isPlaying == true {
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.publish("tick") }
        }
    }

    private func publish(_ reason: String) {
        guard active, let player else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: index == 0 ? "MORA · тестовая мелодия A" : "MORA · тестовая мелодия B",
            MPMediaItemPropertyArtist: "Нативная проверка управления",
            MPMediaItemPropertyPersistentID: NSNumber(value: index + 1),
            MPMediaItemPropertyPlaybackDuration: player.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: player.isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: 2,
        ]
        MoraPlaybackJournal.record("native.probe.state", ["reason": reason, "seq": index,
            "position": player.currentTime, "duration": player.duration, "playing": player.isPlaying])
    }

    func command(_ action: String, time: Double? = nil, source: String, id commandId: String? = nil, completion: @escaping (Bool) -> Void) {
        guard active, let audio = player else { completion(false); return }
        revision += 1
        let intent = revision
        let id = commandId ?? UUID().uuidString
        MoraPlaybackJournal.record("native.probe.command", ["id": id, "action": action, "source": source, "seekTime": time ?? -1])
        if action == "play" || (action == "toggle" && !audio.isPlaying) {
            wantsPlaying = true
            work.async {
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    DispatchQueue.main.async {
                        guard self.active, self.revision == intent, self.wantsPlaying else { completion(false); return }
                        let ok = self.player?.play() == true
                        self.updateTimer(); self.publish("play")
                        MoraPlaybackJournal.record("native.probe.applied", ["id": id, "outcome": ok ? "accepted" : "rejected"])
                        completion(ok)
                    }
                } catch {
                    MoraPlaybackJournal.record("native.probe.applied", ["id": id, "outcome": "rejected"])
                    DispatchQueue.main.async { completion(false) }
                }
            }
            return
        }
        do {
            switch action {
            case "pause", "toggle": wantsPlaying = false; resumeAfterInterruption = false; audio.pause()
            case "nexttrack": try select((index + 1) % 2, playing: audio.isPlaying)
            case "previoustrack":
                if audio.currentTime > 3 { audio.currentTime = 0 }
                else { try select((index + 1) % 2, playing: audio.isPlaying) }
            case "seekto":
                guard let time, time.isFinite else { completion(false); return }
                audio.currentTime = min(max(0, time), max(0, audio.duration - 0.05))
            case "seekforward": audio.currentTime = min(audio.currentTime + 10, max(0, audio.duration - 0.05))
            case "seekbackward": audio.currentTime = max(0, audio.currentTime - 10)
            default: completion(false); return
            }
            updateTimer(); publish(action)
            MoraPlaybackJournal.record("native.probe.applied", ["id": id, "outcome": "accepted"])
            completion(true)
        } catch {
            MoraPlaybackJournal.record("native.probe.applied", ["id": id, "outcome": "rejected"])
            completion(false)
        }
    }

    private func registerCommands() {
        let c = MPRemoteCommandCenter.shared()
        // Music navigation: advertise adjacent tracks, not podcast-style interval
        // controls. Absolute position seeking remains enabled independently.
        c.skipForwardCommand.isEnabled = false; c.skipBackwardCommand.isEnabled = false
        c.seekForwardCommand.isEnabled = false; c.seekBackwardCommand.isEnabled = false
        let bindings: [(MPRemoteCommand, String)] = [(c.playCommand, "play"), (c.pauseCommand, "pause"),
            (c.togglePlayPauseCommand, "toggle"), (c.nextTrackCommand, "nexttrack"),
            (c.previousTrackCommand, "previoustrack"), (c.changePlaybackPositionCommand, "seekto")]
        for (command, action) in bindings {
            command.isEnabled = true
            let target = command.addTarget { [weak self] event in
                let time = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                if action == "seekto", time == nil || time?.isFinite != true { return .commandFailed }
                guard let self else { return .commandFailed }
                let id = UUID().uuidString
                MoraPlaybackJournal.record("native.probe.callback", ["id": id, "action": action])
                // .success means queued. native.probe.applied records actual transport handling.
                DispatchQueue.main.async { self.command(action, time: time, source: "remote", id: id) { _ in } }
                return .success
            }
            targets.append((command, target))
        }
        MoraPlaybackJournal.record("native.probe.controls", ["action": "nexttrack.previoustrack.seekto", "seekable": true])
    }

    func interruption(_ n: Notification) {
        DispatchQueue.main.async {
            guard self.active else { return }
            let type = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                self.resumeAfterInterruption = self.wantsPlaying
                self.revision += 1; self.player?.pause(); self.updateTimer(); self.publish("interruption")
            } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                let options = AVAudioSession.InterruptionOptions(rawValue: n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                let resume = self.resumeAfterInterruption && self.wantsPlaying && options.contains(.shouldResume)
                self.resumeAfterInterruption = false
                if resume { self.command("play", source: "interruption") { _ in } }
            }
        }
    }

    func routeChange(_ n: Notification) {
        if n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
            DispatchQueue.main.async { self.command("pause", source: "route") { _ in } }
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard active, self.player === player else { return }
        if flag && wantsPlaying {
            do { try select((index + 1) % 2, playing: true); publish("advance") }
            catch { wantsPlaying = false; publish("failed") }
        }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard self.player === player else { return }
        wantsPlaying = false; timer?.invalidate(); timer = nil
        MoraPlaybackJournal.record("native.probe.decodeFailed")
        publish("failed")
    }

    deinit {
        timer?.invalidate(); player?.stop()
        for (command, target) in targets { command.removeTarget(target) }
    }
}
