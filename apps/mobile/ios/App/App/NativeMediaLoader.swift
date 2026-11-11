import CryptoKit
import Foundation

/// Source resolution and finite HLS assembly on the preparation queue only.
final class NativeMediaLoader {
    enum Failure: Error { case source, encrypted, playlist }
    let http: NativeMediaHTTP
    private let allowLoopback: Bool
    init(http: NativeMediaHTTP, allowLoopback: Bool = false) { self.http = http; self.allowLoopback = allowLoopback }
    /// The JSC filesystem's virtual path; never accept an arbitrary path from the page.
    static func sharedFile(_ path: String, root: URL) -> URL? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard path.hasPrefix("/data/"), !path.contains("\0"),
              !parts.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        let root = root.resolvingSymlinksInPath().standardizedFileURL
        let file = root.appendingPathComponent(parts.joined(separator: "/")).resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"),
              let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let size = values.fileSize, size > 0, size <= 128 * 1024 * 1024,
              FileManager.default.isReadableFile(atPath: file.path) else { return nil }
        return file
    }
    func backgroundRequest(_ source: [String: Any], ticket: NativePreparationTicket) async throws -> URLRequest {
        let kind = source["kind"] as? String
        let url: URL
        if kind == "yandex" { url = try await yandex(source, ticket: ticket) }
        else if kind == "direct", let text = source["url"] as? String, let direct = URL(string: text) { url = direct }
        else { throw NSError(domain: "MORADownload", code: 1, userInfo: [NSLocalizedDescriptionKey: "Этот поток не поддерживает фоновую загрузку. Используйте загрузку в открытом приложении"]) }
        guard url.scheme == "https", url.user == nil, url.password == nil else { throw Failure.source }
        var request = URLRequest(url: url)
        if kind != "yandex" { for (key, value) in source["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: key) } }
        return request
    }
    func load(_ source: [String: Any], to destination: URL, folder: URL, ticket: NativePreparationTicket) async throws -> URL {
        if ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
        let kind = source["kind"] as? String ?? ""
        if kind == "station" {
            guard let name = source["file"] as? String else { throw Failure.source }
            return try NativeStationFiles.localURL(name)
        }
        if kind == "local" {
            guard let key = source["file"] as? Int, (0..<1_000_000).contains(key) else { throw Failure.source }
            let file = folder.appendingPathComponent("source-\(key).media")
            guard FileManager.default.fileExists(atPath: file.path) else { throw Failure.source }; return file
        }
        let headers = source["headers"] as? [String: String] ?? [:]
        let url: URL
        if kind == "yandex" { url = try await yandex(source, ticket: ticket) }
        else { guard let value = source["url"] as? String, let parsed = URL(string: value) else { throw Failure.source }; url = parsed }
        if kind == "hls" { try await hls(url, headers: headers, to: destination, ticket: ticket, depth: 0) }
        else { try await http.download(url, to: destination, headers: kind == "yandex" ? [:] : headers, ticket: ticket) }
        return destination
    }
    private func yandex(_ source: [String: Any], ticket: NativePreparationTicket) async throws -> URL {
        guard let id = source["externalId"] as? String,
              id.range(of: "^[A-Za-z0-9:-]+$", options: .regularExpression) != nil,
              let token = source["token"] as? String, !token.isEmpty,
              let base = URL(string: source["apiBase"] as? String ?? "https://api.music.yandex.net"),
              (base.scheme == "https" && base.host == "api.music.yandex.net")
                || (allowLoopback && ["127.0.0.1", "localhost"].contains(base.host ?? "")) else { throw Failure.source }
        let endpoint = base.appendingPathComponent("tracks").appendingPathComponent(id).appendingPathComponent("download-info")
        let data = try await http.data(endpoint, headers: ["Authorization": "OAuth \(token)", "Accept": "application/json"], ticket: ticket)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let variants = object["result"] as? [[String: Any]],
              let chosen = variants.filter({ ($0["codec"] as? String) == "mp3" && ($0["preview"] as? Bool) == false
                  && (($0["transport"] as? String) == nil || ($0["transport"] as? String) == "raw") })
                .sorted(by: { ($0["bitrateInKbps"] as? Int ?? 0) > ($1["bitrateInKbps"] as? Int ?? 0) }).first,
              let value = chosen["downloadInfoUrl"] as? String, let info = URL(string: value), mediaURL(info, base: base) else { throw Failure.source }
        if chosen["direct"] as? Bool == true { return info }
        let xml = try await http.data(info, limit: 65536, ticket: ticket)
        guard let text = String(data: xml, encoding: .utf8) else { throw Failure.source }
        return try yandexXML(text, base: base)
    }
    private func mediaURL(_ url: URL, base: URL) -> Bool {
        guard url.user == nil, url.password == nil, let host = url.host else { return false }
        if allowLoopback && url.scheme == base.scheme && host == base.host && url.port == base.port { return true }
        return url.scheme == "https" && (url.port == nil || url.port == 443)
            && ["yandex.net", "yandex.ru", "yandex.com", "yandexmusic.net", "yandexmusic.ru"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
    func yandexXML(_ xml: String, base: URL) throws -> URL {
        guard xml.utf8.count <= 65536, xml.range(of: "<!DOCTYPE|<!ENTITY", options: [.regularExpression, .caseInsensitive]) == nil else { throw Failure.source }
        func field(_ name: String) throws -> String {
            let regex = try NSRegularExpression(pattern: "<\(name)>\\s*([^<>]*)\\s*</\(name)>")
            let matches = regex.matches(in: xml, range: NSRange(xml.startIndex..., in: xml))
            guard matches.count == 1, let range = Range(matches[0].range(at: 1), in: xml) else { throw Failure.source }
            return xml[range].trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "&amp;", with: "&")
        }
        let host = try field("host"), path = try field("path"), ts = try field("ts"), salt = try field("s")
        guard host.range(of: "^[A-Za-z0-9.:-]+$", options: .regularExpression) != nil,
              path.range(of: "^/[A-Za-z0-9_./%+=,@~-]+$", options: .regularExpression) != nil, !path.contains(".."),
              ts.range(of: "^[a-fA-F0-9]{1,64}$", options: .regularExpression) != nil,
              salt.range(of: "^[A-Za-z0-9_+-]+$", options: .regularExpression) != nil else { throw Failure.source }
        let digest = Insecure.MD5.hash(data: Data(("XGRlBW9FXlekgbPrRHuSiA" + String(path.dropFirst()) + salt).utf8)).map { String(format: "%02x", $0) }.joined()
        let authority = (base.host ?? "") + (base.port.map { ":\($0)" } ?? "")
        let scheme = allowLoopback && host == authority ? base.scheme ?? "https" : "https"
        guard let url = URL(string: "\(scheme)://\(host)/get-mp3/\(digest)/\(ts)\(path)"), mediaURL(url, base: base) else { throw Failure.source }
        return url
    }
    private func hls(_ url: URL, headers: [String: String], to destination: URL, ticket: NativePreparationTicket, depth: Int) async throws {
        guard depth < 4 else { throw Failure.playlist }
        let bytes = try await http.data(url, headers: headers, limit: 2 * 1024 * 1024, ticket: ticket)
        guard let text = String(data: bytes, encoding: .utf8), text.contains("#EXTM3U") else { throw Failure.playlist }
        let lines = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if lines.contains(where: { $0.hasPrefix("#EXT-X-KEY:") && !$0.contains("METHOD=NONE") }) { throw Failure.encrypted }
        let segments = lines.filter { !$0.hasPrefix("#") }
        if !text.contains("#EXTINF:") {
            let media = lines.first { $0.hasPrefix("#EXT-X-MEDIA:") && $0.contains("TYPE=AUDIO") }.flatMap { attributes($0)["URI"] }
            guard let first = media ?? segments.first, let next = URL(string: first, relativeTo: url)?.absoluteURL else { throw Failure.playlist }
            try await hls(next, headers: headers, to: destination, ticket: ticket, depth: depth + 1); return
        }
        guard text.contains("#EXT-X-ENDLIST"), !segments.isEmpty, segments.count <= 10000 else { throw Failure.playlist }
        let partial = destination.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).hls")
        guard FileManager.default.createFile(atPath: partial.path, contents: nil, attributes: NativePreparationFiles.attributes) else { throw Failure.playlist }
        defer { try? FileManager.default.removeItem(at: partial) }
        let file = try FileHandle(forWritingTo: partial); defer { try? file.close() }
        var total = 0, byteOffset = 0
        var range: String?
        let map = lines.first(where: { $0.hasPrefix("#EXT-X-MAP:") }).map(attributes)
        struct Part { let url: URL; let headers: [String: String]; let expected: Int?; let packed: Bool }
        // Byte ranges follow from the lines before them, so the playlist is read in order first.
        func part(_ value: String, range: String?, packed: Bool) throws -> Part {
            guard let segmentURL = URL(string: value, relativeTo: url)?.absoluteURL else { throw Failure.playlist }
            var requestHeaders = headers
            var expected: Int?
            if let range {
                let parts = range.split(separator: "@"), count = Int(parts[0]) ?? 0
                if parts.count > 1 { byteOffset = Int(parts[1]) ?? -1 }
                guard count > 0, byteOffset >= 0, count <= 128 * 1024 * 1024 else { throw Failure.playlist }
                requestHeaders["Range"] = "bytes=\(byteOffset)-\(byteOffset + count - 1)"; expected = count; byteOffset += count
            }
            return Part(url: segmentURL, headers: requestHeaders, expected: expected, packed: packed)
        }
        var parts: [Part] = []
        if let map, let initURL = map["URI"] { parts.append(try part(initURL, range: map["BYTERANGE"], packed: false)) }
        for line in lines {
            if line.hasPrefix("#EXT-X-BYTERANGE:") { range = String(line.dropFirst("#EXT-X-BYTERANGE:".count)) }
            else if !line.hasPrefix("#") { parts.append(try part(line, range: range, packed: map == nil)); range = nil }
        }
        // A YouTube track is ~35 short segments: one at a time that was 7–21 s of round trips on a phone.
        // Up to six download at once; they are written strictly in playlist order.
        let http = self.http, width = 6
        try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            var launched = 0, written = 0
            var ready: [Int: Data] = [:]
            while launched < min(width, parts.count) {
                let i = launched, p = parts[i]; launched += 1
                group.addTask { (i, try await http.data(p.url, headers: p.headers, limit: 16 * 1024 * 1024, ticket: ticket)) }
            }
            while let (i, data) = try await group.next() {
                if ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
                ready[i] = data
                while let data = ready.removeValue(forKey: written) {
                    let p = parts[written]
                    if let expected = p.expected, data.count != expected { throw Failure.playlist }
                    let audio = p.packed ? try Self.packedAudio(data) : data
                    total += audio.count; guard total <= 128 * 1024 * 1024 else { throw NativeMediaHTTP.Failure.tooLarge }
                    try file.write(contentsOf: audio)
                    written += 1
                }
                if launched < parts.count {
                    let i = launched, p = parts[i]; launched += 1
                    group.addTask { (i, try await http.data(p.url, headers: p.headers, limit: 16 * 1024 * 1024, ticket: ticket)) }
                }
            }
        }
        guard total > 0 else { throw Failure.playlist }
        if ticket.cancelled { throw NativeMediaHTTP.Failure.cancelled }
        try file.synchronize(); try file.close()
        try FileManager.default.moveItem(at: partial, to: destination)
    }
    private func attributes(_ line: String) -> [String: String] {
        guard let regex = try? NSRegularExpression(pattern: "([A-Z0-9-]+)=(?:\"([^\"]*)\"|([^,]*))") else { return [:] }
        var result: [String: String] = [:]
        for match in regex.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
            guard let key = Range(match.range(at: 1), in: line), let value = Range(match.range(at: match.range(at: 2).location == NSNotFound ? 3 : 2), in: line) else { continue }
            result[String(line[key])] = String(line[value])
        }
        return result
    }
    // Same packed-audio/TS extraction as the existing mobile resolver, ported to Swift.
    // Original adaptation: rootscripts/cloverscripts riff-muriel, MIT.
    static func packedAudio(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        if bytes.first == 0x47 {
            var output = Data(), audioPID = -1, i = 0
            while i + 188 <= bytes.count {
                if bytes[i] != 0x47 { i += 1; continue }
                let pid = Int(bytes[i + 1] & 31) << 8 | Int(bytes[i + 2]), start = bytes[i + 1] & 64 != 0
                let adaptation = (bytes[i + 3] >> 4) & 3
                var at = i + 4
                if adaptation == 0 || adaptation == 2 { i += 188; continue }
                if adaptation == 3 { at += 1 + Int(bytes[at]) }
                if at < i + 188 {
                    if start && at + 8 < i + 188 && bytes[at] == 0 && bytes[at + 1] == 0 && bytes[at + 2] == 1 {
                        let stream = bytes[at + 3]
                        if stream >= 0xc0 && stream <= 0xdf { audioPID = pid; at += 9 + Int(bytes[at + 8]) }
                        else if pid == audioPID { i += 188; continue }
                    }
                    if pid == audioPID && at < i + 188 { output.append(contentsOf: bytes[at..<i + 188]) }
                }
                i += 188
            }
            guard !output.isEmpty else { throw Failure.playlist }; return output
        }
        var at = 0
        while at + 10 <= bytes.count && bytes[at] == 0x49 && bytes[at + 1] == 0x44 && bytes[at + 2] == 0x33 {
            let size = Int(bytes[at + 6]) << 21 | Int(bytes[at + 7]) << 14 | Int(bytes[at + 8]) << 7 | Int(bytes[at + 9])
            at += 10 + size + (bytes[at + 5] & 16 != 0 ? 10 : 0)
            guard at <= bytes.count else { throw Failure.playlist }
        }
        return Data(bytes[at...])
    }
}
