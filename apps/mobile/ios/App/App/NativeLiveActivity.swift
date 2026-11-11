import ActivityKit
import UIKit
import MediaPlayer

@MainActor enum NativeLiveActivity {
    private static var activity: Activity<NativeActivityAttributes>?
    private static var latest: (NativeActivityState?, String)?
    private static var worker: Task<Void, Never>?
    private static var lastState: NativeActivityState?
    private static var lastUpdate = Date.distantPast
    private static var artworkKey = ""
    private static var artworkFile: String?

    static func install(_ host: NativeMixHost) {
        NativePlaybackActions.handler = { [weak host] action in
            guard let host, host.active else { return }
            _ = await withCheckedContinuation { done in
                host.command(action == "next" ? "nexttrack" : action, source: "activity") { done.resume(returning: $0) }
            }
        }
        host.onNowPlaying = { state, ended in
            let store = NativeShellStore.shared
            var content: NativeActivityState?
            if !ended {
                let key = "\(state["trackId"] ?? "")|\(state["artworkReady"] ?? false)"
                if key != artworkKey {
                    artworkKey = key; artworkFile = nil
                    if let artwork = state["artwork"] as? MPMediaItemArtwork,
                       let data = artwork.image(at: CGSize(width: 64, height: 64)).jpegData(compressionQuality: 0.4), data.count <= 16384,
                       let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: NativeWidgetData.group) {
                        do { try data.write(to: root.appendingPathComponent("activity-artwork.jpg"), options: .atomic); artworkFile = "activity-artwork.jpg" } catch {}
                    }
                }
                content = NativeActivityState(trackId: state["trackId"] as? String ?? "",
                    title: String((state["title"] as? String ?? "MORA").prefix(150)),
                    artist: String((state["artist"] as? String ?? "").prefix(150)), artwork: artworkFile,
                    isPlaying: state["playing"] as? Bool == true, position: state["position"] as? Double ?? 0,
                    duration: state["duration"] as? Double ?? 0, offline: store?.offline == true,
                    liked: store.map { $0.reaction(state["trackId"] as? String ?? "") > 0 } ?? false)
            }
            enqueue(content, station: store?.ui.now?.label ?? "Моя волна")
        }
    }

    private static func enqueue(_ state: NativeActivityState?, station: String) {
        if var comparable = state, let previous = lastState {
            comparable.position = previous.position
            if comparable == previous && Date().timeIntervalSince(lastUpdate) < 15 { return }
        }
        latest = (state, station)
        guard worker == nil else { return }
        worker = Task { @MainActor in
            while let next = latest {
                latest = nil
                await apply(next.0, station: next.1)
            }
            worker = nil
        }
    }
    private static func apply(_ state: NativeActivityState?, station: String) async {
        guard let state else {
            for old in Activity<NativeActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
            activity = nil; lastState = nil
            return
        }
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity, activity.activityState == .active {
            await activity.update(content)
        } else {
            guard state.isPlaying, ActivityAuthorizationInfo().areActivitiesEnabled,
                  UIApplication.shared.applicationState == .active else { return }
            for old in Activity<NativeActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
            do { activity = try Activity.request(attributes: NativeActivityAttributes(station: String(station.prefix(100))), content: content, pushType: nil) }
            catch { NativeShellStore.shared?.show("Live Activity недоступна: \(error.localizedDescription)") }
        }
        lastState = state; lastUpdate = .now
    }
}
