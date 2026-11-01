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

precondition(NativeRoute.screen("/") == .home && NativeRoute.screen("/more") == .more && NativeRoute.screen("/liked") == .liked)
precondition(NativeRoute.screen("/library") == .library && NativeRoute.screen("/library/albums") == .web && NativeRoute.screen("/search") == .search)
precondition(NativeRoute.screen("/album/x/y") == .web && NativeRoute.screen("/settings") == .web)
precondition(NativeRoute.tab("/wave") == .home && NativeRoute.tab("/playlist/1") == .library && NativeRoute.tab("/libraryx") == .home)
precondition(NativeRoute.tab("/catalog/artist/1") == .search && NativeRoute.tab("/library/albums") == .library && NativeRoute.tab("/liked") == .liked)
precondition(NativeTab.allCases.allSatisfy { NativeRoute.tab(NativeRoute.root($0)) == $0 && NativeRoute.screen(NativeRoute.root($0)) != .web })
print("Native shell: routes")

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
