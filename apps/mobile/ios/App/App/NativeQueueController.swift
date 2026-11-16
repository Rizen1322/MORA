import Foundation

/// Stage 4: Native queue, wave refill, and playback orchestration in Swift using NativeServerApp
/// and NativeMixHost directly, without depending on the WebView audio controller.
@MainActor final class NativeQueueController {
    struct Entry: Equatable {
        let entryId: String
        let trackId: String
    }
    struct Context: Equatable {
        let type: String
        let id: String?
        let label: String
    }

    static let shared = NativeQueueController()

    private(set) var entries: [Entry] = []
    private var originalEntries: [Entry]?
    private(set) var index: Int = 0
    private(set) var context = Context(type: "library", id: nil, label: "Медиатека")
    private(set) var shuffle = false
    private(set) var repeatMode = "off" // off | all | one
    private(set) var waveSource: String? // own | yandex | online | nil
    private(set) var waveLoading = false
    private(set) var waveError: String?

    private var sessionId: String?
    private var revision = 0
    private var activePlayId: Int?
    private var playStartedAt = Date()
    private var yandexSessionId: String?
    private var toppingUpWave = false
    private var syncTask: Task<Void, Never>?

    var onStateChange: (() -> Void)?

    var currentEntry: Entry? { entries.indices.contains(index) ? entries[index] : nil }
    var isWave: Bool { waveSource != nil || ["wave", "yandex-wave", "online-radio"].contains(context.type) }

    func play(trackIds: [String], at startIndex: Int, context: Context, startPaused: Bool = false, keepWave: Bool = false) async throws {
        guard !trackIds.isEmpty else { return }
        if !keepWave {
            waveSource = nil
            yandexSessionId = nil
            waveError = nil
        }
        var queue = trackIds.map { Entry(entryId: UUID().uuidString, trackId: $0) }
        var targetIndex = max(0, min(queue.count - 1, startIndex))
        originalEntries = nil
        if shuffle && queue.count > 1 {
            let first = queue[targetIndex]
            var rest = queue.enumerated().filter { $0.offset != targetIndex }.map(\.element)
            rest.shuffle()
            originalEntries = queue
            queue = [first] + rest
            targetIndex = 0
        }
        self.entries = queue
        self.index = targetIndex
        self.context = context
        onStateChange?()
        try await startAt(targetIndex, paused: startPaused)
    }

    func enqueue(trackIds: [String], next: Bool) async throws {
        guard !trackIds.isEmpty else { return }
        if entries.isEmpty || !NativeMixHost.shared.active {
            try await play(trackIds: trackIds, at: 0, context: Context(type: "queue", id: nil, label: "Очередь"))
            return
        }
        let added = trackIds.map { Entry(entryId: UUID().uuidString, trackId: $0) }
        if next {
            let insertAt = min(entries.count, index + 1)
            entries.insert(contentsOf: added, at: insertAt)
        } else {
            entries.append(contentsOf: added)
        }
        onStateChange?()
        scheduleSync()
    }

    func editQueue(action: String, entryId: String, after: String? = nil) async throws {
        guard let from = entries.firstIndex(where: { $0.entryId == entryId }) else {
            throw NSError(domain: "NativeQueue", code: 1, userInfo: [NSLocalizedDescriptionKey: "Трека уже нет в очереди"])
        }
        switch action {
        case "remove":
            if from == index {
                let nextIdx = from + 1 < entries.count ? from : (entries.count > 1 ? from - 1 : -1)
                entries.remove(at: from)
                if nextIdx >= 0, entries.indices.contains(nextIdx) {
                    index = nextIdx
                    try await startAt(index, paused: false)
                } else {
                    index = 0
                    stopPlayback()
                }
            } else {
                entries.remove(at: from)
                if from < index { index = max(0, index - 1) }
                onStateChange?()
                scheduleSync()
            }
        case "jump":
            index = from
            onStateChange?()
            try await startAt(from, paused: false)
        case "next":
            let target = min(entries.count - 1, index + 1)
            if from > target {
                let item = entries.remove(at: from)
                entries.insert(item, at: target)
                onStateChange?()
                scheduleSync()
            }
        case "move":
            guard let after, let afterIdx = entries.firstIndex(where: { $0.entryId == after }) else {
                throw NSError(domain: "NativeQueue", code: 2, userInfo: [NSLocalizedDescriptionKey: "Очередь изменилась, попробуйте ещё раз"])
            }
            if afterIdx != from {
                let item = entries.remove(at: from)
                let insertAt = from < afterIdx ? afterIdx : afterIdx + 1
                entries.insert(item, at: min(entries.count, insertAt))
                if from == index { index = min(entries.count - 1, insertAt) }
                else if from < index && insertAt >= index { index = max(0, index - 1) }
                else if from > index && insertAt <= index { index = min(entries.count - 1, index + 1) }
                onStateChange?()
                scheduleSync()
            }
        default:
            throw NSError(domain: "NativeQueue", code: 3, userInfo: [NSLocalizedDescriptionKey: "Неизвестное действие с очередью"])
        }
    }

    func command(_ action: String, seekTime: Double? = nil) async throws {
        let host = NativeMixHost.shared
        if action == "toggle" {
            if host.active {
                let playing = host.snapshot["playing"] as? Bool == true
                _ = try await hostReply { host.command(playing ? "pause" : "play", source: "native", completion: $0) }
            } else if entries.indices.contains(index) {
                try await startAt(index, paused: false)
            }
            return
        }
        guard host.active else {
            if action == "play", entries.indices.contains(index) {
                try await startAt(index, paused: false)
            }
            return
        }
        _ = try await hostReply { host.command(action, time: seekTime, source: "native", completion: $0) }
    }

    func setMode(_ mode: String) async throws {
        switch mode {
        case "shuffle":
            shuffle.toggle()
            if shuffle, entries.count > 1, let cur = currentEntry {
                originalEntries = entries
                var rest = entries.filter { $0.entryId != cur.entryId }
                rest.shuffle()
                entries = [cur] + rest
                index = 0
            } else if !shuffle, let orig = originalEntries, let cur = currentEntry {
                entries = orig
                index = entries.firstIndex(where: { $0.entryId == cur.entryId }) ?? 0
                originalEntries = nil
            }
            onStateChange?()
            scheduleSync()
        case "repeat":
            repeatMode = repeatMode == "off" ? "all" : repeatMode == "all" ? "one" : "off"
            onStateChange?()
            scheduleSync()
        case "automix":
            let settings = try await NativeServerApp.request("GET", "/api/settings", nil)
            var automix = settings["automix"] as? [String: Any] ?? [:]
            let enabled = !(automix["enabled"] as? Bool ?? true)
            automix["enabled"] = enabled
            _ = try await NativeServerApp.request("PUT", "/api/settings", ["automix": automix])
            if NativeMixHost.shared.active {
                _ = try? await hostReply { NativeMixHost.shared.settings(["automix": automix], completion: $0) }
            }
            onStateChange?()
        default:
            throw NSError(domain: "NativeQueue", code: 4, userInfo: [NSLocalizedDescriptionKey: "Неизвестный режим воспроизведения"])
        }
    }

    func startWave(source: String, offline: Bool) async throws {
        if waveSource == source && NativeMixHost.shared.active {
            try await command("toggle")
            return
        }
        waveLoading = true
        waveError = nil
        onStateChange?()
        defer { waveLoading = false; onStateChange?() }

        if source == "yandex" && !offline {
            let res = try await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: ["count": 2])
            yandexSessionId = res["session"] as? String
            let items = res["items"] as? [[String: Any]] ?? []
            var ids: [String] = []
            for item in items {
                if let tid = item["trackId"] as? String, !tid.isEmpty { ids.append(tid) }
                else if let track = item["track"] as? [String: Any] {
                    let imp = try? await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track])
                    if let tid = imp?["trackId"] as? String { ids.append(tid) }
                }
            }
            guard !ids.isEmpty else {
                waveError = "Яндекс Музыка не вернула треки"
                throw NSError(domain: "NativeWave", code: 1, userInfo: [NSLocalizedDescriptionKey: waveError!])
            }
            waveSource = "yandex"
            try await play(trackIds: ids, at: 0, context: Context(type: "yandex-wave", id: "yandex", label: "Моя волна · Яндекс"), keepWave: true)
            return
        }

        let res = try await NativeServerApp.request("POST", "/api/wave/next", body: ["count": 4, "offline": offline])
        let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        guard !picks.isEmpty else {
            waveError = offline ? "Нет скачанных треков для офлайн-волны" : "Добавьте треки в медиатеку, чтобы запустить волну"
            throw NSError(domain: "NativeWave", code: 2, userInfo: [NSLocalizedDescriptionKey: waveError!])
        }
        waveSource = source == "online" ? "online" : "own"
        try await play(trackIds: picks, at: 0, context: Context(type: source == "online" ? "online-radio" : "wave", id: source, label: source == "online" ? "Онлайн-радио" : "Моя волна"), keepWave: true)
    }

    func startArtistRadio(artist: String, tracks: [NativeTrack]) async throws {
        let needle = NativeSearchText.normalize(artist)
        let matching = tracks.filter { $0.ok && $0.reaction >= 0 && NativeSearchText.normalize($0.artist).contains(needle) }
        var ids = Array(matching.shuffled().prefix(2).map(\.id))
        var waveBody: [String: Any] = ["session": ids, "count": 4, "exclude": ids]
        if let first = ids.first { waveBody["currentId"] = first }
        let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: waveBody)
        let picks = (res?["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        ids.append(contentsOf: picks.filter { !ids.contains($0) })
        guard !ids.isEmpty else {
            throw NSError(domain: "NativeWave", code: 3, userInfo: [NSLocalizedDescriptionKey: "Недостаточно треков для радио исполнителя"])
        }
        waveSource = "own"
        try await play(trackIds: ids, at: 0, context: Context(type: "wave", id: artist, label: "\(artist) и похожие"), keepWave: true)
    }

    func syncFromHost(_ snapshot: [String: Any]) {
        guard snapshot["active"] as? Bool == true else { return }
        if let eid = snapshot["entryId"] as? String, let found = entries.firstIndex(where: { $0.entryId == eid }), found != index {
            finishPlay(reason: found == index + 1 ? "transition" : "skip")
            index = found
            if let entry = currentEntry { beginPlay(entry) }
            onStateChange?()
            scheduleSync()
        }
        if isWave && entries.count - 1 - index <= 2 {
            Task { @MainActor in await topUpWaveIfNeeded() }
        }
    }

    // MARK: - Private

    private func startAt(_ targetIndex: Int, paused: Bool) async throws {
        guard entries.indices.contains(targetIndex) else { return }
        revision &+= 1
        let rev = revision
        let entry = entries[targetIndex]
        finishPlay(reason: "skip")

        let nativeFiles = downloadedIds(for: [entry.trackId])
        let manifest = try await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
            "entries": [["entryId": entry.entryId, "trackId": entry.trackId, "file": 0]],
            "previousId": entry.trackId,
            "nativeFiles": nativeFiles,
        ])
        guard rev == revision else { return }
        guard let item = (manifest["items"] as? [[String: Any]])?.first else {
            throw NSError(domain: "NativeQueue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Источник трека недоступен"])
        }

        let host = NativeMixHost.shared
        NativePlaybackHooks.install(host)
        if sessionId == nil || !host.active {
            let begun = try await hostReply { host.begin($0) }
            sessionId = begun["id"] as? String
        }
        guard let sid = sessionId, rev == revision else { return }
        let config: [String: Any] = ["sampleRate": 48000.0, "position": 0.0, "paused": paused, "gainDb": 0.0]
        _ = try await hostReply { host.prepareStart(id: sid, item: item, config: config, completion: $0) }
        guard rev == revision else { return }

        beginPlay(entry)
        saveQueueState()
        onStateChange?()
        scheduleSync()
        if isWave { Task { @MainActor in await topUpWaveIfNeeded() } }
    }

    private func scheduleSync() {
        syncTask?.cancel()
        syncTask = Task { @MainActor in
            await syncQueue()
        }
    }

    private func syncQueue() async {
        guard let sid = sessionId, NativeMixHost.shared.active, let current = currentEntry else { return }
        let rev = revision
        let upcoming = repeatMode == "one" ? [] : Array(entries.dropFirst(index + 1))
        let loopEntries: [Entry] = repeatMode == "one" ? [current] : (repeatMode == "all" ? entries : [])
        guard !upcoming.isEmpty || !loopEntries.isEmpty else { return }

        let all = upcoming + loopEntries
        let nativeFiles = downloadedIds(for: all.map(\.trackId))
        let bodyEntries = all.enumerated().map { idx, e -> [String: Any] in
            ["entryId": e.entryId, "trackId": e.trackId, "file": idx]
        }
        guard let manifest = try? await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
            "entries": bodyEntries,
            "previousId": current.trackId,
            "nativeFiles": nativeFiles,
        ]), rev == revision else { return }

        let items = manifest["items"] as? [[String: Any]] ?? []
        let upcomingIds = Set(upcoming.map(\.entryId))
        let futureItems = items.filter { upcomingIds.contains($0["entryId"] as? String ?? "") }
        let loopItems = items.filter { !upcomingIds.contains($0["entryId"] as? String ?? "") }
        let hostManifest: [String: Any] = [
            "from": index + 1,
            "items": futureItems,
            "loopItems": loopItems,
            "previous": manifest["previous"] ?? ["trackId": current.trackId, "duration": 0.0, "mixingAllowed": false],
            "settings": manifest["settings"] ?? ["enabled": true],
            "retainedSources": [],
        ]
        _ = try? await hostReply { NativeMixHost.shared.prepareQueue(id: sid, manifest: hostManifest, completion: $0) }
    }

    private func topUpWaveIfNeeded() async {
        guard isWave, !toppingUpWave, entries.count - 1 - index <= 2 else { return }
        toppingUpWave = true
        defer { toppingUpWave = false }
        let existing = Set(entries.map(\.trackId))
        if waveSource == "yandex" {
            var yBody: [String: Any] = ["count": 2]
            if let yandexSessionId { yBody["session"] = yandexSessionId }
            guard let res = try? await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: yBody) else { return }
            if let s = res["session"] as? String { yandexSessionId = s }
            let items = res["items"] as? [[String: Any]] ?? []
            var newIds: [String] = []
            for item in items {
                if let tid = item["trackId"] as? String, !existing.contains(tid) { newIds.append(tid) }
                else if let track = item["track"] as? [String: Any],
                        let imp = try? await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track]),
                        let tid = imp["trackId"] as? String, !existing.contains(tid) {
                    newIds.append(tid)
                }
            }
            if !newIds.isEmpty {
                entries.append(contentsOf: newIds.map { Entry(entryId: UUID().uuidString, trackId: $0) })
                onStateChange?()
                scheduleSync()
            }
            return
        }
        var nextBody: [String: Any] = [
            "session": Array(entries.suffix(12).map(\.trackId)),
            "count": 3,
            "exclude": Array(existing.prefix(60)),
        ]
        if let currentId = currentEntry?.trackId { nextBody["currentId"] = currentId }
        guard let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: nextBody) else { return }
        let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { !existing.contains($0) }
        if !picks.isEmpty {
            entries.append(contentsOf: picks.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            onStateChange?()
            scheduleSync()
        }
    }

    private func stopPlayback() {
        finishPlay(reason: "stop")
        sessionId = nil
        NativeMixHost.shared.stop { _ in }
        onStateChange?()
    }

    private func beginPlay(_ entry: Entry) {
        playStartedAt = Date()
        let tid = entry.trackId, ctx = context.type
        Task {
            if let res = try? await NativeServerApp.request("POST", "/api/plays", body: ["trackId": tid, "context": ctx]),
               let id = res["id"] as? Int {
                await MainActor.run { self.activePlayId = id }
            }
        }
    }

    private func finishPlay(reason: String) {
        guard let id = activePlayId else { return }
        activePlayId = nil
        let ms = Int(max(0, Date().timeIntervalSince(playStartedAt) * 1000))
        Task {
            _ = try? await NativeServerApp.request("PATCH", "/api/plays/\(id)", body: ["playedMs": ms, "endReason": reason])
        }
    }

    private func saveQueueState() {
        let q = entries.map { ["entryId": $0.entryId, "trackId": $0.trackId] }
        var ctx: [String: Any] = ["type": context.type, "label": context.label]
        if let cid = context.id { ctx["id"] = cid }
        let body: [String: Any] = ["queue": q, "index": index, "context": ctx]
        Task { _ = try? await NativeServerApp.request("PUT", "/api/queue", body: body) }
    }

    private func downloadedIds(for trackIds: [String]) -> [String] {
        let done = Set(NativeDownloadManager.shared.listSnapshot().filter { $0.state == .done }.map(\.trackId))
        return trackIds.filter { done.contains($0) }
    }

    private func hostReply(_ call: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            call { continuation.resume(with: $0) }
        }
    }
}
