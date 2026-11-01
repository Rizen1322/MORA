import Foundation

/// What the native shell shows, mapped from the page's snapshot (apps/web/src/lib/native-ui.ts).
/// Foundation only (swiftc test).
struct NativeTrack: Equatable, Identifiable {
    let id: String
    let title: String, artist: String, album: String
    let duration: Double
    var reaction: Int
    let cover: String?
    let ok: Bool
    /// Lowercased, ё → е: what search-as-you-type matches against.
    let key: String

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        title = value["title"] as? String ?? ""
        artist = value["artist"] as? String ?? ""
        album = value["album"] as? String ?? ""
        duration = max(0, value["duration"] as? Double ?? 0)
        reaction = value["reaction"] as? Int ?? 0
        cover = value["cover"] as? String
        ok = value["ok"] as? Bool ?? true
        key = NativeSearchText.normalize("\(title) \(artist) \(album)")
    }
    var liked: Bool { reaction > 0 }
}

struct NativePlaylist: Equatable, Identifiable {
    let id: String, name: String, count: Int, cover: String?
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String else { return nil }
        self.id = id
        name = value["name"] as? String ?? ""
        count = value["count"] as? Int ?? 0
        cover = value["cover"] as? String
    }
}

enum NativeWaveSource: String, CaseIterable { case own, online, yandex }

struct NativeWave: Equatable {
    var own = false, yandex = false, playing = false, loading = false
    var active: NativeWaveSource?
    var error: String?

    init() {}
    init(_ value: [String: Any]) {
        own = value["own"] as? Bool == true
        yandex = value["yandex"] as? Bool == true
        playing = value["playing"] as? Bool == true
        loading = value["loading"] as? Bool == true
        active = (value["active"] as? String).flatMap(NativeWaveSource.init(rawValue:))
        error = value["error"] as? String
    }

    var sources: [NativeWaveSource] { yandex ? [.own, .online, .yandex] : [.own, .online] }
    /// The switch position before the listener picks one (as on the web Home).
    var preferred: NativeWaveSource { active ?? (yandex ? .yandex : own ? .own : .online) }

    /// The hero's Play button for the selected source.
    func button(_ source: NativeWaveSource) -> (title: String, symbol: String, enabled: Bool) {
        let selected = active == source
        if selected { return playing ? ("Пауза", "pause.fill", true) : ("Продолжить", "play.fill", true) }
        if loading { return ("Подбираю…", "waveform", false) }
        switch source {
        case .online: return ("Включить радио", "dot.radiowaves.left.and.right", true)
        case .own: return ("Слушать волну", "waveform", own)
        case .yandex: return ("Слушать волну", "waveform", yandex)
        }
    }
}

struct NativeNow: Equatable {
    let id: String, title: String, artist: String, label: String
    let cover: String?
    let playing: Bool
}

struct NativeToast: Equatable { let id: Int, text: String, error: Bool }

/// The page's small state, sent whenever it changes.
struct NativeUiState: Equatable {
    var path = "/", loaded = false, overlay = false
    var wave = NativeWave()
    var now: NativeNow?
    var toast: NativeToast?
    var preparing: String?

    init() {}
    init(_ value: [String: Any]) {
        path = value["path"] as? String ?? "/"
        loaded = value["loaded"] as? Bool == true
        overlay = value["overlay"] as? Bool == true
        wave = NativeWave(value["wave"] as? [String: Any] ?? [:])
        if let now = value["now"] as? [String: Any], let id = now["id"] as? String {
            self.now = NativeNow(id: id, title: now["title"] as? String ?? "", artist: now["artist"] as? String ?? "",
                                 label: now["label"] as? String ?? "", cover: now["cover"] as? String, playing: now["playing"] as? Bool == true)
        }
        if let toast = value["toast"] as? [String: Any], let id = toast["id"] as? Int, let text = toast["text"] as? String {
            self.toast = NativeToast(id: id, text: text, error: toast["kind"] as? String == "error")
        }
        preparing = value["preparing"] as? String
    }
}

enum NativeScreen: Equatable { case home, more, liked, library, search, web }
enum NativeTab: String, CaseIterable { case home, liked, library, search }

/// The page's hash route decides what is on screen: ported routes are native, the rest stay web.
enum NativeRoute {
    static func screen(_ path: String) -> NativeScreen {
        switch path {
        case "", "/": return .home
        case "/more": return .more
        case "/liked": return .liked
        case "/library", "/library/tracks", "/library/search": return .library
        case "/search": return .search
        default: return .web
        }
    }
    /// The highlighted tab, as in the web TabBar (apps/web/src/components/Layout.tsx).
    static func tab(_ path: String) -> NativeTab {
        func under(_ p: String) -> Bool { path == p || path.hasPrefix(p + "/") }
        if path == "/liked" { return .liked }
        if path == "/search" || ["/catalog", "/yandex", "/public", "/soundcloud"].contains(where: under) { return .search }
        if under("/library") || under("/playlist") || under("/album") || under("/artist") { return .library }
        return .home
    }
    static func root(_ tab: NativeTab) -> String {
        switch tab {
        case .home: return "/"
        case .liked: return "/liked"
        case .library: return "/library"
        case .search: return "/search"
        }
    }
}

enum NativeSearchText {
    static func normalize(_ text: String) -> String {
        text.lowercased(with: Locale(identifier: "ru_RU")).replacingOccurrences(of: "ё", with: "е")
    }
    /// Every word of the query must occur in title, artist or album (as the web search does).
    static func filter(_ tracks: [NativeTrack], _ query: String) -> [NativeTrack] {
        let parts = normalize(query).split(whereSeparator: \.isWhitespace)
        if parts.isEmpty { return tracks }
        return tracks.filter { t in parts.allSatisfy { t.key.contains($0) } }
    }
}

enum NativeText {
    /// 1 трек, 2 трека, 5 треков.
    static func tracks(_ n: Int) -> String {
        let d = n % 10, h = n % 100
        let word = d == 1 && h != 11 ? "трек" : (2...4).contains(d) && !(12...14).contains(h) ? "трека" : "треков"
        return "\(n) \(word)"
    }
    static func greeting(hour: Int) -> String {
        hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер"
    }
}
