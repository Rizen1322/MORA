import Foundation

/// Native artist/album catalog pages (`/catalog/...`, `/public/...`, `/soundcloud/...`) and
/// native Yandex catalog search sessions, backed by Swift providers with JSC API fallback.
/// Foundation-only (covered by standalone `swiftc` self-checks).
final class NativeCatalogState {
    typealias Request = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any]
    typealias LocalTrackLookup = (_ provider: String, _ externalId: String) -> (trackId: String, saved: Bool, reaction: Int)?

    struct SearchSession {
        let id: String
        let source: String
        let query: String
        let scope: String
        var page: Int
        var items: [[String: Any]]
        var artists: [[String: Any]]
        var albums: [[String: Any]]
        var more: Bool
        let context: [String: Any]
    }

    private struct CachedPage {
        let data: [String: Any]
        let expires: Date
    }

    private let now: () -> Date
    private var cache: [String: CachedPage] = [:]
    private var pageGeneration = 0
    private(set) var yandexGeneration = 0
    /// Stage 3: SoundCloud, Public (YouTube Music) and Yandex catalog providers in Swift.
    var soundcloud: NativeSoundCloud? = .live
    var publicCatalog: NativePublicCatalog? = .live
    var yandex: NativeYandexCatalog?

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// Search sessions keyed by token (bounded to 24, matching lib/native-catalog.ts).
    private var searchSessions: [String: SearchSession] = [:]
    private var searchSessionOrder: [String] = []
    /// Optimistic reactions for remote catalog tracks not yet imported into local SQLite.
    private var externalReactions: [String: Int] = [:]

    /// Simulator UI check fixtures (never active in production unless explicitly installed).
    private var fixtures: [String: [String: Any]] = [:]
    private var searchFixtures: [String: [String: Any]] = [:]
    private(set) var recordedSearchQueries: [String] = []

    func installFixture(_ path: String, _ page: [String: Any]) { fixtures[path] = page; cache.removeAll(); pageGeneration += 1 }
    func removeFixtures() { fixtures.removeAll(); cache.removeAll(); pageGeneration += 1 }

    func installSearchFixture(_ source: String, _ result: [String: Any]) {
        searchFixtures[source] = result
    }
    func removeSearchFixtures() {
        searchFixtures.removeAll()
        recordedSearchQueries.removeAll()
    }

    /// A catalog track action (like/save/queue) or pull-to-refresh invalidated cached state.
    func invalidate() {
        cache.removeAll()
        pageGeneration += 1
        yandex?.invalidate()
        publicCatalog?.invalidate()
    }

    /// Drops Yandex account credentials and cached Yandex pages/sessions when account changes.
    func clearYandex() {
        for key in cache.keys where key.hasPrefix("yandex/") { cache.removeValue(forKey: key) }
        for (sid, session) in searchSessions where session.source == "yandex" {
            searchSessions.removeValue(forKey: sid)
            searchSessionOrder.removeAll { $0 == sid }
        }
        externalReactions.removeAll()
        pageGeneration += 1
        yandexGeneration += 1
        yandex?.clear()
    }

    private func cached(_ key: String) -> [String: Any]? {
        guard let entry = cache[key] else { return nil }
        if entry.expires > now() { return entry.data }
        cache.removeValue(forKey: key)
        return nil
    }

    private func store(_ key: String, data: [String: Any]) {
        if cache[key] == nil && cache.count >= 40,
           let oldest = cache.min(by: { $0.value.expires < $1.value.expires })?.key {
            cache.removeValue(forKey: oldest)
        }
        let ttl: TimeInterval = key.hasPrefix("yandex/") ? 120 : 300
        cache[key] = CachedPage(data: data, expires: now().addingTimeInterval(ttl))
    }

    func setExternalReaction(provider: String, externalId: String, value: Int) {
        guard !provider.isEmpty, !externalId.isEmpty else { return }
        externalReactions["\(provider):\(externalId)"] = value
    }

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
        let pageGen = pageGeneration
        var data = cached(key) ?? [:]
        let nextPage = (data["page"] as? NSNumber)?.intValue ?? 0
        let account = yandexGeneration
        let more: [String: Any]
        if let yandex {
            more = try await yandex.artistPage(id, page: nextPage + 1)
        } else {
            more = try await request("GET", "/api/catalog/yandex/artists/\(Self.enc(id))?page=\(nextPage + 1)", nil)
        }
        guard yandexGeneration == account else { throw CancellationError() }
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
        if pageGen == pageGeneration { store(key, data: data) }
    }

    func page(_ path: String, request: Request, localLookup: LocalTrackLookup? = nil) async throws -> [String: Any] {
        if let fixture = fixtures[path] { return fixture }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 3, ["artist", "album"].contains(parts[1]) else {
            throw NSError(domain: "NativeCatalogState", code: 1, userInfo: [NSLocalizedDescriptionKey: "Неизвестная страница каталога"])
        }
        let source = parts[0], kind = parts[1]
        let id = parts[2].removingPercentEncoding ?? parts[2]
        let enc = Self.enc(id)

        let pageGen = pageGeneration
        if source == "catalog" {
            let account = yandexGeneration
            if kind == "album" {
                let key = "yandex/album/\(id)"
                let data: [String: Any]
                if let hit = cached(key) { data = hit }
                else {
                    let loaded: [String: Any]
                    if let yandex { loaded = try await yandex.albumPage(id) }
                    else { loaded = try await request("GET", "/api/catalog/yandex/albums/\(enc)", nil) }
                    guard yandexGeneration == account else { throw CancellationError() }
                    if pageGen == pageGeneration { store(key, data: loaded) }
                    data = loaded
                }
                let album = data["album"] as? [String: Any] ?? [:]
                let title = album["title"] as? String ?? ""
                let tracks = Self.enrichTracks(data["tracks"] as? [[String: Any]] ?? [], defaultProvider: "yandex", lookup: localLookup, pendingReactions: externalReactions)
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
            if let hit = cached(key) { data = hit }
            else {
                var loaded: [String: Any]
                if let yandex { loaded = try await yandex.artistPage(id, page: 0) }
                else { loaded = try await request("GET", "/api/catalog/yandex/artists/\(enc)?page=0", nil) }
                guard yandexGeneration == account else { throw CancellationError() }
                loaded["page"] = 0
                if pageGen == pageGeneration { store(key, data: loaded) }
                data = loaded
            }
            let artist = data["artist"] as? [String: Any] ?? [:]
            let name = artist["name"] as? String ?? ""
            let popular = Self.enrichTracks(data["popularTracks"] as? [[String: Any]] ?? [], defaultProvider: "yandex", lookup: localLookup, pendingReactions: externalReactions)
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
        if let hit = cached(key) { data = hit }
        else {
            var nativePage: [String: Any]?
            if source == "soundcloud", kind == "artist", let soundcloud {
                nativePage = try? await soundcloud.artist(id)
            } else if source == "public", let publicCatalog {
                nativePage = try? await (kind == "artist" ? publicCatalog.artist(id) : publicCatalog.album(id))
            }
            try Task.checkCancellation()
            if let nativePage, !(nativePage["tracks"] as? [Any] ?? []).isEmpty || !(nativePage["title"] as? String ?? "").isEmpty {
                if pageGen == pageGeneration { store(key, data: nativePage) }
                data = nativePage
            } else {
                let url = source == "soundcloud"
                    ? "/api/catalog/soundcloud/artists/\(enc)"
                    : "/api/catalog/public/\(kind == "artist" ? "artists" : "albums")/\(enc)"
                let loaded = try await request("GET", url, nil)
                if pageGen == pageGeneration { store(key, data: loaded) }
                data = loaded
            }
        }
        let title = data["title"] as? String ?? ""
        let defaultProvider = source == "soundcloud" ? "soundcloud" : "youtube"
        let tracks = Self.enrichTracks(data["tracks"] as? [[String: Any]] ?? [], defaultProvider: defaultProvider, lookup: localLookup, pendingReactions: externalReactions)
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

    // MARK: Native Yandex Search

    func searchSession(_ id: String) -> SearchSession? {
        searchSessions[id]
    }

    /// Runs Yandex Music search or Home likes feed directly in Swift (with JSC API fallback),
    /// returning the exact dictionary shape consumed by `NativeSearchResults`.
    func searchYandex(query: String, scope: String, more: Bool, previousSession: String?,
                      request: Request, localLookup: LocalTrackLookup? = nil) async throws -> [String: Any] {
        let cleanQuery = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        if let fixture = searchFixtures["yandex"] {
            recordedSearchQueries.append(cleanQuery)
            return fixture
        }
        let validScope = ["track", "artist", "album"].contains(scope) ? scope : "all"
        let previous: SearchSession?
        if more {
            guard let previousSession, let prev = searchSessions[previousSession] else {
                throw NSError(domain: "NativeCatalogState", code: 2, userInfo: [NSLocalizedDescriptionKey: "Результаты устарели. Повторите поиск."])
            }
            guard prev.source == "yandex", prev.query == cleanQuery, prev.scope == validScope else {
                throw NSError(domain: "NativeCatalogState", code: 3, userInfo: [NSLocalizedDescriptionKey: "Поиск уже изменился"])
            }
            previous = prev
        } else {
            previous = nil
        }

        let nextPage = previous.map { $0.page + 1 } ?? 0
        guard nextPage <= 100 else {
            throw NSError(domain: "NativeCatalogState", code: 4, userInfo: [NSLocalizedDescriptionKey: "Слишком много страниц результатов"])
        }

        let account = yandexGeneration
        let found: [String: Any]
        if let yandex {
            found = cleanQuery.isEmpty ? try await yandex.home() : try await yandex.search(cleanQuery, page: nextPage, type: validScope)
        } else {
            let path = cleanQuery.isEmpty
                ? "/api/catalog/yandex/home"
                : "/api/catalog/yandex/search?q=\(Self.enc(cleanQuery))&page=\(nextPage)&type=\(Self.enc(validScope))"
            found = try await request("GET", path, nil)
        }
        guard yandexGeneration == account else { throw CancellationError() }

        let incomingTracks = Self.enrichTracks(found["tracks"] as? [[String: Any]] ?? [], defaultProvider: "yandex", lookup: localLookup, pendingReactions: externalReactions)
        let incomingArtists = (found["artists"] as? [[String: Any]] ?? []).map { raw -> [String: Any] in
            var link = Self.artistLink(raw, pathPrefix: "/catalog/artist/")
            if (link["detail"] as? String ?? "").isEmpty { link["detail"] = "Исполнитель" }
            return link
        }
        let incomingAlbums = (found["albums"] as? [[String: Any]] ?? []).map { raw -> [String: Any] in
            var link = Self.albumLink(raw)
            if (link["detail"] as? String ?? "").isEmpty { link["detail"] = "Альбом" }
            return link
        }

        let mergedTracks = Self.unique((previous?.items ?? []) + incomingTracks) { Self.trackId($0) }
        let mergedArtists = Self.unique((previous?.artists ?? []) + incomingArtists) { $0["id"] as? String ?? "" }
        let mergedAlbums = Self.unique((previous?.albums ?? []) + incomingAlbums) { $0["id"] as? String ?? "" }
        let hasMoreMap = found["hasMore"] as? [String: Any] ?? [:]
        let hasMore = (hasMoreMap["tracks"] as? Bool == true) || (hasMoreMap["artists"] as? Bool == true) || (hasMoreMap["albums"] as? Bool == true)
        let page = (found["page"] as? NSNumber)?.intValue ?? nextPage

        let token = UUID().uuidString
        let label = "Яндекс Музыка" + (cleanQuery.isEmpty ? "" : " · " + cleanQuery)
        let session = SearchSession(
            id: token, source: "yandex", query: cleanQuery, scope: validScope, page: page,
            items: mergedTracks, artists: mergedArtists, albums: mergedAlbums, more: hasMore,
            context: ["type": "search", "label": label]
        )
        storeSession(session)
        return renderSearchSession(session, lookup: localLookup)
    }

    func updateSearchSessionTrack(sessionId: String, externalId: String, reaction: Int? = nil,
                                  libraryTrackId: String? = nil, saved: Bool? = nil,
                                  lookup: LocalTrackLookup? = nil) -> [String: Any]? {
        guard var session = searchSessions[sessionId] else { return nil }
        if let reaction { setExternalReaction(provider: session.source, externalId: externalId, value: reaction) }
        for i in session.items.indices where Self.trackId(session.items[i]) == externalId {
            if let reaction { session.items[i]["reaction"] = reaction }
            if let libraryTrackId { session.items[i]["libraryTrackId"] = libraryTrackId }
            if let saved { session.items[i]["saved"] = saved }
        }
        searchSessions[sessionId] = session
        return renderSearchSession(session, lookup: lookup)
    }

    private func storeSession(_ session: SearchSession) {
        searchSessions[session.id] = session
        searchSessionOrder.removeAll { $0 == session.id }
        searchSessionOrder.append(session.id)
        while searchSessionOrder.count > 24, let oldest = searchSessionOrder.first {
            searchSessionOrder.removeFirst()
            searchSessions.removeValue(forKey: oldest)
        }
    }

    private func renderSearchSession(_ session: SearchSession, lookup: LocalTrackLookup?) -> [String: Any] {
        let formattedTracks = session.items.map { item -> [String: Any] in
            let id = Self.trackId(item)
            let local = lookup?(session.source, id)
            let reaction = local?.reaction ?? (item["reaction"] as? NSNumber)?.intValue ?? 0
            let saved = local?.saved ?? (item["saved"] as? Bool == true)
            var row: [String: Any] = [
                "id": id,
                "externalId": id,
                "provider": item["provider"] as? String ?? session.source,
                "title": item["title"] as? String ?? "",
                "artist": item["artist"] as? String ?? "",
                "album": item["album"] as? String ?? "",
                "duration": (item["duration"] as? NSNumber)?.doubleValue ?? 0.0,
                "reaction": reaction,
                "ok": item["playable"] as? Bool != false,
                "saved": saved,
                "explicit": item["explicit"] as? Bool == true,
                "tags": "",
            ]
            if let cover = item["coverUrl"] as? String, !cover.isEmpty { row["cover"] = cover }
            return row
        }
        return [
            "session": session.id,
            "page": session.page,
            "more": session.more,
            "artists": session.artists,
            "albums": session.albums,
            "tracks": formattedTracks,
        ]
    }

    // MARK: helpers

    static func enrichTracks(_ tracks: [[String: Any]], defaultProvider: String, lookup: LocalTrackLookup?,
                             pendingReactions: [String: Int] = [:]) -> [[String: Any]] {
        tracks.map { raw in
            var t = raw
            let extId = trackId(raw)
            let provider = (raw["audioProvider"] as? String) ?? (raw["provider"] as? String) ?? defaultProvider
            if t["provider"] == nil { t["provider"] = provider }
            if t["externalId"] == nil && !extId.isEmpty { t["externalId"] = extId }
            if t["coverUrl"] == nil, let thumb = raw["thumbnail"] as? String { t["coverUrl"] = thumb }
            if t["artistId"] == nil, let aid = raw["artist_id"] as? String { t["artistId"] = aid }
            if t["pageUrl"] == nil, let page = raw["webpage_url"] as? String { t["pageUrl"] = page }
            if t["playable"] == nil { t["playable"] = true }
            if !extId.isEmpty, let local = lookup?(provider, extId) {
                t["libraryTrackId"] = local.trackId
                t["saved"] = local.saved
                t["reaction"] = local.reaction
            } else if !extId.isEmpty, let pending = pendingReactions["\(provider):\(extId)"] {
                t["reaction"] = pending
            }
            return t
        }
    }

    private static func trackId(_ item: [String: Any]) -> String {
        if let s = item["externalId"] as? String, !s.isEmpty { return s }
        if let s = item["id"] as? String, !s.isEmpty { return s }
        if let n = item["id"] as? NSNumber { return String(n.int64Value) }
        return ""
    }

    private static func unique(_ items: [[String: Any]], by key: ([String: Any]) -> String) -> [[String: Any]] {
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for item in items {
            let k = key(item)
            if k.isEmpty || seen.insert(k).inserted { out.append(item) }
        }
        return out
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
        let provider = source == "ytmusic" ? "youtube" : source
        return items.enumerated().map { index, track in
            let title = track["title"] as? String ?? ""
            let artist = track["artist"] as? String ?? ""
            let duration = (track["duration"] as? NSNumber)?.doubleValue ?? 0
            let saved = (track["saved"] as? Bool) ?? ((track["libraryTrackId"] as? String) != nil)
            let reaction = (track["reaction"] as? NSNumber)?.intValue ?? 0
            let liked = reaction > 0
            let disliked = reaction < 0
            let subtitle = numbered && !artist.isEmpty ? "\(index + 1). \(artist)" : artist
            var canonicalTrack = track
            if canonicalTrack["provider"] == nil { canonicalTrack["provider"] = provider }
            let playPayload: [String: Any] = ["tracks": items, "index": index, "context": context]
            var actions: [[String: Any]] = [
                ["title": "Играть следующим", "symbol": "text.line.first.and.arrowtriangle.forward", "act": ["name": "catalogTrack", "args": ["kind": "next", "track": canonicalTrack]]],
                ["title": "В очередь", "symbol": "text.append", "act": ["name": "catalogTrack", "args": ["kind": "queue", "track": canonicalTrack]]],
                ["title": liked ? "Убрать лайк" : "Нравится", "symbol": liked ? "heart.fill" : "heart", "act": ["name": "catalogTrack", "args": ["kind": "like", "track": canonicalTrack]]],
                ["title": disliked ? "Убрать дизлайк" : "Не нравится", "symbol": "hand.thumbsdown", "act": ["name": "catalogTrack", "args": ["kind": "dislike", "track": canonicalTrack]]],
            ]
            if !saved {
                actions.append(["title": "Сохранить в медиатеку", "symbol": "plus", "act": ["name": "catalogTrack", "args": ["kind": "save", "track": canonicalTrack]]])
            }
            actions.append(["title": "Скачать", "symbol": "arrow.down.circle", "act": ["name": "catalogTrack", "args": ["kind": "download", "track": canonicalTrack]]])
            var row: [String: Any] = [
                "kind": "item",
                "title": duration > 0 ? "\(title) · \(Self.time(duration))" : title,
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
        let year = (raw["year"] as? NSNumber).map { String($0.intValue) } ?? ""
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
