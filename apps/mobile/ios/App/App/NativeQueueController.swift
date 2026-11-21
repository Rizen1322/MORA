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
    private(set) var automixEnabled = true
    private(set) var waveSource: String? // own | yandex | online | nil
    private(set) var waveLoading = false
    private(set) var waveError: String?

    private var sessionId: String?
    private var revision = 0
    private var hostIndex = 0
    private var waveOffline = false
    private static let networkWait: TimeInterval = 12
    private var retryWaveOnlineAt: TimeInterval = 0
    private var waveWaitEntry: String?
    private var waveWaitTask: Task<Void, Never>?
    private var activePlayId: Int?
    private var playStartedAt = Date()
    private var yandexSessionId: String?
    private var yandexQueueIds: [String] = []
    private var toppingUpWave = false
    private var syncTask: Task<Void, Never>?

    var onStateChange: (() -> Void)?

    var currentEntry: Entry? { entries.indices.contains(index) ? entries[index] : nil }
    var isWave: Bool { waveSource != nil || ["wave", "yandex-wave", "online-radio"].contains(context.type) }
    var weakWaveNetwork: Bool { isWave && waveOffline && retryWaveOnlineAt > 0 }

    func play(trackIds: [String], at startIndex: Int, context: Context, startPaused: Bool = false, keepWave: Bool = false) async throws {
        guard !trackIds.isEmpty else { return }
        if !keepWave {
            waveSource = nil
            waveOffline = false
            yandexSessionId = nil
            yandexQueueIds = []
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
                scheduleSync(replaceFuture: true)
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
                scheduleSync(replaceFuture: true)
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
                scheduleSync(replaceFuture: true)
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
            scheduleSync(replaceFuture: true)
        case "repeat":
            repeatMode = repeatMode == "off" ? "all" : repeatMode == "all" ? "one" : "off"
            onStateChange?()
            scheduleSync(replaceFuture: true)
        case "automix":
            let settings = try await NativeServerApp.request("GET", "/api/settings", body: nil)
            var automix = settings["automix"] as? [String: Any] ?? [:]
            let enabled = !(automix["enabled"] as? Bool ?? true)
            automix["enabled"] = enabled
            automixEnabled = enabled
            _ = try await NativeServerApp.request("PUT", "/api/settings", body: ["automix": automix])
            if NativeMixHost.shared.active {
                _ = try? await hostReply { NativeMixHost.shared.settings(["automix": automix], completion: $0) }
            }
            onStateChange?()
        default:
            throw NSError(domain: "NativeQueue", code: 4, userInfo: [NSLocalizedDescriptionKey: "Неизвестный режим воспроизведения"])
        }
    }

    func startWave(source: String, offline: Bool) async throws {
        guard !waveLoading else { return }
        if waveSource == source, NativeMixHost.shared.active, NativeMixHost.shared.snapshot["ended"] as? Bool != true,
           NativeMixHost.shared.snapshot["entryId"] as? String == currentEntry?.entryId {
            try await command("toggle")
            return
        }
        try await launchWave(source: source, offline: offline)
    }

    private func launchWave(source: String, offline: Bool) async throws {
        waveLoading = true
        waveError = nil
        onStateChange?()
        defer { waveLoading = false; onStateChange?() }
        let useOffline = offline || ProcessInfo.processInfo.systemUptime < retryWaveOnlineAt
        do {
            try await loadWave(source: source, offline: useOffline)
            if !useOffline { retryWaveOnlineAt = 0 }
        } catch where !useOffline && (NativeMediaHTTP.Failure.isConnectionLoss(error)
            || (source == "yandex" && [502, 503, 504].contains((error as? NativeServer.RequestFailure)?.status ?? 0))) {
            retryWaveOnlineAt = ProcessInfo.processInfo.systemUptime + 60
            try await loadWave(source: source, offline: true)
        }
    }

    private func loadWave(source: String, offline: Bool) async throws {
        let rev = revision

        if source == "yandex" && !offline {
            let res = try await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: ["count": 2, "queue": Array(yandexQueueIds.suffix(100))], timeout: Self.networkWait)
            guard rev == revision else { throw CancellationError() }
            yandexSessionId = (res["sessionId"] as? String) ?? (res["session"] as? String)
            let items = res["items"] as? [[String: Any]] ?? []
            var ids: [String] = []
            for item in items {
                if let yid = item["yandexId"] as? String, !yid.isEmpty, !yandexQueueIds.contains(yid) { yandexQueueIds.append(yid) }
                let tid: String?
                if let existing = item["trackId"] as? String, !existing.isEmpty { tid = existing }
                else if let track = item["track"] as? [String: Any] {
                    do {
                        let imp = try await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track], timeout: Self.networkWait)
                        tid = imp["trackId"] as? String
                    } catch where !NativeMediaHTTP.Failure.isConnectionLoss(error) { tid = nil }
                    guard rev == revision else { throw CancellationError() }
                } else { tid = nil }
                if let tid, (NativeShellStore.shared?.reaction(tid) ?? 0) >= 0, !ids.contains(tid) {
                    ids.append(tid)
                }
            }
            guard !ids.isEmpty else {
                waveError = "Яндекс Музыка не вернула треки"
                throw NSError(domain: "NativeWave", code: 1, userInfo: [NSLocalizedDescriptionKey: waveError!])
            }
            waveSource = "yandex"
            waveOffline = false
            try await play(trackIds: ids, at: 0, context: Context(type: "yandex-wave", id: "yandex", label: "Моя волна · Яндекс"), keepWave: true)
            return
        }

        let res = try await NativeServerApp.request("POST", "/api/wave/next", body: ["count": 4, "offline": offline])
        guard rev == revision else { throw CancellationError() }
        var picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        if offline && picks.count < 4 { picks += downloadedWaveTracks(excluding: Set(picks), count: 4 - picks.count) }
        waveOffline = offline
        guard !picks.isEmpty else {
            waveError = offline ? "Нет скачанных треков для офлайн-волны" : "Добавьте треки в медиатеку, чтобы запустить волну"
            throw NSError(domain: "NativeWave", code: 2, userInfo: [NSLocalizedDescriptionKey: waveError!])
        }
        waveSource = source
        let onlineRadio = source == "online" && !offline
        let label = offline ? "Моя волна · без сети" : (onlineRadio ? "Онлайн-радио" : "Моя волна")
        try await play(trackIds: picks, at: 0, context: Context(type: onlineRadio ? "online-radio" : "wave", id: source, label: label), keepWave: true)
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
        waveOffline = false
        try await play(trackIds: ids, at: 0, context: Context(type: "wave", id: artist, label: "\(artist) и похожие"), keepWave: true)
    }

    func remapTracks(_ mapping: [String: String]) {
        entries = entries.map { Entry(entryId: $0.entryId, trackId: mapping[$0.trackId] ?? $0.trackId) }
        originalEntries = originalEntries?.map { Entry(entryId: $0.entryId, trackId: mapping[$0.trackId] ?? $0.trackId) }
        onStateChange?()
    }

    func syncFromHost(_ snapshot: [String: Any]) {
        guard snapshot["active"] as? Bool == true else { return }
        if let idx = snapshot["index"] as? Int { hostIndex = idx }
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
        checkWaveBuffering(snapshot)
    }

    private func checkWaveBuffering(_ snapshot: [String: Any]) {
        guard !waveLoading, let source = waveSource, let entry = currentEntry,
              snapshot["entryId"] as? String == entry.entryId else { return }
        let waiting = snapshot["waitingForPreparation"] as? Bool == true
        let recover = waveOffline && snapshot["ended"] as? Bool == true && !waiting
            && (snapshot["count"] as? Int ?? 0) == hostIndex + 1
            && NativeShellStore.shared?.offline != true
        var waitingForNetwork = false
        if !waveOffline && waiting {
            let upcoming = entries.dropFirst(index + 1).map(\.trackId)
            let downloaded = Set(downloadedIds(for: upcoming))
            waitingForNetwork = upcoming.contains { !downloaded.contains($0) && NativeShellStore.shared?.byId[$0]?.offline != true }
        }
        guard recover || waitingForNetwork else {
            waveWaitTask?.cancel(); waveWaitTask = nil; waveWaitEntry = nil
            return
        }
        guard waveWaitEntry != entry.entryId else { return }
        waveWaitTask?.cancel()
        waveWaitEntry = entry.entryId
        let rev = revision
        let delay = recover ? max(0, retryWaveOnlineAt - ProcessInfo.processInfo.systemUptime) : Self.networkWait
        waveWaitTask = Task { @MainActor in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            let host = NativeMixHost.shared.snapshot
            guard !Task.isCancelled, revision == rev, !waveLoading, currentEntry == entry,
                  host["entryId"] as? String == entry.entryId,
                  host[waitingForNetwork ? "waitingForPreparation" : "ended"] as? Bool == true else { return }
            if recover && NativeShellStore.shared?.offline == true { return }
            if waitingForNetwork { retryWaveOnlineAt = ProcessInfo.processInfo.systemUptime + 60 }
            do { try await launchWave(source: source, offline: waitingForNetwork || NativeShellStore.shared?.offline == true) }
            catch { if !NativeShellStore.isCancelled(error) { NativeShellStore.shared?.show(error.localizedDescription) } }
        }
    }

    /// Wave settings changed: the next launch must build a fresh queue with them.
    func resetForNewSettings() {
        revision &+= 1
        waveWaitTask?.cancel(); waveWaitTask = nil; waveWaitEntry = nil
        waveSource = nil
        waveOffline = false
        yandexSessionId = nil
        waveError = nil
        waveLoading = false
        entries = []
        index = 0
        originalEntries = nil
        context = Context(type: "library", id: nil, label: "Медиатека")
        if NativeMixHost.shared.active { NativeMixHost.shared.stop { _ in } }
        onStateChange?()
    }

    // MARK: - Private

    private func startAt(_ targetIndex: Int, paused: Bool) async throws {
        guard entries.indices.contains(targetIndex) else { return }
        revision &+= 1
        let rev = revision
        let entry = entries[targetIndex]
        finishPlay(reason: "skip")

        let nativeFiles = downloadedIds(for: [entry.trackId])
        let networkSource = nativeFiles.isEmpty && NativeShellStore.shared?.byId[entry.trackId]?.offline != true
        let deadline = ProcessInfo.processInfo.systemUptime + Self.networkWait
        let body: [String: Any] = [
            "entries": [["entryId": entry.entryId, "trackId": entry.trackId, "file": 0]],
            "previousId": entry.trackId,
            "nativeFiles": nativeFiles,
        ]
        let manifest: [String: Any]
        do {
            manifest = try await NativeServerApp.request("POST", "/api/mobile/native-sources", body: body, timeout: networkSource ? Self.networkWait : 30)
        } catch let error as URLError where error.code == .timedOut && networkSource {
            guard rev == revision else { throw CancellationError() }
            throw NativeMediaHTTP.Failure.transport(error.errorCode)
        }
        guard rev == revision else { throw CancellationError() }
        guard let item = (manifest["items"] as? [[String: Any]])?.first else {
            throw NSError(domain: "NativeQueue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Источник трека недоступен"])
        }

        let host = NativeMixHost.shared
        NativePlaybackHooks.install(host)
        if sessionId == nil || !host.active {
            let begun = try await hostReply { host.begin($0) }
            guard rev == revision else { throw CancellationError() }
            sessionId = begun["id"] as? String
        }
        guard let sid = sessionId, rev == revision else { return }
        let resolved = try await resolveUploadSources([item], sessionId: sid)
        guard rev == revision else { throw CancellationError() }
        guard let preparedItem = resolved.first else {
            throw NSError(domain: "NativeQueue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Файл трека недоступен"])
        }
        let config: [String: Any] = ["sampleRate": 48000.0, "position": 0.0, "paused": paused, "gainDb": 0.0]
        let state: [String: Any]
        let timeout = networkSource ? max(0, deadline - ProcessInfo.processInfo.systemUptime) : Self.networkWait
        do {
            state = try await hostReply { host.prepareStart(id: sid, item: preparedItem, config: config, networkTimeout: timeout, completion: $0) }
        } catch {
            guard rev == revision else { throw CancellationError() }
            throw error
        }
        guard rev == revision else { throw CancellationError() }
        hostIndex = state["index"] as? Int ?? 0

        beginPlay(entry)
        saveQueueState()
        onStateChange?()
        scheduleSync()
        if isWave { Task { @MainActor in await topUpWaveIfNeeded() } }
    }

    private func scheduleSync(replaceFuture: Bool = false) {
        syncTask?.cancel()
        syncTask = Task { @MainActor in
            await syncQueue(replaceFuture: replaceFuture)
        }
    }

    private func syncQueue(replaceFuture: Bool = false) async {
        guard let sid = sessionId, NativeMixHost.shared.active, let current = currentEntry else { return }
        let rev = revision
        let upcoming = repeatMode == "one" ? [] : Array(entries.dropFirst(index + 1))
        let loopEntries: [Entry] = repeatMode == "one" ? [current] : (repeatMode == "all" ? entries : [])
        guard replaceFuture || !upcoming.isEmpty || !loopEntries.isEmpty else { return }

        let all = upcoming + loopEntries
        var futureItems: [[String: Any]] = []
        var loopItems: [[String: Any]] = []
        var previousMeta: [String: Any] = ["trackId": current.trackId, "duration": 0.0, "mixingAllowed": false]
        var settingsMeta: [String: Any] = ["enabled": automixEnabled]

        if !all.isEmpty {
            let nativeFiles = downloadedIds(for: all.map(\.trackId))
            let bodyEntries = all.enumerated().map { idx, e -> [String: Any] in
                ["entryId": e.entryId, "trackId": e.trackId, "file": idx]
            }
            guard let manifest = try? await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
                "entries": bodyEntries,
                "previousId": current.trackId,
                "nativeFiles": nativeFiles,
            ]), rev == revision else { return }

            let rawItems = manifest["items"] as? [[String: Any]] ?? []
            let items = (try? await resolveUploadSources(rawItems, sessionId: sid)) ?? rawItems
            guard rev == revision else { return }
            let upcomingIds = Set(upcoming.map(\.entryId))
            futureItems = items.filter { upcomingIds.contains($0["entryId"] as? String ?? "") }
            loopItems = items.filter { !upcomingIds.contains($0["entryId"] as? String ?? "") }
            if let prev = manifest["previous"] as? [String: Any] { previousMeta = prev }
            if let st = manifest["settings"] as? [String: Any] {
                settingsMeta = st
                if let enabled = st["enabled"] as? Bool { automixEnabled = enabled }
            }
        }
        let hostManifest: [String: Any] = [
            "from": hostIndex + 1,
            "items": futureItems,
            "loopItems": loopItems,
            "replaceFuture": replaceFuture,
            "previous": previousMeta,
            "settings": settingsMeta,
            "retainedSources": [],
        ]
        _ = try? await hostReply { NativeMixHost.shared.prepareQueue(id: sid, manifest: hostManifest, completion: $0) }
    }

    private func topUpWaveIfNeeded() async {
        guard isWave, !toppingUpWave, entries.count - 1 - index <= 2 else { return }
        if waveOffline, NativeShellStore.shared?.offline != true,
           ProcessInfo.processInfo.systemUptime >= retryWaveOnlineAt { return }
        toppingUpWave = true
        defer { toppingUpWave = false }
        let existing = Set(entries.map(\.trackId))
        let rev = revision
        if waveSource == "yandex" && !waveOffline {
            var yBody: [String: Any] = ["count": 2, "queue": Array(yandexQueueIds.suffix(100))]
            if let yandexSessionId { yBody["session"] = yandexSessionId }
            guard let res = try? await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: yBody) else { return }
            guard rev == revision else { return }
            if let s = (res["sessionId"] as? String) ?? (res["session"] as? String) { yandexSessionId = s }
            let items = res["items"] as? [[String: Any]] ?? []
            var newIds: [String] = []
            for item in items {
                if let yid = item["yandexId"] as? String, !yid.isEmpty, !yandexQueueIds.contains(yid) { yandexQueueIds.append(yid) }
                let tid: String?
                if let existingId = item["trackId"] as? String, !existingId.isEmpty { tid = existingId }
                else if let track = item["track"] as? [String: Any],
                        let imp = try? await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track]) {
                    tid = imp["trackId"] as? String
                } else { tid = nil }
                guard rev == revision else { return }
                if let tid, !existing.contains(tid), !newIds.contains(tid), (NativeShellStore.shared?.reaction(tid) ?? 0) >= 0 {
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
            "offline": waveOffline,
        ]
        if let currentId = currentEntry?.trackId { nextBody["currentId"] = currentId }
        guard let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: nextBody) else { return }
        guard rev == revision else { return }
        var picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { !existing.contains($0) }
        if waveOffline && picks.count < 3 { picks += downloadedWaveTracks(excluding: existing.union(picks), count: 3 - picks.count) }
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

    private func resolveUploadSources(_ items: [[String: Any]], sessionId sid: String) async throws -> [[String: Any]] {
        let uploadIndices = items.indices.filter { ($0 >= 0) && ((items[$0]["source"] as? [String: Any])?["kind"] as? String == "upload") }
        var keys: [Int] = []
        if !uploadIndices.isEmpty {
            let reserved = try await hostReply { NativeMixHost.shared.reserveSources(id: sid, count: uploadIndices.count, completion: $0) }
            keys = reserved["keys"] as? [Int] ?? []
        }
        var out = items
        var keyCursor = 0
        for i in out.indices {
            if let tid = out[i]["trackId"] as? String, ((out[i]["duration"] as? NSNumber)?.doubleValue ?? 0) <= 0,
               let d = NativeShellStore.shared?.byId[tid]?.duration, d > 0 {
                out[i]["duration"] = d
            }
            guard let source = out[i]["source"] as? [String: Any], source["kind"] as? String == "upload" else { continue }
            guard keyCursor < keys.count else { continue }
            let key = keys[keyCursor]; keyCursor += 1
            let tid = source["trackId"] as? String ?? (out[i]["trackId"] as? String ?? "")
            let url: URL? = (source["serverPath"] as? String).flatMap { NativeMediaLoader.sharedFile($0, root: NativeServerApp.root) }
                ?? NativeDownloadManager.shared.localFile(tid)
            guard let url,
                  let reply = try? await hostReply({ NativeMixHost.shared.sourceFromDownload(id: sid, key: key, file: url, completion: $0) }) else { continue }
            if reply["found"] as? Bool == true {
                out[i]["source"] = ["kind": "local", "file": key]
                out[i]["file"] = key
            }
        }
        return out.filter { ($0["source"] as? [String: Any])?["kind"] as? String != "upload" }
    }

    private func downloadedIds(for trackIds: [String]) -> [String] {
        let done = Set(NativeDownloadManager.shared.jobs.filter { $0.state == .done }.map(\.trackId))
        return trackIds.filter { done.contains($0) }
    }

    private func downloadedWaveTracks(excluding: Set<String>, count: Int) -> [String] {
        let downloads = NativeDownloadManager.shared
        let ids = Set(downloads.jobs.filter { $0.state == .done }.map(\.trackId)).subtracting(excluding)
        return Array(ids.shuffled().lazy.filter {
            (NativeShellStore.shared?.reaction($0) ?? 0) >= 0 && downloads.localFile($0) != nil
        }.prefix(count))
    }

    private func hostReply(_ call: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            call { continuation.resume(with: $0) }
        }
    }
}
