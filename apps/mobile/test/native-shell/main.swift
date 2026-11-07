import Foundation

let rows: [[String: Any]] = [
    ["id": "a", "title": "Ёлка", "artist": "Звери", "album": "Районы", "duration": 200.0, "reaction": 1, "cover": "/api/tracks/a/cover", "ok": true],
    ["id": "b", "title": "Night Call", "artist": "Kavinsky", "album": "OutRun", "duration": -4.0, "reaction": 0, "ok": false],
    ["title": "no id"],
]
let tracks = rows.compactMap(NativeTrack.init)
precondition(tracks.map(\.id) == ["a", "b"] && tracks[0].liked && !tracks[1].liked && !tracks[1].ok && tracks[1].duration == 0)
precondition(NativeSearchText.filter(tracks, "елка звер").map(\.id) == ["a"], "ё and case are ignored, every word must match")
precondition(NativeSearchText.filter(tracks, "  ").count == 2 && NativeSearchText.filter(tracks, "outrun KAV").map(\.id) == ["b"])
precondition(NativeSearchText.filter(tracks, "kavinsky звери").isEmpty)
print("Native shell: tracks and search-as-you-type")

let favoriteRows: [[String: Any]] = [
    ["id": "old", "reaction": 1, "likedAt": 100, "addedAt": 900],
    ["id": "new", "reaction": 1, "likedAt": 300, "addedAt": 700],
    ["id": "legacy", "reaction": 1, "addedAt": 200],
    ["id": "disliked", "reaction": -1, "likedAt": 1000],
    ["id": "neutral", "reaction": 0, "addedAt": 2000],
    ["id": "a-tie", "reaction": 1, "likedAt": 300],
]
let favorites = favoriteRows.compactMap(NativeTrack.init)
precondition(NativeTrack.favorites(favorites).map(\.id) == ["a-tie", "new", "legacy", "old"], "Favorites must follow like dates, not import completion")
precondition(NativeTrack.favorites(Array(favorites.reversed())).map(\.id) == ["a-tie", "new", "legacy", "old"])
print("Native shell: favorites newest first, legacy fallback and stable ties")

precondition(NativeRoute.screen("/") == .home && NativeRoute.screen("/more") == .more && NativeRoute.screen("/liked") == .liked)
precondition(NativeRoute.screen("/library") == .library && NativeRoute.screen("/library/albums") == .page && NativeRoute.screen("/search") == .search)
precondition(NativeRoute.screen("/album/x/y") == .page && NativeRoute.screen("/settings") == .page && NativeRoute.screen("/playlist/7") == .page)
precondition(NativeRoute.screen("/playlist/7/mix") == .web && NativeRoute.screen("/diagnostics/charts") == .web && NativeRoute.screen("/album/x") == .web)
precondition(NativeRoute.screen("/yandex") == .web && NativeRoute.screen("/library/tracks") == .library)
precondition(NativeRoute.tab("/wave") == .home && NativeRoute.tab("/playlist/1") == .library && NativeRoute.tab("/libraryx") == .home)
precondition(NativeRoute.tab("/catalog/artist/1") == .search && NativeRoute.tab("/library/albums") == .library && NativeRoute.tab("/liked") == .liked)
precondition(NativeTab.allCases.allSatisfy { NativeRoute.tab(NativeRoute.root($0)) == $0 && NativeRoute.screen(NativeRoute.root($0)) != .web })
print("Native shell: routes")

let described: [String: Any] = ["title": "Плейлист", "refresh": 0.4, "sections": [
    ["play": ["type": "playlist", "id": "p1", "label": "Плейлист"], "reorder": ["name": "reorderPlaylist", "args": ["id": "p1"]], "rows": [
        ["kind": "track", "id": "a", "remove": ["title": "Убрать", "symbol": "minus", "act": ["name": "removeFromPlaylist", "args": ["entry": 3]]]],
        ["kind": "item", "title": "Ёлка", "subtitle": "Звери", "cover": NSNull(), "path": "/album/x/y"],
        ["kind": "item", "title": "Job"],
        ["kind": "slider", "title": "Длина", "value": 12, "min": 8, "max": 48, "step": 1, "unit": "с", "act": ["name": "set"]],
        ["kind": "slider", "title": "Broken", "min": 4, "max": 4, "act": ["name": "set"]],
        ["kind": "choice", "title": "Стиль", "value": "auto", "options": [["auto", "Авто"], ["bad"]], "act": ["name": "set"]],
        ["kind": "url", "title": "http", "url": "http://example.com"],
        ["kind": "unknown"],
    ]],
]]
let page = NativePage(described)!
let pageRows = page.sections[0].rows
precondition(page.title == "Плейлист" && page.refresh == 1 && page.search == nil && page.sections[0].reorder?.name == "reorderPlaylist")
precondition(pageRows.count == 5, "invalid sliders, plain http links and unknown kinds are dropped")
if case .track(let id, let remove) = pageRows[0] { precondition(id == "a" && remove?.act.args["entry"] as? Int == 3) } else { preconditionFailure() }
if case .item(_, _, let cover, _, _, let path, _, _) = pageRows[1] { precondition(cover != nil && cover! == nil && path == "/album/x/y") } else { preconditionFailure() }
if case .item(_, _, let cover, _, _, _, _, _) = pageRows[2] { precondition(cover == nil, "no cover key: no picture") } else { preconditionFailure() }
if case .choice(_, _, let value, let options, _, _) = pageRows[4] { precondition(value == "auto" && options.count == 1) } else { preconditionFailure() }
precondition(pageRows[1].searchText == "елка звери" && pageRows[0].searchText == nil)
precondition(NativePage(["sections": []]) == nil)
print("Native shell: described pages")

var wave = NativeWave(["own": true, "yandex": false, "playing": true, "loading": false, "active": NSNull()])
precondition(wave.sources == [.own, .online] && wave.preferred == .own)
precondition(wave.button(.own) == ("Слушать волну", "waveform", true) && wave.button(.online).title == "Включить радио")
wave.active = .online
precondition(wave.button(.online) == ("Пауза", "pause.fill", true) && wave.preferred == .online)
wave.playing = false; wave.loading = true
precondition(wave.button(.online).title == "Продолжить" && wave.button(.own) == ("Подбираю…", "waveform", false))
precondition(!NativeWave([:]).button(.yandex).enabled && NativeWave(["yandex": true]).preferred == .yandex && NativeWave([:]).preferred == .online)
print("Native shell: wave button")

let ui = NativeUiState(["path": "/liked", "loaded": true, "overlay": false, "wave": ["own": true],
    "now": ["id": "a", "title": "Ёлка", "artist": "Звери", "playing": true, "label": "Медиатека"],
    "toast": ["id": 3, "text": "Добавлено в очередь", "kind": "info"], "preparing": NSNull()])
precondition(ui.path == "/liked" && ui.loaded && ui.now?.title == "Ёлка" && ui.now?.playing == true && ui.toast == NativeToast(id: 3, text: "Добавлено в очередь", error: false))
precondition(ui.preparing == nil && ui.wave.own && NativeUiState([:]) == NativeUiState())
print("Native shell: page state")

precondition(NativeText.tracks(1) == "1 трек" && NativeText.tracks(3) == "3 трека" && NativeText.tracks(11) == "11 треков")
precondition(NativeText.tracks(22) == "22 трека" && NativeText.tracks(105) == "105 треков" && NativeText.tracks(0) == "0 треков")
precondition(NativeText.greeting(hour: 3) == "Доброй ночи" && NativeText.greeting(hour: 20) == "Добрый вечер")
print("Native shell: text")
