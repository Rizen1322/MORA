import Foundation

/// Smart playlists, duplicate merging and listening statistics: library screens whose rows are drawn by
/// `NativePageView` and whose data comes straight from the JSC API, not from a page description.
final class NativeSmartState {
    typealias Row = [String: Any]
    typealias Request = (String, String, Row?) async throws -> Row
    struct Result { var mutated = false; var path: String? = nil; var message: String? = nil }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// `/smart-playlists`, `/smart-playlist/new`, `/smart-playlist/<id>[/edit]`, `/duplicates`, `/statistics`.
    static func handles(_ path: String) -> Bool {
        if ["/smart-playlists", "/duplicates", "/statistics"].contains(path) { return true }
        let parts = path.split(separator: "/").map(String.init)
        return parts.first == "smart-playlist" && (parts.count == 2 || (parts.count == 3 && parts[2] == "edit"))
    }
    static func supports(_ name: String) -> Bool {
        ["saveSmartPlaylist", "deleteSmartPlaylist", "mergeDuplicates"].contains(name)
    }
    /// Only a bounded, path-safe id may reach an API path: the page ids are UUIDs.
    static func component(_ value: Any?) throws -> String {
        guard let value = value as? String, !value.isEmpty, value.count <= 100,
              value.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            throw Failure(message: "Плейлист не найден")
        }
        return value
    }

    // MARK: pages

    func page(_ path: String, request: Request) async throws -> Row {
        switch path {
        case "/smart-playlists": return try await list(request)
        case "/duplicates": return try await duplicates(request)
        case "/statistics": return try await statistics(request)
        default: break
        }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.first == "smart-playlist", parts.count >= 2 else { throw Failure(message: "Неизвестная страница") }
        return try await playlist(parts[1], editing: parts.count == 3 && parts[2] == "edit", request: request)
    }

    private func list(_ request: Request) async throws -> Row {
        let result = try await request("GET", "/api/smart-playlists", nil)
        guard let playlists = result["playlists"] as? [Row] else { throw Failure(message: "Не удалось прочитать умные плейлисты") }
        let rows: [Row] = playlists.compactMap { value -> Row? in
            var row: Row = ["kind": "item", "title": value["name"] as? String ?? "Плейлист"]
            guard let id = value["id"] as? String, let encoded = try? Self.component(id) else { return nil }
            row["path"] = "/smart-playlist/" + encoded
            if let rules = value["rules"] as? Row, !rules.isEmpty { row["subtitle"] = Self.summary(rules) }
            return row
        }
        var saved: Row = ["title": "Сохранённые", "rows": rows]
        if rows.isEmpty { saved["footer"] = "Правила подбирают треки из медиатеки автоматически: жанр, годы, лайки и прослушивания." }
        let create: Row = ["kind": "link", "title": "Создать умный плейлист", "symbol": "plus", "path": "/smart-playlist/new"]
        let createSection: Row = ["rows": [create]]
        return ["title": "Умные плейлисты", "sections": [createSection, saved]]
    }

    private func playlist(_ id: String, editing: Bool, request: Request) async throws -> Row {
        let creating = id == "new"
        var value: Row = [:]
        if !creating { value = try await request("GET", "/api/smart-playlists/" + (try Self.component(id)), nil) }
        let name = value["name"] as? String ?? ""
        let rules = value["rules"] as? Row ?? [:]
        if editing || creating {
            let editorId: String? = creating ? nil : id
            return editor(id: editorId, name: name, rules: rules)
        }
        let encoded = try Self.component(id)
        let ids = (value["tracks"] as? [String] ?? []).filter { !$0.isEmpty }
        let play: Row = ["type": "playlist", "id": id, "label": name]
        let playArgs: Row = ["ids": ids, "type": "playlist", "id": id, "label": name]
        let headerRows: [Row] = [
            ["kind": "button", "title": "Слушать", "symbol": "play.fill", "style": "primary", "disabled": ids.isEmpty,
             "act": ["name": "playAll", "args": playArgs]],
            ["kind": "button", "title": "Вперемешку", "symbol": "shuffle", "disabled": ids.isEmpty,
             "act": ["name": "playAll", "args": playArgs.merging(["shuffle": true]) { _, value in value }]],
            ["kind": "text", "title": name, "detail": Self.tracks(ids.count)],
            ["kind": "link", "title": "Изменить правила", "symbol": "slider.horizontal.3", "path": "/smart-playlist/\(encoded)/edit"],
        ]
        let header: Row = ["play": play, "rows": headerRows]
        let body: Row
        if ids.isEmpty {
            let empty: Row = ["kind": "text", "title": "Пока нет подходящих треков",
                              "detail": "Ослабьте условия или добавьте музыку в медиатеку."]
            body = ["rows": [empty]]
        } else {
            body = ["play": play, "rows": ids.map { track -> Row in ["kind": "track", "id": track] }]
        }
        return ["title": name.isEmpty ? "Умный плейлист" : name, "sections": [header, body]]
    }

    private func editor(id: String?, name: String, rules: Row) -> Row {
        let fields: [(key: String, title: String, value: String)] = [
            ("name", "Название", name),
            ("genre", "Жанр содержит", rules["genre"] as? String ?? ""),
            ("yearFrom", "Год от", Self.number(rules["yearFrom"])),
            ("yearTo", "Год до", Self.number(rules["yearTo"])),
            ("liked", "В любимом: да / нет / пусто", (rules["liked"] as? Bool).map { $0 ? "да" : "нет" } ?? ""),
            ("minPlays", "Не меньше прослушиваний", Self.number(rules["minPlays"])),
            ("notPlayedDays", "Не слушал дней", Self.number(rules["notPlayedDays"])),
        ]
        var values: [String: String] = [:]
        for field in fields { values[field.key] = field.value }
        var args: Row = ["defaults": values]
        if let id { args["id"] = id }
        var actions: [Row] = [
            ["kind": "button", "title": "Сохранить", "style": "primary", "act": ["name": "saveSmartPlaylist", "args": args]],
        ]
        if let id {
            actions.append(["kind": "button", "title": "Удалить", "style": "destructive",
                            "act": ["name": "deleteSmartPlaylist", "args": ["id": id]],
                            "confirm": ["title": "Удалить умный плейлист?", "text": "Треки останутся в медиатеке.", "button": "Удалить"]])
        }
        let rows: [Row] = fields.map { field -> Row in
            ["kind": "field", "key": field.key, "title": field.title, "value": field.value]
        }
        let rulesSection: Row = ["footer": "Все заполненные условия действуют одновременно. Пустое поле не ограничивает подборку.", "rows": rows]
        let actionsSection: Row = ["rows": actions]
        return ["title": id == nil ? "Новый умный плейлист" : "Правила плейлиста", "sections": [rulesSection, actionsSection]]
    }

    private func duplicates(_ request: Request) async throws -> Row {
        let result = try await request("GET", "/api/library/duplicates", nil)
        guard let groups = result["groups"] as? [Row] else { throw Failure(message: "Не удалось прочитать дубликаты") }
        let sections: [Row] = groups.compactMap { group -> Row? in
            guard let hash = group["hash"] as? String, hash.count == 64, let tracks = group["tracks"] as? [Row], !tracks.isEmpty else { return nil }
            var rows: [Row] = tracks.map { track -> Row in
                ["kind": "text", "title": track["title"] as? String ?? "Запись",
                 "detail": track["artist"] as? String ?? "", "value": "\((track["playCount"] as? Int) ?? 0) прослушиваний"]
            }
            rows.append(["kind": "button", "title": "Объединить", "symbol": "arrow.triangle.merge", "style": "primary",
                         "act": ["name": "mergeDuplicates", "args": ["hash": hash]],
                         "confirm": ["title": "Объединить дубликаты?",
                                     "text": "Сохранится запись с наибольшим числом прослушиваний. История, лайки и записи плейлистов будут перенесены. Оригиналы файлов останутся на месте.",
                                     "button": "Объединить"]])
            return ["title": tracks.first?["title"] as? String ?? "Одинаковые файлы", "rows": rows]
        }
        if sections.isEmpty {
            let empty: Row = ["kind": "text", "title": "Дубликатов по содержимому не найдено",
                              "detail": "Одинаковые файлы объединяются без потери истории и лайков."]
            let section: Row = ["rows": [empty]]
            return ["title": "Дубликаты", "sections": [section]]
        }
        return ["title": "Дубликаты", "sections": sections]
    }

    private func statistics(_ request: Request) async throws -> Row {
        let data = try await request("GET", "/api/library/statistics", nil)
        let plays = data["plays"] as? Int ?? 0, streak = data["longestStreak"] as? Int ?? 0
        let topTracks = data["topTracks"] as? [Row] ?? [], topArtists = data["topArtists"] as? [Row] ?? []
        let summary: [Row] = [
            ["kind": "text", "title": "Прослушиваний", "value": String(plays)],
            ["kind": "text", "title": "Время", "value": Self.duration((data["playedMs"] as? Double) ?? 0)],
            ["kind": "text", "title": "Самая длинная серия", "value": "\(streak) \(Self.days(streak))"],
        ]
        var sections: [Row] = [["title": "За 30 дней", "rows": summary]]
        var trackRows: [Row] = topTracks.map { value -> Row in
            ["kind": "text", "title": value["title"] as? String ?? "", "detail": value["artist"] as? String ?? "",
             "value": String((value["plays"] as? Int) ?? 0)]
        }
        if trackRows.isEmpty { trackRows = [["kind": "text", "title": "Пока нет прослушиваний"] as Row] }
        sections.append(["title": "Топ треков", "rows": trackRows])
        var artistRows: [Row] = topArtists.map { value -> Row in
            let artist = (value["artist"] as? String) ?? ""
            return ["kind": "text", "title": artist.isEmpty ? "Неизвестный исполнитель" : artist,
                    "value": String((value["plays"] as? Int) ?? 0)]
        }
        if artistRows.isEmpty { artistRows = [["kind": "text", "title": "Пока нет прослушиваний"] as Row] }
        sections.append(["title": "Топ исполнителей", "rows": artistRows])
        return ["title": "Статистика", "sections": sections]
    }

    // MARK: actions

    func execute(_ name: String, _ args: Row, request: Request) async throws -> Result {
        guard Self.supports(name) else { throw Failure(message: "Неизвестное действие") }
        switch name {
        case "saveSmartPlaylist":
            // The form holds only the edited fields: start from the values the editor opened with.
            var fields = args["defaults"] as? [String: String] ?? [:]
            for (key, value) in args["form"] as? [String: String] ?? [:] { fields[key] = value }
            let name = (fields["name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw Failure(message: "Введите название плейлиста") }
            guard name.count <= 120 else { throw Failure(message: "Название не длиннее 120 символов") }
            let rules = try Self.rules(fields)
            var body: Row = ["name": name, "rules": rules]
            if let id = args["id"] as? String, !id.isEmpty { body["id"] = id }
            let saved = try await request("POST", "/api/smart-playlists", body)
            guard let id = saved["id"] as? String, !id.isEmpty else { throw Failure(message: "Не удалось сохранить плейлист") }
            return Result(path: "/smart-playlist/" + (try Self.component(id)))
        case "deleteSmartPlaylist":
            _ = try await request("DELETE", "/api/smart-playlists/" + (try Self.component(args["id"])), nil)
            return Result(path: "/smart-playlists")
        default: // mergeDuplicates
            guard let hash = args["hash"] as? String, hash.count == 64, hash.allSatisfy({ $0.isHexDigit }) else {
                throw Failure(message: "Группа дубликатов изменилась — обновите список")
            }
            let merged = try await request("POST", "/api/library/duplicates/merge", ["hash": hash])
            let removed = merged["filesRemoved"] as? Int ?? 0
            var message = "Записи объединены, история и лайки сохранены"
            if removed > 0 { message += "; освобождено файлов: \(removed)" }
            if let warnings = merged["cleanupWarnings"] as? [String], !warnings.isEmpty { message += ". " + warnings.joined(separator: " ") }
            return Result(mutated: true, message: message)
        }
    }

    /// Field values of the editor; an empty field never restricts the selection, as in the web version.
    private static func rules(_ form: [String: String]) throws -> Row {
        var rules: Row = [:]
        let genre = (form["genre"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !genre.isEmpty {
            guard genre.count <= 100 else { throw Failure(message: "Жанр не длиннее 100 символов") }
            rules["genre"] = genre
        }
        func number(_ key: String, _ title: String) throws -> Int? {
            let text = (form[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            guard let value = Int(text), (0...1_000_000).contains(value) else { throw Failure(message: "\(title): нужно целое число от 0") }
            return value
        }
        if let year = try number("yearFrom", "Год от") { rules["yearFrom"] = year }
        if let year = try number("yearTo", "Год до") { rules["yearTo"] = year }
        if let plays = try number("minPlays", "Прослушивания") { rules["minPlays"] = plays }
        if let days = try number("notPlayedDays", "Дней без прослушивания") { rules["notPlayedDays"] = days }
        let liked = (form["liked"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["да", "yes", "true", "1"].contains(liked) { rules["liked"] = true }
        else if ["нет", "no", "false", "0"].contains(liked) { rules["liked"] = false }
        else if !liked.isEmpty { throw Failure(message: "В любимом: укажите «да», «нет» или оставьте пусто") }
        if let from = rules["yearFrom"] as? Int, let to = rules["yearTo"] as? Int, from > to { throw Failure(message: "Год «от» больше года «до»") }
        return rules
    }

    static func summary(_ rules: Row) -> String {
        var parts: [String] = []
        if let genre = rules["genre"] as? String, !genre.isEmpty { parts.append("жанр «\(genre)»") }
        let from = rules["yearFrom"] as? Int, to = rules["yearTo"] as? Int
        if let from, let to { parts.append("\(from)–\(to)") }
        else if let from { parts.append("с \(from)") }
        else if let to { parts.append("до \(to)") }
        if let liked = rules["liked"] as? Bool { parts.append(liked ? "в любимом" : "не в любимом") }
        if let plays = rules["minPlays"] as? Int { parts.append("от \(plays) прослушиваний") }
        if let days = rules["notPlayedDays"] as? Int { parts.append("не слушал \(days) \(days == 1 ? "день" : (2...4).contains(days % 10) && !(12...14).contains(days % 100) ? "дня" : "дней")") }
        return parts.isEmpty ? "Без условий — вся медиатека" : parts.joined(separator: " · ")
    }
    private static func tracks(_ n: Int) -> String {
        let d = n % 10, h = n % 100
        return "\(n) " + (d == 1 && h != 11 ? "трек" : (2...4).contains(d) && !(12...14).contains(h) ? "трека" : "треков")
    }
    private static func number(_ value: Any?) -> String { (value as? Int).map { String($0) } ?? "" }
    private static func days(_ n: Int) -> String {
        let d = n % 10, h = n % 100
        return d == 1 && h != 11 ? "день" : (2...4).contains(d) && !(12...14).contains(h) ? "дня" : "дней"
    }
    private static func duration(_ ms: Double) -> String {
        let minutes = Int((ms / 60000).rounded())
        guard minutes >= 60 else { return "\(minutes) мин" }
        return "\(minutes / 60) ч \(String(format: "%02d", minutes % 60)) мин"
    }
}
