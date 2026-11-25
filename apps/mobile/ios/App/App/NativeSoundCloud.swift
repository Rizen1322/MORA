import Foundation

private final class NativeSoundCloudRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Stage 3: the SoundCloud provider in Swift. Browsing (search, artist profiles and their public tracks) no
/// longer needs the JSC server; only the DRM/stream resolver still falls back to the existing yt-dlp path.
final class NativeSoundCloud {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    /// Returns (status, body) for a GET; production uses URLSession, the self-check injects fixtures.
    typealias Fetch = (_ url: URL, _ limit: Int) async throws -> (Int, Data)

    private struct Client { let id: String, until: Date }
    private let lock = NSLock()
    private var client: Client?
    private var retryAt: Date?
    private var artistRetryAt: Date?
    private let fetch: Fetch

    static let live = NativeSoundCloud(fetch: NativeSoundCloud.urlSessionFetch)
    init(fetch: @escaping Fetch = NativeSoundCloud.urlSessionFetch) { self.fetch = fetch }

    private func locked<T>(_ work: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return work()
    }

    // MARK: public surface

    /// Search results in the same shape the catalog used to receive from the JS provider.
    func search(_ query: String, limit: Int = 15) async throws -> [[String: Any]] {
        let clean = query.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return [] }
        if let retryAt = locked({ retryAt }), retryAt > Date() { throw Failure(message: "SoundCloud: быстрый поиск временно недоступен") }
        do {
            let id = try await clientId()
            let count = min(25, max(1, limit))
            var components = URLComponents(string: "https://api-v2.soundcloud.com/search/tracks")!
            components.queryItems = [.init(name: "q", value: String(clean.prefix(200))), .init(name: "limit", value: String(count)),
                                     .init(name: "client_id", value: id), .init(name: "linked_partitioning", value: "1")]
            let (status, data) = try await get(components.url!, limit: 2 << 20)
            guard status == 200, let value = try? JSONSerialization.jsonObject(with: data) else {
                throw Failure(message: "SoundCloud: HTTP \(status)")
            }
            locked { retryAt = nil }
            return Self.parseSearch(value, limit: count)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as NSError where error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
            throw error
        } catch {
            locked { retryAt = Date().addingTimeInterval(30) }
            throw error
        }
    }

    /// A public profile and its first track shelf; identity must agree across both API responses.
    func artist(_ id: String) async throws -> [String: Any] {
        guard id.range(of: "^[0-9]{1,20}$", options: .regularExpression) != nil else {
            throw Failure(message: "Некорректный ID исполнителя")
        }
        if let artistRetryAt = locked({ artistRetryAt }), artistRetryAt > Date() { throw Failure(message: "SoundCloud: профили временно недоступны") }
        do {
            let clientId = try await clientId()
            let (userStatus, userData) = try await get(URL(string: "https://api-v2.soundcloud.com/users/\(id)?client_id=\(clientId)")!, limit: 1 << 20)
            guard userStatus == 200, let user = (try? JSONSerialization.jsonObject(with: userData)) as? [String: Any] else {
                throw Failure(message: "SoundCloud: HTTP \(userStatus)")
            }
            let userId = String((user["id"] as? NSNumber)?.intValue ?? -1)
            let permalink = user["permalink"] as? String ?? ""
            let page = user["permalink_url"] as? String ?? ""
            guard user["kind"] as? String == "user", userId == id,
                  permalink.range(of: "^[\\w-]{1,100}$", options: .regularExpression) != nil,
                  page == "https://soundcloud.com/\(permalink)" else {
                throw Failure(message: "SoundCloud: профиль исполнителя не подтверждён")
            }
            let tracksURL = URL(string: "https://api-v2.soundcloud.com/users/\(id)/tracks?client_id=\(clientId)&limit=25&linked_partitioning=1")!
            let (tracksStatus, tracksData) = try await get(tracksURL, limit: 2 << 20)
            guard tracksStatus == 200, let raw = (try? JSONSerialization.jsonObject(with: tracksData)) as? [String: Any],
                  let collection = raw["collection"] as? [Any] else {
                throw Failure(message: "SoundCloud: изменился формат треков")
            }
            let tracks = Self.parseSearch(["collection": collection], limit: 25)
                .filter { ($0["artist_id"] as? String) == id }
            locked { artistRetryAt = nil }
            var result: [String: Any] = ["id": id, "permalink": permalink,
                                         "title": String((user["username"] as? String ?? "").prefix(300)),
                                         "description": String((user["description"] as? String ?? "").prefix(4000)),
                                         "tracks": tracks]
            if let cover = Self.image(user["avatar_url"]) { result["coverUrl"] = cover }
            return result
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as NSError where error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
            throw error
        } catch {
            locked { artistRetryAt = Date().addingTimeInterval(30) }
            throw error
        }
    }

    // MARK: internals

    private func clientId() async throws -> String {
        if let client = locked({ client }), client.until > Date() { return client.id }
        let (homeStatus, homeData) = try await get(URL(string: "https://soundcloud.com/")!, limit: 1 << 20)
        guard homeStatus == 200, let html = String(data: homeData, encoding: .utf8) else {
            throw Failure(message: "SoundCloud: HTTP \(homeStatus)")
        }
        // Only official assets, bounded independently of whatever the remote HTML contains.
        let pattern = #"<script[^>]+src=["']([^"']+)["']"#
        let regex = try NSRegularExpression(pattern: pattern)
        var scripts: [String] = []
        for match in regex.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
            guard let range = Range(match.range(at: 1), in: html) else { continue }
            let url = String(html[range])
            if url.range(of: #"^https://a-v2\.sndcdn\.com/assets/[\w.-]+\.js$"#, options: .regularExpression) != nil, !scripts.contains(url) {
                scripts.append(url)
            }
        }
        for url in scripts.suffix(3).reversed() {
            let (status, data) = try await get(URL(string: url)!, limit: 4 << 20)
            guard status == 200, let js = String(data: data, encoding: .utf8) else { continue }
            let idRegex = try NSRegularExpression(pattern: #"client_id\s*:\s*["']([0-9a-zA-Z]{32})["']"#)
            if let match = idRegex.firstMatch(in: js, range: NSRange(js.startIndex..., in: js)),
               let range = Range(match.range(at: 1), in: js) {
                let id = String(js[range])
                locked { client = Client(id: id, until: Date().addingTimeInterval(30 * 60)) }
                return id
            }
        }
        throw Failure(message: "SoundCloud: изменился формат публичного поиска")
    }

    private func get(_ url: URL, limit: Int) async throws -> (Int, Data) {
        guard url.scheme == "https", let host = url.host,
              ["soundcloud.com", "api-v2.soundcloud.com", "a-v2.sndcdn.com"].contains(host) else {
            throw Failure(message: "SoundCloud: недопустимый адрес")
        }
        let (status, data) = try await fetch(url, limit)
        guard data.count <= limit else { throw Failure(message: "SoundCloud: слишком большой ответ") }
        if status == 401 || status == 403 { locked { client = nil } }
        return (status, data)
    }

    private static func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

    /// False when every published transcoding is DRM-encrypted: such a record cannot be downloaded.
    static func hasOpenStream(_ track: [String: Any]) -> Bool {
        let media = object(track["media"]), list = media["transcodings"] as? [Any]
        guard let list else { return true }
        return list.contains { raw in
            let format = object(object(raw)["format"])
            return !(format["protocol"] as? String ?? "").contains("encrypted")
        }
    }

    static func parseSearch(_ value: Any, limit: Int) -> [[String: Any]] {
        let collection = (value as? [String: Any])?["collection"] as? [Any]
        guard let collection else { return [] }
        var seen = Set<String>(), result: [[String: Any]] = []
        for raw in collection {
            guard result.count < limit else { break }
            let x = object(raw), user = object(x["user"]), publisher = object(x["publisher_metadata"])
            let id = String(x["id"] as? String ?? (x["id"] as? NSNumber).map { String($0.intValue) } ?? "")
                .replacingOccurrences(of: "soundcloud:tracks:", with: "")
            let title = (x["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard id.range(of: "^[0-9]{1,20}$", options: .regularExpression) != nil, !title.isEmpty, !seen.contains(id),
                  (x["kind"] as? String ?? "track") == "track",
                  x["streamable"] as? Bool != false, x["sharing"] as? String != "private",
                  !["BLOCK", "SNIP"].contains(x["policy"] as? String ?? ""), hasOpenStream(x) else { continue }
            let duration = (x["duration"] as? NSNumber)?.doubleValue ?? 0
            guard duration.isFinite else { continue }
            let seconds = duration / 1000
            guard seconds >= 30, seconds <= 10800 else { continue }
            seen.insert(id)
            let page = (x["permalink_url"] as? String).flatMap {
                $0.range(of: #"^https://soundcloud\.com/[^\s?#]+/[^\s?#]+$"#, options: .regularExpression) != nil ? $0 : nil
            }
            let userId = (user["id"] as? NSNumber).map { String($0.intValue) } ?? ""
            let permalink = (user["permalink"] as? String).flatMap {
                $0.range(of: #"^[\w-]{1,100}$"#, options: .regularExpression) != nil ? $0 : nil
            } ?? ""
            let artist = (publisher["artist"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
                ?? user["username"] as? String ?? ""
            var item: [String: Any] = ["id": id, "title": title, "duration": seconds,
                                       "url": "https://api.soundcloud.com/tracks/\(id)",
                                       "uploader": user["username"] as? String ?? "",
                                       "artist": artist, "artist_permalink": permalink]
            if let page { item["webpage_url"] = page }
            if !userId.isEmpty && !permalink.isEmpty { item["artist_id"] = userId }
            if let thumb = image(x["artwork_url"]) ?? image(user["avatar_url"]) { item["thumbnail"] = thumb }
            if let license = x["license"] as? String { item["license"] = license }
            result.append(item)
        }
        return result
    }

    static func image(_ value: Any?) -> String? {
        guard let text = value as? String, text.range(of: #"^https://i\d?\.sndcdn\.com/[^\s]+$"#, options: .regularExpression) != nil else { return nil }
        return text.replacingOccurrences(of: #"-large\.(jpg|png)(\?.*)?$"#, with: "-t500x500.$1$2", options: .regularExpression)
    }

    private static func urlSessionFetch(_ url: URL, _ limit: Int) async throws -> (Int, Data) {
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.setValue("https://soundcloud.com", forHTTPHeaderField: "Origin")
        request.setValue("https://soundcloud.com/", forHTTPHeaderField: "Referer")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let blocker = NativeSoundCloudRedirectBlocker()
        let session = URLSession(configuration: configuration, delegate: blocker, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}
