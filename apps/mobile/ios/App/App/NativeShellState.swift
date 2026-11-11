import Foundation

/// What the native shell shows, mapped from the page's snapshot (apps/web/src/lib/native-ui.ts).
/// Foundation only (swiftc test).
struct NativeTrack: Equatable, Identifiable {
    let id: String
    let title: String, artist: String, album: String
    let duration: Double
    var reaction: Int
    let likedAt: Double
    let cover: String?
    let ok: Bool
    let binding: String?
    /// Plays without the internet (downloaded, or a file of the library).
    let offline: Bool
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
        likedAt = (value["likedAt"] as? NSNumber)?.doubleValue ?? (value["addedAt"] as? NSNumber)?.doubleValue ?? 0
        cover = value["cover"] as? String
        ok = value["ok"] as? Bool ?? true
        binding = value["binding"] as? String
        offline = value["offline"] as? Bool == true
        key = NativeSearchText.normalize("\(title) \(artist) \(album)")
    }
    var liked: Bool { reaction > 0 }

    static func favorites(_ tracks: [NativeTrack]) -> [NativeTrack] {
        tracks.filter(\.liked).sorted { $0.likedAt == $1.likedAt ? $0.id < $1.id : $0.likedAt > $1.likedAt }
    }
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

struct NativeQueuedTrack {
    let entryId: String, trackId: String
    init?(_ value: [String: Any]) {
        guard let entry = value["entryId"] as? String, let track = value["trackId"] as? String else { return nil }
        entryId = entry; trackId = track
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
    var entryId = ""
    var position = 0.0, duration = 0.0
}

struct NativeToast: Equatable { let id: Int, text: String, error: Bool }

struct NativePlaybackModes: Equatable {
    var shuffle = false, repeatMode = "off", automix = true, canShuffle = true
    init() {}
    init(_ value: [String: Any]) {
        shuffle = value["shuffle"] as? Bool == true
        if let mode = value["repeat"] as? String, ["off", "all", "one"].contains(mode) { repeatMode = mode }
        automix = value["automix"] as? Bool ?? true
        canShuffle = value["canShuffle"] as? Bool ?? true
    }
    var repeatLabel: String { repeatMode == "one" ? "Повтор трека" : repeatMode == "all" ? "Повтор очереди" : "Повтор выключен" }
}

/// The page's small state, sent whenever it changes.
struct NativeUiState: Equatable {
    var path = "/", loaded = false, overlay = false
    var wave = NativeWave()
    var playback = NativePlaybackModes()
    var now: NativeNow?
    var toast: NativeToast?
    var preparing: String?
    var searchQuery: String?, searchSource: String?, searchScope: String?

    init() {}
    init(_ value: [String: Any]) {
        path = value["path"] as? String ?? "/"
        loaded = value["loaded"] as? Bool == true
        overlay = value["overlay"] as? Bool == true
        wave = NativeWave(value["wave"] as? [String: Any] ?? [:])
        playback = NativePlaybackModes(value["playback"] as? [String: Any] ?? [:])
        if let now = value["now"] as? [String: Any], let id = now["id"] as? String {
            self.now = NativeNow(id: id, title: now["title"] as? String ?? "", artist: now["artist"] as? String ?? "",
                                 label: now["label"] as? String ?? "", cover: now["cover"] as? String, playing: now["playing"] as? Bool == true,
                                 entryId: now["entryId"] as? String ?? "", position: now["position"] as? Double ?? 0, duration: now["duration"] as? Double ?? 0)
        }
        if let toast = value["toast"] as? [String: Any], let id = toast["id"] as? Int, let text = toast["text"] as? String {
            self.toast = NativeToast(id: id, text: text, error: toast["kind"] as? String == "error")
        }
        preparing = value["preparing"] as? String
        let search = value["search"] as? [String: Any] ?? [:]
        if let query = search["q"] as? String { searchQuery = String(query.prefix(200)) }
        if let scope = search["type"] as? String, ["all", "track", "artist", "album"].contains(scope) { searchScope = scope }
        if let source = search["source"] as? String, ["all", "local", "ytmusic", "youtube", "soundcloud", "yandex"].contains(source) { searchSource = source }
    }
}

enum NativeScreen: Equatable { case home, more, liked, library, search, page, web }
enum NativeTab: String, CaseIterable { case home, library, search }

/// The page's hash route decides what is on screen: ported routes are native, the rest stay web.
enum NativeRoute {
    static func screen(_ path: String) -> NativeScreen {
        switch path {
        case "", "/": return .home
        case "/more": return .more
        case "/liked": return .liked
        case "/library", "/library/tracks", "/library/search": return .library
        case "/search", "/yandex": return .search
        // Described by the page (apps/web/src/lib/native-pages.ts `describe`, same routes).
        case "/library/albums", "/library/artists", "/library/playlists", "/history", "/wave", "/downloads", "/import", "/sources", "/settings", "/diagnostics", "/sound", "/backups", "/smart-playlists", "/duplicates", "/statistics", "/yandex-playlists":
            return .page
        default:
            let parts = path.split(separator: "/")
            if parts.count == 2 && ["smart-playlist", "track-edit"].contains(parts[0]) { return .page }
            if parts.count == 3 && parts[0] == "smart-playlist" && parts[2] == "edit" { return .page }
            if parts.count == 3 && (["catalog", "public"].contains(parts.first) && ["artist", "album"].contains(parts[1]) || parts.first == "soundcloud" && parts[1] == "artist") { return .page }
            if (parts.first == "album" && parts.count == 3) || (["artist", "playlist"].contains(parts.first) && parts.count == 2) { return .page }
            return .web
        }
    }
    /// The highlighted tab, as in the web TabBar (apps/web/src/components/Layout.tsx).
    static func tab(_ path: String) -> NativeTab {
        func under(_ p: String) -> Bool { path == p || path.hasPrefix(p + "/") }
        if path == "/liked" || path == "/downloads" { return .library }
        if path == "/search" || ["/catalog", "/yandex", "/public", "/soundcloud"].contains(where: under) { return .search }
        if under("/library") || under("/playlist") || under("/album") || under("/artist") { return .library }
        return .home
    }
    static func root(_ tab: NativeTab) -> String {
        switch tab {
        case .home: return "/"
        case .library: return "/library"
        case .search: return "/search"
        }
    }
}

/// A native page as the page describes it (apps/web/src/lib/native-pages.ts, `Screen`).
struct NativePageAct {
    let name: String
    let args: [String: Any]
    init?(_ value: Any?) {
        guard let value = value as? [String: Any], let name = value["name"] as? String else { return nil }
        self.name = name
        args = value["args"] as? [String: Any] ?? [:]
    }
}

struct NativeItemAction {
    let title: String, symbol: String, act: NativePageAct, destructive: Bool
    init?(_ value: Any?) {
        guard let value = value as? [String: Any], let title = value["title"] as? String, let act = NativePageAct(value["act"]) else { return nil }
        self.title = title
        symbol = value["symbol"] as? String ?? "circle"
        self.act = act
        destructive = value["destructive"] as? Bool == true
    }
}

enum NativeTone: String { case ok, warn, error, accent }

enum NativePageRow {
    struct Confirm { let title: String, text: String, button: String }
    struct Prompt { let title: String, initial: String, placeholder: String }

    case text(title: String, detail: String?, value: String?, tone: NativeTone?)
    case toggle(title: String, detail: String?, on: Bool, act: NativePageAct, disabled: Bool)
    case choice(title: String, detail: String?, value: String, options: [(value: String, label: String)], act: NativePageAct, disabled: Bool)
    case slider(title: String, detail: String?, value: Double, range: ClosedRange<Double>, step: Double, unit: String, act: NativePageAct, disabled: Bool)
    case button(title: String, symbol: String?, act: NativePageAct, style: String?, disabled: Bool, confirm: Confirm?, prompt: Prompt?)
    case link(title: String, detail: String?, symbol: String?, path: String)
    case url(title: String, url: URL)
    case field(key: String, title: String, value: String, placeholder: String, secure: Bool, help: String?)
    case file(title: String, symbol: String?, types: [String], multiple: Bool, act: NativePageAct)
    case progress(title: String, value: Double?, detail: String?)
    /// `cover` is nil for rows without a picture, `.some(nil)` for a placeholder.
    /// `number` (an album's track list) is drawn in place of the cover.
    case item(title: String, subtitle: String?, cover: String??, tag: String?, tone: NativeTone?, path: String?, act: NativePageAct?, actions: [NativeItemAction], number: Int?)
    case track(id: String, remove: NativeItemAction?)
    /// A catalog page's header: an artist's full-width photo, or an album's centred cover, with play and shuffle.
    case hero(style: String, title: String, subtitle: String?, detail: String?, cover: String?, play: NativePageAct?, shuffle: NativePageAct?)
    /// A horizontal row of cards: albums, singles, artists.
    case shelf(items: [NativeShelfItem])

    init?(_ v: [String: Any]) {
        let title = v["title"] as? String ?? "", detail = v["detail"] as? String, disabled = v["disabled"] as? Bool == true
        switch v["kind"] as? String {
        case "text": self = .text(title: title, detail: detail, value: v["value"] as? String, tone: (v["tone"] as? String).flatMap(NativeTone.init))
        case "toggle":
            guard let act = NativePageAct(v["act"]) else { return nil }
            self = .toggle(title: title, detail: detail, on: v["on"] as? Bool == true, act: act, disabled: disabled)
        case "choice":
            guard let act = NativePageAct(v["act"]) else { return nil }
            let options = (v["options"] as? [[String]] ?? []).compactMap { $0.count == 2 ? (value: $0[0], label: $0[1]) : nil }
            self = .choice(title: title, detail: detail, value: v["value"] as? String ?? "", options: options, act: act, disabled: disabled)
        case "slider":
            guard let act = NativePageAct(v["act"]), let min = (v["min"] as? NSNumber)?.doubleValue, let max = (v["max"] as? NSNumber)?.doubleValue, min < max else { return nil }
            self = .slider(title: title, detail: detail, value: (v["value"] as? NSNumber)?.doubleValue ?? min, range: min...max, step: (v["step"] as? NSNumber)?.doubleValue ?? 1,
                           unit: v["unit"] as? String ?? "", act: act, disabled: disabled)
        case "button":
            guard let act = NativePageAct(v["act"]) else { return nil }
            let c = v["confirm"] as? [String: Any], p = v["prompt"] as? [String: Any]
            self = .button(title: title, symbol: v["symbol"] as? String, act: act, style: v["style"] as? String, disabled: disabled,
                           confirm: c.map { Confirm(title: $0["title"] as? String ?? title, text: $0["text"] as? String ?? "", button: $0["button"] as? String ?? title) },
                           prompt: p.map { Prompt(title: $0["title"] as? String ?? title, initial: $0["initial"] as? String ?? "", placeholder: $0["placeholder"] as? String ?? "") })
        case "link":
            guard let path = v["path"] as? String else { return nil }
            self = .link(title: title, detail: detail, symbol: v["symbol"] as? String, path: path)
        case "url":
            guard let url = (v["url"] as? String).flatMap(URL.init(string:)), url.scheme == "https" else { return nil }
            self = .url(title: title, url: url)
        case "field":
            guard let key = v["key"] as? String else { return nil }
            self = .field(key: key, title: title, value: v["value"] as? String ?? "", placeholder: v["placeholder"] as? String ?? "", secure: v["secure"] as? Bool == true, help: v["help"] as? String)
        case "file":
            guard let act = NativePageAct(v["act"]) else { return nil }
            self = .file(title: title, symbol: v["symbol"] as? String, types: v["types"] as? [String] ?? [], multiple: v["multiple"] as? Bool == true, act: act)
        case "progress": self = .progress(title: title, value: (v["value"] as? NSNumber)?.doubleValue, detail: detail)
        case "item":
            let cover: String?? = v.keys.contains("cover") ? .some(v["cover"] as? String) : nil
            self = .item(title: title, subtitle: v["subtitle"] as? String, cover: cover, tag: v["tag"] as? String, tone: (v["tone"] as? String).flatMap(NativeTone.init),
                         path: v["path"] as? String, act: NativePageAct(v["act"]), actions: (v["actions"] as? [Any] ?? []).compactMap(NativeItemAction.init),
                         number: (v["number"] as? NSNumber)?.intValue)
        case "track":
            guard let id = v["id"] as? String else { return nil }
            self = .track(id: id, remove: NativeItemAction(v["remove"]))
        case "hero":
            self = .hero(style: v["style"] as? String == "artist" ? "artist" : "album", title: title, subtitle: v["subtitle"] as? String, detail: detail,
                         cover: v["cover"] as? String, play: NativePageAct(v["play"]), shuffle: NativePageAct(v["shuffle"]))
        case "shelf":
            let items = (v["items"] as? [[String: Any]] ?? []).compactMap(NativeShelfItem.init)
            guard !items.isEmpty else { return nil }
            self = .shelf(items: items)
        default: return nil
        }
    }

    /// What the page's search field matches (items and tracks only; other rows always show).
    var searchText: String? {
        switch self {
        case .item(let title, let subtitle, _, _, _, _, _, _, _): return NativeSearchText.normalize("\(title) \(subtitle ?? "")")
        default: return nil
        }
    }
}

struct NativeShelfItem: Identifiable {
    let title: String, subtitle: String?, cover: String?, path: String, round: Bool
    var id: String { path }
    init?(_ v: [String: Any]) {
        guard let title = v["title"] as? String, let path = v["path"] as? String else { return nil }
        self.title = title; self.path = path
        subtitle = v["subtitle"] as? String; cover = v["cover"] as? String; round = v["round"] as? Bool == true
    }
}

struct NativePageSection {
    let title: String?, footer: String?
    let rows: [NativePageRow]
    /// Play context of the section's track rows: type, id and label for `play`.
    let play: [String: Any]?
    let reorder: NativePageAct?
}

struct NativePage {
    let title: String
    let sections: [NativePageSection]
    let search: String?
    let refresh: Double?
    /// "catalog": artist and album pages, drawn as a plain list with large section titles.
    let style: String?

    init?(_ value: Any?) {
        guard let value = value as? [String: Any], let title = value["title"] as? String else { return nil }
        self.title = title
        sections = (value["sections"] as? [[String: Any]] ?? []).map { s in
            NativePageSection(title: s["title"] as? String, footer: s["footer"] as? String,
                              rows: (s["rows"] as? [[String: Any]] ?? []).compactMap(NativePageRow.init),
                              play: s["play"] as? [String: Any], reorder: NativePageAct(s["reorder"]))
        }
        search = value["search"] as? String
        refresh = (value["refresh"] as? Double).flatMap { $0 > 0 ? max(1, $0) : nil }
        style = value["style"] as? String
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


struct NativeReactionOutbox {
    private let defaults: UserDefaults
    private(set) var pending: [String: Int]
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pending = (defaults.dictionary(forKey: "mora.pendingReactions") as? [String: Int] ?? [:]).filter { !$0.key.isEmpty && [-1, 0, 1].contains($0.value) }
    }
    mutating func set(_ id: String, _ value: Int) {
        guard !id.isEmpty, [-1, 0, 1].contains(value) else { return }
        pending[id] = value
        defaults.set(pending, forKey: "mora.pendingReactions")
    }
    mutating func acknowledge(_ id: String, _ value: Int) {
        guard pending[id] == value else { return }
        pending.removeValue(forKey: id)
        defaults.set(pending, forKey: "mora.pendingReactions")
    }
    mutating func remap(_ mapping: [String: String]) {
        var next: [String: Int] = [:]
        for (id, value) in pending {
            let key = mapping[id] ?? id, previous = next[key] ?? 0
            next[key] = value == 1 || previous == 1 ? 1 : value == -1 || previous == -1 ? -1 : 0
        }
        pending = next
        defaults.set(pending, forKey: "mora.pendingReactions")
    }
}


enum NativePreviewResume {
    static func allowed(_ current: [String: Any], after paused: [String: Any]) -> Bool {
        guard let entry = paused["entryId"] as? String, !entry.isEmpty,
              let revision = paused["controlRevision"] as? Int else { return false }
        return current["active"] as? Bool == true && current["playing"] as? Bool != true
            && current["entryId"] as? String == entry && current["controlRevision"] as? Int == revision
            && current["epoch"] as? Int == paused["epoch"] as? Int
    }
}
struct NativeCatalogLink: Identifiable {
    let id: String, title: String, detail: String, path: String
    let cover: String?
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let path = value["path"] as? String, path.hasPrefix("/") else { return nil }
        self.id = id; self.path = path; title = value["title"] as? String ?? ""
        detail = value["detail"] as? String ?? ""; cover = value["cover"] as? String
    }
}
struct NativeSearchHit: Identifiable {
    var id: String { track.id }
    let track: NativeTrack, explicit: Bool, saved: Bool, tags: String
    init?(_ value: [String: Any]) {
        guard let track = NativeTrack(value) else { return nil }
        self.track = track; explicit = value["explicit"] as? Bool == true
        saved = value["saved"] as? Bool == true; tags = value["tags"] as? String ?? ""
    }
}
struct NativeSearchResults {
    let session: String, tracks: [NativeSearchHit], artists: [NativeCatalogLink], albums: [NativeCatalogLink], more: Bool
    init?(_ value: Any?) {
        guard let value = value as? [String: Any], let session = value["session"] as? String, !session.isEmpty else { return nil }
        self.session = session
        tracks = (value["tracks"] as? [[String: Any]] ?? []).compactMap(NativeSearchHit.init)
        artists = (value["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
        albums = (value["albums"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
        more = value["more"] as? Bool == true
    }
    var isEmpty: Bool { tracks.isEmpty && artists.isEmpty && albums.isEmpty }
}
