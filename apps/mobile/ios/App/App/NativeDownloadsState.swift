import Foundation

struct NativeDownloadsState {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    struct Job: Identifiable {
        let id: String, title: String, artist: String, album: String, state: String
        let trackId: String?, error: String?
        let native: Bool
        let progress: Double, bytes: Double, totalBytes: Double, duration: Double
        let eta: Double?
        var identity: String { (native ? "native:" : "server:") + id }
        var active: Bool { state != "done" && state != "cancelled" }
        var canPause: Bool { ["queued", "downloading", "waiting"].contains(state) }
        var canRetry: Bool { ["paused", "failed"].contains(state) }
        var status: String {
            if let error, state != "downloading" { return error }
            return ["queued": "В очереди", "downloading": "Скачивается", "waiting": "Ждём подключения",
                    "paused": "На паузе", "failed": "Ошибка", "done": "Готово", "cancelled": "Отменено"][state] ?? state
        }
        init(_ row: [String: Any], native: Bool) throws {
            guard let id = row["id"] as? String, !id.isEmpty, id.utf8.count <= 512,
                  let state = row["state"] as? String,
                  ["queued", "downloading", "waiting", "paused", "failed", "done", "cancelled"].contains(state) else {
                throw Failure(message: "Некорректная запись в очереди загрузок")
            }
            self.id = id; self.state = state; self.native = native
            title = row["title"] as? String ?? "Трек"
            artist = row["artist"] as? String ?? ""; album = row["album"] as? String ?? ""
            trackId = row["trackId"] as? String; error = row["error"] as? String
            func number(_ key: String) -> Double {
                let value = (row[key] as? NSNumber)?.doubleValue ?? 0
                return value.isFinite ? min(1e15, max(0, value)) : 0
            }
            progress = min(1, number("progress")); bytes = number("bytes"); totalBytes = number("totalBytes")
            duration = number("duration"); eta = number("eta") > 0 ? number("eta") : nil
        }
    }
    struct Usage {
        let cacheBytes: Double, pinnedBytes: Double, limitBytes: Double
        let freeBytes: Double?
        var availableForNative: Double { max(0, limitBytes - cacheBytes - pinnedBytes) }
        init(_ row: [String: Any]) throws {
            func number(_ key: String) throws -> Double {
                guard let value = (row[key] as? NSNumber)?.doubleValue, value.isFinite, value >= 0, value <= 1e15 else {
                    throw Failure(message: "Не удалось прочитать сведения о месте на диске")
                }
                return value
            }
            cacheBytes = try number("cacheBytes"); pinnedBytes = try number("pinnedBytes"); limitBytes = try number("limitBytes")
            if row["freeBytes"] is NSNull || row["freeBytes"] == nil { freeBytes = nil }
            else { freeBytes = try number("freeBytes") }
        }
    }
    var serverJobs: [Job] = [], nativeJobs: [Job] = []
    var usage: Usage?
    var active: [Job] { (serverJobs + nativeJobs).filter(\.active) }
    var nativeBytes: Double { nativeJobs.filter { $0.state == "done" }.reduce(0) { $0 + $1.bytes } }
    mutating func receive(_ response: [String: Any]) throws {
        guard let jobs = response["jobs"] as? [[String: Any]], let raw = response["usage"] as? [String: Any] else {
            throw Failure(message: "Не удалось прочитать загрузки")
        }
        let parsed = try jobs.map { try Job($0, native: false) }
        let usage = try Usage(raw)
        serverJobs = parsed; self.usage = usage
    }
    mutating func receiveNative(_ response: [String: Any]) throws {
        guard let rows = response["jobs"] as? [[String: Any]] else { throw Failure(message: "Не удалось прочитать фоновые загрузки") }
        nativeJobs = try rows.map { try Job($0, native: true) }
    }
    func downloaded(in library: [NativeTrack], byId: [String: NativeTrack]) -> [NativeTrack] {
        let done = Set((serverJobs + nativeJobs).filter { $0.state == "done" }.compactMap(\.trackId))
        var tracks = library.filter { $0.pinned || done.contains($0.id) }
        var seen = Set(tracks.map(\.id))
        for job in nativeJobs where job.state == "done" {
            guard let id = job.trackId, seen.insert(id).inserted else { continue }
            if let track = byId[id] ?? NativeTrack(["id": id, "title": job.title, "artist": job.artist,
                "album": job.album, "duration": job.duration, "offline": true, "ok": false]) { tracks.append(track) }
        }
        return Self.sorted(tracks)
    }
    static func own(in library: [NativeTrack]) -> [NativeTrack] { sorted(library.filter { $0.provider == "local" && !$0.pinned }) }
    static func sorted(_ tracks: [NativeTrack]) -> [NativeTrack] {
        tracks.sorted { a, b in
            let order = a.title.compare(b.title, locale: Locale(identifier: "ru_RU"))
            return order == .orderedSame ? a.id < b.id : order == .orderedAscending
        }
    }
    static func component(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~")) ?? ""
    }
    static func space(_ bytes: Double) -> String {
        bytes >= 1024 * 1024 * 1024 ? String(format: "%.1f ГБ", bytes / (1024 * 1024 * 1024)).replacingOccurrences(of: ".", with: ",") : "\(Int((bytes / (1024 * 1024)).rounded())) МБ"
    }
}
