import Foundation
import CoreFoundation

private final class NativeYandexRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Stage 3: Yandex Music catalog provider in Swift (`search`, `home`, `artistPage`, `albumPage`).
/// Foundation-only (covered by standalone `swiftc` self-checks). Credentials come strictly from memory
/// via the private mobile token handoff closure, never from `/api/settings` or logs.
final class NativeYandexCatalog {
    struct Failure: LocalizedError {
        let statusCode: Int
        let message: String
        var errorDescription: String? { message }
    }

    typealias CredentialsLoader = () async throws -> (token: String, apiBase: String)
    typealias Fetch = (_ request: URLRequest, _ limit: Int) async throws -> (Int, Data)

    private struct CacheEntry { let expires: Date; let value: [String: Any] }
    private struct CredCache { let token: String; let apiBase: String; let expires: Date }

    private static let maxResponseBytes = 4 << 20
    private static let cacheLimit = 40
    private static let cacheTTL: TimeInterval = 120
    private static let credentialsTTL: TimeInterval = 60

    private static let trackIdRegex = try! NSRegularExpression(
        pattern: #"^(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?::\d+)?$"#,
        options: .caseInsensitive
    )
    private static let numericIdRegex = try! NSRegularExpression(pattern: #"^\d{1,24}$"#)
    private static let controlCharRegex = try! NSRegularExpression(pattern: #"[\u0000-\u001f\u007f]"#)
    private static let htmlTagRegex = try! NSRegularExpression(pattern: #"<[^>]*>"#)
    private static let audioPathRegex = try! NSRegularExpression(
        pattern: #"/get-mp3/|\.(mp3|flac|wav|m3u8|aac|ogg)(?:$|/)"#,
        options: .caseInsensitive
    )
    private static let unreservedFormChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static let mediaDomains = ["yandex.net", "yandex.ru", "yandex.com", "yandexmusic.net", "yandexmusic.ru"]

    private let credentialsLoader: CredentialsLoader
    private let fetch: Fetch
    private let lock = NSLock()
    private var creds: CredCache?
    private var cache: [String: CacheEntry] = [:]
    private var cacheOrder: [String] = []
    private var generation = 0
    private var cacheGeneration = 0

    init(credentialsLoader: @escaping CredentialsLoader, fetch: @escaping Fetch = NativeYandexCatalog.urlSessionFetch) {
        self.credentialsLoader = credentialsLoader
        self.fetch = fetch
    }

    private func locked<T>(_ work: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try work()
    }

    /// Drops both cached pages and credentials (when account connects or disconnects).
    func clear() {
        locked {
            generation &+= 1
            cacheGeneration &+= 1
            creds = nil
            cache.removeAll()
            cacheOrder.removeAll()
        }
    }

    /// Drops cached catalog pages while preserving credentials.
    func invalidate() {
        locked {
            cacheGeneration &+= 1
            cache.removeAll()
            cacheOrder.removeAll()
        }
    }

    // MARK: public API

    func search(_ query: String, page: Int = 0, type: String = "all") async throws -> [String: Any] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 300,
              Self.controlCharRegex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) == nil else {
            throw Failure(statusCode: 400, message: "Введите поисковый запрос длиной до 300 символов")
        }
        guard ["all", "track", "artist", "album"].contains(type) else {
            throw Failure(statusCode: 400, message: "Некорректный тип поиска")
        }
        guard (0...100).contains(page) else {
            throw Failure(statusCode: 400, message: "Некорректная страница каталога")
        }
        return try await cached("search:\(type):\(page):\(trimmed)") { apiBase in
            let qs = Self.formEncode([("text", trimmed), ("type", type), ("page", String(page)), ("playlist-in-best", "false")])
            let raw = Self.object(try await self.call(method: "GET", path: "/search?\(qs)"))
            var tracks = Self.list(Self.object(raw["tracks"])["results"]).compactMap { Self.track($0, apiBase: apiBase) }
            var artists = Self.list(Self.object(raw["artists"])["results"]).compactMap { Self.artist($0, apiBase: apiBase) }
            var albums = Self.list(Self.object(raw["albums"])["results"]).compactMap { Self.album($0, apiBase: apiBase) }

            var best: [String: Any]?
            let rawBest = Self.object(raw["best"])
            let bestType = rawBest["type"] as? String ?? ""
            let bestResult = Self.object(rawBest["result"])
            if bestType == "track", let t = Self.track(bestResult, apiBase: apiBase), let tid = t["externalId"] as? String {
                best = ["type": "track", "id": tid]
                if !tracks.contains(where: { ($0["externalId"] as? String) == tid }) { tracks.insert(t, at: 0) }
            } else if bestType == "artist", let a = Self.artist(bestResult, apiBase: apiBase), let aid = a["id"] as? String {
                best = ["type": "artist", "id": aid]
                if !artists.contains(where: { ($0["id"] as? String) == aid }) { artists.insert(a, at: 0) }
            } else if bestType == "album", let al = Self.album(bestResult, apiBase: apiBase), let alid = al["id"] as? String {
                best = ["type": "album", "id": alid]
                if !albums.contains(where: { ($0["id"] as? String) == alid }) { albums.insert(al, at: 0) }
            }

            var out: [String: Any] = [
                "query": trimmed,
                "tracks": tracks,
                "artists": artists,
                "albums": albums,
                "page": page,
                "hasMore": [
                    "tracks": Self.more(raw["tracks"], page: page),
                    "artists": Self.more(raw["artists"], page: page),
                    "albums": Self.more(raw["albums"], page: page),
                ],
            ]
            if let best { out["best"] = best }
            return out
        }
    }

    func home() async throws -> [String: Any] {
        try await cached("home") { apiBase in
            let statusRaw = Self.object(try await self.call(method: "GET", path: "/account/status"))
            guard let uid = Self.numericId(Self.object(statusRaw["account"])["uid"]) else {
                throw Failure(statusCode: 502, message: "Не удалось загрузить медиатеку Яндекс Музыки")
            }
            let likesRaw = Self.object(try await self.call(method: "GET", path: "/users/\(uid)/likes/tracks"))
            let ids = Self.list(Self.object(likesRaw["library"])["tracks"], limit: 60).compactMap { value -> String? in
                let item = Self.object(value)
                let base = Self.stringId(item["id"]) ?? ""
                let album = Self.numericId(item["albumId"])
                let full = album.map { "\(base):\($0)" } ?? base
                return Self.isYandexTrackId(full) ? full : nil
            }.prefix(20)

            let rawTracks: [Any] = ids.isEmpty ? [] : Self.list(
                try await self.call(method: "POST", path: "/tracks", formBody: [("track-ids", ids.joined(separator: ","))]),
                limit: 20
            )
            let tracks = rawTracks.compactMap { Self.track($0, apiBase: apiBase) }
            var seenArtists = Set<String>()
            var artists: [[String: Any]] = []
            var seenAlbums = Set<String>()
            var albums: [[String: Any]] = []
            for raw in rawTracks {
                let obj = Self.object(raw)
                for rawArtist in Self.list(obj["artists"], limit: 20) {
                    if let parsed = Self.artist(rawArtist, apiBase: apiBase),
                       let aid = parsed["id"] as? String,
                       seenArtists.insert(aid).inserted {
                        artists.append(parsed)
                        if artists.count >= 8 { break }
                    }
                }
                for rawAlbum in Self.list(obj["albums"], limit: 10) {
                    if let parsed = Self.album(rawAlbum, apiBase: apiBase),
                       let alid = parsed["id"] as? String,
                       seenAlbums.insert(alid).inserted {
                        albums.append(parsed)
                        if albums.count >= 8 { break }
                    }
                }
            }
            return [
                "query": "",
                "tracks": tracks,
                "artists": artists,
                "albums": albums,
                "page": 0,
                "hasMore": ["tracks": false, "artists": false, "albums": false],
            ]
        }
    }

    func artistPage(_ id: String, page: Int = 0) async throws -> [String: Any] {
        guard let cleanId = Self.numericId(id) else {
            throw Failure(statusCode: 400, message: "Некорректный ID каталога")
        }
        guard (0...100).contains(page) else {
            throw Failure(statusCode: 400, message: "Некорректная страница каталога")
        }
        return try await cached("artist:\(cleanId):\(page)") { apiBase in
            async let briefLoad: Any = self.call(method: "GET", path: "/artists/\(cleanId)/brief-info")
            let qs = Self.formEncode([("page", String(page)), ("page-size", "20"), ("sort-by", "year")])
            async let directLoad = self.callResult(method: "GET", path: "/artists/\(cleanId)/direct-albums?\(qs)")

            let brief = Self.object(try await briefLoad)
            let stats = brief["stats"]
            let rawArtist = brief["artist"]
            guard let artist = Self.artist(rawArtist, stats: stats, apiBase: apiBase) else {
                throw Failure(statusCode: 404, message: "Артист не найден")
            }
            let directResult = await directLoad
            let direct: [String: Any]?
            switch directResult {
            case .success(let value): direct = Self.object(value)
            case .failure(let err):
                if page > 0 { throw err }
                direct = nil
            }
            let albums = Self.list(direct?["albums"] ?? brief["albums"]).compactMap { Self.album($0, apiBase: apiBase) }
            let popRaw = brief["popularTracks"] ?? Self.object(rawArtist)["popularTracks"]
            let popularTracks = Self.list(popRaw, limit: 30).compactMap { Self.track($0, apiBase: apiBase) }
            let similarArtists = Self.list(brief["similarArtists"], limit: 12).compactMap { Self.artist($0, apiBase: apiBase) }
            let hasMoreAlbums = direct.map { Self.more($0, page: page) } ?? false
            return [
                "artist": artist,
                "popularTracks": popularTracks,
                "albums": albums,
                "similarArtists": similarArtists,
                "page": page,
                "hasMoreAlbums": hasMoreAlbums,
            ]
        }
    }

    func albumPage(_ id: String) async throws -> [String: Any] {
        guard let cleanId = Self.numericId(id) else {
            throw Failure(statusCode: 400, message: "Некорректный ID каталога")
        }
        return try await cached("album:\(cleanId)") { apiBase in
            let raw = Self.object(try await self.call(method: "GET", path: "/albums/\(cleanId)/with-tracks"))
            guard let album = Self.album(raw, apiBase: apiBase) else {
                throw Failure(statusCode: 404, message: "Альбом не найден")
            }
            let volumes = Self.list(raw["volumes"], limit: 30)
            var tracks: [[String: Any]] = []
            for (discIdx, vol) in volumes.enumerated() {
                for (posIdx, rawTrack) in Self.list(vol, limit: 300).enumerated() {
                    if let parsed = Self.track(rawTrack, albumContext: raw, disc: discIdx + 1, position: posIdx + 1, apiBase: apiBase) {
                        tracks.append(parsed)
                    }
                }
            }
            tracks.sort {
                let da = ($0["disc"] as? NSNumber)?.intValue ?? 1
                let db = ($1["disc"] as? NSNumber)?.intValue ?? 1
                if da != db { return da < db }
                let pa = ($0["position"] as? NSNumber)?.intValue ?? 0
                let pb = ($1["position"] as? NSNumber)?.intValue ?? 0
                return pa < pb
            }
            var out: [String: Any] = ["album": album, "tracks": tracks]
            if let desc = Self.description(raw["description"] ?? raw["shortDescription"]) {
                out["description"] = desc
            }
            return out
        }
    }

    // MARK: cache & transport

    private func cached(_ key: String, work: (_ apiBase: String) async throws -> [String: Any]) async throws -> [String: Any] {
        let now = Date()
        let hit: (value: [String: Any]?, account: Int, cache: Int) = locked {
            if let entry = cache[key], entry.expires > now {
                cacheOrder.removeAll { $0 == key }
                cacheOrder.append(key)
                return (entry.value, generation, cacheGeneration)
            }
            cache.removeValue(forKey: key)
            cacheOrder.removeAll { $0 == key }
            return (nil, generation, cacheGeneration)
        }
        if let cachedValue = hit.value { return cachedValue }

        let creds = try await loadCredentials()
        let value: [String: Any]
        do {
            value = try await work(creds.apiBase)
        } catch is CancellationError {
            throw CancellationError()
        } catch let err as Failure {
            throw err
        } catch {
            try Task.checkCancellation()
            throw Failure(statusCode: 502, message: "Не удалось загрузить каталог Яндекс Музыки. Повторите запрос")
        }

        try Task.checkCancellation()
        try locked {
            guard generation == hit.account else { throw CancellationError() }
            guard cacheGeneration == hit.cache else { return }
            cache[key] = CacheEntry(expires: Date().addingTimeInterval(Self.cacheTTL), value: value)
            cacheOrder.removeAll { $0 == key }
            cacheOrder.append(key)
            while cacheOrder.count > Self.cacheLimit, let oldest = cacheOrder.first {
                cacheOrder.removeFirst()
                cache.removeValue(forKey: oldest)
            }
        }
        return value
    }

    private func loadCredentials() async throws -> (token: String, apiBase: String) {
        if let hit = locked({ creds.flatMap { $0.expires > Date() ? ($0.token, $0.apiBase) : nil } }) {
            return hit
        }
        let gen = locked { generation }
        let loaded = try await credentialsLoader()
        guard !loaded.token.isEmpty else {
            throw Failure(statusCode: 409, message: "Подключите аккаунт Яндекс Музыки")
        }
        guard let base = Self.checkedApiBase(loaded.apiBase) else {
            throw Failure(statusCode: 502, message: "Некорректный адрес API Яндекса")
        }
        try Task.checkCancellation()
        try locked {
            guard generation == gen else { throw CancellationError() }
            creds = CredCache(token: loaded.token, apiBase: base, expires: Date().addingTimeInterval(Self.credentialsTTL))
        }
        return (loaded.token, base)
    }

    private func call(method: String, path: String, formBody: [(String, String)]? = nil, allowRetry: Bool = true) async throws -> Any {
        let gen = locked { generation }
        let cred = try await loadCredentials()
        guard locked({ generation }) == gen else {
            throw Failure(statusCode: 409, message: "Подключение Яндекс Музыки изменилось. Повторите запрос")
        }
        guard let url = URL(string: cred.apiBase + path) else {
            throw Failure(statusCode: 400, message: "Некорректный запрос каталога")
        }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("OAuth \(cred.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let formBody {
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(Self.formEncode(formBody).utf8)
        }

        let (status, data) = try await fetch(request, Self.maxResponseBytes)
        try Task.checkCancellation()
        guard locked({ generation }) == gen else { throw CancellationError() }
        if status == 401 || status == 403 {
            try locked {
                guard generation == gen else { throw CancellationError() }
                if creds?.token == cred.token { creds = nil }
            }
            if allowRetry {
                _ = try await loadCredentials()
                guard locked({ generation }) == gen else { throw CancellationError() }
                return try await call(method: method, path: path, formBody: formBody, allowRetry: false)
            }
            throw Failure(statusCode: 401, message: "Токен не принят. Подключите Яндекс Музыку заново")
        }
        guard data.count <= Self.maxResponseBytes else {
            throw Failure(statusCode: 502, message: "Яндекс Музыка вернула слишком большой ответ")
        }
        guard (200..<300).contains(status),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["error"] == nil,
              let result = json["result"] else {
            throw Failure(statusCode: 502, message: "Яндекс Музыка не выполнила запрос (HTTP \(status))")
        }
        return result
    }

    private func callResult(method: String, path: String) async -> Result<Any, Error> {
        do { return .success(try await call(method: method, path: path)) }
        catch { return .failure(error) }
    }

    // MARK: validation & DTO mapping

    static func checkedApiBase(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
        let isLoopback = ["127.0.0.1", "::1", "[::1]", "localhost"].contains(host)
        if url.scheme == "https" { return trimmed }
        if isLoopback && url.scheme == "http" { return trimmed }
        return nil
    }

    static func isYandexTrackId(_ id: String) -> Bool {
        let range = NSRange(id.startIndex..., in: id)
        return trackIdRegex.firstMatch(in: id, range: range) != nil
    }

    private static func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    private static func list(_ value: Any?, limit: Int = 50) -> [Any] {
        guard let arr = value as? [Any] else { return [] }
        return Array(arr.prefix(limit))
    }

    private static func cleanText(_ value: Any?, max: Int = 300) -> String {
        guard let s = value as? String else { return "" }
        let clean = controlCharRegex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(clean.prefix(max))
    }

    private static func count(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        let d = n.doubleValue
        guard d >= 0, d == floor(d), let intVal = Int(exactly: d) else { return nil }
        return intVal
    }

    private static func stringId(_ value: Any?) -> String? {
        if let s = value as? String { return s }
        if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue >= 0,
           let i = Int64(exactly: n.doubleValue) {
            return String(i)
        }
        return nil
    }

    private static func numericId(_ value: Any?) -> String? {
        guard let s = stringId(value) else { return nil }
        return numericIdRegex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil ? s : nil
    }

    static func image(_ value: Any?, apiBase: String) -> String? {
        var raw = cleanText(value, max: 2048).replacingOccurrences(of: "%%", with: "400x400")
        guard !raw.isEmpty else { return nil }
        if raw.hasPrefix("//") { raw = "https:" + raw }
        else if !raw.lowercased().hasPrefix("http://") && !raw.lowercased().hasPrefix("https://") { raw = "https://" + raw }
        guard let url = URL(string: raw), let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
        let baseURL = URL(string: apiBase)
        let baseHost = baseURL?.host?.lowercased() ?? ""
        let isTestOrigin = ["127.0.0.1", "::1", "[::1]", "localhost"].contains(baseHost)
            && url.scheme?.lowercased() == baseURL?.scheme?.lowercased()
            && host == baseHost
            && url.port == baseURL?.port
        let allowedDomain = mediaDomains.contains { host == $0 || host.hasSuffix("." + $0) }
        if !isTestOrigin {
            guard url.scheme?.lowercased() == "https", allowedDomain, url.port == nil || url.port == 443 else { return nil }
        }
        guard url.query == nil, url.fragment == nil else { return nil }
        let p = url.path
        guard audioPathRegex.firstMatch(in: p, range: NSRange(p.startIndex..., in: p)) == nil else { return nil }
        return url.absoluteString
    }

    private static func description(_ value: Any?) -> String? {
        let raw = value as? String ?? (object(value)["text"] as? String)
        let text = cleanText(raw, max: 8000)
        guard !text.isEmpty else { return nil }
        let noHtml = htmlTagRegex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let bounded = String(noHtml.prefix(4000))
        return bounded.isEmpty ? nil : bounded
    }

    private static func combinedTitle(_ value: [String: Any]) -> String {
        let base = cleanText(value["title"])
        let version = cleanText(value["version"], max: 160)
        return version.isEmpty ? base : "\(base) (\(version))"
    }

    private static func artistRef(_ value: Any?, apiBase: String) -> [String: Any]? {
        let raw = object(value)
        guard let id = numericId(raw["id"]) else { return nil }
        let name = cleanText(raw["name"], max: 200)
        guard !name.isEmpty else { return nil }
        var out: [String: Any] = ["id": id, "name": name]
        if let img = image(object(raw["cover"])["uri"] ?? raw["opImage"] ?? raw["ogImage"], apiBase: apiBase) {
            out["imageUrl"] = img
        }
        return out
    }

    private static func artist(_ value: Any?, stats: Any? = nil, apiBase: String) -> [String: Any]? {
        let raw = object(value)
        guard var out = artistRef(raw, apiBase: apiBase) else { return nil }
        out["genres"] = list(raw["genres"], limit: 12).map { cleanText($0, max: 60) }.filter { !$0.isEmpty }
        if let desc = description(raw["description"] ?? raw["handMadeDescription"]) {
            out["description"] = desc
        }
        let counts = object(raw["counts"])
        if !counts.isEmpty {
            out["counts"] = [
                "tracks": count(counts["tracks"]) ?? 0,
                "albums": count(counts["directAlbums"] ?? counts["albums"]) ?? 0,
            ]
        }
        let statistics = object(stats ?? raw["stats"])
        if let listeners = count(statistics["lastMonthListeners"] ?? raw["listeners"]) {
            out["listeners"] = listeners
        }
        return out
    }

    private static func album(_ value: Any?, apiBase: String) -> [String: Any]? {
        let raw = object(value)
        guard raw["error"] == nil, let id = numericId(raw["id"]) else { return nil }
        let title = combinedTitle(raw)
        guard !title.isEmpty else { return nil }
        let artists = list(raw["artists"], limit: 20).compactMap { artistRef($0, apiBase: apiBase) }
        let type = cleanText(raw["type"], max: 40)
        let available = (raw["available"] as? Bool != false) || (raw["availableForPremiumUsers"] as? Bool == true)
        var out: [String: Any] = [
            "id": id,
            "title": title,
            "artists": artists,
            "type": type.isEmpty ? "album" : type,
            "available": available,
        ]
        if let img = image(raw["coverUri"] ?? raw["ogImage"], apiBase: apiBase) { out["imageUrl"] = img }
        if let year = count(raw["year"] ?? raw["originalReleaseYear"]) { out["year"] = year }
        if let trackCount = count(raw["trackCount"]) { out["trackCount"] = trackCount }
        return out
    }

    private static func track(_ value: Any?, albumContext: [String: Any]? = nil, disc: Int? = nil, position: Int? = nil, apiBase: String) -> [String: Any]? {
        let raw = object(value)
        guard raw["error"] == nil, let rawId = stringId(raw["id"]), isYandexTrackId(rawId) else { return nil }
        let title = combinedTitle(raw)
        guard !title.isEmpty else { return nil }
        let sourceAlbums = list(raw["albums"]).map(object)
        let sourceAlbum: [String: Any]?
        if let albumContext {
            let targetAlbumId = numericId(albumContext["id"])
            sourceAlbum = sourceAlbums.first { numericId($0["id"]) == targetAlbumId }
        } else {
            sourceAlbum = sourceAlbums.first
        }
        let selected = albumContext ?? sourceAlbum ?? [:]
        let albumId = numericId(selected["id"])
        let baseId = String(rawId.split(separator: ":").first ?? Substring(rawId))
        let externalId = albumId.map { "\(baseId):\($0)" } ?? rawId
        let artists = list(raw["artists"], limit: 20).compactMap { artistRef($0, apiBase: apiBase) }
        let durationMs = (raw["durationMs"] as? NSNumber)?.doubleValue ?? 0
        let duration = durationMs.isFinite ? max(0, durationMs / 1000.0) : 0
        let playable = (raw["available"] as? Bool != false) || (raw["availableForPremiumUsers"] as? Bool == true)
        let explicit = (raw["contentWarning"] as? String == "explicit") || (raw["explicit"] as? Bool == true)

        var out: [String: Any] = [
            "id": externalId,
            "externalId": externalId,
            "provider": "yandex",
            "source": "yandex",
            "title": title,
            "artist": artists.compactMap { $0["name"] as? String }.joined(separator: ", "),
            "album": combinedTitle(selected),
            "duration": duration,
            "pageUrl": "https://music.yandex.ru/track/\(baseId)",
            "playable": playable,
            "artists": artists,
            "explicit": explicit,
        ]
        if let cover = image(raw["coverUri"] ?? selected["coverUri"], apiBase: apiBase) { out["coverUrl"] = cover }
        if let albumId { out["albumId"] = albumId }

        let trackPos = object(raw["trackPosition"] ?? sourceAlbum?["trackPosition"] ?? selected["trackPosition"])
        if let trackNumber = count(trackPos["index"]) ?? position { out["position"] = trackNumber }
        if let discNumber = count(trackPos["volume"]) ?? disc { out["disc"] = discNumber }
        return out
    }

    private static func more(_ sectionValue: Any?, page: Int) -> Bool {
        let section = object(sectionValue)
        let pager = object(section["pager"])
        guard let total = count(section["total"] ?? pager["total"]),
              let perPage = count(section["perPage"] ?? pager["perPage"]),
              perPage > 0 else { return false }
        return (page + 1) * perPage < total
    }

    private static func formEncode(_ pairs: [(String, String)]) -> String {
        func esc(_ s: String) -> String {
            (s.addingPercentEncoding(withAllowedCharacters: unreservedFormChars) ?? s)
                .replacingOccurrences(of: "%20", with: "+")
        }
        return pairs.map { "\(esc($0.0))=\(esc($0.1))" }.joined(separator: "&")
    }

    private static let sharedRedirectBlocker = NativeYandexRedirectBlocker()
    private static let sharedSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration, delegate: sharedRedirectBlocker, delegateQueue: nil)
    }()

    private static func urlSessionFetch(_ request: URLRequest, _ limit: Int) async throws -> (Int, Data) {
        let (data, response) = try await sharedSession.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}