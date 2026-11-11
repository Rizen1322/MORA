import AppIntents
import MediaPlayer
import UIKit

/// Siri and Shortcuts («Включи волну в MORA», «Что играет в MORA», «Лайкни трек в MORA»).
/// They act through the same shell store as the native screens. Starting the wave needs the page,
/// which only runs in the foreground, so that intent opens the app; the others work while music plays.

enum NativeIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notReady
    var localizedStringResource: LocalizedStringResource { "MORA ещё загружается — попробуйте через пару секунд" }
}

@MainActor enum NativeIntentShell {
    /// Starts the selected wave unless one already plays (the page's `wave` command toggles a playing wave).
    /// Returns false when it was already playing.
    @discardableResult static func startWave(_ store: NativeShellStore, source: NativeWaveSource? = nil) -> Bool {
        let wave = store.ui.wave
        let chosen = source ?? wave.active ?? wave.preferred
        if wave.active == chosen && wave.playing { return false }
        store.run("wave", ["source": chosen.rawValue])
        return true
    }

    /// The shell once the page has loaded (a cold start from Siri needs a few seconds).
    static func ready() async -> NativeShellStore? {
        for _ in 0..<80 {
            if let store = NativeShellStore.shared, store.webView != nil, store.ui.loaded { return store }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return nil
    }

    /// The track that plays now: the native host's, or the page's when the web engine plays.
    static func currentTrackId(_ store: NativeShellStore) async -> String? {
        if let host = store.host, host.active {
            let id: String? = await withCheckedContinuation { done in
                host.playerState { result in
                    if case .success(let value) = result { done.resume(returning: NativePlayerState(value).trackId) } else { done.resume(returning: nil) }
                }
            }
            if let id, !id.isEmpty { return id }
        }
        return store.ui.now?.id
    }
}

/// `mora://wave|player|liked|search` from the widgets (MORAWidgets): the same actions as the app's own buttons.
enum NativeDeepLink {
    static let scheme = "mora"
    @MainActor static var splashVisible = false
    @MainActor private static var pending: [URL] = []

    @MainActor static func finishSplash() {
        splashVisible = false
        let links = pending
        pending.removeAll()
        links.forEach { open($0) }
    }

    static func open(_ url: URL) {
        guard url.scheme?.lowercased() == scheme else { return }
        Task { @MainActor in
            if splashVisible { pending.append(url); return }
            if let link = NativeWaveLink(url), URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "autoplay" && $0.value == "1" }) == true {
                do { try await StationStarter.start(source: link.source); return }
                catch { NativeShellStore.shared?.show(error.localizedDescription) }
            }
            guard let store = await NativeIntentShell.ready() else { return }
            switch url.host?.lowercased() {
            case "wave":
                guard let link = NativeWaveLink(url) else { return }
                NativeIntentShell.startWave(store, source: link.source.flatMap(NativeWaveSource.init(rawValue:)))
            // «Продолжить»: resume what was paused, or show what already plays.
            case "player": if store.miniPlaying { store.openPlayer() } else if store.miniTitle != nil { store.togglePlayback() }
            case "liked": store.go("/liked")
            case "search": store.go("/search")
            case "import": store.go("/import")
            case "track":
                guard let link = NativeTrackLink(url) else { return }
                do { _ = try await store.call("openTrack", ["id": link.id]); store.openPlayer() }
                catch { store.show(error.localizedDescription) }
            default: break
            }
        }
    }
}

struct StartWaveIntent: AppIntent {
    static let title: LocalizedStringResource = "Включить волну"
    static let description = IntentDescription("Запускает «Мою волну» в MORA с источником, выбранным на главной.")
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        if UIApplication.shared.applicationState == .background { AppDelegate.backgroundLaunch = true }
        do {
            try await StationStarter.start()
            return .result(dialog: "Включаю сохранённую волну")
        } catch {
            return .result(dialog: "Откройте MORA, чтобы начать")
        }
    }
}

struct NowPlayingIntent: AppIntent {
    static let title: LocalizedStringResource = "Что сейчас играет"
    static let description = IntentDescription("Называет трек и исполнителя, которые играют в MORA.")

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let title = info[MPMediaItemPropertyTitle] as? String ?? NativeShellStore.shared?.miniTitle ?? ""
        let artist = info[MPMediaItemPropertyArtist] as? String ?? NativeShellStore.shared?.miniArtist ?? ""
        guard !title.isEmpty else { return .result(value: "", dialog: "Сейчас ничего не играет") }
        let text = artist.isEmpty ? title : "\(title) — \(artist)"
        return .result(value: text, dialog: "\(text)")
    }
}

struct LikeCurrentTrackIntent: AppIntent {
    static let title: LocalizedStringResource = "Лайкнуть текущий трек"
    static let description = IntentDescription("Добавляет играющий трек в «Любимое». Без сети отметка сохранится и отправится позже.")

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let store = NativeShellStore.shared else { throw NativeIntentError.notReady }
        guard let id = await NativeIntentShell.currentTrackId(store), !id.isEmpty else { return .result(dialog: "Сейчас ничего не играет") }
        if store.reaction(id) > 0 { return .result(dialog: "Трек уже в любимом") }
        // The same outbox as the lock-screen like: saved now, synced when the page can take it.
        store.react(id: id, value: 1)
        return .result(dialog: "Трек в любимом")
    }
}

struct MoraShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartWaveIntent(), phrases: ["Включи волну в \(.applicationName)", "Запусти мою волну в \(.applicationName)"],
                    shortTitle: "Моя волна", systemImageName: "waveform")
        AppShortcut(intent: NowPlayingIntent(), phrases: ["Что играет в \(.applicationName)", "Какой трек играет в \(.applicationName)"],
                    shortTitle: "Что играет", systemImageName: "music.note")
        AppShortcut(intent: LikeCurrentTrackIntent(), phrases: ["Лайкни трек в \(.applicationName)", "Мне нравится этот трек в \(.applicationName)"],
                    shortTitle: "Нравится", systemImageName: "heart")
        AppShortcut(intent: PlayPlaylistIntent(), phrases: ["Включи плейлист \(\.$playlist) в \(.applicationName)"], shortTitle: "Включить плейлист", systemImageName: "music.note.list")
        AppShortcut(intent: SetSleepTimerIntent(), phrases: ["Таймер сна в \(.applicationName)"], shortTitle: "Таймер сна", systemImageName: "moon.zzz")
        AppShortcut(intent: DownloadCurrentIntent(), phrases: ["Скачай текущий трек в \(.applicationName)"], shortTitle: "Скачать трек", systemImageName: "arrow.down.circle")
    }
}

struct MoraPlaylistEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Плейлист"
    static var defaultQuery = MoraPlaylistQuery()
    var id: String
    var name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}
struct MoraPlaylistQuery: EntityStringQuery {
    private func all() -> [MoraPlaylistEntity] { (NativeWidgetData.load()?.playlists ?? []).map { .init(id: $0.id, name: $0.name) } }
    func entities(for identifiers: [String]) async throws -> [MoraPlaylistEntity] { all().filter { identifiers.contains($0.id) } }
    func entities(matching string: String) async throws -> [MoraPlaylistEntity] { all().filter { $0.name.localizedCaseInsensitiveContains(string) } }
    func suggestedEntities() async throws -> [MoraPlaylistEntity] { all() }
}
struct PlayPlaylistIntent: AppIntent {
    static var title: LocalizedStringResource = "Включить плейлист"
    static var openAppWhenRun = false
    @Parameter(title: "Плейлист") var playlist: MoraPlaylistEntity
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            if UIApplication.shared.applicationState == .active, let store = NativeShellStore.shared, store.ui.loaded {
                _ = try await store.call("playPlaylist", ["id": playlist.id])
            } else { try await StationStarter.start(playlistId: playlist.id) }
            return .result(dialog: "Включаю плейлист")
        } catch { return .result(dialog: "Откройте MORA, чтобы начать этот плейлист") }
    }
}
struct SetSleepTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Таймер сна"
    @Parameter(title: "Минуты", default: 30) var minutes: Int
    @Parameter(title: "В конце трека", default: false) var endOfTrack: Bool
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        guard NativeMixHost.shared.active else { return .result(dialog: "Сейчас ничего не играет") }
        if endOfTrack {
            let id = NativeMixHost.shared.snapshot["entryId"] as? String ?? ""
            guard !id.isEmpty else { return .result(dialog: "Трек ещё загружается") }
            NativeSleepTimer.shared.set(.endOfTrack(entryId: id))
        } else {
            guard (1...720).contains(minutes) else { return .result(dialog: "Укажите от 1 до 720 минут") }
            NativeSleepTimer.shared.set(.until(Date().addingTimeInterval(Double(minutes) * 60)))
        }
        return .result(dialog: "Таймер сна включён")
    }
}
struct DownloadCurrentIntent: AppIntent {
    static var title: LocalizedStringResource = "Скачать текущий трек"
    static var openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let store = await NativeIntentShell.ready() else { return .result(dialog: "Откройте MORA, чтобы скачать трек") }
        _ = try await store.call("downloadCurrent", timeout: 60)
        return .result(dialog: "Трек добавлен в очередь загрузок")
    }
}
