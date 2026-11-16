import Foundation

/// Native artist/album catalog pages (/catalog/..., /public/..., /soundcloud/...) backed directly
/// by JSC API instead of the WebView `describeNativeCatalog` helper.
final class NativeCatalogState {
    typealias Request = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any]

    private var cache: [String: [String: Any]] = [:]
    /// The simulator UI check injects pages instead of calling the real providers.
    private var fixtures: [String: [String: Any]] = [:]

    func installFixture(_ path: String, _ page: [String: Any]) { fixtures[path] = page; cache.removeAll() }
    func removeFixtures() { fixtures.removeAll(); cache.removeAll() }
    /// A catalog track action (like/save/queue) changed state the cached page still shows.
    func invalidate() { cache.removeAll() }

    static func handles(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 3 else { return false }
        return ["catalog", "public", "soundcloud"].contains(parts[0]) && ["artist", "album"].contains(parts[1])
    }

    static func supports(_ name: String) -> Bool {
        name == "catalogMore"
    }

    func execute(_ name: String, _ args: [String: Any], request: Request) async throws {
        guard name == "catalogMore", let id = args["id"] as? String, !id.isEmpty else { return }
        let key = "yandex/artist/\(id)"
        var data = cache[key] ?? [:]
        let nextPage = (data["page"] as? NSNumber)?.intValue ?? 0
        let enc = Self.enc(id)
        let more = try await request("GET", "/api/catalog/yandex/artists/\(enc)?page=\(nextPage + 1)", nil)
        let existing = data["albums"] as? [[String: Any]] ?? []
        let added = more["albums"] as? [[String: Any]] ?? []
        var seen = Set(existing.compactMap { $0["id"] as? String })
        let merged = existing + added.filter {
            guard let aid = $0["id"] as? String else { return false }
            return seen.insert(aid).inserted
        }
        data["albums"] = merged
        data["hasMoreAlbums"] = more["hasMoreAlbums"] as? Bool ?? false
        data["page"] = nextPage + 1
        cache[key] = data
    }

    func page(_ path: String, request: Request) async throws -> [String: Any] {
        if let fixture = fixtures[path] { return fixture }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 3, ["artist", "album"].contains(parts[1]) else {
            throw NSError(domain: "NativeCatalogState", code: 1, userInfo: [NSLocalizedDescriptionKey: "Неизвестная страница каталога"])
        }
        let source = parts[0], kind = parts[1]
        let id = parts[2].removingPercentEncoding ?? parts[2]
        let enc = Self.enc(id)

        if source == "catalog" {
            if kind == "album" {
                let key = "yandex/album/\(id)"
                let data: [String: Any]
                if let hit = cache[key] { data = hit }
                else {
                    let loaded = try await request("GET", "/api/catalog/yandex/albums/\(enc)", nil)
                    cache[key] = loaded; data = loaded
                }
                let album = data["album"] as? [String: Any] ?? [:]
                let title = album["title"] as? String ?? ""
                let tracks = data["tracks"] as? [[String: Any]] ?? []
                let artists = album["artists"] as? [[String: Any]] ?? []
                let subtitle = artists.compactMap { $0["name"] as? String }.joined(separator: ", ")
                let year = (album["year"] as? NSNumber).map { String($0.intValue) }
                let detail = [year, Self.tracksWord(tracks.count)].compactMap { $0 }.joined(separator: " · ")
                return [
                    "title": title,
                    "style": "catalog",
                    "sections": [
                        ["rows": [Self.hero(style: "album", title: title, cover: album["imageUrl"] as? String, subtitle: subtitle, detail: detail, playable: !tracks.isEmpty, items: tracks, context: ["type": "album", "id": id, "label": title])]],
                        ["rows": Self.trackRows(tracks, numbered: true, source: "yandex", context: ["type": "album", "id": id, "label": title])],
                        ["title": "Исполнители", "rows": Self.shelf(artists.map { Self.artistLink($0, pathPrefix: "/catalog/artist/") }, round: true)],
                    ],
                ]
            }

            let key = "yandex/artist/\(id)"
            let data: [String: Any]
            if let hit = cache[key] { data = hit }
            else {
                var loaded = try await request("GET", "/api/catalog/yandex/artists/\(enc)?page=0", nil)
                loaded["page"] = 0
                cache[key] = loaded; data = loaded
            }
            let artist = data["artist"] as? [String: Any] ?? [:]
            let name = artist["name"] as? String ?? ""
            let popular = data["popularTracks"] as? [[String: Any]] ?? []
            let albums = data["albums"] as? [[String: Any]] ?? []
            let similar = data["similarArtists"] as? [[String: Any]] ?? []
            let genres = (artist["genres"] as? [String] ?? []).joined(separator: " · ")
            let hasMore = data["hasMoreAlbums"] as? Bool == true
            var albumRows = Self.shelf(albums.map { Self.albumLink($0) }, round: false)
            if hasMore {
                albumRows.append(["kind": "button", "title": "Ещё альбомы", "act": ["name": "catalogMore", "args": ["id": id]]])
            }
            var sections: [[String: Any]] = [
                ["rows": [Self.hero(style: "artist", title: name, cover: artist["imageUrl"] as? String, subtitle: genres, detail: nil, playable: !popular.isEmpty, items: popular, context: ["type": "artist", "id": id, "label": name])]],
                ["title": "Популярные треки", "rows": Self.trackRows(Array(popular.prefix(10)), numbered: false, source: "yandex", context: ["type": "artist", "id": id, "label": name])],
                ["title": "Альбомы", "rows": albumRows],
                ["title": "Похожие исполнители", "rows": Self.shelf(similar.map { Self.artistLink($0, pathPrefix: "/catalog/artist/") }, round: true)],
            ]
            if let desc = artist["description"] as? String, !desc.isEmpty {
                sections.append(["title": "Об исполнителе", "rows": [["kind": "text", "title": desc]]])
            }
            return ["title": name, "style": "catalog", "sections": sections]
        }

        let key = "\(source)/\(kind)/\(id)"
        let data: [String: Any]
        if let hit = cache[key] { data = hit }
        else {
            let url = source == "soundcloud"
                ? "/api/catalog/soundcloud/artists/\(enc)"
                : "/api/catalog/public/\(kind == "artist" ? "artists" : "albums")/\(enc)"
            let loaded = try await request("GET", url, nil)
            cache[key] = loaded; data = loaded
        }
        let title = data["title"] as? String ?? ""
        let tracks = data["tracks"] as? [[String: Any]] ?? []
        let src = data["source"] as? String ?? source
        let albums = data["albums"] as? [[String: Any]] ?? []
        let isArtist = kind == "artist"
        let heroSub = isArtist ? (data["description"] as? String) : (tracks.first?["artist"] as? String)
        let heroDetail = isArtist ? nil : Self.tracksWord(tracks.count)
        let context: [String: Any] = ["type": kind, "id": id, "label": title]
        var trackSection: [String: Any] = ["rows": Self.trackRows(tracks, numbered: !isArtist, source: src, context: context)]
        if isArtist { trackSection["title"] = "Популярные треки" }
        if data["limited"] as? Bool == true { trackSection["footer"] = "Показаны записи, доступные в этом источнике." }
        var sections: [[String: Any]] = [
            ["rows": [Self.hero(style: isArtist ? "artist" : "album", title: title, cover: data["coverUrl"] as? String, subtitle: heroSub, detail: heroDetail, playable: !tracks.isEmpty, items: tracks, context: context)]],
            trackSection,
        ]
        if !albums.isEmpty {
            let links: [[String: Any]] = albums.compactMap { album in
                guard let aid = album["id"] as? String, let atitle = album["title"] as? String else { return nil }
                var card: [String: Any] = [
                    "id": aid,
                    "title": atitle,
                    "detail": album["artist"] as? String ?? "",
                    "path": "/public/album/\(Self.enc(aid))",
                ]
                if let cover = album["coverUrl"] as? String { card["cover"] = cover }
                return card
            }
            sections.append(["title": "Альбомы", "rows": Self.shelf(links, round: false)])
        }
        return ["title": title, "style": "catalog", "sections": sections]
    }

    private static func hero(style: String, title: String, cover: String?, subtitle: String?, detail: String?,
                             playable: Bool, items: [[String: Any]], context: [String: Any]) -> [String: Any] {
        var row: [String: Any] = ["kind": "hero", "style": style, "title": title]
        if let cover, !cover.isEmpty { row["cover"] = cover }
        if let subtitle, !subtitle.isEmpty { row["subtitle"] = subtitle }
        if let detail, !detail.isEmpty { row["detail"] = detail }
        if playable {
            let payload: [String: Any] = ["tracks": items, "context": context]
            row["play"] = ["name": "catalogPlay", "args": payload.merging(["shuffle": false]) { a, _ in a }]
            row["shuffle"] = ["name": "catalogPlay", "args": payload.merging(["shuffle": true]) { a, _ in a }]
        }
        return row
    }

    private static func trackRows(_ items: [[String: Any]], numbered: Bool, source: String, context: [String: Any]) -> [[String: Any]] {
        items.enumerated().map { index, track in
            let title = track["title"] as? String ?? ""
            let artist = track["artist"] as? String ?? ""
            let duration = (track["duration"] as? NSNumber)?.doubleValue ?? 0
            let saved = (track["libraryTrackId"] as? String) != nil
            let reaction = (track["reaction"] as? NSNumber)?.intValue ?? 0
            let liked = reaction > 0
            let subtitle = numbered && !artist.isEmpty ? "\(index + 1). \(artist)" : artist
            let playPayload: [String: Any] = ["tracks": items, "index": index, "context": context]
            var actions: [[String: Any]] = [
                ["title": "Играть следующим", "symbol": "text.line.first.and.arrowtriangle.forward", "act": ["name": "catalogTrack", "args": ["kind": "next", "track": track]]],
                ["title": "В очередь", "symbol": "text.append", "act": ["name": "catalogTrack", "args": ["kind": "queue", "track": track]]],
                ["title": liked ? "Убрать из любимого" : "Нравится", "symbol": liked ? "heart.slash" : "heart", "act": ["name": "catalogTrack", "args": ["kind": "like", "track": track]]],
            ]
            if !saved {
                actions.append(["title": "Сохранить в медиатеку", "symbol": "plus", "act": ["name": "catalogTrack", "args": ["kind": "save", "track": track]]])
            }
            actions.append(["title": "Скачать", "symbol": "arrow.down.circle", "act": ["name": "catalogTrack", "args": ["kind": "download", "track": track]]])
            var row: [String: Any] = [
                "kind": "item",
                "title": "\(title) · \(Self.time(duration))",
                "subtitle": subtitle,
                "act": ["name": "catalogPlay", "args": playPayload],
                "actions": actions,
            ]
            if let cover = track["coverUrl"] as? String, !cover.isEmpty { row["cover"] = cover }
            return row
        }
    }

    private static func shelf(_ items: [[String: Any]], round: Bool) -> [[String: Any]] {
        items.isEmpty ? [] : [["kind": "shelf", "round": round, "items": items]]
    }

    private static func artistLink(_ raw: [String: Any], pathPrefix: String) -> [String: Any] {
        let id = raw["id"] as? String ?? ""
        let name = raw["name"] as? String ?? ""
        var card: [String: Any] = [
            "id": id,
            "title": name,
            "path": pathPrefix + (Self.enc(id)),
        ]
        if let cover = raw["imageUrl"] as? String { card["cover"] = cover }
        return card
    }

    private static func albumLink(_ raw: [String: Any]) -> [String: Any] {
        let id = raw["id"] as? String ?? ""
        let title = raw["title"] as? String ?? ""
        let year = (raw["year"] as? NSNumber)?.intValue.map(String.init) ?? ""
        var card: [String: Any] = [
            "id": id,
            "title": title,
            "detail": year,
            "path": "/catalog/album/" + (Self.enc(id)),
        ]
        if let cover = raw["imageUrl"] as? String { card["cover"] = cover }
        return card
    }

    /// Strict segment encoding: ids come from the API and must not add path parts.
    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
    }
    private static func time(_ seconds: Double) -> String {
        let value = max(0, Int(seconds))
        return String(format: "%d:%02d", value / 60, value % 60)
    }
    private static func tracksWord(_ n: Int) -> String {
        let m10 = n % 10, m100 = n % 100
        let word = (m10 == 1 && m100 != 11) ? "трек" : ([2, 3, 4].contains(m10) && ![12, 13, 14].contains(m100) ? "трека" : "треков")
        return "\(n) \(word)"
    }
}
