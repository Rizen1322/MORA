import Foundation

/// Stage 4: Native queue, wave refill, and playback orchestration in Swift using NativeServerApp
/// and NativeMixHost directly, without depending on the WebView audio controller.
@MainActor final class NativeQueueController {
    struct Entry: Equatable {
        let entryId: String
        let trackId: String
        var yandexId: String? = nil
        var yandexSessionId: String? = nil
        var yandexBatchId: String? = nil
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
    private var waveRequestId = 0
    private var waveFallbackActive = false
    private var activePlayId: Int?
    private var activePlayEntry: Entry?
    private var playStartedAt = Date()
    private var yandexSessionId: String?
    private var yandexQueueIds: [String] = []
    private var toppingUpWave = false
    private var syncTask: Task<Void, Never>?

    var onStateChange: (() -> Void)?

    var currentEntry: Entry? { entries.indices.contains(index) ? entries[index] : nil }
    var isWave: Bool { waveSource != nil || ["wave", "yandex-wave", "online-radio"].contains(context.type) }

    func play(trackIds: [String], at startIndex: Int, context: Context, startPaused: Bool = false, keepWave: Bool = false) async throws {
        let queue = trackIds.map { Entry(entryId: UUID().uuidString, trackId: $0) }
        try await playEntries(queue, at: startIndex, context: context, startPaused: startPaused, keepWave: keepWave)
    }

    private func playEntries(_ items: [Entry], at startIndex: Int, context: Context, startPaused: Bool = false, keepWave: Bool = false) async throws {
        guard !items.isEmpty else { return }
        if !keepWave {
            waveRequestId &+= 1
            waveSource = nil
            waveFallbackActive = false
            yandexSessionId = nil
            yandexQueueIds = []
            waveError = nil
        }
        var queue = items
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
        let chosen = (source == "yandex" || source == "online") ? source : "own"
        if waveSource == chosen && NativeMixHost.shared.active && !(waveFallbackActive && !offline) {
            try await command("toggle")
            return
        }
        waveRequestId &+= 1
        let reqId = waveRequestId
        waveLoading = true
        waveError = nil
        waveOffline = offline
        onStateChange?()
        defer {
            if reqId == waveRequestId {
                waveLoading = false
                onStateChange?()
            }
        }

        if offline {
            let picks = await fetchOfflineWaveTrackIds(count: 4)
            guard reqId == waveRequestId else { return }
            guard !picks.isEmpty else {
                waveSource = nil
                waveFallbackActive = false
                waveError = "Нет скачанных треков для офлайн-волны"
                throw NSError(domain: "NativeWave", code: 2, userInfo: [NSLocalizedDescriptionKey: waveError!])
            }
            waveSource = chosen
            waveFallbackActive = chosen != "own"
            waveOffline = true
            NativeShellStore.shared?.show("Нет сети — включил волну из загрузок")
            try await play(trackIds: picks, at: 0, context: waveContext(for: chosen, offlineFallback: true), keepWave: true)
            return
        }

        if chosen == "yandex" {
            do {
                let res = try await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: ["count": 3, "queue": Array(yandexQueueIds.suffix(100))])
                let sid = (res["sessionId"] as? String) ?? (res["session"] as? String)
                let batchId = res["batchId"] as? String
                let isNewSession = sid != nil && sid != yandexSessionId
                yandexSessionId = sid
                let waveEntries = await collectYandexWaveEntries(from: res, limit: 3, excluding: [])
                guard reqId == waveRequestId else { return }
                guard !waveEntries.isEmpty else {
                    throw NSError(domain: "NativeWave", code: 1, userInfo: [NSLocalizedDescriptionKey: "Яндекс Музыка не вернула треки"])
                }
                if isNewSession, let sid {
                    sendYandexFeedback(sessionId: sid, batchId: batchId, event: ["type": "radioStarted", "from": "desktop_home-radio_bubble-default"])
                }
                waveSource = "yandex"
                waveFallbackActive = false
                waveOffline = false
                try await playEntries(waveEntries, at: 0, context: waveContext(for: "yandex", offlineFallback: false), keepWave: true)
                return
            } catch {
                guard reqId == waveRequestId else { return }
                let fallback = await fetchOfflineWaveTrackIds(count: 4)
                guard reqId == waveRequestId else { return }
                if !fallback.isEmpty {
                    waveSource = "yandex"
                    waveFallbackActive = true
                    waveOffline = NativeShellStore.shared?.offline ?? true
                    NativeShellStore.shared?.show("Нет связи с Яндексом — играю из загрузок")
                    try await play(trackIds: fallback, at: 0, context: waveContext(for: "yandex", offlineFallback: true), keepWave: true)
                    return
                }
                waveSource = nil
                waveFallbackActive = false
                waveError = error.localizedDescription
                throw error
            }
        }

        if chosen == "online" {
            do {
                let radioEntries = try await fetchOnlineRadioEntries(count: 3, excluding: [])
                guard reqId == waveRequestId else { return }
                waveSource = "online"
                waveFallbackActive = false
                waveOffline = false
                try await playEntries(radioEntries, at: 0, context: waveContext(for: "online", offlineFallback: false), keepWave: true)
                return
            } catch {
                guard reqId == waveRequestId else { return }
                let fallback = await fetchOfflineWaveTrackIds(count: 4)
                guard reqId == waveRequestId else { return }
                if !fallback.isEmpty {
                    waveSource = "online"
                    waveFallbackActive = true
                    waveOffline = NativeShellStore.shared?.offline ?? true
                    NativeShellStore.shared?.show("Нет связи с радио — играю из загрузок")
                    try await play(trackIds: fallback, at: 0, context: waveContext(for: "online", offlineFallback: true), keepWave: true)
                    return
                }
                waveSource = nil
                waveFallbackActive = false
                waveError = error.localizedDescription
                throw error
            }
        }

        do {
            let res = try await NativeServerApp.request("POST", "/api/wave/next", body: ["count": 4, "offline": false])
            guard reqId == waveRequestId else { return }
            let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            guard !picks.isEmpty else {
                waveSource = nil
                waveFallbackActive = false
                waveError = "Добавьте треки в медиатеку, чтобы запустить волну"
                throw NSError(domain: "NativeWave", code: 2, userInfo: [NSLocalizedDescriptionKey: waveError!])
            }
            waveSource = "own"
            waveFallbackActive = false
            waveOffline = false
            try await play(trackIds: picks, at: 0, context: waveContext(for: "own", offlineFallback: false), keepWave: true)
        } catch {
            guard reqId == waveRequestId else { return }
            waveSource = nil
            waveFallbackActive = false
            waveError = error.localizedDescription
            throw error
        }
    }

    func handleNetworkChange(offline: Bool) {
        waveOffline = offline
        guard isWave, NativeMixHost.shared.active, let source = waveSource else { return }
        if !offline && (source == "yandex" || source == "online") {
            waveFallbackActive = false
            context = waveContext(for: source, offlineFallback: false)
            if index + 1 < entries.count {
                entries.removeSubrange((index + 1)..<entries.count)
            }
            onStateChange?()
            Task { @MainActor in await self.topUpWaveIfNeeded(force: true) }
        } else if offline && (source == "yandex" || source == "online") {
            waveFallbackActive = true
            context = waveContext(for: source, offlineFallback: true)
            onStateChange?()
        }
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

    func remapTracks(_ mapping: [String: String]) {
        let remap = { (e: Entry) in Entry(entryId: e.entryId, trackId: mapping[e.trackId] ?? e.trackId, yandexId: e.yandexId, yandexSessionId: e.yandexSessionId, yandexBatchId: e.yandexBatchId) }
        entries = entries.map(remap)
        originalEntries = originalEntries?.map(remap)
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
    }

    /// Wave settings changed: the next launch must build a fresh queue with them.
    func resetForNewSettings() {
        waveRequestId &+= 1
        waveSource = nil
        waveFallbackActive = false
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
        let resolved = try await resolveUploadSources([item], sessionId: sid)
        guard let preparedItem = resolved.first, rev == revision else {
            throw NSError(domain: "NativeQueue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Файл трека недоступен"])
        }
        let config: [String: Any] = ["sampleRate": 48000.0, "position": 0.0, "paused": paused, "gainDb": 0.0]
        let state = try await hostReply { host.prepareStart(id: sid, item: preparedItem, config: config, completion: $0) }
        guard rev == revision else { return }
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

    private func waveContext(for source: String, offlineFallback: Bool) -> Context {
        switch source {
        case "yandex":
            return Context(type: "yandex-wave", id: "yandex", label: offlineFallback ? "Моя волна · Яндекс (офлайн)" : "Моя волна · Яндекс")
        case "online":
            return Context(type: "online-radio", id: "online", label: offlineFallback ? "Онлайн-радио (офлайн)" : "Онлайн-радио")
        default:
            return Context(type: "wave", id: "own", label: offlineFallback ? "Моя волна · Офлайн" : "Моя волна")
        }
    }

    private func fetchOfflineWaveTrackIds(count: Int, excluding: Set<String> = []) async -> [String] {
        let clampedCount = max(1, min(20, count))
        var body: [String: Any] = [
            "count": clampedCount,
            "offline": true,
            "session": Array(entries.suffix(12).map(\.trackId)),
            "exclude": Array(excluding.prefix(60)),
        ]
        if let currentId = currentEntry?.trackId { body["currentId"] = currentId }
        if let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: body) {
            let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { !excluding.contains($0) }
            if !picks.isEmpty { return picks }
        }
        if !excluding.isEmpty {
            var retryBody: [String: Any] = [
                "count": clampedCount,
                "offline": true,
                "session": Array(entries.suffix(12).map(\.trackId)),
                "exclude": currentEntry.map { [$0.trackId] } ?? [],
            ]
            if let currentId = currentEntry?.trackId { retryBody["currentId"] = currentId }
            if let retry = try? await NativeServerApp.request("POST", "/api/wave/next", body: retryBody) {
                let picks = (retry["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
                if !picks.isEmpty { return picks }
            }
        }
        let store = NativeShellStore.shared
        var offlinePool = Set(NativeDownloadManager.shared.jobs.compactMap { job in
            job.state == .done && NativeDownloadManager.shared.localFile(job.trackId) != nil && (store?.reaction(job.trackId) ?? 0) >= 0 ? job.trackId : nil
        })
        if let store {
            for track in store.library where track.offline && track.ok && track.reaction >= 0 {
                offlinePool.insert(track.id)
            }
        }
        let fresh = offlinePool.filter { !excluding.contains($0) }.shuffled()
        if !fresh.isEmpty { return Array(fresh.prefix(clampedCount)) }
        let looped = offlinePool.filter { $0 != currentEntry?.trackId }.shuffled()
        return Array(looped.prefix(clampedCount))
    }

    private func fetchOnlineRadioEntries(count: Int, excluding: Set<String>) async throws -> [Entry] {
        let store = NativeShellStore.shared
        let candidates = (store?.library ?? []).filter { $0.ok && $0.reaction >= 0 && !excluding.contains($0.id) }
        let liked = candidates.filter(\.liked)
        let recent = candidates.filter { $0.lastPlayedAt > 0 }.sorted { $0.lastPlayedAt > $1.lastPlayedAt }
        let seedTrack = currentEntry.flatMap { store?.byId[$0.trackId] }
            ?? liked.randomElement()
            ?? recent.prefix(12).randomElement()
            ?? candidates.randomElement()
            ?? store?.library.first(where: { $0.ok && $0.reaction >= 0 })

        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        var videoId: String?
        if let seed = seedTrack {
            let queryText = "\(seed.artist) \(seed.title)".trimmingCharacters(in: .whitespacesAndNewlines)
            let encodedQuery = queryText.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
            if !encodedQuery.isEmpty,
               let searchRes = try? await NativeServerApp.request("GET", "/api/search/ytmusic?q=\(encodedQuery)"),
               let firstPlayable = (searchRes["items"] as? [[String: Any]])?.first(where: { $0["playable"] as? Bool != false }) {
                videoId = firstPlayable["externalId"] as? String
            }
        }
        guard let seedVideoId = videoId, !seedVideoId.isEmpty else {
            throw NSError(domain: "NativeWave", code: 10, userInfo: [NSLocalizedDescriptionKey: "Не удалось найти основу для онлайн-радио"])
        }
        let encodedId = seedVideoId.addingPercentEncoding(withAllowedCharacters: allowed) ?? seedVideoId
        let radioRes = try await NativeServerApp.request("GET", "/api/public/radio/\(encodedId)")
        let radioItems = radioRes["items"] as? [[String: Any]] ?? []
        var picked: [Entry] = []
        var seenIds = excluding
        for item in radioItems {
            guard picked.count < count else { break }
            guard item["playable"] as? Bool != false else { continue }
            if let existingId = item["libraryTrackId"] as? String, !existingId.isEmpty {
                if seenIds.contains(existingId) || (store?.reaction(existingId) ?? 0) < 0 { continue }
                seenIds.insert(existingId)
                picked.append(Entry(entryId: UUID().uuidString, trackId: existingId))
                continue
            }
            guard let extId = item["externalId"] as? String, !extId.isEmpty else { continue }
            let provider = item["audioProvider"] as? String ?? "youtube"
            guard let prep = try? await NativeServerApp.request("POST", "/api/public/prepare", body: [
                "provider": provider,
                "externalId": extId,
                "progressive": true,
            ]), let tid = prep["trackId"] as? String, !tid.isEmpty else { continue }
            if seenIds.contains(tid) || (store?.reaction(tid) ?? 0) < 0 { continue }
            seenIds.insert(tid)
            picked.append(Entry(entryId: UUID().uuidString, trackId: tid))
        }
        guard !picked.isEmpty else {
            throw NSError(domain: "NativeWave", code: 11, userInfo: [NSLocalizedDescriptionKey: "Онлайн-радио не вернуло доступных треков"])
        }
        return picked
    }

    private func topUpWaveIfNeeded(force: Bool = false) async {
        guard isWave, !toppingUpWave, (force || entries.count - 1 - index <= 2) else { return }
        toppingUpWave = true
        defer { toppingUpWave = false }
        let existing = Set(entries.map(\.trackId))
        let isOffline = NativeShellStore.shared?.offline ?? waveOffline

        if waveSource == "yandex" {
            if !isOffline {
                var yBody: [String: Any] = ["count": 2, "queue": Array(yandexQueueIds.suffix(100))]
                if let yandexSessionId { yBody["session"] = yandexSessionId }
                if let res = try? await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: yBody) {
                    if let s = (res["sessionId"] as? String) ?? (res["session"] as? String) { yandexSessionId = s }
                    let newEntries = await collectYandexWaveEntries(from: res, limit: 2, excluding: existing)
                    if !newEntries.isEmpty {
                        waveFallbackActive = false
                        waveOffline = false
                        context = waveContext(for: "yandex", offlineFallback: false)
                        entries.append(contentsOf: newEntries)
                        onStateChange?()
                        scheduleSync(replaceFuture: force)
                        return
                    }
                }
            }
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            if !fallback.isEmpty {
                waveFallbackActive = true
                context = waveContext(for: "yandex", offlineFallback: true)
                entries.append(contentsOf: fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
                onStateChange?()
                scheduleSync(replaceFuture: force)
            }
            return
        }

        if waveSource == "online" {
            if !isOffline,
               let radioEntries = try? await fetchOnlineRadioEntries(count: 2, excluding: existing),
               !radioEntries.isEmpty {
                waveFallbackActive = false
                waveOffline = false
                context = waveContext(for: "online", offlineFallback: false)
                entries.append(contentsOf: radioEntries)
                onStateChange?()
                scheduleSync(replaceFuture: force)
                return
            }
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            if !fallback.isEmpty {
                waveFallbackActive = true
                context = waveContext(for: "online", offlineFallback: true)
                entries.append(contentsOf: fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
                onStateChange?()
                scheduleSync(replaceFuture: force)
            }
            return
        }

        if isOffline {
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            if !fallback.isEmpty {
                entries.append(contentsOf: fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
                onStateChange?()
                scheduleSync(replaceFuture: force)
            }
            return
        }

        var nextBody: [String: Any] = [
            "session": Array(entries.suffix(12).map(\.trackId)),
            "count": 3,
            "exclude": Array(existing.prefix(60)),
            "offline": false,
        ]
        if let currentId = currentEntry?.trackId { nextBody["currentId"] = currentId }
        guard let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: nextBody) else { return }
        let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { !existing.contains($0) }
        if !picks.isEmpty {
            entries.append(contentsOf: picks.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            onStateChange?()
            scheduleSync(replaceFuture: force)
        }
    }

    private func collectYandexWaveEntries(from res: [String: Any], limit: Int, excluding: Set<String>) async -> [Entry] {
        let sid = (res["sessionId"] as? String) ?? (res["session"] as? String) ?? yandexSessionId
        let batchId = res["batchId"] as? String
        let items = res["items"] as? [[String: Any]] ?? []
        var picked: [Entry] = []
        var seen = Set<String>()
        for item in items {
            guard picked.count < limit else { break }
            let yid = item["yandexId"] as? String
            let tid: String?
            if let existingId = item["trackId"] as? String, !existingId.isEmpty { tid = existingId }
            else if let track = item["track"] as? [String: Any],
                    let imp = try? await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track]) {
                tid = imp["trackId"] as? String
            } else { tid = nil }
            if let tid, !excluding.contains(tid), seen.insert(tid).inserted, (NativeShellStore.shared?.reaction(tid) ?? 0) >= 0 {
                if let yid, !yid.isEmpty, !yandexQueueIds.contains(yid) { yandexQueueIds.append(yid) }
                picked.append(Entry(entryId: UUID().uuidString, trackId: tid, yandexId: yid, yandexSessionId: sid, yandexBatchId: batchId))
            }
        }
        return picked
    }

    private func sendYandexFeedback(sessionId: String, batchId: String?, event: [String: Any]) {
        var body: [String: Any] = ["sessionId": sessionId, "event": event]
        if let batchId, !batchId.isEmpty { body["batchId"] = batchId } else { body["batchId"] = NSNull() }
        Task { _ = try? await NativeServerApp.request("POST", "/api/providers/yandex/feedback", body: body) }
    }

    private func stopPlayback() {
        finishPlay(reason: "stop")
        sessionId = nil
        NativeMixHost.shared.stop { _ in }
        onStateChange?()
    }

    private func beginPlay(_ entry: Entry) {
        playStartedAt = Date()
        activePlayEntry = entry
        if let sid = entry.yandexSessionId, !sid.isEmpty, let yid = entry.yandexId, !yid.isEmpty {
            sendYandexFeedback(sessionId: sid, batchId: entry.yandexBatchId, event: ["type": "trackStarted", "trackId": yid])
        }
        let tid = entry.trackId, ctx = context.type
        Task {
            if let res = try? await NativeServerApp.request("POST", "/api/plays", body: ["trackId": tid, "context": ctx]),
               let id = res["id"] as? Int {
                await MainActor.run { self.activePlayId = id }
            }
        }
    }

    private func finishPlay(reason: String) {
        let playedSec = max(0.0, Date().timeIntervalSince(playStartedAt))
        let finishedEntry = activePlayEntry
        activePlayEntry = nil
        if let finishedEntry, let sid = finishedEntry.yandexSessionId, !sid.isEmpty, let yid = finishedEntry.yandexId, !yid.isEmpty {
            let type: String?
            if reason == "transition" || reason == "ended" || playedSec >= 30 { type = "trackFinished" }
            else if reason == "skip" { type = "skip" }
            else { type = nil }
            if let type {
                sendYandexFeedback(sessionId: sid, batchId: finishedEntry.yandexBatchId, event: [
                    "type": type,
                    "trackId": yid,
                    "totalPlayedSeconds": Int(playedSec.rounded()),
                ])
            }
        }
        guard let id = activePlayId else { return }
        activePlayId = nil
        let ms = Int(max(0, playedSec * 1000))
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

    private func hostReply(_ call: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            call { continuation.resume(with: $0) }
        }
    }
}
