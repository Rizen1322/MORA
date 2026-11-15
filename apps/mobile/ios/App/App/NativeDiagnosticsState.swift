import Foundation

/// AutoMix diagnostics: engine health, the transition log with its plan and both tracks' analysis.
/// Rows are drawn by `NativePageView`; every request goes straight to the JSC API.
final class NativeDiagnosticsState {
    typealias Row = [String: Any]
    typealias Request = (String, String, Row?) async throws -> Row
    struct Result { var mutated = false; var path: String? = nil; var message: String? = nil }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// `latest` or a transition id from the log; survives page reloads inside the screen.
    private(set) var selection = "latest"

    static func handles(_ path: String) -> Bool { path == "/diagnostics" }
    static func supports(_ name: String) -> Bool { name == "diagSelect" }

    func execute(_ name: String, _ args: Row, request: Request) async throws -> Result {
        guard name == "diagSelect", let value = args["value"] as? String, !value.isEmpty, value.count <= 40 else {
            throw Failure(message: "Неизвестное действие")
        }
        selection = value
        return Result()
    }

    func page(_ path: String, name: (String) -> String?, automix: Bool, request: Request) async throws -> Row {
        guard path == "/diagnostics" else { throw Failure(message: "Неизвестная страница") }
        let health = try? await request("GET", "/api/health", nil)
        let log = ((try? await request("GET", "/api/automix/log?limit=30", nil))?["items"] as? [Row]) ?? []
        let chosen = selected(log)
        let plan = chosen?["plan"] as? Row

        var sections: [Row] = []
        let checks = checks(health: health, plan: plan, automix: automix)
        let worst = checks.contains { $0["tone"] as? String == "warn" } ? "Есть что проверить" : "Всё в порядке"
        sections.append(["title": worst, "rows": checks])

        var transition: [Row] = []
        if log.isEmpty {
            transition.append(["kind": "text", "title": "Переходов пока нет",
                               "detail": "Включите AutoMix и послушайте пару треков: здесь появятся точки входа и выхода."])
        } else {
            transition.append(["kind": "choice", "title": "Какой переход показать", "value": selection,
                               "options": options(log, name: name), "act": ["name": "diagSelect"]])
            if let plan {
                transition.append(contentsOf: planRows(plan, name: name))
                let from = plan["fromTrackId"] as? String, to = plan["toTrackId"] as? String
                if let from, let to {
                    transition.append(["kind": "button", "title": "Послушать переход", "symbol": "play.fill", "style": "primary",
                                       "act": ["name": "previewPair", "args": ["from": from, "to": to]]])
                    for id in [from, to] {
                        if let row = try await analysis(id, name: name, request: request) { transition.append(row) }
                    }
                }
            } else {
                transition.append(["kind": "text", "title": "План перехода недоступен",
                                   "detail": "Выберите другой переход или включите AutoMix."])
            }
        }
        // The waveform and automation charts stay on the web page.
        transition.append(["kind": "link", "title": "Графики перехода", "symbol": "chart.xyaxis.line", "path": "/diagnostics/charts"])
        sections.append(["title": "Переходы", "rows": transition])

        sections.append(["title": "Технические подробности", "footer": "Счётчики относятся к текущему запуску плеера.",
                         "rows": technical(health)])
        return ["title": "Диагностика AutoMix", "sections": sections]
    }

    // MARK: pieces

    private func selected(_ log: [Row]) -> Row? {
        guard selection != "latest" else { return log.first }
        return log.first { id($0) == selection } ?? log.first
    }
    private func id(_ item: Row) -> String { (item["id"] as? NSNumber).map { String($0.intValue) } ?? "" }

    private func options(_ log: [Row], name: (String) -> String?) -> [[String]] {
        var rows: [[String]] = [["latest", "Последний переход"]]
        for item in log.prefix(30) {
            let key = id(item)
            guard !key.isEmpty else { continue }
            let from = (item["fromTrackId"] as? String).flatMap(name) ?? "Трек"
            let to = (item["toTrackId"] as? String).flatMap(name) ?? "Трек"
            rows.append([key, "\(from) → \(to) · \(Self.date(item["executedAt"]))"])
        }
        return rows
    }

    private func checks(health: Row?, plan: Row?, automix: Bool) -> [Row] {
        var rows: [Row] = []
        if let health {
            let decoder = (health["decoder"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (health["ffmpeg"] as? String)
            if decoder == nil || decoder == "" {
                rows.append(["kind": "text", "title": "Декодер звука не найден — файлы не воспроизводятся.", "tone": "warn"])
            }
        } else {
            rows.append(["kind": "text", "title": "Нет связи со встроенным сервером MORA. Перезапустите приложение, если это не пройдёт.", "tone": "warn"])
        }
        if !automix {
            rows.append(["kind": "text", "title": "AutoMix выключен в настройках: треки играют подряд без переходов."])
        }
        if let health {
            let analysis = health["analysis"] as? Row ?? [:]
            let pending = Self.int(analysis["running"]) + Self.int(analysis["queued"])
            rows.append(pending > 0
                ? ["kind": "text", "title": "Анализируем треки: осталось \(pending). Пока анализ не готов, переходы проще."]
                : ["kind": "text", "title": "Все треки проанализированы.", "tone": "ok"])
        }
        if let plan {
            if let reason = plan["fallbackReason"] as? String, !reason.isEmpty {
                rows.append(["kind": "text", "title": "Переход упрощён: \(reason)"])
            } else {
                let confidence = (plan["confidence"] as? NSNumber)?.doubleValue ?? 0
                rows.append(["kind": "text", "title": "Переход рассчитан, уверенность \(Int((confidence * 100).rounded())) %.", "tone": "ok"])
            }
        }
        if rows.isEmpty { rows.append(["kind": "text", "title": "Всё в порядке", "tone": "ok"]) }
        return rows
    }

    private func planRows(_ plan: Row, name: (String) -> String?) -> [Row] {
        var rows: [Row] = []
        let method = plan["method"] as? String ?? ""
        let vocal = plan["vocalA"] != nil || plan["vocalB"] != nil || plan["voiceEcho"] != nil
        rows.append(["kind": "text", "title": Self.method(method),
                     "detail": vocal ? "План с отдельными вокальными партиями" : "План по исходному звуку треков"])
        let from = (plan["fromTrackId"] as? String).flatMap(name) ?? "Текущий трек"
        let to = (plan["toTrackId"] as? String).flatMap(name) ?? "Следующий трек"
        rows.append(["kind": "text", "title": "Выход из трека", "detail": from, "value": Self.time(plan["aExit"])])
        rows.append(["kind": "text", "title": "Вход в следующий", "detail": to, "value": Self.time(plan["bEntry"])])
        let confidence = Int((((plan["confidence"] as? NSNumber)?.doubleValue ?? 0) * 100).rounded())
        rows.append(["kind": "text", "title": "Уверенность", "value": "\(confidence) %"])
        let duration = (plan["duration"] as? NSNumber)?.doubleValue ?? 0, gap = (plan["gap"] as? NSNumber)?.doubleValue ?? 0
        rows.append(["kind": "text", "title": "Длительность", "value": Self.seconds(duration) + (gap > 0 ? ", пауза \(Self.seconds(gap))" : "")])
        if let beat = plan["beatAlign"] as? Row {
            let a = (beat["bpmA"] as? NSNumber)?.doubleValue ?? 0, b = (beat["bpmB"] as? NSNumber)?.doubleValue ?? 0
            let relation = (beat["relation"] as? NSNumber)?.doubleValue ?? 1
            rows.append(["kind": "text", "title": "Темп", "value": String(format: "%.2f → %.2f BPM", a, b) + (abs(relation - 1) > 0.001 ? String(format: " (×%.2f)", relation) : "")])
            let beats = Self.int(beat["overlapBeats"])
            var overlap: Row = ["kind": "text", "title": "Наложение", "value": "\(beats) \(Self.beats(beats))"]
            if beat["phraseAligned"] as? Bool == true { overlap["detail"] = "по фразам" }
            rows.append(overlap)
        }
        return rows
    }

    private func analysis(_ trackId: String, name: (String) -> String?, request: Request) async throws -> Row? {
        guard trackId.range(of: "^[A-Za-z0-9._-]{1,100}$", options: .regularExpression) != nil else { return nil }
        guard let result = try? await request("GET", "/api/tracks/\(trackId)/analysis", nil) else { return nil }
        let title = name(trackId) ?? "Трек"
        guard let analysis = result["analysis"] as? Row else { return nil }
        let status = analysis["status"] as? String ?? "none"
        if status == "error" {
            return ["kind": "text", "title": "Анализ: \(title)", "detail": analysis["error"] as? String ?? "Анализ не удался", "tone": "warn"]
        }
        if status == "running" || status == "pending" {
            let progress = (analysis["progress"] as? NSNumber)?.doubleValue ?? 0
            return ["kind": "text", "title": "Анализ: \(title)", "value": "анализ… \(Int((progress * 100).rounded())) %"]
        }
        guard status == "done" else { return ["kind": "text", "title": "Анализ: \(title)", "value": "нет анализа"] }
        let bpm = (analysis["bpm"] as? NSNumber)?.doubleValue
        let key = (analysis["camelot"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (analysis["keyName"] as? String)
        var value: [String] = []
        if let bpm { value.append(String(format: "%.0f BPM", bpm)) }
        if let key, !key.isEmpty { value.append(key) }
        var detail: [String] = []
        if let energy = (analysis["energy"] as? NSNumber)?.doubleValue { detail.append(String(format: "энергия %.2f", energy)) }
        if let lufs = (analysis["lufs"] as? NSNumber)?.doubleValue { detail.append(String(format: "%.1f LUFS", lufs)) }
        if let peak = (analysis["truePeak"] as? NSNumber)?.doubleValue { detail.append(String(format: "пик %.1f dBFS", peak)) }
        var row: Row = ["kind": "text", "title": "Анализ: \(title)", "value": value.joined(separator: " · ")]
        if !detail.isEmpty { row["detail"] = detail.joined(separator: " · ") }
        return row
    }

    private func technical(_ health: Row?) -> [Row] {
        guard let health else { return [["kind": "text", "title": "Счётчики появятся после начала воспроизведения."]] }
        let analysis = health["analysis"] as? Row ?? [:]
        var rows: [Row] = [
            ["kind": "text", "title": "Анализ", "detail": "Анализатор \(health["analyzer"] as? String ?? "?"), планировщик \(health["planner"] as? String ?? "?")",
             "value": "потоков \(Self.int(analysis["workers"]))"],
            ["kind": "text", "title": "Медиатека", "value": "\(Self.int(health["tracks"])) \(Self.tracks(Self.int(health["tracks"])))"],
        ]
        if let bytes = (health["pcmCacheBytes"] as? NSNumber)?.doubleValue, let limit = (health["pcmCacheLimit"] as? NSNumber)?.doubleValue, limit > 0 {
            rows.append(["kind": "text", "title": "Кэш звука", "value": "\(Self.mb(bytes)) из \(Self.mb(limit))"])
        }
        if let stems = health["stems"] as? Row, let available = stems["available"] as? Bool {
            rows.append(["kind": "text", "title": "Разделение вокала", "value": available ? "доступно" : "недоступно"])
        }
        return rows
    }

    // MARK: formatting

    private static func method(_ value: String) -> String {
        ["fallback_crossfade": "Резервный кроссфейд", "beatmatch_blend": "Битматч", "tempo_bridge": "Смена темпа",
         "drop_mix": "Дроп", "phrase_cut": "Срез по фразе", "crossfade": "Кроссфейд", "echo_out": "Эхо",
         "gapless": "Без паузы", "skip_fade": "Быстрый переход"][value] ?? (value.isEmpty ? "Переход" : value)
    }
    private static func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private static func time(_ value: Any?) -> String {
        let seconds = max(0, (value as? NSNumber)?.doubleValue ?? 0)
        return String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
    private static func seconds(_ value: Double) -> String { String(format: "%.2f с", value) }
    private static func beats(_ n: Int) -> String {
        let d = n % 10, h = n % 100
        return d == 1 && h != 11 ? "доля" : (2...4).contains(d) && !(12...14).contains(h) ? "доли" : "долей"
    }
    private static func tracks(_ n: Int) -> String {
        let d = n % 10, h = n % 100
        return d == 1 && h != 11 ? "трек" : (2...4).contains(d) && !(12...14).contains(h) ? "трека" : "треков"
    }
    private static func mb(_ bytes: Double) -> String { String(format: "%.0f МБ", bytes / 1_048_576) }
    private static func date(_ value: Any?) -> String {
        let ms = (value as? NSNumber)?.doubleValue ?? 0
        guard ms > 0 else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}
