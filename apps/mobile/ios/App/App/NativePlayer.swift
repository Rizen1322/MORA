import AVKit
import Combine
import MediaPlayer
import SwiftUI
import UIKit

/// iPhone full player over the WebView while NativeMixHost plays. It reads native state only,
/// so it keeps working while WebContent is suspended or reloading.
final class NativePlayerHostingController: UIHostingController<NativePlayerView> {
    fileprivate var transitionController: NativePlayerTransitionController?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            rootView.model.finish()
        }
    }
}

private final class NativePlayerTransitionController: NSObject, UIViewControllerTransitioningDelegate, UIViewControllerAnimatedTransitioning, UIGestureRecognizerDelegate {
    weak var sourceView: UIView?
    private weak var presented: UIViewController?
    private var presenting = true
    private var interactive: UIPercentDrivenInteractiveTransition?
    private var drivesDismissal = false

    init(sourceView: UIView?) {
        self.sourceView = sourceView
        super.init()
    }

    func attachDismissGesture(to controller: UIViewController, interactive drivesDismissal: Bool) {
        self.presented = controller
        self.drivesDismissal = drivesDismissal
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        controller.view.addGestureRecognizer(pan)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let presented, presented.presentedViewController == nil, !presented.isBeingDismissed,
              let pan = gestureRecognizer as? UIPanGestureRecognizer, let view = pan.view else { return false }
        let velocity = pan.velocity(in: view)
        return velocity.y > 0 && velocity.y > abs(velocity.x) * 1.2
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let view = gestureRecognizer.view
        var cursor = touch.view
        while let current = cursor, current !== view {
            if current is UISlider { return false }
            if let scroll = current as? UIScrollView, scroll.contentOffset.y > -scroll.adjustedContentInset.top + 2 {
                return false
            }
            cursor = current.superview
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Let a scroll view at the top give way to dismissal. With system zoom, its own pan can still lead.
        if let scroll = other.view as? UIScrollView, other === scroll.panGestureRecognizer { return true }
        return !drivesDismissal && other is UIPanGestureRecognizer
    }

    @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
        guard let presented else { return }
        let translation = pan.translation(in: pan.view)
        let dy = max(0, translation.y)
        let vy = pan.velocity(in: pan.view).y
        if !drivesDismissal {
            // UIKit handles its interactive zoom first. This path covers drags its recognizer misses.
            guard pan.state == .ended, dy > abs(translation.x) * 1.2,
                  (dy >= 64 && vy > -100) || (dy >= 18 && vy >= 480),
                  presented.presentedViewController == nil, !presented.isBeingDismissed,
                  presented.transitionCoordinator == nil else { return }
            presented.presentingViewController?.dismiss(animated: true)
            return
        }
        let height = max(320, pan.view?.bounds.height ?? 700)
        let progress = min(1, dy / (height * 0.45))
        switch pan.state {
        case .began:
            let driver = UIPercentDrivenInteractiveTransition()
            interactive = driver
            presented.presentingViewController?.dismiss(animated: true)
        case .changed:
            interactive?.update(progress)
        case .ended, .cancelled, .failed:
            guard let driver = interactive else { break }
            interactive = nil
            if pan.state == .ended && (progress > 0.28 || vy > 700) {
                driver.finish()
            } else {
                driver.cancel()
            }
        default:
            break
        }
    }

    func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        self.presenting = true
        return self
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        self.presenting = false
        return self
    }

    func interactionControllerForDismissal(using animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        interactive
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        0.44
    }

    func animateTransition(using ctx: UIViewControllerContextTransitioning) {
        let container = ctx.containerView
        guard let fromVC = ctx.viewController(forKey: .from),
              let toVC = ctx.viewController(forKey: .to) else {
            ctx.completeTransition(false)
            return
        }
        let reduce = UIAccessibility.isReduceMotionEnabled
        let targetFrame = ctx.finalFrame(for: toVC)
        let pillFrame: CGRect = {
            if let sourceView, sourceView.window != nil {
                return sourceView.convert(sourceView.bounds, to: container)
            }
            return CGRect(x: 14, y: container.bounds.height - 130, width: max(120, container.bounds.width - 28), height: 56)
        }()

        if presenting {
            guard let toView = ctx.view(forKey: .to) else { ctx.completeTransition(false); return }
            let dim = UIView(frame: container.bounds)
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            dim.alpha = 0
            container.addSubview(dim)
            toView.frame = reduce ? targetFrame : pillFrame
            toView.layer.cornerCurve = .continuous
            toView.layer.cornerRadius = reduce ? 0 : pillFrame.height / 2
            toView.layer.masksToBounds = true
            if reduce { toView.alpha = 0 }
            container.addSubview(toView)
            let snapshot = sourceView?.snapshotView(afterScreenUpdates: false)
            if !reduce, let snapshot {
                snapshot.frame = toView.bounds
                snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                toView.addSubview(snapshot)
            }
            sourceView?.isHidden = true

            let animator = UIViewPropertyAnimator(duration: reduce ? 0.2 : 0.44, dampingRatio: reduce ? 1.0 : 0.88) {
                dim.alpha = 1
                toView.frame = targetFrame
                toView.layer.cornerRadius = 0
                toView.alpha = 1
                snapshot?.alpha = 0
                if !reduce { fromVC.view.transform = CGAffineTransform(scaleX: 0.95, y: 0.95) }
            }
            animator.addCompletion { _ in
                dim.removeFromSuperview()
                snapshot?.removeFromSuperview()
                fromVC.view.transform = .identity
                let completed = !ctx.transitionWasCancelled
                if !completed { self.sourceView?.isHidden = false }
                ctx.completeTransition(completed)
            }
            animator.startAnimation()
        } else {
            guard let fromView = ctx.view(forKey: .from) else { ctx.completeTransition(false); return }
            let dim = UIView(frame: container.bounds)
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            container.insertSubview(dim, belowSubview: fromView)
            fromView.layer.cornerCurve = .continuous
            fromView.layer.masksToBounds = true
            let animator = UIViewPropertyAnimator(duration: reduce ? 0.18 : 0.40, dampingRatio: reduce ? 1.0 : 0.9) {
                dim.alpha = 0
                fromVC.view.transform = .identity
                toVC.view.transform = .identity
                if reduce {
                    fromView.alpha = 0
                } else {
                    fromView.frame = pillFrame
                    fromView.layer.cornerRadius = pillFrame.height / 2
                    fromView.alpha = 0.2
                }
            }
            animator.addCompletion { _ in
                dim.removeFromSuperview()
                toVC.view.transform = .identity
                let completed = !ctx.transitionWasCancelled
                if completed {
                    self.sourceView?.isHidden = false
                } else {
                    fromView.frame = container.bounds
                    fromView.layer.cornerRadius = 0
                    fromView.alpha = 1
                }
                ctx.completeTransition(completed)
            }
            animator.startAnimation()
        }
    }
}

enum NativePlayerSheet {
    /// `finished` receives "close" or "more" («Ещё»: the page opens its own full player).
    static func present(host: NativeMixHost, from parent: UIViewController, sourceView: UIView? = nil, finished: @escaping (String) -> Void) {
        let resolvedSource = sourceView ?? (parent as? MoraRootViewController)?.miniPlayerSourceView
        let model = NativePlayerModel(host: host)
        let controller = NativePlayerHostingController(rootView: NativePlayerView(model: model))
        model.controller = controller
        model.onFinish = finished
        controller.overrideUserInterfaceStyle = .dark
        controller.view.backgroundColor = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
        let delegate = NativePlayerTransitionController(sourceView: resolvedSource)
        controller.transitionController = delegate
        if #available(iOS 18.0, *), let resolvedSource {
            let options = UIViewController.Transition.ZoomOptions()
            options.dimmingColor = UIColor.black.withAlphaComponent(0.45)
            controller.preferredTransition = .zoom(options: options) { [weak parent, weak resolvedSource] _ in
                resolvedSource ?? (parent as? MoraRootViewController)?.miniPlayerSourceView
            }
            delegate.attachDismissGesture(to: controller, interactive: false)
        } else if resolvedSource != nil {
            controller.modalPresentationStyle = .custom
            controller.transitioningDelegate = delegate
            delegate.attachDismissGesture(to: controller, interactive: true)
        } else {
            controller.modalPresentationStyle = .pageSheet
            controller.sheetPresentationController?.prefersGrabberVisible = true
            delegate.attachDismissGesture(to: controller, interactive: false)
        }
        parent.present(controller, animated: true)
    }
}

final class NativePlayerModel: ObservableObject {
    @Published var state = NativePlayerState()
    @Published private(set) var artwork: UIImage?
    @Published private(set) var artists: [NativeCatalogLink] = []
    @Published private(set) var albumPath: String?
    private var navigationTrack = ""
    /// The seek target from the moment the finger lifts until the host reports it.
    @Published var scrub: Double?
    @Published private(set) var reaction = 0
    @Published private(set) var modes = NativePlaybackModes()
    @Published private(set) var changingMode = false
    @Published var actionError: String?
    @Published private(set) var banner: String?
    @Published private(set) var offline = false
    @Published private(set) var automixStyle = "auto"
    @Published var playlistTarget: [NativeTrack] = []
    /// When `state.position` was read: the scrubber runs the clock on from there between polls.
    private(set) var receivedAt = Date()
    weak var controller: UIViewController?
    var onFinish: ((String) -> Void)?
    private var action = "close"
    private let host: NativeMixHost
    private var timer: Timer?
    private var artworkKey = ""

    init(host: NativeMixHost) {
        self.host = host
        if let store = NativeShellStore.shared {
            self.modes = store.ui.playback
            self.banner = store.banner
            self.offline = store.offline
            if store.nativePlaying {
                let p = store.player
                self.state = NativePlayerState([
                    "active": true,
                    "playing": p.playing,
                    "position": store.playbackProgress.position,
                    "duration": store.playbackProgress.duration,
                    "entryId": p.entryId,
                    "currentTrack": ["trackId": p.trackId, "title": p.title, "artist": p.artist],
                ])
                self.artwork = store.artwork ?? store.byId[p.trackId]?.cover.flatMap { NativeCovers.cached($0) }
                self.reaction = store.reaction(p.trackId)
                if !p.trackId.isEmpty { loadNavigation(p.trackId) }
            } else if let now = store.ui.now {
                self.state = NativePlayerState([
                    "active": true,
                    "playing": now.playing,
                    "position": now.position,
                    "duration": now.duration,
                    "entryId": now.entryId,
                    "currentTrack": ["trackId": now.id, "title": now.title, "artist": now.artist],
                ])
                self.artwork = now.cover.flatMap { NativeCovers.cached($0) }
                self.reaction = store.reaction(now.id)
                if !now.id.isEmpty { loadNavigation(now.id) }
            }
            store.$ui.map(\.playback).removeDuplicates().assign(to: &$modes)
            store.$banner.assign(to: &$banner)
            store.$offline.assign(to: &$offline)
        }
    }
    #if DEBUG
    var visualCheck = false
    @Published var visualShowLyrics = false
    func installVisualFixture() {
        visualCheck = true
        receivedAt = Date()
        state = NativePlayerState(["active": true, "playing": true, "duration": 180.0, "position": 160.0,
            "entryId": "visual-a", "currentTrack": ["title": "MORA · Native Player", "artist": "Проверка интерфейса", "trackId": "visual-a"],
            "blend": ["index": 1, "progress": 0.4], "upcoming": [["entryId": "visual-b", "title": "Следующий трек", "artist": "Очередь AutoMix", "transition": ["method": "beatmatch_blend"]]]])
        modes = NativeShellStore.shared?.ui.playback ?? NativePlaybackModes()
        artists = [NativeCatalogLink(["id": "77", "title": "Native Artist", "path": "/catalog/artist/77"])!]
        albumPath = "/catalog/album/88"
        artwork = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 600)).image { ctx in
            UIColor(Color.moraMint).setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
            UIImage(systemName: "waveform", withConfiguration: UIImage.SymbolConfiguration(pointSize: 250))?.withTintColor(.black).draw(in: CGRect(x: 100, y: 170, width: 400, height: 260))
        }
    }
    #endif

    /// Polls only while the sheet is on screen and the app is in the foreground.
    func start() {
        #if DEBUG
        if visualCheck { return }
        #endif
        if NativeShellStore.shared?.sharedLibrary == true {
            Task { @MainActor in
                if let settings = try? await NativeServerApp.request("GET", "/api/settings"),
                   let automix = settings["automix"] as? [String: Any] {
                    let enabled = automix["enabled"] as? Bool ?? true
                    let style = automix["style"] as? String ?? "auto"
                    self.automixStyle = enabled ? style : "off"
                }
            }
        }
        guard timer == nil else { return }
        refresh()
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
    func stop() { timer?.invalidate(); timer = nil }

    func refresh(then: (() -> Void)? = nil) {
        host.playerState { [weak self] result in
            defer { then?() }
            guard let self, case .success(let value) = result else { return }
            var next = NativePlayerState(value)
            let restored = !next.active ? NativeShellStore.shared?.ui.now : nil
            if let restored {
                next = NativePlayerState(["active": true, "playing": restored.playing, "entryId": restored.entryId,
                    "position": restored.position, "duration": restored.duration,
                    "currentTrack": ["trackId": restored.id, "title": restored.title, "artist": restored.artist]])
            }
            // Show the requested queue immediately, while native resolves/copies its sources in batches.
            if let store = NativeShellStore.shared, let at = store.queue.firstIndex(where: { $0.entryId == next.entryId }) {
                let planned = Dictionary(next.upcoming.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                let known = Set(store.queue.dropFirst(at + 1).map(\.entryId))
                next.upcoming = store.queue.dropFirst(at + 1).compactMap { entry in
                    if let row = planned[entry.entryId] { return row }
                    guard let track = store.byId[entry.trackId] else { return nil }
                    return NativePlayerRow(id: entry.entryId, trackId: track.id, title: track.title, artist: track.artist, automix: false, cover: track.cover, artwork: nil)
                } + next.upcoming.filter { !known.contains($0.id) }
            }
            self.reaction = NativeShellStore.shared?.reaction(next.trackId) ?? 0
            if !next.active { self.stop(); self.close("close"); return }
            if next.entryId != self.state.entryId { self.scrub = nil }
            self.receivedAt = Date()
            if next != self.state { self.state = next }
            if next.trackId != self.navigationTrack { self.loadNavigation(next.trackId) }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                self.artwork = (value["artwork"] as? MPMediaItemArtwork)?.image(at: CGSize(width: 600, height: 600))
                if let cover = restored?.cover {
                    Task { @MainActor in
                        let image = await NativeCovers.image(cover)
                        if self.artworkKey == key { self.artwork = image }
                    }
                }
            }
        }
    }

    /// The same command path as the lock screen.
    private func send(_ action: String, time: Double? = nil, then: (() -> Void)? = nil) {
        // `then` runs once the post-command state is shown, so a seek target never flashes back to the old position.
        if !host.active, let store = NativeShellStore.shared {
            Task { @MainActor in
                do {
                    if store.sharedLibrary {
                        try await NativeQueueController.shared.command(action, seekTime: time)
                    } else {
                        var args: [String: Any] = ["action": action]
                        if let time { args["time"] = time }
                        _ = try await store.call("playerCommand", args)
                    }
                } catch { self.actionError = error.localizedDescription }
                self.refresh(then: then)
            }
            return
        }
        host.command(action, time: time, source: "player") { [weak self] _ in
            if let self {
                if action == "pause" || action == "seekto" {
                    Task { @MainActor in NativeQueueController.shared.saveCurrentPosition() }
                }
                self.refresh(then: then)
            } else { then?() }
        }
    }
    func transport(_ action: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if action == "play" || action == "pause" { state.playing = action == "play" }
        send(action)
    }
    func seek(to time: Double) {
        scrub = time
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send("seekto", time: time) { [weak self] in
            if self?.scrub == time { self?.scrub = nil }
        }
    }

    func playbackMode(_ mode: String) {
        guard !changingMode, let store = NativeShellStore.shared else { return }
        changingMode = true
        UISelectionFeedbackGenerator().selectionChanged()
        Task { @MainActor in
            defer { changingMode = false }
            do {
                if store.sharedLibrary {
                    try await NativeQueueController.shared.setMode(mode)
                    let qc = NativeQueueController.shared
                    modes = NativePlaybackModes([
                        "shuffle": qc.shuffle,
                        "repeat": qc.repeatMode,
                        "automix": mode == "automix" ? !modes.automix : modes.automix,
                        "canShuffle": qc.entries.count > 1,
                    ])
                } else {
                    modes = NativePlaybackModes(try await store.call("playbackMode", ["mode": mode]) as? [String: Any] ?? [:])
                }
            }
            catch { if !NativeShellStore.isCancelled(error) { actionError = error.localizedDescription } }
        }
    }

    func setAutomixStyle(_ style: String) {
        guard !changingMode, let store = NativeShellStore.shared else { return }
        changingMode = true
        UISelectionFeedbackGenerator().selectionChanged()
        var automix: [String: Any] = ["enabled": style != "off"]
        if style != "off" { automix["style"] = style }
        let body: [String: Any] = ["automix": automix]
        let labels = ["auto": "Авто", "smooth": "Плавное сведение", "tight": "Короткое сведение", "off": "Выключен"]
        let label = labels[style] ?? style
        Task<Void, Never> { @MainActor in
            defer { changingMode = false }
            do {
                if store.sharedLibrary {
                    try await NativeQueueController.shared.setAutomixStyle(style)
                } else {
                    _ = try await NativeServerApp.request("PUT", "/api/settings", body: body)
                }
                automixStyle = style
                modes.automix = style != "off"
                store.show("AutoMix: \(label)")
            } catch {
                if !NativeShellStore.isCancelled(error) { actionError = error.localizedDescription }
            }
        }
    }

    private static func unpackTrackLinks(_ value: ([NativeCatalogLink], String?)) -> (artists: [NativeCatalogLink], albumPath: String?) {
        (value.0, value.1)
    }
    private static func unpackTrackLinks(_ value: (String?, [NativeCatalogLink])) -> (artists: [NativeCatalogLink], albumPath: String?) {
        (value.1, value.0)
    }
    private static func unpackTrackLinks(_ value: [String: Any]) -> (artists: [NativeCatalogLink], albumPath: String?) {
        let artists = (value["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
        let albumPath = (value["album"] as? String) ?? (value["albumPath"] as? String)
        return (artists, albumPath)
    }

    private func loadNavigation(_ id: String) {
        guard !id.isEmpty, let store = NativeShellStore.shared else { return }
        navigationTrack = id; artists = []; albumPath = nil
        Task { @MainActor in
            if store.sharedLibrary, let raw = store.localTrackLinks(id: id) {
                guard state.trackId == id else { return }
                let links = Self.unpackTrackLinks(raw)
                artists = links.artists
                albumPath = links.albumPath
                return
            }
            do {
                let value = try await store.call("trackLinks", ["id": id]) as? [String: Any]
                guard state.trackId == id else { return }
                artists = (value?["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
                albumPath = value?["album"] as? String
            } catch { if navigationTrack == id { navigationTrack = "" } }
        }
    }

    func navigate(_ path: String) {
        controller?.presentingViewController?.dismiss(animated: true) { NativeShellStore.shared?.go(path) }
    }

    func open(_ destination: String) {
        if destination == "album", let albumPath { navigate(albumPath); return }
        if destination == "artist", let artist = artists.first { navigate(artist.path); return }
        let id = state.trackId
        guard let store = NativeShellStore.shared else { return }
        Task { @MainActor in
            if store.sharedLibrary, let raw = store.localTrackLinks(id: id) {
                guard state.trackId == id else { return }
                let links = Self.unpackTrackLinks(raw)
                artists = links.artists
                albumPath = links.albumPath
                if let path = destination == "album" ? links.albumPath : links.artists.first?.path {
                    navigate(path)
                } else {
                    actionError = NativeShellError.page.localizedDescription
                }
                return
            }
            do {
                let value = try await store.call("trackLinks", ["id": id]) as? [String: Any]
                guard state.trackId == id else { return }
                let links = (value?["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
                guard let path = destination == "album" ? value?["album"] as? String : links.first?.path else { throw NativeShellError.page }
                navigate(path)
            } catch {
                if NativeShellStore.isCancelled(error) { return }
                actionError = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
            }
        }
    }

    func versions() {
        NativeShellStore.shared?.presentVersions(id: state.trackId, from: controller)
    }

    func addToPlaylist() {
        guard !state.trackId.isEmpty else { return }
        let track = NativeShellStore.shared?.byId[state.trackId]
            ?? NativeTrack(["id": state.trackId, "title": state.title, "artist": state.artist, "duration": state.duration])
        if let track { playlistTarget = [track] }
    }

    /// The page owns the queue (lib/native-ui.ts `queueEdit`); its next snapshot redraws the list.
    func editQueue(_ action: String, _ entry: String, after: String? = nil) {
        guard let store = NativeShellStore.shared else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        var args: [String: Any] = ["action": action, "entry": entry]
        if let after { args["after"] = after }
        Task { @MainActor in
            do {
                if store.sharedLibrary {
                    try await NativeQueueController.shared.editQueue(action: action, entryId: entry, after: after)
                } else {
                    _ = try await store.call("queueEdit", args)
                }
            }
            catch {
                if NativeShellStore.isCancelled(error) { refresh(); return }
                actionError = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
            }
            refresh()
        }
    }

    func react(_ value: Int) {
        guard let store = NativeShellStore.shared else { return }
        reaction = reaction == value ? 0 : value
        store.react(id: state.trackId, value: reaction)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func close(_ action: String) {
        self.action = action
        // From the presenter: dismissing this controller would only close the queue sheet above it.
        controller?.presentingViewController?.dismiss(animated: true)
    }
    /// Also reached by swipe-down, which dismisses without close().
    func finish() {
        stop()
        onFinish?(action); onFinish = nil
    }
}

/// Sleep timer of native playback. The page's timer (lib/sleepTimer.ts) cannot run while WebContent is
/// suspended in the background, so this one lives next to the host: a wall-clock deadline (a phone that slept
/// past it pauses on the next tick) or the end of the current track, where an AutoMix blend counts as the end.
final class NativeSleepTimer: ObservableObject {
    static let shared = NativeSleepTimer()
    enum Mode: Equatable { case until(Date), endOfTrack(entryId: String), tracks(remaining: Int, entryId: String) }
    @Published private(set) var mode: Mode?
    private var timer: Timer?

    func set(_ mode: Mode?) {
        self.mode = mode
        NativeMixHost.shared.sleepGain(1)
        timer?.invalidate(); timer = nil
        guard mode != nil else { return }
        // Audio playback keeps the app running in the background, so the main run loop keeps ticking.
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        guard let mode else { return }
        let host = NativeMixHost.shared
        switch mode {
        case .until(let date):
            let seconds = date.timeIntervalSinceNow
            if seconds <= 0 { finish(host) } else { host.sleepGain(NativeSleepStep.fade(seconds: seconds)) }
        case .endOfTrack(let entry): checkTracks(host, count: 1, entry: entry, expected: mode)
        case .tracks(let count, let entry): checkTracks(host, count: count, entry: entry, expected: mode)
        }
    }

    private func checkTracks(_ host: NativeMixHost, count: Int, entry: String, expected: Mode) {
        host.playerState { [weak self] result in
            guard let self, self.mode == expected, case .success(let value) = result else { return }
            let step = NativeSleepStep.evaluate(remaining: count, entryId: entry, state: NativePlayerState(value))
            if step.finished { self.finish(host); return }
            if step.entryId != entry { self.mode = .tracks(remaining: step.remaining, entryId: step.entryId) }
            host.sleepGain(step.gain)
        }
    }

    private func finish(_ host: NativeMixHost) {
        host.command("pause", source: "player") { _ in }
        set(nil)
    }

    /// «23 мин», «конец трека», nil when off.
    var label: String? {
        switch mode {
        case .until(let date): return "\(max(1, Int((date.timeIntervalSinceNow / 60).rounded(.up)))) мин"
        case .endOfTrack: return "конец трека"
        case .tracks(let count, _): return "ещё треков: \(count)"
        case nil: return nil
        }
    }
}

extension Color {
    static let moraBackground = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)
    static let moraSurface = Color(red: 13 / 255, green: 25 / 255, blue: 20 / 255)
    static let moraSurfaceElevated = Color(red: 20 / 255, green: 38 / 255, blue: 30 / 255)
    static let moraMint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
    static let moraGold = Color(red: 245 / 255, green: 200 / 255, blue: 110 / 255)
}

private enum NativeCoverPalette {
    struct Colors: Equatable {
        let primary: Color
        let secondary: Color

        static let fallback = Colors(
            primary: Color(red: 0.08, green: 0.22, blue: 0.16),
            secondary: Color(red: 0.04, green: 0.14, blue: 0.10)
        )
    }

    private final class Entry {
        weak var image: UIImage?
        let colors: Colors

        init(image: UIImage, colors: Colors) {
            self.image = image
            self.colors = colors
        }
    }

    private static let lock = NSLock()
    private static var cache: [ObjectIdentifier: Entry] = [:]
    private static var order: [ObjectIdentifier] = []
    private static let maxEntries = 24

    static func colors(for image: UIImage?) -> Colors {
        guard let image else { return .fallback }
        let key = ObjectIdentifier(image)
        lock.lock()
        if let entry = cache[key], entry.image === image {
            if order.last != key {
                order.removeAll { $0 == key }
                order.append(key)
            }
            lock.unlock()
            return entry.colors
        }
        lock.unlock()

        let computed = extract(from: image)

        lock.lock()
        cache[key] = Entry(image: image, colors: computed)
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > maxEntries {
            let evicted = order.removeFirst()
            cache.removeValue(forKey: evicted)
        }
        lock.unlock()
        return computed
    }

    private static func extract(from image: UIImage) -> Colors {
        guard let cgImage = image.cgImage else { return .fallback }
        var pixels = [UInt8](repeating: 0, count: 64)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let base = buffer.baseAddress,
                  let context = CGContext(
                      data: base,
                      width: 4,
                      height: 4,
                      bitsPerComponent: 8,
                      bytesPerRow: 16,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
                  ) else { return false }
            context.interpolationQuality = .medium
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 4, height: 4))
            return true
        }
        guard drawn else { return .fallback }

        struct Sample {
            let hue: CGFloat
            let saturation: CGFloat
            let brightness: CGFloat
            var score: CGFloat { saturation * (0.45 + 0.55 * brightness) }
        }

        var samples: [Sample] = []
        samples.reserveCapacity(16)

        for i in 0..<16 {
            let offset = i * 4
            let a = CGFloat(pixels[offset + 3]) / 255.0
            guard a >= 0.08 else { continue }
            let r = min(1.0, CGFloat(pixels[offset]) / 255.0 / a)
            let g = min(1.0, CGFloat(pixels[offset + 1]) / 255.0 / a)
            let b = min(1.0, CGFloat(pixels[offset + 2]) / 255.0 / a)

            var h: CGFloat = 0
            var s: CGFloat = 0
            var v: CGFloat = 0
            var alpha: CGFloat = 0
            guard UIColor(red: r, green: g, blue: b, alpha: 1).getHue(&h, saturation: &s, brightness: &v, alpha: &alpha) else {
                continue
            }
            guard v >= 0.08, s >= 0.08 else { continue }
            samples.append(Sample(hue: h, saturation: s, brightness: v))
        }

        guard !samples.isEmpty else { return .fallback }
        samples.sort { $0.score > $1.score }

        let first = samples[0]
        let primaryS = min(0.72, max(0.25, first.saturation))
        let primaryB = min(0.30, max(0.12, first.brightness))
        let primary = Color(hue: Double(first.hue), saturation: Double(primaryS), brightness: Double(primaryB))

        let distinct = samples.dropFirst().first { candidate in
            let diff = abs(candidate.hue - first.hue)
            return min(diff, 1.0 - diff) >= 0.08
        }

        let secondary: Color
        if let second = distinct {
            let secondaryS = min(0.72, max(0.25, second.saturation))
            let secondaryB = min(0.30, max(0.12, second.brightness))
            secondary = Color(hue: Double(second.hue), saturation: Double(secondaryS), brightness: Double(secondaryB))
        } else {
            let secondaryS = min(0.72, max(0.25, primaryS * 0.78))
            let secondaryB = min(0.30, max(0.12, primaryB * 0.62))
            secondary = Color(hue: Double(first.hue), saturation: Double(secondaryS), brightness: Double(secondaryB))
        }

        return Colors(primary: primary, secondary: secondary)
    }
}

private struct IconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).contentTransition(.symbolEffect(.replace)).font(.title3.weight(.semibold))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }
}

private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = UIColor.white.withAlphaComponent(0.7)
        view.activeTintColor = UIColor(red: 74 / 255, green: 222 / 255, blue: 154 / 255, alpha: 1)
        view.prioritizesVideoDevices = false
        view.accessibilityLabel = "Устройство вывода"
        return view
    }
    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

private struct HorizontalCoverSwipe: UIViewRepresentable {
    var enabled: Bool
    var onDrag: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat) -> Void
    var onDoubleTap: (() -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handlePan(_:)))
        pan.delegate = context.coordinator
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = context.coordinator
        view.addGestureRecognizer(doubleTap)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: HorizontalCoverSwipe
        init(parent: HorizontalCoverSwipe) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard parent.enabled else { return false }
            if let pan = gestureRecognizer as? UIPanGestureRecognizer {
                let v = pan.velocity(in: pan.view)
                return abs(v.x) > abs(v.y) * 1.15
            }
            return true
        }

        @objc func handlePan(_ pan: UIPanGestureRecognizer) {
            let translation = pan.translation(in: pan.view)
            let velocity = pan.velocity(in: pan.view)
            switch pan.state {
            case .began, .changed:
                parent.onDrag(translation.x)
            case .ended, .cancelled, .failed:
                parent.onEnd(translation.x, velocity.x)
            default:
                break
            }
        }

        @objc func handleDoubleTap(_ tap: UITapGestureRecognizer) {
            if tap.state == .ended, parent.enabled {
                parent.onDoubleTap?()
            }
        }
    }
}

struct NativePlayerView: View {
    private enum PlayerPanel { case cover, lyrics, queue }

    @ObservedObject var model: NativePlayerModel
    @ObservedObject private var sleep = NativeSleepTimer.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var panel: PlayerPanel = .cover
    @State private var lyricsRefreshToken = 0
    @State private var coverDragOffset: CGFloat = 0
    @State private var swipeDirection: Int = 0
    @State private var prevTapCount = 0
    @State private var nextTapCount = 0
    @State private var showLikeBurst = false
    @State private var likeBurstGeneration = 0
    @Namespace private var playerLayout

    private var queueOpen: Bool { panel == .queue }
    private var showLyrics: Bool { panel == .lyrics }

    var body: some View {
        let s = model.state
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.28))
                .frame(width: 36, height: 5)
                .padding(.top, 2)
                .padding(.bottom, 6)
                .accessibilityHidden(true)
            if !showLyrics {
                HStack {
                    IconButton(symbol: "chevron.down", label: "Свернуть плеер") { model.close("close") }
                        .buttonStyle(MoraPressStyle(scale: 0.88))
                    Spacer()
                    VStack(spacing: 3) {
                        Text(model.offline ? "Нет сети" : "Сейчас играет").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                            .accessibilityHidden(true)
                        if let badge = sourceBadge(for: s.trackId) {
                            Button { model.versions() } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: badge.icon).font(.system(size: 9, weight: .semibold))
                                    Text(badge.text).font(.caption2.weight(.semibold))
                                }
                                .foregroundStyle(Color.moraMint.opacity(0.92))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color.moraMint.opacity(0.14), in: Capsule())
                                .overlay(Capsule().stroke(Color.moraMint.opacity(0.24), lineWidth: 0.6))
                            }
                            .buttonStyle(MoraPressStyle(scale: 0.94))
                            .accessibilityLabel("Источник: \(badge.text). Выбрать другую версию")
                        }
                    }
                    Spacer()
                    Menu {
                        trackMenuItems(s)
                    } label: {
                        Image(systemName: "ellipsis").font(.title3.weight(.semibold)).frame(width: 44, height: 44)
                    }
                    .buttonStyle(MoraPressStyle(scale: 0.88))
                    .accessibilityLabel("Действия с треком")
                }
                .padding(.horizontal, -10)
            }
            if showLyrics {
                compactLyricsHeader(s)
                    .padding(.top, 4)
                    .padding(.bottom, 6)
                NativeLyricsView(model: model, externalRefresh: lyricsRefreshToken)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 16)))
            } else if queueOpen {
                Spacer(minLength: 12)
                HStack(spacing: 12) {
                    NativeCover(url: nil, radius: 10, image: model.artwork, monogram: s.title, aspectSquare: true)
                        .frame(width: 64, height: 64)
                        .matchedGeometryEffect(id: "cover", in: playerLayout)
                    metadata.matchedGeometryEffect(id: "metadata", in: playerLayout)
                }
                NativeQueueContent(model: model).frame(maxHeight: .infinity)
                    .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 16)))
            } else {
                Spacer(minLength: 12)
                cover(playing: s.playing).matchedGeometryEffect(id: "cover", in: playerLayout)
                Spacer(minLength: 14)
                metadata.matchedGeometryEffect(id: "metadata", in: playerLayout)
            }
            NativeScrubber(state: s, receivedAt: model.receivedAt, pending: model.scrub) { model.seek(to: $0) }
                .padding(.top, showLyrics ? 8 : 18)
            transport(playing: s.playing).padding(.vertical, showLyrics ? 8 : 12)
            if !showLyrics { Spacer(minLength: 8) }
            NativeSystemVolume().frame(height: 32).padding(.top, showLyrics ? 6 : 12)
            HStack {
                IconButton(symbol: showLyrics ? "quote.bubble.fill" : "quote.bubble", label: showLyrics ? "Скрыть текст песни" : "Текст песни") {
                    panel = (panel == .lyrics) ? .cover : .lyrics
                }
                .buttonStyle(MoraPressStyle(scale: 0.88))
                .foregroundStyle(showLyrics ? .white : .white.opacity(0.7))
                .background(Circle().fill(Color.white.opacity(showLyrics ? 0.18 : 0)).frame(width: 42, height: 42))
                Spacer()
                sleepMenu
                Spacer()
                RoutePicker().frame(width: 44, height: 44)
                Spacer()
                IconButton(symbol: "list.bullet", label: queueOpen ? "Показать обложку" : "Очередь") {
                    panel = (panel == .queue) ? .cover : .queue
                }
                .buttonStyle(MoraPressStyle(scale: 0.88))
                .foregroundStyle(queueOpen ? Color.moraMint : .white.opacity(0.7))
                .background(Circle().fill(Color.moraMint.opacity(queueOpen ? 0.2 : 0)).frame(width: 42, height: 42))
            }
            .padding(.top, 10)
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .foregroundStyle(.white)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .background { backdrop.ignoresSafeArea() }
        .overlay(alignment: .top) {
            if let text = model.banner {
                Text(text).font(.footnote).padding(12).background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 58).padding(.horizontal, 20).allowsHitTesting(false)
                    .transition(.opacity).accessibilityHidden(true)
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.banner)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.44, dampingFraction: 0.85), value: panel)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.84), value: s.blending)
        .onChange(of: panel) { _, next in if next != .cover { coverDragOffset = 0 } }
        .onChange(of: s.entryId) { _, _ in
            if swipeDirection != 0 {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(450))
                    swipeDirection = 0
                }
            }
        }
        .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
        .alert("Не удалось выполнить действие", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(model.actionError ?? "") }
        .sheet(isPresented: Binding(get: { !model.playlistTarget.isEmpty }, set: { if !$0 { model.playlistTarget = [] } })) {
            if let store = NativeShellStore.shared {
                NativePlaylistPicker(tracks: model.playlistTarget).environmentObject(store)
                    .presentationBackground(Color.moraBackground)
                    .presentationDragIndicator(.visible)
                    .tint(.moraMint)
                    .preferredColorScheme(.dark)
            } else {
                NavigationStack {
                    Text("Медиатека недоступна").foregroundStyle(.secondary)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { model.playlistTarget = [] } } }
                }
                .presentationBackground(Color.moraBackground)
                .preferredColorScheme(.dark)
            }
        }
        .onAppear {
            model.start()
            #if DEBUG
            if model.visualCheck { Task { @MainActor in try? await Task.sleep(for: .seconds(4)); if !model.visualShowLyrics { panel = .queue } } }
            #endif
        }
        #if DEBUG
        .onChange(of: model.visualShowLyrics) { _, value in
            panel = value ? .lyrics : .cover
        }
        #endif
        .onDisappear {
            if !(model.controller is NativePlayerHostingController) {
                model.finish()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in model.stop() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in model.start() }

    }

    private func sourceBadge(for trackId: String) -> (text: String, icon: String)? {
        guard !trackId.isEmpty, let track = NativeShellStore.shared?.byId[trackId] else { return nil }
        let isOfflineCopy = track.offline || NativeDownloadManager.shared.localFile(trackId) != nil
        switch track.provider {
        case "yandex":
            return (isOfflineCopy ? "Яндекс · Офлайн" : "Яндекс", isOfflineCopy ? "arrow.down.circle.fill" : "music.note")
        case "youtube", "ytmusic":
            return (isOfflineCopy ? "YouTube · Офлайн" : "YouTube", isOfflineCopy ? "arrow.down.circle.fill" : "play.circle")
        case "soundcloud":
            return (isOfflineCopy ? "SoundCloud · Офлайн" : "SoundCloud", isOfflineCopy ? "arrow.down.circle.fill" : "cloud")
        default:
            return ("Медиатека", "internaldrive")
        }
    }

    @ViewBuilder private func trackMenuItems(_ s: NativePlayerState) -> some View {
        Button("Добавить в плейлист", systemImage: "text.badge.plus") { model.addToPlaylist() }.disabled(s.trackId.isEmpty)
        Button("Другая версия", systemImage: "arrow.triangle.swap") { model.versions() }
        if showLyrics {
            Button("Обновить текст", systemImage: "arrow.clockwise") { lyricsRefreshToken &+= 1 }
        }
        Menu("Стиль AutoMix", systemImage: "waveform.path") {
            ForEach([
                ("auto", "Авто"),
                ("smooth", "Длинные и плавные"),
                ("tight", "Короткие, по фразе"),
                ("off", "Выключен")
            ], id: \.0) { value, label in
                Button {
                    model.setAutomixStyle(value)
                } label: {
                    if model.automixStyle == value {
                        Label(label, systemImage: "checkmark")
                    } else {
                        Text(label)
                    }
                }
            }
        }
        Button("Перейти к исполнителю", systemImage: "music.mic") { model.open("artist") }
        Button("Перейти к альбому", systemImage: "square.stack") { model.open("album") }.disabled(model.albumPath == nil)
        if let url = URL(string: "mora://track/" + s.trackId), !s.trackId.isEmpty { ShareLink(item: url) { Label("Поделиться треком", systemImage: "square.and.arrow.up") } }
        Button("Звук и эквалайзер", systemImage: "slider.vertical.3") { model.navigate("/sound") }
    }

    private func compactLyricsHeader(_ s: NativePlayerState) -> some View {
        HStack(spacing: 12) {
            Button { panel = .cover } label: {
                NativeCover(url: nil, radius: 10, image: model.artwork, monogram: s.title, aspectSquare: true)
                    .frame(width: 56, height: 56)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.white.opacity(0.16), lineWidth: 0.75))
                    .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
            }
            .buttonStyle(MoraPressStyle(scale: 0.94))
            .matchedGeometryEffect(id: "cover", in: playerLayout)
            .accessibilityLabel("Показать обложку")
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title.isEmpty ? "MORA" : s.title)
                    .font(.headline.bold())
                    .lineLimit(1)
                    .foregroundStyle(.white)
                Text(s.artist)
                    .font(.subheadline)
                    .lineLimit(1)
                    .foregroundStyle(.white.opacity(0.68))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .matchedGeometryEffect(id: "metadata", in: playerLayout)
            Button { model.react(1) } label: {
                Image(systemName: model.reaction > 0 ? "heart.fill" : "heart")
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: model.reaction > 0)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(model.reaction > 0 ? Color.moraMint : .white.opacity(0.85))
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(MoraPressStyle(scale: 0.88))
            .accessibilityLabel(model.reaction > 0 ? "Убрать лайк" : "Нравится")
            Menu {
                trackMenuItems(s)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white.opacity(0.9))
                    .frame(width: 34, height: 34)
                    .background(Color.white.opacity(0.14), in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Действия с треком")
        }
    }

    private var sleepMenu: some View {
        Menu {
            if let label = sleep.label {
                Button("Выключить таймер (\(label))", systemImage: "moon.zzz", role: .destructive) { sleep.set(nil) }
            }
            ForEach([15, 30, 45, 60], id: \.self) { minutes in
                Button("\(minutes) минут") { sleep.set(.until(Date().addingTimeInterval(Double(minutes) * 60))) }
            }
            Button("В конце трека", systemImage: "music.note") { sleep.set(.endOfTrack(entryId: model.state.entryId)) }
                .disabled(model.state.entryId.isEmpty)
            ForEach([2, 5, 10, 20], id: \.self) { count in
                Button("После \(count) треков") { sleep.set(.tracks(remaining: count, entryId: model.state.entryId)) }
                    .disabled(model.state.entryId.isEmpty)
            }
        } label: {
            Image(systemName: sleep.mode == nil ? "moon" : "moon.fill").font(.title3.weight(.semibold))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(sleep.mode == nil ? .white.opacity(0.7) : Color.moraMint)
        .accessibilityLabel("Таймер сна")
        .accessibilityValue(sleep.label ?? "Выключен")
    }

    private var metadata: some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 4) {
                Button { model.open("album") } label: {
                    Text(model.state.title.isEmpty ? "MORA" : model.state.title).contentTransition(.opacity).font(.title2.bold()).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).disabled(model.albumPath == nil)
                    .accessibilityHint("Открыть альбом").accessibilityIdentifier("player.album")
                artistLine
            }.frame(maxWidth: .infinity, alignment: .leading)
            IconButton(symbol: model.reaction > 0 ? "heart.fill" : "heart", label: model.reaction > 0 ? "Убрать лайк" : "Нравится") { model.react(1) }
                .buttonStyle(MoraPressStyle(scale: 0.88))
                .symbolEffect(.bounce, value: model.reaction > 0)
                .foregroundStyle(model.reaction > 0 ? Color.moraMint : .white)
                .accessibilityValue(model.reaction > 0 ? "Включено" : "Выключено")
            IconButton(symbol: model.reaction < 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown", label: "Не нравится") { model.react(-1) }
                .buttonStyle(MoraPressStyle(scale: 0.88))
                .symbolEffect(.bounce, value: model.reaction < 0)
                .foregroundStyle(model.reaction < 0 ? Color.moraGold : .white.opacity(0.7))
                .accessibilityValue(model.reaction < 0 ? "Включено" : "Выключено")
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: model.state.entryId)
    }

    private var artistText: AttributedString {
        var value = AttributedString()
        for (index, artist) in model.artists.enumerated() {
            if index > 0 { value.append(AttributedString(", ")) }
            var part = AttributedString(artist.title)
            part.link = URL(string: "mora-native:" + artist.path)
            part.foregroundColor = Color.white.opacity(0.65)
            value.append(part)
        }
        return value
    }
    @ViewBuilder private var artistLine: some View {
        if model.artists.isEmpty {
            Button { model.open("artist") } label: { Text(model.state.artist).contentTransition(.opacity).font(.title3).foregroundStyle(.white.opacity(0.65)).lineLimit(1) }.buttonStyle(.plain)
        } else {
            Text(artistText).font(.title3).lineLimit(1).contentTransition(.opacity)
                .environment(\.openURL, OpenURLAction { url in
                    guard url.scheme == "mora-native" else { return .discarded }
                    model.navigate(String(url.absoluteString.dropFirst("mora-native:".count)))
                    return .handled
                })
                .contextMenu { ForEach(model.artists) { artist in Button(artist.title) { model.navigate(artist.path) } } }
                .accessibilityIdentifier("player.artists")
        }
    }

    private var backdrop: some View {
        let palette = NativeCoverPalette.colors(for: model.artwork)
        let emeraldHint = Color(red: 0.05, green: 0.16, blue: 0.11)
        return ZStack {
            Group {
                if #available(iOS 18.0, *) {
                    MeshGradient(
                        width: 3,
                        height: 3,
                        points: [
                            SIMD2<Float>(0.0, 0.0), SIMD2<Float>(0.5, 0.0), SIMD2<Float>(1.0, 0.0),
                            SIMD2<Float>(0.0, 0.5), SIMD2<Float>(0.5, 0.46), SIMD2<Float>(1.0, 0.5),
                            SIMD2<Float>(0.0, 1.0), SIMD2<Float>(0.5, 1.0), SIMD2<Float>(1.0, 1.0)
                        ],
                        colors: [
                            palette.primary, emeraldHint, palette.secondary,
                            palette.secondary, palette.primary, .moraBackground,
                            .moraBackground, emeraldHint, .moraBackground
                        ],
                        background: .moraBackground
                    )
                } else {
                    ZStack {
                        LinearGradient(
                            colors: [palette.primary, palette.secondary, .moraBackground],
                            startPoint: .topLeading,
                            endPoint: .bottom
                        )
                        RadialGradient(
                            colors: [palette.primary.opacity(0.65), emeraldHint.opacity(0.45), .clear],
                            center: .topTrailing,
                            startRadius: 20,
                            endRadius: 460
                        )
                    }
                }
            }
            .overlay {
                if let image = model.artwork {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .saturation(showLyrics ? 1.2 : 1.0)
                        .blur(radius: 64)
                        .opacity(showLyrics ? 0.36 : 0.28)
                        .id(ObjectIdentifier(image))
                        .transition(.opacity)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .clipped()
            if showLyrics {
                RadialGradient(colors: [Color.moraMint.opacity(0.12), .clear], center: .topTrailing, startRadius: 20, endRadius: 420)
                LinearGradient(colors: [Color.black.opacity(0.34), Color.black.opacity(0.58)], startPoint: .top, endPoint: .bottom)
            } else {
                LinearGradient(colors: [Color.black.opacity(0.14), Color.black.opacity(0.40)], startPoint: .top, endPoint: .bottom)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.62), value: model.artwork.map(ObjectIdentifier.init))
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: showLyrics)
    }

    private func cover(playing: Bool) -> some View {
        let artId = "\(model.state.entryId)|\(model.artwork.map { ObjectIdentifier($0).hashValue } ?? 0)"
        let coverTransition: AnyTransition = {
            if reduceMotion || swipeDirection == 0 { return .opacity }
            return .asymmetric(
                insertion: .move(edge: swipeDirection > 0 ? .trailing : .leading).combined(with: .opacity),
                removal: .move(edge: swipeDirection > 0 ? .leading : .trailing).combined(with: .opacity)
            )
        }()
        return Color.clear.aspectRatio(1, contentMode: .fit).frame(maxWidth: 430)
            .overlay {
                ZStack {
                    if let image = model.artwork {
                        Image(uiImage: image).resizable().scaledToFill().accessibilityHidden(true)
                    } else {
                        ZStack {
                            Color.moraMint.opacity(0.12)
                            Image(systemName: "music.note").font(.system(size: 64)).foregroundStyle(.white.opacity(0.4))
                        }
                        .accessibilityHidden(true)
                    }
                }
                .id(artId)
                .transition(coverTransition)
                .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.85), value: artId)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.6), radius: playing ? 30 : 14, y: playing ? 20 : 10)
            .scaleEffect(playing || reduceMotion ? 1 : 0.87)
            .offset(x: reduceMotion ? 0 : coverDragOffset)
            .overlay {
                ZStack {
                    HorizontalCoverSwipe(
                        enabled: !queueOpen && !showLyrics,
                        onDrag: { dx in
                            guard !reduceMotion else { return }
                            coverDragOffset = max(-48, min(48, dx * 0.45))
                        },
                        onEnd: { dx, vx in
                            if dx < -60 || vx < -420 {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                swipeDirection = 1
                                nextTapCount &+= 1
                                model.transport("nexttrack")
                            } else if dx > 60 || vx > 420 {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                swipeDirection = -1
                                prevTapCount &+= 1
                                model.transport("previoustrack")
                            }
                            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.78)) {
                                coverDragOffset = 0
                            }
                        },
                        onDoubleTap: {
                            if model.reaction <= 0 { model.react(1) }
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            likeBurstGeneration &+= 1
                            let gen = likeBurstGeneration
                            withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.65)) {
                                showLikeBurst = true
                            }
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(650))
                                guard gen == likeBurstGeneration else { return }
                                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                                    showLikeBurst = false
                                }
                            }
                        }
                    )
                    if showLikeBurst {
                        Image(systemName: "heart.fill")
                            .font(.system(size: 72, weight: .bold))
                            .foregroundStyle(Color.moraMint)
                            .shadow(color: Color.moraMint.opacity(0.55), radius: 22)
                            .scaleEffect(showLikeBurst ? 1.0 : 0.6)
                            .transition(.scale(scale: 0.55).combined(with: .opacity))
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.44, dampingFraction: 0.72), value: playing)
            .layoutPriority(-1)
    }

    private func transport(playing: Bool) -> some View {
        HStack {
            Spacer()
            Button {
                swipeDirection = -1
                prevTapCount &+= 1
                model.transport("previoustrack")
            } label: {
                Image(systemName: "backward.fill")
                    .symbolEffect(.bounce, value: prevTapCount)
                    .font(.system(size: 34))
                    .frame(width: 64, height: 64)
            }
            .buttonStyle(MoraPressStyle(scale: 0.88))
            .accessibilityLabel("Предыдущий")
            Spacer()
            Button { model.transport(playing ? "pause" : "play") } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill").contentTransition(.symbolEffect(.replace)).font(.system(size: 48, weight: .semibold))
                    .frame(width: 80, height: 80)
            }
            .buttonStyle(MoraPressStyle(scale: 0.88))
            .accessibilityLabel(playing ? "Пауза" : "Играть")
            Spacer()
            Button {
                swipeDirection = 1
                nextTapCount &+= 1
                model.transport("nexttrack")
            } label: {
                Image(systemName: "forward.fill")
                    .symbolEffect(.bounce, value: nextTapCount)
                    .font(.system(size: 34))
                    .frame(width: 64, height: 64)
            }
            .buttonStyle(MoraPressStyle(scale: 0.88))
            .accessibilityLabel("Следующий")
            Spacer()
        }
    }
}

private struct NativeLyricsView: View {
    @ObservedObject var model: NativePlayerModel
    var externalRefresh: Int = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ScaledMetric(relativeTo: .title) private var lyricFontSize: CGFloat = 29
    @State private var lyrics: NativeLyricsResult?
    @State private var failure: String?
    @State private var retry = 0
    @State private var offsetMs = 0.0
    @State private var follow = true
    @State private var refreshRequested = false
    @State private var showTimingTools = false

    private var activeOffset: Double { offsetMs / 1000.0 }
    private func clock() -> Double {
        let s = model.state
        return s.position + (s.playing ? Date().timeIntervalSince(model.receivedAt) : 0) + activeOffset
    }

    var body: some View {
        let lines = lyrics?.lines ?? []
        let synced = lyrics?.status == "synced" && !lines.isEmpty
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 24) {
                    if let failure {
                        VStack(spacing: 12) {
                            Text(failure)
                                .font(.body)
                                .foregroundStyle(.white.opacity(0.75))
                                .multilineTextAlignment(.center)
                            Button("Повторить") { retry &+= 1 }
                                .buttonStyle(.borderedProminent)
                                .tint(.moraMint)
                                .foregroundStyle(Color.moraBackground)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 56)
                    } else if let lyrics {
                        if !lines.isEmpty {
                            TimelineView(.periodic(from: .now, by: model.state.playing ? 0.15 : 60)) { _ in
                                let now = clock()
                                let active = lines.lastIndex { $0.time <= now } ?? -1
                                VStack(alignment: .leading, spacing: 24) {
                                    ForEach(lines.indices, id: \.self) { index in
                                        lyricRow(lines[index], index: index, active: active, now: now)
                                    }
                                }
                                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88), value: active)
                                .onChange(of: active, initial: true) { _, index in
                                    if follow && index >= 0 {
                                        withAnimation(reduceMotion ? nil : .spring(response: 0.55, dampingFraction: 0.9)) {
                                            proxy.scrollTo(index, anchor: UnitPoint(x: 0.5, y: 0.30))
                                        }
                                    }
                                }
                                .onChange(of: follow) { _, isFollowing in
                                    if isFollowing && active >= 0 {
                                        withAnimation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.88)) {
                                            proxy.scrollTo(active, anchor: UnitPoint(x: 0.5, y: 0.30))
                                        }
                                    }
                                }
                            }
                        } else if lyrics.status == "plain" && !lyrics.plain.isEmpty {
                            Text("Текст без синхронизации")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.moraMint.opacity(0.85))
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(lyrics.plain)
                                .font(.title3.weight(.semibold))
                                .lineSpacing(7)
                                .foregroundStyle(.white.opacity(0.9))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            VStack(spacing: 12) {
                                Text(model.offline ? "Нет сети — текст не удалось загрузить." : "Текст для этой песни не найден.")
                                    .font(.body)
                                    .foregroundStyle(.white.opacity(0.75))
                                    .multilineTextAlignment(.center)
                                Button("Поискать снова") { refreshRequested = true; retry &+= 1 }
                                    .buttonStyle(.borderedProminent)
                                    .tint(.moraMint)
                                    .foregroundStyle(Color.moraBackground)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 56)
                        }
                        if let attribution = Self.attribution(lyrics) {
                            Text(attribution)
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.42))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 12)
                        }
                    } else {
                        ProgressView("Ищем текст…")
                            .tint(.moraMint)
                            .foregroundStyle(.white.opacity(0.75))
                            .frame(maxWidth: .infinity)
                            .padding(.top, 64)
                    }
                }
                .padding(.horizontal, 2)
                .padding(.top, 28)
                .padding(.bottom, 96)
            }
            .simultaneousGesture(DragGesture(minimumDistance: 10).onChanged { _ in if follow { follow = false } })
            .mask(
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0.0),
                        .init(color: .black, location: 0.05),
                        .init(color: .black, location: 0.84),
                        .init(color: .clear, location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .overlay(alignment: .bottomLeading) {
                if !follow && !lines.isEmpty {
                    Button {
                        follow = true
                    } label: {
                        Label("К текущей строке", systemImage: "scope")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.moraMint)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background {
                                if reduceTransparency {
                                    Capsule().fill(Color.moraSurfaceElevated)
                                } else {
                                    Capsule().fill(.ultraThinMaterial)
                                }
                            }
                            .overlay(Capsule().stroke(Color.white.opacity(0.16), lineWidth: 0.75))
                    }
                    .buttonStyle(MoraPressStyle(scale: 0.94))
                    .padding(.bottom, 10)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: follow)
            .overlay(alignment: .bottomTrailing) {
                if synced {
                    HStack(spacing: 8) {
                        if showTimingTools {
                            HStack(spacing: 4) {
                                Button { shiftOffset(by: 250) } label: {
                                    Image(systemName: "minus").font(.caption.weight(.bold)).frame(width: 30, height: 32)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Текст раньше на 0,25 с")
                                Button { shiftOffset(to: 0) } label: {
                                    Text(Self.offsetText(offsetMs))
                                        .font(.caption.monospacedDigit().weight(.semibold))
                                        .foregroundStyle(.white.opacity(offsetMs == 0 ? 0.65 : 1))
                                        .frame(minWidth: 52)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Сбросить сдвиг текста")
                                Button { shiftOffset(by: -250) } label: {
                                    Image(systemName: "plus").font(.caption.weight(.bold)).frame(width: 30, height: 32)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Текст позже на 0,25 с")
                                Divider().frame(height: 16).overlay(Color.white.opacity(0.2))
                                Button { refreshRequested = true; retry &+= 1 } label: {
                                    Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold)).frame(width: 30, height: 32)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Обновить текст")
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background {
                                if reduceTransparency {
                                    Capsule().fill(Color.moraSurfaceElevated)
                                } else {
                                    Capsule().fill(.ultraThinMaterial)
                                }
                            }
                            .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.75))
                            .transition(.opacity.combined(with: .scale(scale: 0.92, anchor: .trailing)))
                        }
                        Button {
                            withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85)) {
                                showTimingTools.toggle()
                            }
                        } label: {
                            Image(systemName: showTimingTools ? "xmark" : "slider.horizontal.3")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(showTimingTools ? Color.moraMint : .white.opacity(0.9))
                                .frame(width: 42, height: 42)
                                .background {
                                    if reduceTransparency {
                                        Circle().fill(Color.moraSurfaceElevated)
                                    } else {
                                        Circle().fill(.ultraThinMaterial)
                                    }
                                }
                                .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 0.75))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showTimingTools ? "Скрыть настройку сдвига" : "Настройка сдвига текста")
                    }
                    .padding(.bottom, 10)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(model.state.trackId)|\(retry)") {
            let shouldRefresh = refreshRequested
            refreshRequested = false
            await load(model.state.trackId, refresh: shouldRefresh)
        }
        .onChange(of: externalRefresh) { _, _ in
            refreshRequested = true
            retry &+= 1
        }
    }

    private func lyricRow(_ line: NativeLyricLine, index: Int, active: Int, now: Double) -> some View {
        let isActive = index == active
        let distance = active < 0 ? 0 : abs(index - active)
        let depthActive = follow && active >= 0 && !reduceMotion && !reduceTransparency
        let blurRadius: CGFloat = !isActive && depthActive && distance <= 5 ? min(4.2, CGFloat(distance) * 1.4) : 0
        let opacityValue: Double = {
            if isActive { return 1.0 }
            if !follow || active < 0 { return index < active ? 0.40 : 0.62 }
            switch distance {
            case 1: return 0.42
            case 2: return 0.25
            default: return 0.14
            }
        }()
        let scaleValue: CGFloat = {
            if isActive || !follow || active < 0 || reduceMotion { return 1.0 }
            switch distance {
            case 1: return 0.98
            case 2: return 0.96
            default: return 0.95
            }
        }()

        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            follow = true
            model.seek(to: max(0, line.time - activeOffset))
        } label: {
            Group {
                if isActive && !line.words.isEmpty {
                    karaoke(line.words, now: now)
                } else {
                    Text(line.text.isEmpty ? "♪" : line.text)
                        .foregroundStyle(isActive ? Color.white : Color.white.opacity(0.95))
                }
            }
            .font(.system(size: min(lyricFontSize, 38), weight: .bold))
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)
            .shadow(color: isActive ? Color.moraMint.opacity(0.32) : .clear, radius: isActive ? 14 : 0, y: 2)
            .opacity(opacityValue)
            .blur(radius: blurRadius)
            .scaleEffect(scaleValue, anchor: .leading)
        }
        .buttonStyle(.plain)
        .id(index)
    }

    /// Word texts carry their own spacing (as in the web WordLyricLine).
    private func karaoke(_ words: [NativeLyricWord], now: Double) -> Text {
        words.reduce(Text("")) { line, word in
            let color: Color = now >= word.end ? .white : (now >= word.time ? .moraMint : .white.opacity(0.38))
            return line + Text(word.text).foregroundColor(color)
        }
    }

    private func shiftOffset(by deltaMs: Double) { shiftOffset(to: offsetMs + deltaMs) }
    private func shiftOffset(to rawMs: Double) {
        let clamped = min(30_000, max(-30_000, rawMs.rounded()))
        offsetMs = clamped
        let id = model.state.trackId
        guard !id.isEmpty else { return }
        let keyId = NativeShellStore.shared?.byId[id]?.binding ?? id
        NativeLyricsService.shared.saveOffsetMs(clamped, for: keyId)
        guard NativeShellStore.shared?.sharedLibrary == true else { return }
        let escaped = id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? id
        Task { _ = try? await NativeServerApp.request("PUT", "/api/tracks/\(escaped)/lyrics/offset", body: ["offsetMs": Int(clamped)]) }
    }

    private static func offsetText(_ ms: Double) -> String {
        let sec = ms / 1000.0
        let sign = sec > 0.004 ? "+" : ""
        return sign + String(format: "%.2f", sec).replacingOccurrences(of: ".", with: ",") + " с"
    }

    private static func attribution(_ lyrics: NativeLyricsResult) -> String? {
        guard lyrics.status != "none" || lyrics.hasWordTimings else { return nil }
        if lyrics.hasWordTimings { return "Текст распознан локально (Whisper)" }
        let base = lyrics.source == "file" ? "Из файла рядом с треком" : "Текст: LRCLIB"
        if let m = lyrics.matched, !m.title.isEmpty {
            return "\(base) · \(m.artist) — \(m.title)"
        }
        return base
    }

    @MainActor private func load(_ id: String, refresh: Bool) async {
        lyrics = nil; failure = nil; follow = true
        guard !id.isEmpty else { failure = "Трек недоступен"; return }
        let track = NativeShellStore.shared?.byId[id]
        let title = track?.title ?? model.state.title
        let artist = track?.artist ?? model.state.artist
        let album = track?.album ?? ""
        let duration = track?.duration ?? model.state.duration
        let keyId = track?.binding ?? id
        let cacheDir = NativeServerApp.root.appendingPathComponent("data/cache/lyrics", isDirectory: true)
        do {
            let loaded = try await NativeLyricsService.shared.load(
                trackId: keyId,
                title: title,
                artist: artist,
                album: album,
                duration: duration,
                refresh: refresh,
                cacheDir: cacheDir
            )
            guard !Task.isCancelled else { return }
            offsetMs = loaded.offsetMs
            lyrics = loaded
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}

private struct NativeQueueContent: View {
    @ObservedObject var model: NativePlayerModel
    var body: some View {
        let upcoming = model.state.upcoming
        List {
            Group {
                NativeQueueModes(model: model).padding(.top, 16)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Продолжение").font(.title2.bold())
                    if let label = NativeShellStore.shared?.ui.now?.label, !label.isEmpty {
                        Text("Из: \(label)").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if upcoming.isEmpty { Text("Очередь пуста").foregroundStyle(.secondary) }
            }
            .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets())
            ForEach(upcoming) { row in
                Button { model.editQueue("jump", row.id) } label: {
                    HStack(spacing: 12) {
                        NativeCover(url: row.cover ?? NativeShellStore.shared?.byId[row.trackId]?.cover, size: 48, radius: 7, embedded: row.artwork)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.title).font(.body.weight(.medium)).lineLimit(1)
                            Text(row.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            if let label = row.mixLabel {
                                Label(label, systemImage: "sparkles").font(.caption.weight(.medium)).foregroundStyle(Color.moraGold)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Играть сейчас")
                .accessibilityAction(named: "Играть следующим") { model.editQueue("next", row.id) }
                .accessibilityAction(named: "Убрать из очереди") { model.editQueue("remove", row.id) }
                .swipeActions(edge: .leading) {
                    Button { model.editQueue("next", row.id) } label: { Label("Следующим", systemImage: "text.line.first.and.arrowtriangle.forward") }
                        .tint(.moraMint)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) { model.editQueue("remove", row.id) } label: { Label("Убрать", systemImage: "minus.circle") }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
            }
            // Drag to reorder: the moved entry goes after the row above its new place (or after the current track).
            .onMove { from, to in
                guard let index = from.first, upcoming.indices.contains(index) else { return }
                let after = to == 0 ? model.state.entryId : upcoming[to - 1].id
                guard after != upcoming[index].id else { return }
                model.editQueue("move", upcoming[index].id, after: after)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
    }
}


private struct NativeQueueModes: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 10) {
            mode("shuffle", symbol: "shuffle", label: "Перемешать", on: model.modes.shuffle, disabled: !model.modes.canShuffle)
            mode("repeat", symbol: model.modes.repeatMode == "one" ? "repeat.1" : "repeat", label: model.modes.repeatLabel, on: model.modes.repeatMode != "off")
            mode("automix", symbol: "waveform", label: "AutoMix", on: model.modes.automix)
        }
        .disabled(model.changingMode)
        .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.78), value: model.modes)
    }
    private func mode(_ mode: String, symbol: String, label: String, on: Bool, disabled: Bool = false) -> some View {
        Button { model.playbackMode(mode) } label: {
            Group {
                if mode == "automix" {
                    HStack(spacing: -7) {
                        Circle().stroke(lineWidth: 2.5)
                        Circle().fill().overlay(Circle().fill(on ? Color.moraMint : Color.moraBackground).frame(width: 4, height: 4))
                    }.frame(width: 30, height: 19)
                } else { Image(systemName: symbol).font(.title3.weight(.semibold)).contentTransition(.symbolEffect(.replace)) }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(on ? Color.moraBackground : Color.white.opacity(0.65))
            .background(on ? Color.moraMint : Color.white.opacity(0.1), in: Capsule())
            .opacity(disabled ? 0.35 : 1)
        }
        .buttonStyle(MoraPressStyle(scale: 0.94)).disabled(disabled)
        .accessibilityLabel(label).accessibilityValue(on ? "Включено" : "Выключено")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint(disabled ? "В волне порядок подбирается автоматически" : "Изменить режим воспроизведения")
        .accessibilityIdentifier("queue." + mode)
    }
}

private struct NativeSystemVolume: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView()
        view.showsRouteButton = false
        view.tintColor = UIColor.white.withAlphaComponent(0.65)
        view.accessibilityLabel = "Громкость"
        return view
    }
    func updateUIView(_ view: MPVolumeView, context: Context) {}
}


private struct NativeScrubber: View {
    let state: NativePlayerState
    let receivedAt: Date
    let pending: Double?
    let seek: (Double) -> Void
    @GestureState private var drag: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let duration = max(state.duration, 1)
        let isDragging = drag != nil
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !state.playing || isDragging || pending != nil)) { context in
            let live = min(state.duration, state.position + (state.playing ? max(0, context.date.timeIntervalSince(receivedAt)) : 0))
            let shown = drag ?? pending ?? live
            let inMixZone = state.blending || (state.mixStart.map { shown >= $0 } ?? false)
            let activeFill = inMixZone
                ? LinearGradient(colors: [.moraMint, .moraGold], startPoint: .leading, endPoint: .trailing)
                : LinearGradient(
                    colors: [.white.opacity(isDragging ? 1.0 : 0.90), .moraMint.opacity(isDragging ? 0.95 : 0.72)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            VStack(spacing: 6) {
                GeometryReader { geo in
                    let width = geo.size.width
                    let barHeight: CGFloat = isDragging ? 9 : 5
                    let x = width * min(1, max(0, shown / duration))
                    let mixX = state.mixStart.map { width * min(1, max(0, $0 / duration)) }
                    let mixW = state.mixStart.map { start -> CGFloat in
                        let end = state.mixLength > 0 ? min(duration, start + state.mixLength) : duration
                        return max(2, width * min(1, max(0, (end - start) / duration)))
                    }
                    ZStack(alignment: .leading) {
                        ZStack(alignment: .leading) {
                            Capsule().fill(.white.opacity(0.18)).frame(height: barHeight)
                            if let mixX, let mixW {
                                Rectangle()
                                    .fill(
                                        LinearGradient(
                                            colors: [
                                                Color.moraMint.opacity(state.blending ? 0.80 : 0.35),
                                                Color.moraGold.opacity(state.blending ? 0.65 : 0.25)
                                            ],
                                            startPoint: .leading,
                                            endPoint: .trailing
                                        )
                                    )
                                    .frame(width: mixW, height: barHeight)
                                    .offset(x: mixX)
                            }
                        }
                        .frame(width: width, height: barHeight)
                        .clipShape(Capsule())
                        Capsule()
                            .fill(activeFill)
                            .frame(width: x, height: barHeight)
                            .shadow(color: inMixZone ? Color.moraMint.opacity(0.35) : .clear, radius: 6)
                        if let mixX {
                            Capsule()
                                .fill(Color.moraMint)
                                .frame(width: 2.5, height: isDragging ? 14 : 10)
                                .offset(x: min(max(0, mixX - 1.25), max(0, width - 2.5)))
                                .shadow(color: Color.moraMint.opacity(0.5), radius: 3)
                        }
                        if isDragging {
                            Circle()
                                .fill(.white)
                                .frame(width: 18, height: 18)
                                .shadow(color: .black.opacity(0.35), radius: 4, y: 1)
                                .offset(x: min(max(0, x - 9), max(0, width - 18)))
                                .transition(.scale(scale: 0.35).combined(with: .opacity))
                        }
                    }
                    .frame(width: width, height: 44)
                    .contentShape(Rectangle())
                    .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: isDragging)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: inMixZone)
                    // GestureState resets when the sheet's own pan cancels the drag; a @State value stayed stuck there.
                    .gesture(DragGesture(minimumDistance: 4)
                        .updating($drag) { g, value, _ in
                            guard state.duration > 0, width > 0 else { return }
                            if value == nil { UISelectionFeedbackGenerator().selectionChanged() }
                            value = min(state.duration, max(0, g.location.x / width * state.duration))
                        }
                        .onEnded { g in
                            guard state.duration > 0, width > 0 else { return }
                            seek(min(state.duration, max(0, g.location.x / width * state.duration)))
                        })
                }
                .frame(height: 44)
                ZStack {
                    HStack {
                        Text(NativePlayerTime.text(shown))
                        Spacer()
                        Text("−" + NativePlayerTime.text(max(0, state.duration - shown)))
                    }
                    if state.blending {
                        Text("Микширование").font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(reduceMotion || !state.playing ? 0.8 : 0.65 + 0.35 * sin(context.date.timeIntervalSinceReferenceDate * 3)))
                            .shadow(color: .white.opacity(0.25), radius: 3)
                            .transition(.opacity)
                    }
                }
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(.white.opacity(isDragging ? 0.88 : 0.55))
                .accessibilityHidden(true)
            }
            .accessibilityElement()
            .accessibilityLabel("Позиция")
            .accessibilityValue("\(NativePlayerTime.text(shown)) из \(NativePlayerTime.text(state.duration))" + (state.mixStart.map { ", AutoMix с \(NativePlayerTime.text($0))" } ?? ""))
            .accessibilityAdjustableAction { direction in
                guard state.duration > 0 else { return }
                seek(min(state.duration, max(0, shown + (direction == .increment ? 10 : -10))))
            }
        }
        .disabled(state.duration <= 0)
    }
}
