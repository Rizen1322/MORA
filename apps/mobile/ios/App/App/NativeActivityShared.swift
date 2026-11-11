import Foundation

struct NativeActivityState: Codable, Hashable {
    var trackId: String, title: String, artist: String
    var artwork: String?
    var isPlaying: Bool
    var position: Double, duration: Double
    var offline: Bool, liked: Bool
}

#if os(iOS)
import ActivityKit
import AppIntents

struct NativeActivityAttributes: ActivityAttributes {
    typealias ContentState = NativeActivityState
    var station: String
    var label = "MORA"
}

@MainActor enum NativePlaybackActions {
    static var handler: ((String) async -> Void)?
}

enum NativePlaybackAction: String, AppEnum {
    case toggle, next, like
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Действие плеера"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [.toggle: "Пауза / продолжить", .next: "Следующий трек", .like: "Нравится"]
}

struct NativePlaybackActionIntent: LiveActivityIntent, AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Управление MORA"
    static var openAppWhenRun = false
    @Parameter(title: "Действие") var action: NativePlaybackAction
    init() { action = .toggle }
    init(action: NativePlaybackAction) { self.action = action }
    @MainActor func perform() async throws -> some IntentResult {
        await NativePlaybackActions.handler?(action.rawValue)
        return .result()
    }
}
#endif
