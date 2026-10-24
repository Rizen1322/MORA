import AVFoundation
import MediaPlayer
import Combine
import UIKit

/// First native playback slice. No JavaScript in the render callback and no localhost backend.
/// Transition rendering and stem separation are separate milestones, not claimed here.
@MainActor
final class NativePlayer: NSObject, ObservableObject {
    @Published private(set) var current: LocalTrack?
    @Published private(set) var isPlaying = false
    @Published private(set) var position: Double = 0
    @Published var error: String?
    private var engine = AVAudioEngine()
    private var node = AVAudioPlayerNode()
    private var file: AVAudioFile?
    private var library: LocalLibrary?
    private var queue: [LocalTrack] = []
    private var index = 0
    private var startOffset: Double = 0
    private var generation = 0
    private var timer: Timer?
    private var resumeAfterInterruption = false
    private var commands: [(MPRemoteCommand, Any)] = []
    private var artwork: MPMediaItemArtwork?
    private var lastInfoSecond = -1
    private var lastCheckpoint = Date.distantPast

    override init() {
        super.init()
        attachGraph()
        registerCommands()
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(mediaReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func attachGraph() {
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: nil)
        // Provisional headroom until measured LUFS/true-peak normalization is ported.
        engine.mainMixerNode.outputVolume = 0.5
    }

    func play(_ track: LocalTrack, from tracks: [LocalTrack], library: LocalLibrary) {
        guard let selected = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        self.library = library; queue = tracks; index = selected
        loadCurrent()
    }

    /// Restore context only: launching MORA must not start audio or interrupt another app.
    func restore(from library: LocalLibrary) {
        guard current == nil, queue.isEmpty else { return }
        self.library = library
        do {
            guard let saved = try PlaybackBookmarkStore(directory: library.directory).load() else { return }
            let byID = Dictionary(library.tracks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var restored: [LocalTrack] = []
            var selected: Int?
            for (i, id) in saved.queue.enumerated() {
                guard let track = byID[id] else { continue }
                restored.append(track)
                if i == saved.index { selected = restored.count - 1 }
            }
            guard let selected = selected else { return }
            queue = restored; index = selected; current = restored[selected]
            position = min(saved.position, restored[selected].duration)
            startOffset = position
            if let url = library.artworkURL(for: restored[selected]), let image = ArtworkCache.image(at: url) {
                artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            }
            // Do not claim system Now Playing merely because the app was opened.
        } catch { self.error = "Не удалось восстановить позицию. Музыкальные файлы сохранены. \(error.localizedDescription)" }
    }

    func checkpoint(force: Bool = true) {
        guard let library = library, queue.indices.contains(index), current?.id == queue[index].id else { return }
        if !force && Date().timeIntervalSince(lastCheckpoint) < 10 { return }
        lastCheckpoint = Date()
        do {
            try PlaybackBookmarkStore(directory: library.directory).save(PlaybackBookmark(queue: queue.map(\.id), index: index, position: min(86400, max(0, position))))
        } catch { self.error = "Не удалось сохранить позицию: \(error.localizedDescription)" }
    }

    private func loadCurrent(at seconds: Double = 0) {
        guard queue.indices.contains(index), let library = library else { return }
        generation += 1; node.stop(); isPlaying = false
        current = queue[index]; position = 0; startOffset = 0
        artwork = nil
        if let url = library.artworkURL(for: queue[index]), let image = ArtworkCache.image(at: url) {
            artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        do {
            file = try AVAudioFile(forReading: library.url(for: queue[index]))
            try schedule(at: seconds, playing: true)
            error = nil
        } catch { file = nil; self.error = error.localizedDescription; updateNowPlaying() }
    }

    func toggle() { isPlaying ? pause() : resume() }
    func pause() {
        tick(); node.pause(); engine.pause(); isPlaying = false; resumeAfterInterruption = false
        updateNowPlaying()
        checkpoint()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func resume() {
        guard file != nil else { if let current = current { loadCurrent(at: position >= current.duration - 0.1 ? 0 : position) }; return }
        do {
            try activate()
            if !engine.isRunning { try engine.start() }
            node.play(); isPlaying = true; error = nil; updateNowPlaying()
        } catch { self.error = error.localizedDescription }
    }
    func next() { guard index + 1 < queue.count else { pause(); return }; index += 1; loadCurrent() }
    func previous() { if position > 3 || index == 0 { seek(0) } else { index -= 1; loadCurrent() } }
    func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        do {
            if file == nil, let current = current, let library = library { file = try AVAudioFile(forReading: library.url(for: current)) }
            guard file != nil else { return }
            try schedule(at: seconds, playing: isPlaying); error = nil
        }
        catch { isPlaying = false; self.error = error.localizedDescription; updateNowPlaying() }
    }
    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        try session.setActive(true)
    }
    private func schedule(at seconds: Double, playing: Bool) throws {
        guard let file = file, file.length > 0 else { return }
        generation += 1
        let token = generation
        node.stop()
        engine.stop()
        let rate = file.processingFormat.sampleRate
        let bounded = min(max(0, seconds), Double(file.length - 1) / rate)
        let start = min(file.length - 1, max(0, AVAudioFramePosition(bounded * rate)))
        startOffset = Double(start) / rate; position = startOffset
        // Explicit file format lets the engine convert 44.1/48/96 kHz to the hardware rate.
        engine.disconnectNodeOutput(node)
        engine.connect(node, to: engine.mainMixerNode, format: file.processingFormat)
        let remaining = file.length - start
        guard remaining <= Int64(UInt32.max) else { throw CocoaError(.fileReadTooLarge) }
        node.scheduleSegment(file, startingFrame: start, frameCount: AVAudioFrameCount(remaining), at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.generation == token else { return }
                guard self.isPlaying else { self.file = nil; self.updateNowPlaying(); return }
                if self.index + 1 < self.queue.count { self.next() }
                else {
                    self.isPlaying = false; self.position = self.current?.duration ?? 0
                    self.node.stop(); self.engine.stop()
                    self.file = nil; self.updateNowPlaying()
                    self.checkpoint()
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                }
            }
        }
        if playing {
            try activate()
            if !engine.isRunning { try engine.start() }
            node.play()
        }
        isPlaying = playing; updateNowPlaying(); checkpoint()
    }

    private func tick() {
        if isPlaying, let time = node.lastRenderTime, let playback = node.playerTime(forNodeTime: time), playback.sampleRate > 0 {
            position = min(current?.duration ?? .greatestFiniteMagnitude, startOffset + Double(playback.sampleTime) / playback.sampleRate)
            if Int(position) != lastInfoSecond { updateNowPlaying() }
            checkpoint(force: false)
        }
    }
    private func updateNowPlaying() {
        lastInfoSecond = Int(position)
        guard let current = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        var info: [String: Any] = [MPMediaItemPropertyTitle: current.title, MPMediaItemPropertyArtist: current.artist,
            MPMediaItemPropertyPlaybackDuration: current.duration, MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0]
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
    private func registerCommands() {
        let center = MPRemoteCommandCenter.shared()
        func bind(_ command: MPRemoteCommand, _ action: @escaping @MainActor () -> Void) {
            let token = command.addTarget { _ in Task { @MainActor in action() }; return .success }
            commands.append((command, token))
        }
        bind(center.playCommand) { [weak self] in self?.resume() }
        bind(center.pauseCommand) { [weak self] in self?.pause() }
        bind(center.togglePlayPauseCommand) { [weak self] in self?.toggle() }
        bind(center.nextTrackCommand) { [weak self] in self?.next() }
        bind(center.previousTrackCommand) { [weak self] in self?.previous() }
        let token = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let time = event.positionTime
            Task { @MainActor in self?.seek(time) }
            return .success
        }
        commands.append((center.changePlaybackPositionCommand, token))
    }
    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            let playing = isPlaying; pause(); resumeAfterInterruption = playing
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            let shouldResume = resumeAfterInterruption && options.contains(.shouldResume)
            resumeAfterInterruption = false
            if shouldResume { resume() }
        }
    }
    @objc private func routeChanged(_ note: Notification) {
        if let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
           reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { pause() }
    }
    @objc private func mediaReset() {
        let saved = position
        generation += 1; isPlaying = false; resumeAfterInterruption = false
        engine = AVAudioEngine(); node = AVAudioPlayerNode(); attachGraph()
        do {
            if let current = current, let library = library {
                file = try AVAudioFile(forReading: library.url(for: current))
                try schedule(at: saved, playing: false)
            }
        } catch { file = nil; self.error = error.localizedDescription }
        updateNowPlaying()
    }
}
