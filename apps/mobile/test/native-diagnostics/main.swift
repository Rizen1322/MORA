import Foundation

// Self-check for NativeDiagnosticsState.swift: engine health, the transition log with plan details and both
// tracks' analysis, without a page description. Build and run by .github/workflows/ios.yml.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) {
    if !condition { fail(message) }
}
func rows(_ section: [String: Any]) -> [[String: Any]] { section["rows"] as? [[String: Any]] ?? [] }
func find(_ list: [[String: Any]], _ title: String) -> [String: Any]? { list.first { $0["title"] as? String == title } }
func options(_ list: [[String: Any]]) -> [[String]] {
    (list.first { $0["kind"] as? String == "choice" }?["options"] as? [[String]]) ?? []
}

let names = ["t1": "Alpha", "t2": "Beta", "t3": "Gamma", "t4": "Delta"]
let health: [String: Any] = [
    "ok": true, "ffmpeg": "ffmpeg", "decoder": "native", "analyzer": "rust", "planner": "swift",
    "analysis": ["queued": 0, "running": 0, "workers": 2] as [String: Any],
    "pcmCacheBytes": 3_145_728.0, "pcmCacheLimit": 52_428_800.0, "tracks": 109,
    "stems": ["available": true] as [String: Any],
]
let log: [String: Any] = ["items": [
    ["id": 7, "fromTrackId": "t1", "toTrackId": "t2", "executedAt": 1_700_000_000_000.0,
     "plan": ["method": "beatmatch_blend", "fromTrackId": "t1", "toTrackId": "t2", "aExit": 120.5, "bEntry": 8.25,
              "confidence": 0.91, "duration": 3.5, "gap": 0.0,
              "beatAlign": ["bpmA": 128.0, "bpmB": 126.5, "relation": 1.012, "overlapBeats": 4, "phraseAligned": true] as [String: Any]
             ] as [String: Any]] as [String: Any],
    ["id": 8, "fromTrackId": "t3", "toTrackId": "t4", "executedAt": 1_700_000_100_000.0,
     "plan": ["method": "fallback_crossfade", "fromTrackId": "t3", "toTrackId": "t4", "aExit": 100.0, "bEntry": 0.0,
              "confidence": 0.4, "duration": 2.0, "gap": 0.5, "fallbackReason": "analysis_pending"] as [String: Any]] as [String: Any],
] as [[String: Any]]]
let analyses: [String: [String: Any]] = [
    "t1": ["status": "done", "bpm": 128.0, "camelot": "8A", "energy": 0.72, "lufs": -9.5, "truePeak": -1.0] as [String: Any],
    "t2": ["status": "done", "bpm": 126.5, "keyName": "Gm", "energy": 0.5] as [String: Any],
    "t3": ["status": "error", "error": "decode failed"] as [String: Any],
    "t4": ["status": "running", "progress": 0.4] as [String: Any],
]

let state = NativeDiagnosticsState()
let request: NativeDiagnosticsState.Request = { method, path, _ in
    if method == "GET", path == "/api/health" { return health }
    if method == "GET", path == "/api/automix/log?limit=30" { return log }
    if method == "GET", path.hasPrefix("/api/tracks/") {
        let id = path.replacingOccurrences(of: "/api/tracks/", with: "").replacingOccurrences(of: "/analysis", with: "")
        guard let analysis = analyses[id] else { throw NativeDiagnosticsState.Failure(message: "unknown track") }
        return ["status": "ok", "analysis": analysis]
    }
    throw NativeDiagnosticsState.Failure(message: "unexpected \(method) \(path)")
}

check(NativeDiagnosticsState.handles("/diagnostics"), "diagnostics is handled")
check(!NativeDiagnosticsState.handles("/settings"), "settings stay with their own screen")
check(NativeDiagnosticsState.supports("diagSelect") && !NativeDiagnosticsState.supports("playAll"), "only the selection is owned")

// MARK: latest transition

let page = try await state.page("/diagnostics", name: { names[$0] }, automix: true, request: request)
check(page["title"] as? String == "Диагностика AutoMix", "title")
let sections = page["sections"] as? [[String: Any]] ?? []
check(sections.count == 3, "checks, transitions and technical details")
let checks = rows(sections[0])
check(sections[0]["title"] as? String == "Всё в порядке", "healthy engine heading")
check(checks.contains { $0["title"] as? String == "Все треки проанализированы." }, "analysis health")
check(checks.contains { ($0["title"] as? String ?? "").contains("уверенность 91 %") }, "plan confidence check")

let transitions = rows(sections[1])
let choice = transitions.first { $0["kind"] as? String == "choice" } ?? [:]
check(choice["value"] as? String == "latest", "latest transition is selected")
let listed = options(transitions)
check(listed.count == 3 && listed[0][0] == "latest", "latest plus two logged transitions")
check(listed[1][0] == "7" && listed[2][0] == "8", "log ids are the option values")
check((listed[1][1]).contains("Alpha") && (listed[1][1]).contains("Beta"), "option names come from the library")
check(find(transitions, "Битматч") != nil, "method is localized")
check((find(transitions, "Выход из трека")?["value"] as? String) == "2:00", "exit time")
check((find(transitions, "Вход в следующий")?["value"] as? String) == "0:08", "entry time")
check((find(transitions, "Уверенность")?["value"] as? String) == "91 %", "confidence")
check((find(transitions, "Длительность")?["value"] as? String) == "3.50 с", "duration")
check((find(transitions, "Темп")?["value"] as? String)?.contains("BPM") == true, "tempo")
check((find(transitions, "Наложение")?["value"] as? String) == "4 доли", "overlap beats")
check((find(transitions, "Наложение")?["detail"] as? String) == "по фразам", "phrase alignment")

let alpha = find(transitions, "Анализ: Alpha") ?? [:]
check((alpha["value"] as? String ?? "").contains("128") && (alpha["value"] as? String ?? "").contains("8A"), "analysis summary")
check((alpha["detail"] as? String ?? "").contains("энергия") && (alpha["detail"] as? String ?? "").contains("LUFS"), "analysis detail")
check(find(transitions, "Анализ: Beta") != nil, "both plan tracks are analysed")

let preview = transitions.first { $0["kind"] as? String == "button" } ?? [:]
check((preview["act"] as? [String: Any])?["name"] as? String == "previewPair", "preview button")
let args = (preview["act"] as? [String: Any])?["args"] as? [String: Any]
check(args?["from"] as? String == "t1" && args?["to"] as? String == "t2", "preview pair ids")
check(transitions.contains { ($0["path"] as? String) == "/diagnostics/charts" }, "charts stay on the web page")

let technical = rows(sections[2])
check((find(technical, "Анализ")?["value"] as? String) == "потоков 2", "analysis workers")
check((find(technical, "Медиатека")?["value"] as? String) == "109 треков", "library size")
check((find(technical, "Кэш звука")?["value"] as? String ?? "").contains("МБ"), "cache size")
check((find(technical, "Разделение вокала")?["value"] as? String) == "доступно", "stem separation")

// MARK: another transition

_ = try await state.execute("diagSelect", ["value": "8"], request: request)
let selected = try await state.page("/diagnostics", name: { names[$0] }, automix: true, request: request)
let selectedTransitions = rows((selected["sections"] as? [[String: Any]])?[1] ?? [:])
check((selectedTransitions.first { $0["kind"] as? String == "choice" }?["value"] as? String) == "8", "selection is remembered")
check(find(selectedTransitions, "Резервный кроссфейд") != nil, "fallback method")
let selectedChecks = rows((selected["sections"] as? [[String: Any]])?[0] ?? [:])
check(find(selectedChecks, "Переход упрощён: analysis_pending") != nil, "fallback reason is shown")
check((find(selectedTransitions, "Длительность")?["value"] as? String) == "2.00 с, пауза 0.50 с", "gap is shown")
let gamma = find(selectedTransitions, "Анализ: Gamma") ?? [:]
check(gamma["tone"] as? String == "warn" && (gamma["detail"] as? String == "decode failed"), "analysis error")
let delta = find(selectedTransitions, "Анализ: Delta") ?? [:]
check((delta["value"] as? String ?? "").contains("40"), "running analysis progress")

// MARK: empty log and unhealthy engine

let emptyRequest: NativeDiagnosticsState.Request = { method, path, _ in
    if path == "/api/health" { return ["ok": true, "ffmpeg": "ffmpeg", "analyzer": "rust", "planner": "swift",
                                       "analysis": ["queued": 2, "running": 1, "workers": 2] as [String: Any], "tracks": 0] }
    if path == "/api/automix/log?limit=30" { return ["items": [[String: Any]]()] }
    throw NativeDiagnosticsState.Failure(message: "unexpected")
}
let empty = try await state.page("/diagnostics", name: { _ in nil }, automix: false, request: emptyRequest)
let emptySections = empty["sections"] as? [[String: Any]] ?? []
let emptyTransitions = rows(emptySections[1])
check(emptyTransitions.contains { $0["title"] as? String == "Переходов пока нет" }, "empty transition log")
check(!emptyTransitions.contains { $0["kind"] as? String == "choice" }, "no selection without transitions")
let emptyChecks = rows(emptySections[0])
check(emptyChecks.contains { ($0["title"] as? String ?? "").contains("Анализируем треки: осталось 3") }, "pending analysis")
check(emptyChecks.contains { ($0["title"] as? String ?? "").contains("AutoMix выключен") }, "AutoMix off notice")

let offline: NativeDiagnosticsState.Request = { _, path, _ in
    if path == "/api/automix/log?limit=30" { return ["items": [[String: Any]]()] }
    throw NativeDiagnosticsState.Failure(message: "offline")
}
let noServer = try await state.page("/diagnostics", name: { _ in nil }, automix: true, request: offline)
check(rows((noServer["sections"] as? [[String: Any]])?[0] ?? [:]).contains { ($0["title"] as? String ?? "").contains("Нет связи") }, "server warning")

do { _ = try await state.execute("diagSelect", ["value": ""], request: request); fail("empty selection accepted") } catch {}
do { _ = try await state.execute("other", [:], request: request); fail("unknown action accepted") } catch {}

print("Native diagnostics: health, transition plans, track analysis, empty log and offline states passed")
