import Foundation

struct NativeImportPick: Identifiable {
    var id: String { job + ":" + String(position) }
    let job: String, position: Int, title: String, artist: String
}

/// Uses the existing native row renderer; import data and actions no longer come from WebContent.
final class NativeImportState {
    typealias Row = [String: Any]
    typealias Request = (String, String, Row?) async throws -> Row
    struct Result { var mutated = false; var path: String? = nil; var message: String? = nil }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    private(set) var job: Row?
    private(set) var includeUncertain = false
    private var generation = 0
    static func handles(_ path: String) -> Bool { path == "/import" || path == "/yandex-playlists" }
    static func supports(_ name: String) -> Bool {
        ["importUrl", "openImport", "closeImport", "deleteImport", "resolveImport", "importUncertain", "importPlaylist", "importYandexPlaylist"].contains(name)
    }
    static func component(_ value: Any?) throws -> String {
        guard let value = value as? String, !value.isEmpty, value.count <= 512,
              let encoded = value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) else {
            throw Failure(message: "Импорт не найден")
        }
        return encoded
    }
    static func candidate(_ raw: Row) throws -> Row {
        guard raw["playable"] as? Bool == true, let provider = raw["audioProvider"] as? String, ["youtube", "soundcloud"].contains(provider),
              let id = raw["externalId"] as? String, !id.isEmpty, id.count <= 512,
              let title = raw["title"] as? String, !title.isEmpty,
              let duration = (raw["duration"] as? NSNumber)?.doubleValue, duration.isFinite, duration >= 0 else { throw Failure(message: "Эта запись недоступна") }
        let labels = (raw["labels"] as? [Row] ?? []).filter { $0["tag"] is String && ["source", "title"].contains($0["origin"] as? String ?? "") }
        return ["provider": provider, "externalId": id, "title": title, "artist": raw["artist"] as? String ?? "", "duration": duration, "coverUrl": (raw["coverUrl"] as? String).map { $0 as Any } ?? NSNull(), "labels": labels]
    }
    private static func checked(_ raw: Row) throws -> Row {
        guard let id = raw["id"] as? String, !id.isEmpty, raw["rows"] is [Row],
              let state = raw["state"] as? String, ["matching", "ready", "creating", "done", "failed"].contains(state) else { throw Failure(message: "Некорректный отчёт импорта") }
        return raw
    }
    func start(_ body: Row, request: Request) async throws {
        generation &+= 1
        job = try Self.checked(await request("POST", "/api/imports", body))
        includeUncertain = false
    }
    func pick(_ position: Int) throws -> NativeImportPick {
        guard let job, let id = job["id"] as? String,
              let row = (job["rows"] as? [Row])?.first(where: { $0["position"] as? Int == position }), row["status"] as? String != "pending" else { throw Failure(message: "Позиция импорта изменилась") }
        return NativeImportPick(job: id, position: position, title: row["title"] as? String ?? "", artist: row["artist"] as? String ?? "")
    }
    func execute(_ name: String, _ args: Row, request: Request) async throws -> Result {
        guard Self.supports(name) else { throw Failure(message: "Неизвестное действие импорта") }
        generation &+= 1
        switch name {
        case "importUrl":
            let form = args["form"] as? [String: String] ?? [:], text = (form["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let spotify = text.range(of: #"^spotify:(playlist|album):[A-Za-z0-9]+$"#, options: .regularExpression) != nil
            guard text.count <= 2000, let url = URL(string: text), (url.scheme?.lowercased() == "https" && url.host != nil || spotify), url.user == nil, url.password == nil else { throw Failure(message: "Вставьте ссылку на плейлист") }
            try await start(["url": text], request: request)
        case "openImport":
            job = try Self.checked(await request("GET", "/api/imports/" + Self.component(args["id"]), nil)); includeUncertain = false
        case "closeImport": job = nil; includeUncertain = false
        case "deleteImport":
            _ = try await request("DELETE", "/api/imports/" + Self.component(args["id"]), nil)
            if args["id"] as? String == job?["id"] as? String { job = nil }
        case "importUncertain": includeUncertain = args["value"] as? Bool == true
        case "resolveImport", "importPlaylist":
            guard let job, let id = job["id"] as? String else { throw Failure(message: "Откройте отчёт импорта") }
            let path = "/api/imports/" + (try Self.component(id))
            if name == "resolveImport" {
                guard args["job"] == nil || args["job"] as? String == id,
                      let position = args["position"] as? Int, position >= 0,
                      (job["rows"] as? [Row])?.contains(where: { $0["position"] as? Int == position }) == true else { throw Failure(message: "Позиция импорта изменилась") }
                self.job = try Self.checked(await request("POST", path + "/resolve", ["position": position, "choice": args["choice"] ?? NSNull()]))
            } else {
                guard job["state"] as? String != "matching" else { throw Failure(message: "Сопоставление ещё идёт") }
                self.job = try Self.checked(await request("POST", path + "/playlist", ["includeUncertain": includeUncertain]))
            }
            return Result(mutated: true)
        case "importYandexPlaylist":
            let result = try await request("POST", "/api/providers/yandex/playlists/" + Self.component(args["kind"]) + "/import", nil)
            let unavailable = result["unavailable"] as? Int ?? 0
            return Result(mutated: true, path: "/playlist/" + (try Self.component(result["id"])), message: "Импортировано: \(result["count"] as? Int ?? 0)" + (unavailable > 0 ? ". Недоступно: \(unavailable); места сохранены" : ""))
        default: break
        }
        return Result()
    }
    func page(_ path: String, request: Request) async throws -> Row {
        if path == "/yandex-playlists" {
            let result = try await request("GET", "/api/providers/yandex/playlists", nil)
            guard let playlists = result["playlists"] as? [Row] else { throw Failure(message: "Не удалось прочитать плейлисты") }
            return ["title": "Плейлисты Яндекса", "sections": [["footer": "Импортируется состав плейлиста. Звук скачивается отдельно; места недоступных треков сохраняются.", "rows": playlists.isEmpty ? [text("Плейлистов пока нет")] : playlists.map { button(($0["name"] as? String ?? "Плейлист") + " · \(($0["count"] as? Int) ?? 0)", "importYandexPlaylist", ["kind": $0["kind"] ?? ""]) }]]]
        }
        if let id = job?["id"] as? String {
            let current = generation
            let fresh = try Self.checked(await request("GET", "/api/imports/" + Self.component(id), nil))
            if !Task.isCancelled && current == generation && job?["id"] as? String == id { job = fresh }
        }
        if let job { return report(job) }
        let result = try await request("GET", "/api/imports", nil)
        guard let jobs = result["jobs"] as? [Row] else { throw Failure(message: "Не удалось прочитать импорты") }
        let recent: [Row] = jobs.map { value in
            ["kind": "item", "title": value["name"] ?? "Импорт", "subtitle": value["state"] as? String == "matching" ? "Сопоставляется" : "Открыть отчёт", "act": act("openImport", ["id": value["id"] ?? ""]),
             "actions": [["title": "Удалить отчёт", "symbol": "trash", "destructive": true, "act": act("deleteImport", ["id": value["id"] ?? ""])]]]
        }
        var page: Row = ["title": "Импорт", "sections": [audio, ["title": "Плейлист из сервиса", "footer": "Spotify, Apple Music, YouTube, SoundCloud или CSV, JSON, M3U. Берутся названия; звук ищется отдельно.", "rows": [
            ["kind": "field", "key": "url", "title": "Ссылка на плейлист", "placeholder": "https://open.spotify.com/playlist/…"], button("Прочитать", "importUrl"),
            ["kind": "file", "title": "Файл плейлиста (CSV, M3U, JSON)", "types": ["csv", "json", "m3u", "m3u8", "txt"], "act": act("importFile")],
            ["kind": "link", "title": "Плейлисты Яндекса", "path": "/yandex-playlists", "symbol": "music.note.list"]]], ["title": "Недавние импорты", "rows": recent]]]
        if jobs.contains(where: { $0["state"] as? String == "matching" }) { page["refresh"] = 2.0 }
        return page
    }
    private func act(_ name: String, _ args: Row = [:]) -> Row { ["name": name, "args": args] }
    private func button(_ title: String, _ name: String, _ args: Row = [:]) -> Row { ["kind": "button", "title": title, "act": act(name, args)] }
    private func text(_ title: String) -> Row { ["kind": "text", "title": title] }
    private var audio: Row {
        ["title": "Музыка с iPhone", "footer": "Файлы из «Файлов» и iCloud Drive копируются в приложение и играют без интернета.", "rows": [
            ["kind": "file", "title": "Добавить аудиофайлы", "types": NativeImportFiles.audioExtensions, "multiple": true, "act": act("importAudio")],
            ["kind": "link", "title": "Свои файлы", "symbol": "arrow.down.circle", "path": "/downloads"]]]
    }
    private func report(_ job: Row) -> Row {
        let rows = job["rows"] as? [Row] ?? [], matching = job["state"] as? String == "matching"
        let matched = rows.filter { $0["status"] as? String == "matched" }.count, uncertain = rows.filter { $0["status"] as? String == "uncertain" }.count
        let pending = rows.filter { $0["status"] as? String == "pending" }.count, missing = rows.filter { $0["status"] as? String == "missing" }.count
        var header: [Row] = [text(job["name"] as? String ?? "Импорт"), text("Найдено \(matched) · проверьте \(uncertain) · не найдено \(missing) · ищем \(pending)")]
        if job["complete"] as? Bool != true { header.append(text((job["note"] as? String ?? "Источник показал не весь список.") + " Проверьте список перед созданием плейлиста.")) }
        if let error = job["error"] as? String, !error.isEmpty { header.append(text(error)) }
        if matching { header.append(["kind": "progress", "title": "Сопоставление", "value": Double(rows.count - pending) / Double(max(1, rows.count))]) }
        header.append(button("Закрыть отчёт", "closeImport"))
        let items: [Row] = rows.map { row in
            let position = row["position"] as? Int ?? 0, status = row["status"] as? String ?? "pending", candidate = row["candidate"] as? Row
            var actions: [Row] = []
            func action(_ title: String, _ symbol: String, _ name: String, _ extra: Row = [:]) -> Row {
                ["title": title, "symbol": symbol, "act": act(name, ["job": job["id"] ?? "", "position": position].merging(extra) { _, new in new })]
            }
            if status == "uncertain", let candidate { actions.append(action("Принять", "checkmark", "resolveImport", ["choice": candidate])) }
            if status != "pending" { actions.append(action("Найти вручную", "magnifyingglass", "pickImport")) }
            if status == "uncertain" || status == "matched" && row["how"] as? String != "source" { actions.append(action("Не добавлять", "xmark", "resolveImport", ["choice": NSNull()])) }
            let title = row["title"] as? String ?? "", artist = row["artist"] as? String ?? ""
            var detail = candidate.map { ($0["artist"] as? String ?? "") + " — " + ($0["title"] as? String ?? "") + " · " + ($0["provider"] as? String == "youtube" ? "YouTube" : "SoundCloud") } ?? artist
            if candidate != nil {
                let how = row["how"] as? String
                detail += how == "user" ? " · выбрано вами" : how == "source" ? " · из плейлиста" : " · уверенность \(Int(((row["confidence"] as? NSNumber)?.doubleValue ?? 0) * 100))%"
            }
            return ["kind": "item", "title": "\(position + 1). \(title)", "subtitle": detail,
                    "tag": ["matched": "Найдено", "uncertain": "Проверьте", "missing": "Не найдено", "pending": "Ищем…"][status] ?? status, "actions": actions]
        }
        var footer: [Row] = [["kind": "toggle", "title": "Добавить и непроверенные (\(uncertain))", "on": includeUncertain, "act": act("importUncertain")]]
        var create = button(job["playlistId"] is String ? "Обновить плейлист" : "Создать плейлист · \(matched + (includeUncertain ? uncertain : 0))", "importPlaylist")
        create["disabled"] = matching || matched + (includeUncertain ? uncertain : 0) == 0
        footer.append(create)
        if let id = job["playlistId"] as? String, let encoded = try? Self.component(id) { footer.append(["kind": "link", "title": "Открыть плейлист", "path": "/playlist/" + encoded]) }
        var page: Row = ["title": "Импорт", "search": "Найти в отчёте", "sections": [audio, ["rows": header], ["rows": items], ["rows": footer, "footer": "Ненайденные треки можно выбрать вручную — они встанут на своё место."]]]
        if matching { page["refresh"] = 1.2 }
        return page
    }
}
