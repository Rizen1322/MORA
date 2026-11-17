import Foundation

// Self-check for NativeWaveState.swift: the wave page and its settings sheet built from the JSC API,
// with the queue slice and station index the page sends. Run by .github/workflows/ios.yml.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func rows(_ section: [String: Any]) -> [[String: Any]] { section["rows"] as? [[String: Any]] ?? [] }
func sections(_ page: [String: Any]) -> [[String: Any]] { page["sections"] as? [[String: Any]] ?? [] }
func row(_ list: [[String: Any]], _ title: String) -> [String: Any]? { list.first { $0["title"] as? String == title } }

let state = NativeWaveState()
var requests: [(String, String, [String: Any]?)] = []
var settings: [String: Any] = ["wave": ["mood": "calm", "diversity": "discover", "mode": "mix", "yandexSeeds": ["seed-a"]]]
let request: NativeWaveState.Request = { method, path, body in
    requests.append((method, path, body))
    if path == "/api/settings" { return settings }
    if path == "/api/providers/yandex/wave/settings" {
        return ["groups": [["name": "Настроение", "values": [["seed": "seed-a", "name": "Спокойно"], ["seed": "seed-b", "name": "Бодро"]]]]]
    }
    if method == "PUT" { return ["ok": true] }
    throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "unexpected \(method) \(path)"])
}

check(NativeWaveState.handles("/wave"), "wave route")
check(!NativeWaveState.handles("/wave/settings"), "the sheet is not the wave route")
check(NativeWaveState.supports("set") && NativeWaveState.supports("yandexSeed") && !NativeWaveState.supports("react"), "only tuning writes are owned")

// MARK: settings sheet

let own = try await state.settingsPage("own", request: request)
check(own["title"] as? String == "Настроить волну", "settings title")
let ownRows = rows(sections(own)[0])
check(ownRows.count == 3, "energy, character and mix toggle")
check((row(ownRows, "Энергия")?["value"] as? String) == "calm", "energy value from settings")
check((row(ownRows, "Характер")?["value"] as? String) == "discover", "character value from settings")
check((row(ownRows, "Для микса")?["on"] as? Bool) == true, "mix toggle from settings")
check((row(ownRows, "Энергия")?["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["key"] as? String } == "mood", "energy writes mood")

let online = try await state.settingsPage("online", request: request)
check(row(rows(sections(online)[0]), "Для микса")?["detail"] as? String == "Близкие BPM и тональности получают приоритет, когда есть анализ.", "online mix detail")

let yandex = try await state.settingsPage("yandex", request: request)
let yandexRows = rows(sections(yandex)[0])
check(yandexRows.count == 1, "one yandex group")
check((yandexRows[0]["value"] as? String) == "seed-a", "selected yandex seed")
check((yandexRows[0]["options"] as? [[String]])?.count == 3, "default plus two seeds")
let seedAct = yandexRows[0]["act"] as? [String: Any]
check((seedAct?["args"] as? [String: Any])?["group"] as? [String] == ["seed-a", "seed-b"], "seed group members")

do { _ = try await state.settingsPage("bogus", request: request); fail("unknown source accepted") } catch {}

// MARK: wave page

let now = ["id": "t1", "title": "One", "artist": "Artist", "cover": "/api/covers/1", "playing": true, "entryId": "e1"] as [String: Any]
let ui = NativeUiState([
    "wave": ["own": true, "yandex": true, "active": "own", "playing": true, "loading": false] as [String: Any],
    "now": now,
    "queue": [["entryId": "e1", "trackId": "t1"], ["entryId": "e2", "trackId": "t2"], ["entryId": "e3", "trackId": "t3"]],
    "station": ["index": 5, "count": 9] as [String: Any],
])
check(ui.queue.count == 3 && ui.stationIndex == 5 && ui.stationCount == 9, "queue slice and station position")
let byId = [
    "t1": NativeTrack(["id": "t1", "title": "One", "artist": "Artist", "cover": "/api/covers/1"])!,
    "t2": NativeTrack(["id": "t2", "title": "Two", "artist": "Artist", "cover": "/api/covers/2"])!,
    "t3": NativeTrack(["id": "t3", "title": "Three", "artist": "Artist"])!,
]

let page = try await state.page(source: nil, ui: ui, byId: byId, libraryCount: 9, request: request)
check(page["title"] as? String == "Моя волна", "wave title")
let waveSections = sections(page)
check(waveSections.count == 4, "stage, tuning, now and next")
let stage = rows(waveSections[0])
check((stage.first?["value"] as? String) == "own", "own source is selected")
check(row(stage, "Пауза") != nil, "playing wave offers pause")
check(row(stage, "Другой трек") != nil, "playing wave offers another track")
check((waveSections[1]["title"] as? String) == "Настроить звучание", "tuning section")
check((rows(waveSections[2]).first?["title"] as? String) == "One", "now playing row")
check((rows(waveSections[2]).first?["subtitle"] as? String)?.contains("Моя коллекция") == true, "now playing source")
check(rows(waveSections[2]).first?["cover"] as? String == "/api/covers/1", "now playing cover")
let nextRows = rows(waveSections[3])
check(nextRows.count == 3, "two upcoming tracks and the queue button")
check((nextRows[0]["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["index"] as? Int } == 6, "jump uses the absolute station index")
check((nextRows[1]["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["index"] as? Int } == 7, "next index")
check(row(nextRows, "Вся очередь") != nil, "the full queue is offered")
check((waveSections[3]["footer"] as? String) == "3 трека", "remaining tracks count")

// MARK: inactive and unavailable wave

let idle = try await state.page(source: nil, ui: NativeUiState(), byId: byId, libraryCount: 9, request: request)
check(row(rows(sections(idle)[0]), "Поймать волну") != nil, "idle wave offers to start")
check((sections(idle)[3]["footer"] as? String) == "Запустите волну — здесь появятся следующие треки вашей подборки.", "idle next footer")

let empty = try await state.page(source: nil, ui: NativeUiState(), byId: byId, libraryCount: 0, request: request)
check(row(rows(sections(empty)[0]), "Поймать волну")?["disabled"] as? Bool == true, "empty library disables the wave")
check(rows(sections(empty)[0]).contains { ($0["path"] as? String) == "/library" }, "empty library links to the library")

let loadingUi = NativeUiState(["wave": ["own": true, "loading": true] as [String: Any]])
let loading = try await state.page(source: nil, ui: loadingUi, byId: byId, libraryCount: 3, request: request)
check((loading["refresh"] as? NSNumber)?.intValue == 2, "loading wave asks the page to refresh")

// source preference: the wave link asks for yandex but the provider is off
let requested = try await state.page(source: "yandex", ui: NativeUiState(), byId: byId, libraryCount: 3, request: request)
check((rows(sections(requested)[0]).first?["value"] as? String) == "own", "yandex without a provider falls back to own")

// MARK: tuning writes

requests.removeAll()
try await state.execute("set", ["group": "wave", "key": "mood", "value": "calm"], request: request)
check(requests.count == 1 && requests[0].0 == "PUT" && requests[0].1 == "/api/settings", "wave setting endpoint")
check((requests[0].2?["wave"] as? [String: Any])?["mood"] as? String == "calm", "wave setting body")

try await state.execute("set", ["group": "wave", "key": "mode", "value": true, "map": ["true": "mix", "false": "normal"]], request: request)
check((requests.last?.2?["wave"] as? [String: Any])?["mode"] as? String == "mix", "toggle maps to the settings value")

try await state.execute("yandexSeed", ["group": ["seed-a"], "value": "seed-b"], request: request)
check((requests.last?.2?["wave"] as? [String: Any])?["yandexSeeds"] as? [String] == ["seed-b"], "yandex seed replaces its group")

check(!state.consumeChange(), "no tuning change before any write")
try await state.execute("set", ["group": "wave", "key": "diversity", "value": "discover"], request: request)
check(state.consumeChange(), "a tuning write is reported once")
check(!state.consumeChange(), "the tuning change is consumed")
do { try await state.execute("set", ["group": "player", "key": "mood", "value": "calm"], request: request); fail("foreign group accepted") } catch {}
do { try await state.execute("unknown", [:], request: request); fail("unknown action accepted") } catch {}
check(!state.consumeChange(), "a rejected write is not a change")

print("Native wave: settings sheet, page from the queue slice, inactive and empty states, tuning writes passed")
