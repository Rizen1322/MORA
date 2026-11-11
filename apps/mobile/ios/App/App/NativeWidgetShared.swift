import Foundation

/// What the app shows in its widgets (MORAWidgets), shared through the App Group.
/// Compiled into both the app and the widget extension. Without the group (a signature that
/// lacks it) each side gets its own defaults: the widgets then show their launch buttons only.
struct NativeWidgetData: Codable, Equatable {
    struct Song: Codable, Equatable { var title: String, artist: String }
    struct Playlist: Codable, Equatable { var id: String, name: String }
    var now: Song?
    var playing = false
    var liked: [Song] = []
    var likedCount = 0
    var updatedAt: Date?
    var playlists: [Playlist]?

    static let group = "group.ru.mora.player"
    private static let key = "mora.widget"

    static func load() -> NativeWidgetData? {
        guard let data = UserDefaults(suiteName: group)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(NativeWidgetData.self, from: data)
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults(suiteName: Self.group)?.set(data, forKey: Self.key)
    }
}

#if os(iOS)
import AppIntents

/// The Control Center button «Плеер MORA» (MoraPlaybackControl): runs in the app, where
/// NativePlaybackHooks sets `handler` to the native player's play/pause.
@MainActor enum NativePlaybackActions {
    static var handler: (() async -> Void)?
}

struct NativePlaybackToggleIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Пауза / продолжить MORA"
    static var openAppWhenRun = false
    @MainActor func perform() async throws -> some IntentResult {
        await NativePlaybackActions.handler?()
        return .result()
    }
}
#endif
