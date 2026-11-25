import Foundation

private final class NativePublicRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Stage 3: Public YouTube Music / YouTube browse & search endpoints in Swift (no account required).
/// Foundation-only (covered by standalone `swiftc` self-checks).
final class NativePublicCatalog {
    struct Failure: LocalizedError {
        let statusCode: Int
        let message: String
        var errorDescription: String? { message }
    }

    typealias Fetch = (_ request: URLRequest, _ limit: Int) async throws -> (Int, Data)

    private struct CacheEntry { let until: Date; let value: [String: Any] }
    private struct BreakerState { var fails = 0; var until = Date.distantPast }

    static let live = NativePublicCatalog()

    private static let maxBytes = 4 << 20
    private static let cacheLimit = 40
    private static let cacheTTL: TimeInterval = 300
    private static let client: [String: Any] = [
        "clientName": "WEB_REMIX",
        "clientVersion": "1.20260101.01.00",
        "hl": "ru",
        "gl": "RU",
    ]
    private static let songsParams = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    private static let videosParams = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
    private static let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

    private static let artistIdRegex = try! NSRegularExpression(pattern: #"^UC[\w-]{22}$"#)
    private static let albumIdRegex = try! NSRegularExpression(pattern: #"^MPRE[\w-]{6,80}$"#)
    private static let videoIdRegex = try! NSRegularExpression(pattern: #"^[\w-]{11}$"#)
    private static let durationRegex = try! NSRegularExpression(pattern: #"^\d+(:\d{1,2}){1,2}$"#)
    private static let thumbHostRegex = try! NSRegularExpression(pattern: #"(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com)$"#)
    private static let ytmThumbSizeRegex = try! NSRegularExpression(pattern: #"=w\d+-h\d+[^&]*$"#)
    private static let topicSuffixRegex = try! NSRegularExpression(pattern: #"\s*-\s*Topic$"#, options: .caseInsensitive)

    private let fetch: Fetch
    private let lock = NSLock()
    private var breakers: [String: BreakerState] = [:]
    private var cache: [String: CacheEntry] = [:]
    private var cacheOrder: [String] = []

    init(fetch: @escaping Fetch = NativePublicCatalog.urlSessionFetch) {
        self.fetch = fetch
    }

    private func locked<T>(_ work: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return work()
    }

    func invalidate() {
        locked {
            cache.removeAll()
            cacheOrder.removeAll()
        }
    }

    // MARK: public surface

    static func validCatalogId(type: String, id: String) -> Bool {
        let range = NSRange(id.startIndex..., in: id)
        if type == "artist" { return artistIdRegex.firstMatch(in: id, range: range) != nil }
        if type == "album" { return albumIdRegex.firstMatch(in: id, range: range) != nil }
        return false
    }

    static func parseDuration(_ text: String) -> Double {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard durationRegex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil else { return 0 }
        return trimmed.split(separator: ":").reduce(0.0) { acc, part in
            acc * 60.0 + (Double(part) ?? 0.0)
        }
    }

    func artist(_ id: String) async throws -> [String: Any] {
        try await get(type: "artist", id: id)
    }

    func album(_ id: String) async throws -> [String: Any] {
        try await get(type: "album", id: id)
    }

    func get(type: String, id: String) async throws -> [String: Any] {
        guard Self.validCatalogId(type: type, id: id) else {
            throw Failure(statusCode: 400, message: "Некорректный ID каталога")
        }
        let key = "\(type):\(id)"
        if let hit = locked({ () -> [String: Any]? in
            guard let entry = cache[key], entry.until > Date() else { return nil }
            cacheOrder.removeAll { $0 == key }
            cacheOrder.append(key)
            return entry.value
        }) {
            return hit
        }

        let raw = try await requestYtm(endpoint: "browse", body: ["browseId": id])
        let parsed = try Self.parseCatalog(raw, type: type, id: id)
        locked {
            cache[key] = CacheEntry(until: Date().addingTimeInterval(Self.cacheTTL), value: parsed)
            cacheOrder.removeAll { $0 == key }
            cacheOrder.append(key)
            while cacheOrder.count > Self.cacheLimit, let oldest = cacheOrder.first {
                cacheOrder.removeFirst()
                cache.removeValue(forKey: oldest)
            }
        }
        return parsed
    }

    func search(_ query: String, kind: String = "song") async throws -> [[String: Any]] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        let bounded = String(q.prefix(200))
        let params = kind == "video" ? Self.videosParams : Self.songsParams
        let raw = try await requestYtm(endpoint: "search", body: ["query": bounded, "params": params])
        return Self.parseSearch(raw, kind: kind == "video" ? "video" : "song")
    }

    func requestYtm(endpoint: String, body: [String: Any], service: String = "music") async throws -> [String: Any] {
        guard ["search", "next", "browse"].contains(endpoint) else {
            throw Failure(statusCode: 400, message: "Некорректный запрос каталога")
        }
        let key = "\(service):\(endpoint)"
        let blockedUntil = locked { breakers[key]?.until ?? .distantPast }
        if Date() < blockedUntil {
            throw Failure(statusCode: 502, message: "YouTube Music временно не отвечает")
        }
        let origin = service == "music" ? "https://music.youtube.com" : "https://www.youtube.com"
        guard let url = URL(string: "\(origin)/youtubei/v1/\(endpoint)?prettyPrint=false") else {
            throw Failure(statusCode: 400, message: "Некорректный адрес YouTube Music")
        }
        var clientPayload = Self.client
        if service != "music" { clientPayload["clientName"] = "WEB" }
        var payload = body
        payload["context"] = ["client": clientPayload]
        let encoded = try JSONSerialization.data(withJSONObject: payload)

        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.httpBody = encoded
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("\(origin)/", forHTTPHeaderField: "Referer")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")

        do {
            let (status, data) = try await fetch(request, Self.maxBytes)
            guard (200..<300).contains(status) else {
                throw Failure(statusCode: 502, message: "YouTube Music: HTTP \(status)")
            }
            guard data.count <= Self.maxBytes else {
                throw Failure(statusCode: 502, message: "YouTube Music: слишком большой ответ")
            }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw Failure(statusCode: 502, message: "YouTube Music: неверный формат ответа")
            }
            locked { breakers[key] = BreakerState(fails: 0, until: .distantPast) }
            return json
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as NSError where error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
            throw error
        } catch {
            locked {
                var st = breakers[key] ?? BreakerState()
                st.fails += 1
                if st.fails >= 3 {
                    st.until = Date().addingTimeInterval(15)
                    st.fails = 0
                }
                breakers[key] = st
            }
            throw error
        }
    }

    // MARK: parsers matching apps/server/src/public/catalog.ts & ytmusic.ts

    static func parseCatalog(_ json: [String: Any], type: String, id: String) throws -> [String: Any] {
        guard validCatalogId(type: type, id: id) else {
            throw Failure(statusCode: 400, message: "Некорректный ID каталога")
        }
        let contents = object(json["contents"])
        let twoCol = object(contents["twoColumnBrowseResultsRenderer"])
        let firstTwoColTab = object(list(twoCol["tabs"]).first)
        let primarySections = list(object(object(object(firstTwoColTab["tabRenderer"])["content"])["sectionListRenderer"])["contents"])
        let headerObj = object(json["header"])
        let header: [String: Any]
        if type == "artist" {
            header = object(headerObj["musicImmersiveHeaderRenderer"])
        } else {
            let detail = object(headerObj["musicDetailHeaderRenderer"])
            if !detail.isEmpty {
                header = detail
            } else {
                let found = primarySections.compactMap { object($0)["musicResponsiveHeaderRenderer"] as? [String: Any] }.first ?? [:]
                header = found
            }
        }

        let title = rendererText(header["title"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty || (type == "album" && twoCol.isEmpty && headerObj["musicDetailHeaderRenderer"] == nil) {
            throw Failure(statusCode: 404, message: type == "artist" ? "Музыкальная страница исполнителя не найдена" : "Альбом не найден")
        }

        var artists = artistRefs(
            list(object(header["straplineTextOne"])["runs"]) + list(object(header["subtitle"])["runs"])
        )
        if type == "artist" {
            artists.insert(["id": id, "name": title], at: 0)
        }
        let coverUrl = thumb(header["thumbnail"])
            ?? thumb(object(object(json["microformat"])["microformatDataRenderer"])["thumbnail"])

        var tracks: [[String: Any]] = []
        var albums: [[String: Any]] = []
        var seenTracks = Set<String>()
        var seenAlbums = Set<String>()
        var limited = type == "artist"

        let singleCol = object(contents["singleColumnBrowseResultsRenderer"])
        let singleSections = list(object(object(object(object(list(singleCol["tabs"]).first)["tabRenderer"])["content"])["sectionListRenderer"])["contents"])
        let secondarySections = list(object(object(twoCol["secondaryContents"])["sectionListRenderer"])["contents"])
        let sections = !singleSections.isEmpty ? singleSections : (!secondarySections.isEmpty ? secondarySections : primarySections)

        for rawSection in sections.prefix(30) {
            let sec = object(rawSection)
            let shelf = object(sec["musicShelfRenderer"] ?? sec["musicCarouselShelfRenderer"] ?? sec["musicPlaylistShelfRenderer"])
            guard !shelf.isEmpty else { continue }
            if !list(shelf["continuations"]).isEmpty { limited = true }
            for rawWrap in list(shelf["contents"], limit: 200) {
                let wrap = object(rawWrap)
                let row = object(wrap["musicResponsiveListItemRenderer"])
                if !row.isEmpty {
                    if row["musicItemRendererDisplayPolicy"] as? String == "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT" { continue }
                    let flex = list(row["flexColumns"]).map { item -> [Any] in
                        list(object(object(object(item)["musicResponsiveListItemFlexColumnRenderer"])["text"])["runs"])
                    }
                    let watchVideoId = (object(object(object(object(object(row["overlay"])["musicItemThumbnailOverlayRenderer"])["content"])["musicPlayButtonRenderer"])["playNavigationEndpoint"])["watchEndpoint"]) as? [String: Any]
                    let videoId = (object(row["playlistItemData"])["videoId"] as? String) ?? (watchVideoId?["videoId"] as? String) ?? ""
                    let name = flex.isEmpty ? "" : rendererText(["runs": flex[0]]).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard validVideoId(videoId), !name.isEmpty, !seenTracks.contains(videoId) else { continue }
                    let meta = flex.dropFirst().flatMap { $0 }
                    let credits = artistRefs(meta)
                    let albumRun = meta.first { pageType(endpoint($0)) == "MUSIC_PAGE_TYPE_ALBUM" }
                    let fixedText = object(object(list(row["fixedColumns"]).first)["musicResponsiveListItemFixedColumnRenderer"])["text"]
                    var duration = parseDuration(rendererText(fixedText))
                    if duration == 0 {
                        duration = meta.lazy.map { parseDuration(object($0)["text"] as? String ?? "") }.first { $0 > 0 } ?? 0
                    }
                    seenTracks.insert(videoId)

                    let artistString = !credits.isEmpty
                        ? credits.compactMap { $0["name"] as? String }.joined(separator: ", ")
                        : (!artists.isEmpty ? artists.compactMap { $0["name"] as? String }.joined(separator: ", ") : "Неизвестный исполнитель")
                    let artistId = (credits.first?["id"] as? String) ?? (artists.first?["id"] as? String)
                    let albumTitle = type == "album" ? title : (object(albumRun)["text"] as? String ?? "")
                    let rawAlbumId = (endpoint(albumRun)["browseId"] as? String) ?? ""
                    let albumId = type == "album" ? id : (validCatalogId(type: "album", id: rawAlbumId) ? rawAlbumId : nil)
                    let explicit = list(row["badges"]).contains {
                        object(object(object($0)["musicInlineBadgeRenderer"])["icon"])["iconType"] as? String == "MUSIC_EXPLICIT_BADGE"
                    }

                    var item: [String: Any] = [
                        "id": videoId,
                        "externalId": videoId,
                        "videoId": videoId,
                        "provider": "youtube",
                        "audioProvider": "youtube",
                        "source": "ytmusic",
                        "title": name,
                        "artist": artistString,
                        "album": albumTitle,
                        "duration": duration,
                        "pageUrl": "https://music.youtube.com/watch?v=\(videoId)",
                        "explicit": explicit,
                        "kind": "song",
                        "playable": true,
                    ]
                    if let artistId { item["artistId"] = artistId }
                    if let albumId { item["albumId"] = albumId }
                    if let cover = thumb(row["thumbnail"]) ?? coverUrl { item["coverUrl"] = cover }
                    tracks.append(item)
                    if tracks.count == 100 { limited = true; break }
                }

                let card = object(wrap["musicTwoRowItemRenderer"])
                if !card.isEmpty && albums.count < 40 {
                    let titleRuns = list(object(card["title"])["runs"])
                    let ep = endpoint(titleRuns.first).isEmpty ? object(object(card["navigationEndpoint"])["browseEndpoint"]) : endpoint(titleRuns.first)
                    if pageType(ep) == "MUSIC_PAGE_TYPE_ALBUM",
                       let aid = ep["browseId"] as? String,
                       validCatalogId(type: "album", id: aid),
                       !seenAlbums.contains(aid) {
                        seenAlbums.insert(aid)
                        let subRefs = artistRefs(list(object(card["subtitle"])["runs"]))
                        let artistName = !subRefs.isEmpty
                            ? subRefs.compactMap { $0["name"] as? String }.joined(separator: ", ")
                            : artists.compactMap { $0["name"] as? String }.joined(separator: ", ")
                        var albumItem: [String: Any] = [
                            "id": aid,
                            "title": rendererText(card["title"]),
                            "artist": artistName,
                        ]
                        if let cover = thumb(card["thumbnailRenderer"]) { albumItem["coverUrl"] = cover }
                        albums.append(albumItem)
                    }
                }
            }
            if tracks.count >= 100 { break }
        }

        let desc = rendererText(header["description"])
        let secondSub = rendererText(header["secondSubtitle"])
        var result: [String: Any] = [
            "id": id,
            "type": type,
            "title": title,
            "source": "ytmusic",
            "description": desc.isEmpty ? secondSub : desc,
            "artists": artists,
            "tracks": tracks,
            "albums": albums,
            "limited": limited,
        ]
        if let coverUrl { result["coverUrl"] = coverUrl }
        return result
    }

    static func parseSearch(_ json: [String: Any], kind: String = "song") -> [[String: Any]] {
        let tabs = list(object(object(json["contents"])["tabbedSearchResultsRenderer"])["tabs"])
        let sections = list(object(object(object(object(tabs.first)["tabRenderer"])["content"])["sectionListRenderer"])["contents"])
        var out: [[String: Any]] = []
        for rawSection in sections {
            let contents = list(object(object(rawSection)["musicShelfRenderer"])["contents"])
            for wrap in contents {
                let r = object(object(wrap)["musicResponsiveListItemRenderer"])
                guard !r.isEmpty else { continue }
                let cols = list(r["flexColumns"])
                func runs(_ i: Int) -> [Any] {
                    guard cols.indices.contains(i) else { return [] }
                    return list(object(object(object(cols[i])["musicResponsiveListItemFlexColumnRenderer"])["text"])["runs"])
                }
                let overlayVideo = object(object(object(object(object(r["overlay"])["musicItemThumbnailOverlayRenderer"])["content"])["musicPlayButtonRenderer"])["playNavigationEndpoint"])["watchEndpoint"]
                let videoId = (object(r["playlistItemData"])["videoId"] as? String)
                    ?? (object(overlayVideo)["videoId"] as? String) ?? ""
                guard validVideoId(videoId) else { continue }
                let title = runs(0).compactMap { object($0)["text"] as? String }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
                let meta = runs(1)
                let artists = meta.filter {
                    let p = pageType(endpoint($0))
                    return p == "MUSIC_PAGE_TYPE_ARTIST" || p == "MUSIC_PAGE_TYPE_USER_CHANNEL"
                }
                let albumRun = meta.first { pageType(endpoint($0)) == "MUSIC_PAGE_TYPE_ALBUM" }
                let parts = meta.compactMap { object($0)["text"] as? String }.joined()
                    .components(separatedBy: " • ")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                let duration = parts.last.map(parseDuration) ?? 0
                let rawArtist: String
                if !artists.isEmpty {
                    rawArtist = artists.compactMap { object($0)["text"] as? String }.joined(separator: ", ")
                } else {
                    let firstPart = parts.first ?? ""
                    rawArtist = topicSuffixRegex.stringByReplacingMatches(in: firstPart, range: NSRange(firstPart.startIndex..., in: firstPart), withTemplate: "")
                }
                let artist = rawArtist.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty, duration == 0 || duration >= 30 else { continue }
                let explicit = list(r["badges"]).contains {
                    object(object(object($0)["musicInlineBadgeRenderer"])["icon"])["iconType"] as? String == "MUSIC_EXPLICIT_BADGE"
                }
                let artistId = artists.first { pageType(endpoint($0)) == "MUSIC_PAGE_TYPE_ARTIST" }
                    .flatMap { endpoint($0)["browseId"] as? String }
                let albumId = albumRun.flatMap { endpoint($0)["browseId"] as? String }
                var item: [String: Any] = [
                    "id": videoId,
                    "externalId": videoId,
                    "videoId": videoId,
                    "provider": "youtube",
                    "audioProvider": "youtube",
                    "source": kind == "song" ? "ytmusic" : "youtube",
                    "title": title,
                    "artist": artist.isEmpty ? "Неизвестный исполнитель" : artist,
                    "album": object(albumRun)["text"] as? String ?? "",
                    "duration": duration,
                    "pageUrl": kind == "song" ? "https://music.youtube.com/watch?v=\(videoId)" : "https://www.youtube.com/watch?v=\(videoId)",
                    "explicit": explicit,
                    "kind": kind,
                    "playable": true,
                ]
                if let artistId { item["artistId"] = artistId }
                if let albumId { item["albumId"] = albumId }
                if let cover = bestThumb(list(object(object(object(r["thumbnail"])["musicThumbnailRenderer"])["thumbnail"])["thumbnails"])) {
                    item["coverUrl"] = cover
                }
                out.append(item)
            }
        }
        return out
    }

    // MARK: helpers

    private static func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    private static func list(_ value: Any?, limit: Int? = nil) -> [Any] {
        guard let arr = value as? [Any] else { return [] }
        return limit.map { Array(arr.prefix($0)) } ?? arr
    }

    private static func validVideoId(_ id: String) -> Bool {
        videoIdRegex.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil
    }

    private static func rendererText(_ value: Any?) -> String {
        let obj = object(value)
        if let simple = obj["simpleText"] as? String { return String(simple.prefix(4000)) }
        let joined = list(obj["runs"]).compactMap { object($0)["text"] as? String }.joined()
        return String(joined.prefix(4000))
    }

    private static func endpoint(_ run: Any?) -> [String: Any] {
        object(object(object(run)["navigationEndpoint"])["browseEndpoint"])
    }

    private static func pageType(_ ep: [String: Any]) -> String {
        object(object(ep["browseEndpointContextSupportedConfigs"])["browseEndpointContextMusicConfig"])["pageType"] as? String ?? ""
    }

    private static func artistRefs(_ runs: [Any]) -> [[String: Any]] {
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for run in runs {
            let ep = endpoint(run)
            let name = rendererText(["runs": [run]]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty,
               pageType(ep) == "MUSIC_PAGE_TYPE_ARTIST",
               let bid = ep["browseId"] as? String,
               validCatalogId(type: "artist", id: bid),
               seen.insert(bid).inserted {
                out.append(["id": bid, "name": name])
            }
        }
        return out
    }

    private static func thumb(_ renderer: Any?) -> String? {
        let r = object(renderer)
        let listVal = list(object(object(r["musicThumbnailRenderer"])["thumbnail"])["thumbnails"])
        let candidates = !listVal.isEmpty ? listVal : list(r["thumbnails"])
        let sorted = candidates.sorted { a, b in
            let wa = (object(a)["width"] as? NSNumber)?.doubleValue
            let wb = (object(b)["width"] as? NSNumber)?.doubleValue
            let da = wa.map { abs($0 - 640) } ?? 10000
            let db = wb.map { abs($0 - 640) } ?? 10000
            return da < db
        }
        for item in sorted {
            guard let raw = object(item)["url"] as? String,
                  let url = URL(string: raw),
                  url.scheme == "https",
                  url.user == nil, url.password == nil, url.port == nil,
                  let host = url.host?.lowercased(),
                  thumbHostRegex.firstMatch(in: host, range: NSRange(host.startIndex..., in: host)) != nil else { continue }
            return url.absoluteString
        }
        return nil
    }

    private static func bestThumb(_ thumbnails: [Any]) -> String? {
        guard let last = thumbnails.last, let raw = object(last)["url"] as? String, raw.hasPrefix("https://") else { return nil }
        return ytmThumbSizeRegex.stringByReplacingMatches(in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "=w544-h544")
    }

    private static func urlSessionFetch(_ request: URLRequest, _ limit: Int) async throws -> (Int, Data) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let blocker = NativePublicRedirectBlocker()
        let session = URLSession(configuration: configuration, delegate: blocker, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}
