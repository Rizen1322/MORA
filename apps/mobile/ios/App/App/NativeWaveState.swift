import Foundation

/// Native Wave settings and /wave page backed directly by JSC API (GET/PUT /api/settings,
/// GET /api/providers/yandex/wave/settings). Playback launch/skip commands still route to
/// the queue controller (stage 4).
final class NativeWaveState {
    typealias Request = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any]

    private var cachedYandexGroups: [[String: Any]]?
    /// A tuning write happened: the next dismissal must rebuild the wave with these values.
    private var changed = false

    static func handles(_ path: String) -> Bool {
        path == "/wave"
    }

    static func supports(_ name: String) -> Bool {
        name == "set" || name == "yandexSeed"
    }

    func settingsPage(_ source: String, request: Request) async throws -> [String: Any] {
        guard ["own", "online", "yandex"].contains(source) else {
            throw NSError(domain: "NativeWaveState", code: 1, userInfo: [NSLocalizedDescriptionKey: "Неизвестный источник волны"])
        }
        let settings = try await request("GET", "/api/settings", nil)
        let wave = settings["wave"] as? [String: Any] ?? [:]
        let section = try await tuningSection(source: source, wave: wave, request: request)
        return ["title": "Настроить волну", "sections": [section]]
    }

    func page(source explicitSource: String?, ui: NativeUiState, byId: [String: NativeTrack], libraryCount: Int, request: Request) async throws -> [String: Any] {
        let settings = try await request("GET", "/api/settings", nil)
        let wave = settings["wave"] as? [String: Any] ?? [:]
        let yandex = ui.wave.yandex
        let active = ui.wave.active?.rawValue
        let waveOn = active != nil
        let resolvedSource: String = {
            if let explicitSource, ["own", "online", "yandex"].contains(explicitSource) {
                if explicitSource != "yandex" || yandex { return explicitSource }
            }
            if let active { return active }
            return yandex ? "yandex" : "own"
        }()
        let selected = waveOn && active == resolvedSource
        let playing = selected && ui.wave.playing
        let unavailable = resolvedSource == "own" ? libraryCount == 0 : (resolvedSource == "yandex" && !yandex)
        let loading = ui.wave.loading

        var sourceOptions: [[String]] = [["own", "Моя коллекция"], ["online", "Онлайн-радио"]]
        if yandex { sourceOptions.append(["yandex", "Яндекс Музыка"]) }

        var stageRows: [[String: Any]] = [
            ["kind": "choice", "title": "Источник", "value": resolvedSource, "act": ["name": "waveSource", "args": [:]], "options": sourceOptions],
            [
                "kind": "button",
                "title": selected ? (playing ? "Пауза" : "Продолжить") : (loading ? "Подбираю музыку…" : (resolvedSource == "online" ? "Включить радио" : "Поймать волну")),
                "symbol": playing ? "pause.fill" : "play.fill",
                "style": "primary",
                "disabled": !selected && (loading || unavailable),
                "act": ["name": "waveLaunch", "args": ["source": resolvedSource]],
            ],
        ]
        if selected {
            stageRows.append(["kind": "button", "title": "Другой трек", "symbol": "forward.fill", "act": ["name": "next", "args": [:]]])
        }
        if unavailable && !selected {
            stageRows.append(resolvedSource == "own"
                ? ["kind": "link", "title": "Добавьте музыку в медиатеку, чтобы начать", "path": "/library"]
                : ["kind": "link", "title": "Подключите Яндекс Музыку", "path": "/sources"])
        }
        if let err = ui.wave.error, !err.isEmpty {
            stageRows.append(["kind": "text", "title": err, "tone": "error"])
        }

        var tuning = try await tuningSection(source: resolvedSource, wave: wave, request: request)
        tuning["title"] = "Настроить звучание"

        var nowRows: [[String: Any]] = []
        if waveOn, let now = ui.now {
            let track = byId[now.id]
            let liked = (track?.reaction ?? 0) > 0
            let sourceName = active == "online" ? "Онлайн-радио" : active == "yandex" ? "Яндекс Музыка" : "Моя коллекция"
            var item: [String: Any] = [
                "kind": "item",
                "title": track?.title ?? now.title,
                "subtitle": "\(track?.artist ?? now.artist) · \(sourceName)",
                "actions": [
                    ["title": liked ? "Убрать из любимого" : "Нравится", "symbol": liked ? "heart.fill" : "heart",
                     "act": ["name": "react", "args": ["id": now.id, "value": liked ? 0 : 1]]],
                    ["title": "Не нравится, убрать из волны", "symbol": "hand.thumbsdown", "destructive": true,
                     "act": ["name": "react", "args": ["id": now.id, "value": -1]]],
                ],
            ]
            if let cover = track?.cover ?? now.cover { item["cover"] = cover }
            nowRows.append(item)
        } else {
            nowRows.append(["kind": "text", "title": "Всё начинается с вас", "detail": "Лайкайте то, что цепляет. Волна подстроится под ваш вкус."])
        }

        var nextRows: [[String: Any]] = []
        let currentIndex = ui.queue.firstIndex { $0.entryId == ui.now?.entryId } ?? (ui.queue.isEmpty ? -1 : 0)
        if waveOn, currentIndex >= 0 {
            let upcoming = ui.queue.dropFirst(currentIndex + 1).prefix(5)
            for (offset, entry) in upcoming.enumerated() {
                guard let track = byId[entry.trackId] else { continue }
                var row: [String: Any] = [
                    "kind": "item",
                    "title": track.title,
                    "subtitle": track.artist,
                    "act": ["name": "jump", "args": ["index": ui.stationIndex + currentIndex + 1 + offset]],
                ]
                if let cover = track.cover { row["cover"] = cover }
                nextRows.append(row)
            }
            let left = max(0, ui.stationCount - ui.stationIndex - 1)
            if left > upcoming.count {
                nextRows.append(["kind": "button", "title": "Вся очередь", "symbol": "list.bullet", "act": ["name": "queue", "args": [:]]])
            }
            var page: [String: Any] = [
                "title": "Моя волна",
                "sections": [
                    ["footer": "Музыка, которая чувствует ваш ритм.", "rows": stageRows],
                    tuning,
                    ["title": "Сейчас в эфире", "rows": nowRows, "footer": "Волна учитывает лайки, дослушивания и пропуски. «Не нравится» убирает трек из подборки."],
                    ["title": "На подходе", "footer": loading ? "Готовим продолжение…" : Self.tracksWord(left), "rows": nextRows],
                ],
            ]
            if loading { page["refresh"] = 2 }
            return page
        }

        var page: [String: Any] = [
            "title": "Моя волна",
            "sections": [
                ["footer": "Музыка, которая чувствует ваш ритм.", "rows": stageRows],
                tuning,
                ["title": "Ваша частота", "rows": nowRows, "footer": "Волна учитывает лайки, дослушивания и пропуски. «Не нравится» убирает трек из подборки."],
                ["title": "На подходе", "footer": loading ? "Готовим продолжение…" : "Запустите волну — здесь появятся следующие треки вашей подборки.", "rows": nextRows],
            ],
        ]
        if loading { page["refresh"] = 2 }
        return page
    }

    func consumeChange() -> Bool { defer { changed = false }; return changed }

    func execute(_ name: String, _ args: [String: Any], request: Request) async throws -> String? {
        if name == "set" {
            guard let group = args["group"] as? String, group == "wave",
                  let key = args["key"] as? String, !key.isEmpty else {
                throw NSError(domain: "NativeWaveState", code: 2, userInfo: [NSLocalizedDescriptionKey: "Некорректный параметр волны"])
            }
            var value: Any = args["value"] ?? NSNull()
            if let map = args["map"] as? [String: Any], let mapped = map[String(describing: value)] {
                value = mapped
            }
            _ = try await request("PUT", "/api/settings", ["wave": [key: value]])
            changed = true
            return nil
        }
        if name == "yandexSeed" {
            let group = Set(args["group"] as? [String] ?? [])
            let picked = (args["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let current = try await request("GET", "/api/settings", nil)
            let wave = current["wave"] as? [String: Any] ?? [:]
            var seeds = (wave["yandexSeeds"] as? [String] ?? []).filter { !group.contains($0) }
            if !picked.isEmpty { seeds.append(picked) }
            _ = try await request("PUT", "/api/settings", ["wave": ["yandexSeeds": seeds]])
            changed = true
            return nil
        }
        throw NSError(domain: "NativeWaveState", code: 3, userInfo: [NSLocalizedDescriptionKey: "Неизвестное действие волны"])
    }

    private func tuningSection(source: String, wave: [String: Any], request: Request) async throws -> [String: Any] {
        var rows: [[String: Any]] = []
        if source == "yandex" {
            let groups: [[String: Any]]?
            if let cachedYandexGroups {
                groups = cachedYandexGroups
            } else if let response = try? await request("GET", "/api/providers/yandex/wave/settings", nil),
                      let loaded = response["groups"] as? [[String: Any]] {
                cachedYandexGroups = loaded
                groups = loaded
            } else {
                groups = nil
            }
            let seeds = Set(wave["yandexSeeds"] as? [String] ?? [])
            if let groups {
                if groups.isEmpty {
                    rows.append(["kind": "text", "title": "Яндекс пока не вернул доступные настройки. Попробуйте позже."])
                } else {
                    for g in groups {
                        let name = g["name"] as? String ?? ""
                        let values = g["values"] as? [[String: Any]] ?? []
                        let groupSeeds = values.compactMap { $0["seed"] as? String }
                        let selected = groupSeeds.first(where: { seeds.contains($0) }) ?? ""
                        var options: [[String]] = [["", "По умолчанию"]]
                        for v in values {
                            if let seed = v["seed"] as? String, let title = v["name"] as? String {
                                options.append([seed, title])
                            }
                        }
                        rows.append([
                            "kind": "choice",
                            "title": name,
                            "value": selected,
                            "options": options,
                            "act": ["name": "yandexSeed", "args": ["group": groupSeeds]],
                            "disabled": wave.isEmpty,
                        ])
                    }
                }
            } else {
                rows.append(["kind": "text", "title": "Не удалось получить настройки Яндекса.", "tone": "warn"])
            }
            return ["title": "Подбор Яндекса", "footer": "Настройки вашего аккаунта Яндекса применятся к продолжению волны.", "rows": rows]
        }

        let online = source == "online"
        let mood = wave["mood"] as? String ?? "normal"
        let diversity = wave["diversity"] as? String ?? "balanced"
        let mode = wave["mode"] as? String ?? "normal"

        let moodDetail: String = online
            ? "Энергия учитывается у уже проанализированных записей."
            : (mood == "calm" ? "Выдохнуть и замедлиться" : mood == "energetic" ? "Добавить движения" : "Знакомый ритм вашего дня")
        let diversityDetail: String? = online ? nil
            : (diversity == "discover" ? "Больше музыки, которую вы ещё не слышали" : diversity == "familiar" ? "Ближе к тому, что уже нравится" : "Знакомые треки и новые находки")
        let mixDetail: String = online
            ? "Близкие BPM и тональности получают приоритет, когда есть анализ."
            : (mode == "mix" ? "Больше совместимых по ритму треков" : "Подбор прежде всего по вашему вкусу")

        var diversityRow: [String: Any] = [
            "kind": "choice",
            "title": online ? "Знакомое и новое" : "Характер",
            "value": diversity,
            "options": [["familiar", online ? "Ближе к любимому" : "Любимое"], ["balanced", "Вперемешку"], ["discover", "Открытия"]],
            "act": ["name": "set", "args": ["group": "wave", "key": "diversity"]],
            "disabled": wave.isEmpty,
        ]
        if let diversityDetail { diversityRow["detail"] = diversityDetail }

        rows = [
            ["kind": "choice", "title": "Энергия", "detail": moodDetail, "value": mood,
             "options": [["calm", "Спокойнее"], ["normal", "В моём ритме"], ["energetic", "Бодрее"]],
             "act": ["name": "set", "args": ["group": "wave", "key": "mood"]], "disabled": wave.isEmpty],
            diversityRow,
            ["kind": "toggle", "title": "Для микса", "detail": mixDetail, "on": mode == "mix",
             "act": ["name": "set", "args": ["group": "wave", "key": "mode", "map": ["true": "mix", "false": "normal"]]], "disabled": wave.isEmpty],
        ]
        return [
            "title": online ? "Радио по вашему вкусу" : "Характер подборки",
            "footer": "Новые настройки применятся к следующим трекам.",
            "rows": rows,
        ]
    }

    private static func tracksWord(_ n: Int) -> String {
        let m10 = n % 10, m100 = n % 100
        let word = (m10 == 1 && m100 != 11) ? "трек" : ([2, 3, 4].contains(m10) && ![12, 13, 14].contains(m100) ? "трека" : "треков")
        return "\(n) \(word)"
    }
}
