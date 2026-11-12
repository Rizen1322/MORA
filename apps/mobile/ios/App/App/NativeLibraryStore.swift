import Foundation
import SQLite3

/// One read-only connection, used only on the shell's library queue. The server owns schema and writes.
final class NativeLibraryStore {
    struct Entry { let id: Int, trackId: String }
    struct Play { let id: Int, trackId: String, startedAt: Double, playedMs: Double; let reason: String? }
    struct Snapshot {
        let tracks: [NativeTrack], library: [NativeTrack], playlists: [NativePlaylist]
        let entries: [String: [Entry]], history: [Play]
    }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    private let db: OpaquePointer
    private var version: Int?

    init(path: String) throws {
        var handle: OpaquePointer?
        let rc = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "Не удалось открыть медиатеку"
            sqlite3_close_v2(handle)
            throw Failure(message: message)
        }
        db = handle
        sqlite3_busy_timeout(db, 5000)
    }
    deinit { sqlite3_close_v2(db) }

    private func rows(_ sql: String) throws -> [[String: Any]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw Failure(message: String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }
        var result: [[String: Any]] = []
        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_DONE { return result }
            guard rc == SQLITE_ROW else { throw Failure(message: String(cString: sqlite3_errmsg(db))) }
            var row: [String: Any] = [:]
            for index in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, index))
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(statement, index))
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, index)
                case SQLITE_TEXT:
                    let bytes = sqlite3_column_text(statement, index)!
                    row[name] = String(decoding: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_column_bytes(statement, index))), as: UTF8.self)
                default: break
                }
            }
            result.append(row)
        }
    }

    /// data_version observes commits on the server's connection, including background jobs and restores.
    /// A transaction keeps tracks, reactions, playlist entries and history at the same WAL snapshot.
    func readIfChanged(force: Bool = false) throws -> Snapshot? {
        _ = try rows("BEGIN")
        do {
            let current = try rows("PRAGMA data_version").first?["data_version"] as? Int
            if !force, version != nil, current == version { _ = try rows("COMMIT"); return nil }
            let raw = try rows("""
                SELECT t.*, COALESCE(a.duration,t.duration) AS playback_duration,
                    COALESCE(a.status,t.status) AS playback_status, COALESCE(a.pinned,t.pinned) AS playback_pinned,
                    (SELECT kind FROM track_sources WHERE track_id=COALESCE(a.id,t.id) ORDER BY id LIMIT 1) AS playback_kind, r.value AS reaction,
                    r.updated_at AS liked_at, b.asset_id, s.kind AS source_kind, s.provider AS source_provider, s.meta AS source_meta
                FROM tracks t LEFT JOIN reactions r ON r.track_id=t.id
                LEFT JOIN track_bindings b ON b.track_id=t.id LEFT JOIN tracks a ON a.id=b.asset_id
                LEFT JOIN track_sources s ON s.id=(SELECT id FROM track_sources WHERE track_id=t.id ORDER BY id LIMIT 1)
                ORDER BY t.added_at DESC,t.title,t.id
                """)
            var all: [NativeTrack] = [], saved: [NativeTrack] = []
            for row in raw {
                guard let id = row["id"] as? String else { continue }
                var value = row
                value["duration"] = (row["playback_duration"] as? NSNumber)?.doubleValue ?? 0
                value["likedAt"] = row["liked_at"] ?? row["added_at"]
                value["binding"] = row["asset_id"]
                let ok = row["status"] as? String == "ok"
                value["ok"] = ok
                let localSource = ["managed", "linked"].contains(row["playback_kind"] as? String ?? "")
                value["offline"] = row["playback_status"] as? String == "ok" && (row["playback_pinned"] as? Int == 1 || localSource)
                if let cover = row["cover_id"] as? String { value["cover"] = "/api/covers/\(cover)" }
                else if row["source_kind"] as? String == "remote" {
                    if ["youtube", "soundcloud"].contains(row["source_provider"] as? String ?? "") { value["cover"] = "/api/tracks/\(id)/cover" }
                    else if row["provider"] as? String == "yandex", let meta = row["source_meta"] as? String,
                            let data = meta.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                            let cover = object["coverUrl"] as? String, let url = URL(string: cover), url.scheme == "https",
                            ["avatars.mds.yandex.net", "avatars.yandex.net"].contains(url.host ?? "") { value["cover"] = cover }
                }
                if let track = NativeTrack(value) { all.append(track); if row["saved"] as? Int != 0 { saved.append(track) } }
            }
            let playlists = try rows("""
                SELECT p.id,p.name,COUNT(pt.id) AS count,
                    (SELECT t.cover_id FROM playlist_tracks x JOIN tracks t ON t.id=x.track_id WHERE x.playlist_id=p.id AND t.cover_id IS NOT NULL ORDER BY x.position,x.id LIMIT 1) AS cover_id,
                    (SELECT t.id FROM playlist_tracks x JOIN tracks t ON t.id=x.track_id WHERE x.playlist_id=p.id AND t.provider IN ('youtube','soundcloud') ORDER BY x.position,x.id LIMIT 1) AS cover_track
                FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC,p.id
                """).compactMap { row -> NativePlaylist? in
                    var value = row
                    if let cover = row["cover_id"] as? String { value["cover"] = "/api/covers/\(cover)" }
                    else if let track = row["cover_track"] as? String { value["cover"] = "/api/tracks/\(track)/cover" }
                    return NativePlaylist(value)
                }
            var entries: [String: [Entry]] = [:]
            for row in try rows("SELECT id,playlist_id,track_id FROM playlist_tracks ORDER BY playlist_id,position,id") {
                if let playlist = row["playlist_id"] as? String, let id = row["id"] as? Int, let track = row["track_id"] as? String {
                    entries[playlist, default: []].append(Entry(id: id, trackId: track))
                }
            }
            let history = try rows("SELECT id,track_id,started_at,played_ms,end_reason FROM plays ORDER BY id DESC LIMIT 300").compactMap { row -> Play? in
                guard let id = row["id"] as? Int, let track = row["track_id"] as? String else { return nil }
                return Play(id: id, trackId: track, startedAt: (row["started_at"] as? NSNumber)?.doubleValue ?? 0,
                    playedMs: (row["played_ms"] as? NSNumber)?.doubleValue ?? 0, reason: row["end_reason"] as? String)
            }
            _ = try rows("COMMIT")
            version = current
            return Snapshot(tracks: all, library: saved, playlists: playlists, entries: entries, history: history)
        } catch {
            _ = try? rows("ROLLBACK")
            throw error
        }
    }
}

extension NativeLibraryStore.Snapshot {
    /// These pages read their contents here; mutations still use the existing server commands.
    func page(_ path: String, sort: String = "") throws -> [String: Any]? {
        typealias Row = [String: Any]
        func act(_ name: String, _ args: Row = [:]) -> Row { ["name": name, "args": args] }
        func button(_ title: String, _ name: String, _ args: Row = [:], _ extra: Row = [:]) -> Row {
            ["kind": "button", "title": title, "act": act(name, args)].merging(extra) { _, value in value }
        }
        func link(_ title: String, _ path: String, _ symbol: String) -> Row { ["kind": "link", "title": title, "path": path, "symbol": symbol] }
        func text(_ title: String) -> Row { ["kind": "text", "title": title] }
        func time(_ seconds: Double) -> String { let value = max(0, Int(seconds)); return String(format: "%d:%02d", value / 60, value % 60) }
        if path == "/library/playlists" {
            let rows: [Row] = playlists.map { p in
                var row: Row = ["kind": "item", "title": p.name, "subtitle": NativeText.tracks(p.count), "path": "/playlist/\(p.id)"]
                row["cover"] = p.cover.map { $0 as Any } ?? NSNull()
                return row
            }
            return ["title": "Плейлисты", "sections": [
                ["rows": [button("Создать плейлист", "createPlaylist", [:], ["symbol": "plus", "style": "primary", "prompt": ["title": "Новый плейлист", "placeholder": "Название"]]), link("Умные плейлисты", "/smart-playlists", "sparkles")]],
                ["title": "Собрано вами", "footer": rows.isEmpty ? "Добавляйте музыку в плейлист через меню трека." : "", "rows": rows]]]
        }
        let byId = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        if path == "/history" {
            let date = DateFormatter(); date.locale = Locale(identifier: "ru_RU"); date.dateStyle = .short; date.timeStyle = .short
            let labels = ["finished": "дослушан", "transition": "AutoMix-переход", "skip": "пропущен", "stop": "остановлен", "error": "ошибка"]
            let rows: [Row] = history.compactMap { h in
                guard let track = byId[h.trackId] else { return nil }
                var row: Row = ["kind": "item", "title": track.title,
                    "subtitle": "\(track.artist) · \(date.string(from: Date(timeIntervalSince1970: h.startedAt / 1000))) · \(time(h.playedMs / 1000))",
                    "tag": labels[h.reason ?? ""] ?? "играл", "cover": track.cover.map { $0 as Any } ?? NSNull()]
                if h.reason == "skip" { row["tone"] = "warn" } else if h.reason == "transition" { row["tone"] = "accent" }
                return row
            }
            let controls = rows.isEmpty ? [text("История пуста.")] : [button("Очистить историю", "clearHistory", [:], ["style": "destructive", "confirm": ["title": "Очистить историю?", "text": "Записи о прослушиваниях будут удалены. «Моя волна» начнёт учиться заново, лайки сохранятся.", "button": "Очистить"]])]
            return ["title": "История", "sections": [["rows": controls], ["rows": rows]]]
        }
        let parts = path.split(separator: "/")
        guard parts.count == 2, parts[0] == "playlist" else { return nil }
        let id = String(parts[1]).removingPercentEncoding ?? String(parts[1])
        guard let playlist = playlists.first(where: { $0.id == id }) else { throw NativeLibraryStore.Failure(message: "Плейлист не найден") }
        var list = (entries[id] ?? []).filter { byId[$0.trackId] != nil }
        if ["title", "artist", "duration"].contains(sort) {
            list = list.enumerated().sorted { a, b in
                let left = byId[a.element.trackId]!, right = byId[b.element.trackId]!
                if sort == "duration" { return left.duration == right.duration ? a.offset < b.offset : left.duration < right.duration }
                let result = (sort == "artist" ? left.artist : left.title).localizedStandardCompare(sort == "artist" ? right.artist : right.title)
                return result == .orderedSame ? a.offset < b.offset : result == .orderedAscending
            }.map(\.element)
        }
        let ids = list.map(\.trackId), ctx: Row = ["type": "playlist", "id": id, "label": playlist.name]
        let play = ctx.merging(["ids": ids]) { _, value in value }
        let pending = list.contains { byId[$0.trackId]?.reaction == 0 }
        let header: [Row] = [
            button("Слушать", "playAll", play, ["symbol": "play.fill", "style": "primary", "disabled": ids.isEmpty]),
            button("Вперемешку", "playAll", play.merging(["shuffle": true]) { _, value in value }, ["symbol": "shuffle", "disabled": ids.isEmpty]),
            button(pending ? "Лайкнуть все" : "Всё в любимом", "likeAll", ["ids": ids], ["symbol": "heart", "disabled": !pending])]
        let controls: [Row] = [
            button("Переименовать", "renamePlaylist", ["id": id], ["symbol": "pencil", "prompt": ["title": "Переименовать плейлист", "initial": playlist.name, "placeholder": "Название"]]),
            ["kind": "choice", "title": "Порядок", "value": sort, "act": act("playlistSort", ["id": id]), "options": [["", "Как в плейлисте"], ["title", "По названию"], ["artist", "По исполнителю"], ["duration", "По длительности"]]],
            button("Скачать на iPhone", "downloadTracks", ["ids": ids], ["symbol": "arrow.down.circle"]),
            button("Экспорт", "exportPlaylist", ["id": id], ["symbol": "square.and.arrow.up"]),
            link("Собрать микс", "/playlist/\(id)/mix", "wand.and.stars")]
        var section: Row = ["play": ctx, "rows": list.map { entry -> Row in
            ["kind": "track", "id": entry.trackId, "remove": ["title": "Убрать из плейлиста", "symbol": "minus.circle", "act": act("removeFromPlaylist", ["id": id, "entry": entry.id])]]
        }]
        if sort.isEmpty { section["reorder"] = act("reorderPlaylist", ["id": id, "entries": list.map(\.id)]) }
        if list.isEmpty { section = ["title": "У каждой истории есть первый трек", "rows": [text("Добавьте музыку через меню трека."), link("Выбрать из медиатеки", "/library", "books.vertical")]] }
        return ["title": playlist.name, "search": ids.isEmpty ? "" : "Найти в плейлисте", "sections": [
            ["footer": "\(NativeText.tracks(ids.count)), \(time(ids.reduce(0) { $0 + (byId[$1]?.duration ?? 0) }))", "rows": header],
            ["rows": controls], ["rows": [button("Удалить плейлист", "deletePlaylist", ["id": id], ["style": "destructive", "confirm": ["title": "Удалить плейлист?", "text": "Плейлист «\(playlist.name)» будет удалён. Треки останутся в медиатеке.", "button": "Удалить"]])]], section]]
    }
}
