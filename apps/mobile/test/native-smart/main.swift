import Foundation

// Self-check for NativeSmartState.swift: the smart playlist list/detail/editor, duplicate merging and
// statistics pages without a page description. Build and run by .github/workflows/ios.yml.

func fail(_ message: String) -> Never {
    fatalError("FAIL: " + message)
}
func check(_ condition: Bool, _ message: String) {
    if !condition { fail(message) }
}

let id = "11111111-2222-3333-4444-555555555555"
let playlistRows: [[String: Any]] = [
    ["id": id, "name": "Любимый рок", "rules": ["genre": "rock", "yearFrom": 1990, "yearTo": 1999, "liked": true, "minPlays": 5] as [String: Any]],
    ["id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "name": "Свежие", "rules": [String: Any]()],
]
let detailRow: [String: Any] = ["id": id, "name": "Любимый рок", "rules": ["genre": "rock"] as [String: Any], "tracks": ["t1", "t2"]]
let duplicateGroups: [[String: Any]] = [[
    "hash": String(repeating: "a", count: 64), "count": 2,
    "tracks": [
        ["id": "t1", "title": "Song", "artist": "Artist", "playCount": 7],
        ["id": "t2", "title": "Song", "artist": "Artist", "playCount": 2],
    ] as [[String: Any]],
]]
let statistics: [String: Any] = [
    "plays": 42, "playedMs": 3_900_000.0, "longestStreak": 3,
    "topTracks": [["id": "t1", "title": "Song", "artist": "Artist", "plays": 9] as [String: Any]],
    "topArtists": [["artist": "Artist", "plays": 9] as [String: Any]],
]

var requests: [(String, String, [String: Any]?)] = []
let state = NativeSmartState()
let request: NativeSmartState.Request = { method, path, body in
    requests.append((method, path, body))
    switch (method, path) {
    case ("GET", "/api/smart-playlists"): return ["playlists": playlistRows]
    case ("POST", "/api/smart-playlists"): return ["id": "new-id"]
    case ("POST", "/api/library/duplicates/merge"): return ["filesRemoved": 1, "cleanupWarnings": ["Не удалось удалить старый файл"]]
    case ("GET", "/api/library/duplicates"): return ["groups": duplicateGroups]
    case ("GET", "/api/library/statistics"): return statistics
    case ("GET", let path) where path.hasPrefix("/api/smart-playlists/"): return detailRow
    case ("DELETE", _): return ["ok": true]
    default: throw NativeSmartState.Failure(message: "unexpected \(method) \(path)")
    }
}

// Routes the native shell must own.
check(NativeSmartState.handles("/smart-playlists"), "smart playlists list is handled")
check(NativeSmartState.handles("/smart-playlist/new"), "new smart playlist is handled")
check(NativeSmartState.handles("/smart-playlist/\(id)"), "smart playlist detail is handled")
check(NativeSmartState.handles("/smart-playlist/\(id)/edit"), "smart playlist editor is handled")
check(NativeSmartState.handles("/duplicates"), "duplicates are handled")
check(NativeSmartState.handles("/statistics"), "statistics are handled")
check(!NativeSmartState.handles("/settings"), "settings stay with their own screen")
check(!NativeSmartState.handles("/smart-playlist/\(id)/other"), "unknown smart sub-pages fall back")
check(!NativeSmartState.handles("/duplicates/x"), "duplicate sub-pages fall back")
check(NativeSmartState.supports("saveSmartPlaylist") && NativeSmartState.supports("deleteSmartPlaylist") && NativeSmartState.supports("mergeDuplicates"), "actions are owned")
check(!NativeSmartState.supports("createPlaylist"), "unrelated actions stay with the page")

// Path ids cannot escape the route.
do { _ = try NativeSmartState.component("a/b"); fail("slash id accepted") } catch {}
do { _ = try NativeSmartState.component(""); fail("empty id accepted") } catch {}
do { _ = try NativeSmartState.component(String(repeating: "a", count: 101)); fail("long id accepted") } catch {}
check((try? NativeSmartState.component(id)) == id, "uuid id passes")

// MARK: list

let listed = try await state.page("/smart-playlists", request: request)
check(listed["title"] as? String == "Умные плейлисты", "list title")
let listSections = listed["sections"] as? [[String: Any]] ?? []
check(listSections.count == 2, "list has the create row and one saved section")
let createRow = (listSections.first?["rows"] as? [[String: Any]])?.first ?? [:]
check(createRow["kind"] as? String == "link" && createRow["path"] as? String == "/smart-playlist/new", "create row opens the editor")
let savedRows = listSections.last?["rows"] as? [[String: Any]] ?? []
check(savedRows.count == 2, "two saved playlists")
check(savedRows[0]["path"] as? String == "/smart-playlist/\(id)", "saved row path")
check((savedRows[0]["subtitle"] as? String ?? "").contains("жанр «rock»"), "saved row summary shows the rules")
check((savedRows[0]["subtitle"] as? String ?? "").contains("1990–1999"), "year range summary")
check((savedRows[0]["subtitle"] as? String ?? "").contains("в любимом"), "liked summary")
check(savedRows[1]["subtitle"] == nil, "empty rules have no summary")

// MARK: editor

let created = try await state.page("/smart-playlist/new", request: request)
check(created["title"] as? String == "Новый умный плейлист", "new editor title")
let createdSections = created["sections"] as? [[String: Any]] ?? []
let fields = createdSections.first?["rows"] as? [[String: Any]] ?? []
check(fields.count == 7 && fields.allSatisfy { $0["kind"] as? String == "field" }, "seven rule fields")
check(Set(fields.compactMap { $0["key"] as? String }) == ["name", "genre", "yearFrom", "yearTo", "liked", "minPlays", "notPlayedDays"], "field keys")
check((fields.first?["value"] as? String) == "", "new editor starts empty")
let createdActions = createdSections.last?["rows"] as? [[String: Any]] ?? []
check(createdActions.count == 1 && (createdActions.first?["act"] as? [String: Any])?["name"] as? String == "saveSmartPlaylist", "new editor saves")

let edited = try await state.page("/smart-playlist/\(id)/edit", request: request)
check(edited["title"] as? String == "Правила плейлиста", "edit title")
let editedFields = ((edited["sections"] as? [[String: Any]])?.first?["rows"] as? [[String: Any]]) ?? []
check(editedFields.first?["value"] as? String == "Любимый рок", "name is prefilled")
check(editedFields.first(where: { $0["key"] as? String == "genre" })?["value"] as? String == "rock", "genre is prefilled")
check(editedFields.first(where: { $0["key"] as? String == "liked" })?["value"] as? String == "нет", "unknown liked stays empty")
let editedActions = ((edited["sections"] as? [[String: Any]])?.last?["rows"] as? [[String: Any]]) ?? []
check(editedActions.count == 2, "edit has save and delete")
check((editedActions.last?["act"] as? [String: Any])?["name"] as? String == "deleteSmartPlaylist", "delete action")
check((editedActions.last?["confirm"] as? [String: Any])?["title"] as? String == "Удалить умный плейлист?", "delete confirmation")
let saveArgs = (editedActions.first?["act"] as? [String: Any])?["args"] as? [String: Any]
check((saveArgs?["defaults"] as? [String: String])?["name"] == "Любимый рок", "save carries the prefilled fields")
check((saveArgs?["defaults"] as? [String: String])?["genre"] == "rock", "save carries the prefilled genre")

// MARK: detail

let detail = try await state.page("/smart-playlist/\(id)", request: request)
check(detail["title"] as? String == "Любимый рок", "detail title")
let detailSections = detail["sections"] as? [[String: Any]] ?? []
check(detailSections.count == 2, "detail header and tracks")
let play = detailSections.first?["play"] as? [String: Any] ?? [:]
check(play["type"] as? String == "playlist" && play["id"] as? String == id, "detail play context")
let headerRows = detailSections.first?["rows"] as? [[String: Any]] ?? []
check(headerRows.count == 4, "detail header rows")
check((headerRows.first?["act"] as? [String: Any])?["name"] as? String == "playAll", "detail play button")
let playArgs = (headerRows.first?["act"] as? [String: Any])?["args"] as? [String: Any]
check((playArgs?["ids"] as? [String])?.count == 2, "play button ids")
check(((headerRows[1]["act"] as? [String: Any])?["args"] as? [String: Any])?["shuffle"] as? Bool == true, "shuffle button")
let trackRows = detailSections.last?["rows"] as? [[String: Any]] ?? []
check(trackRows.count == 2 && trackRows.allSatisfy { $0["kind"] as? String == "track" }, "detail track rows")
check((detailSections.last?["play"] as? [String: Any])?["label"] as? String == "Любимый рок", "track section label")

// MARK: save

requests.removeAll()
let saved = try await state.execute("saveSmartPlaylist", ["form": [
    "name": "  Свежий  ", "genre": " rock ", "yearFrom": "1990", "yearTo": "1999",
    "liked": "да", "minPlays": "5", "notPlayedDays": "  ",
]], request: request)
check(saved.path == "/smart-playlist/new-id", "save returns the new playlist path")
check(requests.count == 1 && requests[0].0 == "POST" && requests[0].1 == "/api/smart-playlists", "save calls the API")
let body = requests.first?.2 ?? [:]
check(body["name"] as? String == "Свежий", "name is trimmed")
check(body["id"] == nil, "a new playlist sends no id")
let rules = body["rules"] as? [String: Any] ?? [:]
check(rules["genre"] as? String == "rock", "genre rule")
check(rules["yearFrom"] as? Int == 1990 && rules["yearTo"] as? Int == 1999, "year rules")
check(rules["liked"] as? Bool == true, "liked rule")
check(rules["minPlays"] as? Int == 5, "plays rule")
check(rules["notPlayedDays"] == nil, "empty fields never restrict")

requests.removeAll()
_ = try await state.execute("saveSmartPlaylist", ["id": id, "form": ["name": "Новое имя", "liked": "нет"]], request: request)
check(requests.first?.2?["id"] as? String == id, "editing sends the playlist id")
check((requests.first?.2?["rules"] as? [String: Any])?["liked"] as? Bool == false, "liked no")

requests.removeAll()
_ = try await state.execute("saveSmartPlaylist", [
    "defaults": ["name": "Старое имя", "genre": "rock"], "form": ["yearFrom": "2000"]
], request: request)
let mergedBody = requests.first?.2 ?? [:]
check(mergedBody["name"] as? String == "Старое имя", "unchanged fields keep their values")
let mergedRules = mergedBody["rules"] as? [String: Any] ?? [:]
check(mergedRules["genre"] as? String == "rock" && mergedRules["yearFrom"] as? Int == 2000, "edited fields win over defaults")

for bad in [
    ["name": "   "],
    ["name": "Плейлист", "yearFrom": "abc"],
    ["name": "Плейлист", "yearFrom": "2000", "yearTo": "1990"],
    ["name": "Плейлист", "liked": "может быть"],
    ["name": "Плейлист", "minPlays": "-1"],
] as [[String: String]] {
    do { _ = try await state.execute("saveSmartPlaylist", ["form": bad], request: request); fail("invalid rules accepted: \(bad)") } catch {}
}

// MARK: delete and merge

requests.removeAll()
let deleted = try await state.execute("deleteSmartPlaylist", ["id": id], request: request)
check(deleted.path == "/smart-playlists", "delete returns to the list")
check(requests.first?.0 == "DELETE" && requests.first?.1 == "/api/smart-playlists/\(id)", "delete path")
do { _ = try await state.execute("deleteSmartPlaylist", ["id": "a/b"], request: request); fail("unsafe delete id accepted") } catch {}

requests.removeAll()
let hash = String(repeating: "a", count: 64)
let merged = try await state.execute("mergeDuplicates", ["hash": hash], request: request)
check(merged.mutated, "merge changes the library")
check(requests.first?.1 == "/api/library/duplicates/merge" && requests.first?.2?["hash"] as? String == hash, "merge body")
check((merged.message ?? "").contains("объединены"), "merge message")
check((merged.message ?? "").contains("Не удалось удалить старый файл"), "cleanup warnings are shown")
do { _ = try await state.execute("mergeDuplicates", ["hash": "short"], request: request); fail("invalid hash accepted") } catch {}
do { _ = try await state.execute("mergeDuplicates", ["hash": String(repeating: "z", count: 64)], request: request); fail("non-hex hash accepted") } catch {}

// MARK: duplicates and statistics

let duplicates = try await state.page("/duplicates", request: request)
check(duplicates["title"] as? String == "Дубликаты", "duplicates title")
let duplicateSections = duplicates["sections"] as? [[String: Any]] ?? []
check(duplicateSections.count == 1, "one duplicate group")
let duplicateRows = duplicateSections.first?["rows"] as? [[String: Any]] ?? []
check(duplicateRows.count == 3, "two tracks and a merge button")
check(duplicateRows[0]["value"] as? String == "7 прослушиваний", "play count value")
let mergeButton = duplicateRows.last ?? [:]
check(mergeButton["kind"] as? String == "button" && (mergeButton["act"] as? [String: Any])?["name"] as? String == "mergeDuplicates", "merge button")
check(((mergeButton["act"] as? [String: Any])?["args"] as? [String: Any])?["hash"] as? String == hash, "merge button hash")

let emptyRequest: NativeSmartState.Request = { method, path, _ in
    switch (method, path) {
    case ("GET", "/api/library/duplicates"): return ["groups": [[String: Any]]()]
    case ("GET", "/api/library/statistics"): return ["plays": 0, "playedMs": 0.0, "longestStreak": 0, "topTracks": [[String: Any]](), "topArtists": [[String: Any]]()]
    default: throw NativeSmartState.Failure(message: "unexpected")
    }
}
let emptyDuplicates = try await state.page("/duplicates", request: emptyRequest)
check(((emptyDuplicates["sections"] as? [[String: Any]])?.first?["rows"] as? [[String: Any]])?.first?["title"] as? String == "Дубликатов по содержимому не найдено", "empty duplicates message")

let stats = try await state.page("/statistics", request: request)
check(stats["title"] as? String == "Статистика", "statistics title")
let statsSections = stats["sections"] as? [[String: Any]] ?? []
check(statsSections.count == 3, "three statistics sections")
let summary = statsSections.first?["rows"] as? [[String: Any]] ?? []
check(summary.first(where: { $0["title"] as? String == "Прослушиваний" })?["value"] as? String == "42", "plays count")
check(summary.first(where: { $0["title"] as? String == "Время" })?["value"] as? String == "1 ч 05 мин", "listening time")
check(summary.first(where: { $0["title"] as? String == "Самая длинная серия" })?["value"] as? String == "3 дня", "streak")
check(((statsSections[1]["rows"] as? [[String: Any]])?.first?["value"] as? String) == "9", "top track plays")
check(((statsSections[2]["rows"] as? [[String: Any]])?.first?["title"] as? String) == "Artist", "top artist")

let emptyStats = try await state.page("/statistics", request: emptyRequest)
check(((emptyStats["sections"] as? [[String: Any]])?[1]["rows"] as? [[String: Any]])?.first?["title"] as? String == "Пока нет прослушиваний", "empty statistics message")

print("Native smart playlists: pages, rules, delete, duplicate merge and statistics passed")
