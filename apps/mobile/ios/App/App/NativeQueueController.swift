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
    private var originalOrder: [String]?
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
    private var startingRevision: Int?
    private var hostIndex = 0
    private var waveOffline = false
    private var waveOfflineOnly = false
    private var waveRequestId = 0
    private var waveFallbackActive = false
    private var activePlayRecord: Task<Int?, Never>?
    private var activePlayEntry: Entry?
    private var playStartedAt = Date()
    private var yandexSessionId: String?
    private var yandexQueueIds: [String] = []
    private var toppingUpWave: Int?
    private var syncTask: Task<Void, Never>?
    private var windowContinuation: (job: String, offset: Int)?
    private(set) var restoredPosition: Double = 0
    private var didRestoreQueue = false
    private var prefetchedIds = Set<String>()
    private var cachedKeepWave: (count: Int, at: Date)?
    private var rescuedEndedEntryId: String?

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
            waveOfflineOnly = false
            waveFallbackActive = false
            yandexSessionId = nil
            yandexQueueIds = []
            waveError = nil
            waveLoading = false
        }
        var queue = items
        var targetIndex = max(0, min(queue.count - 1, startIndex))
        originalOrder = nil
        if shuffle && queue.count > 1 {
            let first = queue[targetIndex]
            var rest = queue.enumerated().filter { $0.offset != targetIndex }.map(\.element)
            rest.shuffle()
            originalOrder = queue.map(\.entryId)
            queue = [first] + rest
            targetIndex = 0
        }
        self.entries = queue
        self.index = targetIndex
        self.context = context
        self.restoredPosition = 0
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
            if let current = currentEntry, let anchor = originalOrder?.firstIndex(of: current.entryId) {
                originalOrder?.insert(contentsOf: added.map(\.entryId), at: anchor + 1)
            }
        } else {
            entries.append(contentsOf: added)
        }
        saveCurrentPosition()
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
                saveCurrentPosition()
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
                if let current = currentEntry { moveOriginal(entryId, after: current.entryId) }
                saveCurrentPosition()
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
                moveOriginal(entryId, after: after)
                saveCurrentPosition()
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
                if playing { saveCurrentPosition() }
                _ = try await hostReply { host.command(playing ? "pause" : "play", source: "native", completion: $0) }
            } else if entries.indices.contains(index) {
                let pos = restoredPosition
                restoredPosition = 0
                try await startAt(index, paused: false, startPosition: pos)
            }
            return
        }
        guard host.active else {
            if action == "play", entries.indices.contains(index) {
                let pos = restoredPosition
                restoredPosition = 0
                try await startAt(index, paused: false, startPosition: pos)
            } else if (action == "seek" || action == "seekto"), let seekTime {
                restoredPosition = max(0, seekTime)
                saveQueueState(position: restoredPosition)
                onStateChange?()
            }
            return
        }
        if action == "pause" {
            saveCurrentPosition()
        } else if (action == "seek" || action == "seekto"), let seekTime {
            saveQueueState(position: max(0, seekTime))
        }
        _ = try await hostReply { host.command(action, time: seekTime, source: "native", completion: $0) }
    }

    func setAutomixStyle(_ style: String) async throws {
        guard ["auto", "smooth", "tight", "off"].contains(style) else {
            throw NSError(domain: "NativeQueue", code: 6, userInfo: [NSLocalizedDescriptionKey: "Неизвестный стиль AutoMix"])
        }
        let settings = try await NativeServerApp.request("GET", "/api/settings", body: nil)
        var automix = settings["automix"] as? [String: Any] ?? [:]
        let enabled = style != "off"
        automix["enabled"] = enabled
        if enabled { automix["style"] = style }
        automixEnabled = enabled
        _ = try await NativeServerApp.request("PUT", "/api/settings", body: ["automix": automix])
        if NativeMixHost.shared.active {
            _ = try? await hostReply { NativeMixHost.shared.settings(["automix": automix], completion: $0) }
        }
        onStateChange?()
    }

    func restoreSavedQueueIfNeeded() async {
        guard !didRestoreQueue, entries.isEmpty, !NativeMixHost.shared.active else { return }
        didRestoreQueue = true
        guard let saved = try? await NativeServerApp.request("GET", "/api/queue", body: nil),
              let rawItems = saved["items"] as? [[String: Any]], !rawItems.isEmpty,
              entries.isEmpty, !NativeMixHost.shared.active else { return }

        let byId = NativeShellStore.shared?.byId ?? [:]
        let rawIndex = (saved["index"] as? NSNumber)?.intValue ?? 0
        var restored: [Entry] = []
        var mappedIndex = 0
        for (offset, item) in rawItems.enumerated() {
            guard let tid = item["trackId"] as? String, !tid.isEmpty, byId[tid] != nil else { continue }
            if offset <= rawIndex { mappedIndex = restored.count }
            let eid = (item["entryId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            restored.append(Entry(entryId: eid, trackId: tid))
        }
        guard !restored.isEmpty else { return }

        let ctxRaw = saved["context"] as? [String: Any]
        let ctxType = ctxRaw?["type"] as? String ?? "library"
        let ctxId = ctxRaw?["id"] as? String
        let ctxLabel = ctxRaw?["label"] as? String ?? "Медиатека"
        let restoredPos = max(0.0, (saved["position"] as? NSNumber)?.doubleValue ?? 0)

        entries = restored
        index = max(0, min(restored.count - 1, mappedIndex))
        context = Context(type: ctxType, id: ctxId, label: ctxLabel)
        shuffle = saved["shuffle"] as? Bool == true
        if shuffle {
            originalOrder = NativeMixTimeline.restoredOrder(saved["unshuffledEntryIds"] as? [String] ?? [], available: entries.map(\.entryId))
        }
        if let rep = saved["repeat"] as? String, ["off", "all", "one"].contains(rep) {
            repeatMode = rep
        }
        restoredPosition = restoredPos
        waveOfflineOnly = saved["waveOfflineOnly"] as? Bool == true
        if ctxType == "yandex-wave" { waveSource = "yandex" }
        else if ctxType == "online-radio" { waveSource = "online" }
        else if ctxType == "wave" { waveSource = "own" }
        onStateChange?()
    }

    func saveCurrentPosition() {
        guard !entries.isEmpty else { return }
        let pos: Double
        if NativeMixHost.shared.active {
            pos = max(0.0, (NativeMixHost.shared.snapshot["position"] as? NSNumber)?.doubleValue ?? 0)
        } else {
            pos = max(0.0, restoredPosition)
        }
        saveQueueState(position: pos)
    }

    private func moveOriginal(_ entryId: String, after: String) {
        guard let originalOrder else { return }
        var order = NativeMixTimeline.restoredOrder(originalOrder, available: entries.map(\.entryId))
        order.removeAll { $0 == entryId }
        guard let anchor = order.firstIndex(of: after) else { return }
        order.insert(entryId, at: anchor + 1)
        self.originalOrder = order
    }

    func setMode(_ mode: String) async throws {
        switch mode {
        case "shuffle":
            shuffle.toggle()
            if shuffle, entries.count > 1, let cur = currentEntry {
                originalOrder = entries.map(\.entryId)
                var rest = entries.filter { $0.entryId != cur.entryId }
                rest.shuffle()
                entries = [cur] + rest
                index = 0
            } else if !shuffle {
                if let originalOrder, let cur = currentEntry {
                    let byEntry = Dictionary(entries.map { ($0.entryId, $0) }, uniquingKeysWith: { first, _ in first })
                    entries = NativeMixTimeline.restoredOrder(originalOrder, available: entries.map(\.entryId)).compactMap { byEntry[$0] }
                    index = entries.firstIndex(where: { $0.entryId == cur.entryId }) ?? 0
                }
                self.originalOrder = nil
            }
            saveCurrentPosition()
            onStateChange?()
            scheduleSync()
        case "repeat":
            repeatMode = repeatMode == "off" ? "all" : repeatMode == "all" ? "one" : "off"
            saveCurrentPosition()
            onStateChange?()
            scheduleSync()
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

    func startWave(source: String, offline: Bool, offlineOnly: Bool = false) async throws {
        let chosen = (source == "yandex" || source == "online") ? source : "own"
        let useOffline = offlineOnly || offline
        if waveSource == chosen, waveOfflineOnly == offlineOnly, (NativeMixHost.shared.active || !entries.isEmpty),
           !(waveFallbackActive && !useOffline) {
            if offlineOnly {
                if NativeMixHost.shared.snapshot["playing"] as? Bool != true { try await command("play") }
            } else { try await command("toggle") }
            return
        }
        waveRequestId &+= 1
        let reqId = waveRequestId
        waveLoading = true
        waveError = nil
        onStateChange?()
        defer {
            if reqId == waveRequestId {
                waveLoading = false
                onStateChange?()
            }
        }

        if useOffline {
            let picks = await fetchOfflineWaveTrackIds(count: 4)
            guard reqId == waveRequestId else { return }
            guard !picks.isEmpty else {
                waveSource = nil
                waveFallbackActive = false
                waveError = "Нет скачанных треков для офлайн-волны"
                throw NSError(domain: "NativeWave", code: 2, userInfo: [NSLocalizedDescriptionKey: waveError!])
            }
            waveSource = chosen
            waveOfflineOnly = offlineOnly
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
                let waveEntries = await collectYandexWaveEntries(from: res, limit: 3, excluding: [])
                guard reqId == waveRequestId else { return }
                guard !waveEntries.isEmpty else {
                    throw NSError(domain: "NativeWave", code: 1, userInfo: [NSLocalizedDescriptionKey: "Яндекс Музыка не вернула треки"])
                }
                if let sid, sid != yandexSessionId {
                    sendYandexFeedback(sessionId: sid, batchId: batchId, event: ["type": "radioStarted", "from": "desktop_home-radio_bubble-default"])
                }
                yandexSessionId = sid
                rememberYandexEntries(waveEntries)
                waveSource = "yandex"
                waveOfflineOnly = false
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
                    waveOfflineOnly = false
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
                waveOfflineOnly = false
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
                    waveOfflineOnly = false
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
            waveOfflineOnly = false
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
        let changed = offline != waveOffline
        waveOffline = offline
        guard changed, !waveOfflineOnly, !waveLoading, isWave, NativeMixHost.shared.active, let source = waveSource else { return }
        waveRequestId &+= 1
        if !offline && (source == "yandex" || source == "online") {
            waveFallbackActive = false
            context = waveContext(for: source, offlineFallback: false)
            if index + 1 < entries.count {
                entries.removeSubrange((index + 1)..<entries.count)
            }
            onStateChange?()
            scheduleSync()
            Task { @MainActor in await self.topUpWaveIfNeeded(force: true) }
        } else if offline && (source == "yandex" || source == "online") {
            waveFallbackActive = true
            context = waveContext(for: source, offlineFallback: true)
            pruneUndownloadedFuture()
            onStateChange?()
            scheduleSync()
            Task { @MainActor in await self.topUpWaveIfNeeded(force: true) }
        }
    }

    private func isDownloaded(_ trackId: String) -> Bool {
        NativeDownloadManager.shared.localFile(trackId) != nil || NativeShellStore.shared?.byId[trackId]?.offline == true
    }

    private func pruneUndownloadedFuture() {
        guard index + 1 < entries.count else { return }
        let keptHead = Array(entries.prefix(index + 1))
        let downloadedTail = entries.dropFirst(index + 1).filter { isDownloaded($0.trackId) }
        guard downloadedTail.count != entries.count - keptHead.count else { return }
        entries = keptHead + downloadedTail
    }

    private func rescueEndedWave() async {
        guard isWave, !waveLoading else { return }
        pruneUndownloadedFuture()
        if index + 1 >= entries.count {
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: Set(entries.map(\.trackId)))
            if !fallback.isEmpty {
                entries.append(contentsOf: fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            }
        }
        guard index + 1 < entries.count else { return }
        if let source = waveSource, source == "yandex" || source == "online" {
            waveFallbackActive = true
            context = waveContext(for: source, offlineFallback: true)
        }
        onStateChange?()
        try? await startAt(index + 1, paused: false)
    }

    func startArtistRadio(artist: String, tracks: [NativeTrack]) async throws {
        waveRequestId &+= 1
        let request = waveRequestId
        waveLoading = false
        let needle = NativeSearchText.normalize(artist)
        let matching = tracks.filter { $0.ok && $0.reaction >= 0 && NativeSearchText.normalize($0.artist).contains(needle) }
        var ids = Array(matching.shuffled().prefix(2).map(\.id))
        var waveBody: [String: Any] = ["session": ids, "count": 4, "exclude": ids]
        if let first = ids.first { waveBody["currentId"] = first }
        let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: waveBody)
        guard request == waveRequestId else { return }
        let picks = (res?["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        ids.append(contentsOf: picks.filter { !ids.contains($0) })
        guard !ids.isEmpty else {
            throw NSError(domain: "NativeWave", code: 3, userInfo: [NSLocalizedDescriptionKey: "Недостаточно треков для радио исполнителя"])
        }
        waveSource = "own"
        waveOfflineOnly = false
        try await play(trackIds: ids, at: 0, context: Context(type: "wave", id: artist, label: "\(artist) и похожие"), keepWave: true)
    }

    func remapTracks(_ mapping: [String: String]) {
        let remap = { (e: Entry) in Entry(entryId: e.entryId, trackId: mapping[e.trackId] ?? e.trackId, yandexId: e.yandexId, yandexSessionId: e.yandexSessionId, yandexBatchId: e.yandexBatchId) }
        entries = entries.map(remap)
        onStateChange?()
    }

    func syncFromHost(_ snapshot: [String: Any]) {
        guard startingRevision == nil, snapshot["active"] as? Bool == true,
              let idx = snapshot["index"] as? Int, let eid = snapshot["entryId"] as? String,
              let found = entries.firstIndex(where: { $0.entryId == eid }) else { return }
        let previousHostIndex = hostIndex
        hostIndex = idx
        let movedInQueue = found != index
        if movedInQueue || idx != previousHostIndex {
            if movedInQueue { rescuedEndedEntryId = nil }
            finishPlay(reason: idx == previousHostIndex + 1 ? "transition" : "skip")
            index = found
            if let entry = currentEntry { beginPlay(entry) }
            saveCurrentPosition()
            onStateChange?()
            if movedInQueue { scheduleSync(preservePendingSkip: true) }
        } else {
            continueQueueIfNeeded(snapshot)
        }
        if isWave && entries.count - 1 - index <= 2 {
            Task { @MainActor in await topUpWaveIfNeeded() }
        }
        if isWave && !waveLoading && snapshot["ended"] as? Bool == true
            && snapshot["playing"] as? Bool != true
            && snapshot["waitingForPreparation"] as? Bool != true
            && rescuedEndedEntryId != eid {
            rescuedEndedEntryId = eid
            Task { @MainActor in await self.rescueEndedWave() }
        }
    }

    /// Wave settings changed: the next launch must build a fresh queue with them.
    func resetForNewSettings() {
        revision &+= 1
        startingRevision = nil
        syncTask?.cancel()
        waveRequestId &+= 1
        waveSource = nil
        waveOfflineOnly = false
        waveFallbackActive = false
        rescuedEndedEntryId = nil
        yandexSessionId = nil
        waveError = nil
        waveLoading = false
        restoredPosition = 0
        entries = []
        index = 0
        originalOrder = nil
        context = Context(type: "library", id: nil, label: "Медиатека")
        if NativeMixHost.shared.active { NativeMixHost.shared.stop { _ in } }
        onStateChange?()
    }

    // MARK: - Private

    private func startAt(_ targetIndex: Int, paused: Bool, startPosition: Double = 0) async throws {
        guard entries.indices.contains(targetIndex) else { return }
        rescuedEndedEntryId = nil
        revision &+= 1
        let rev = revision
        startingRevision = rev
        syncTask?.cancel()
        windowContinuation = nil
        defer { if startingRevision == rev { startingRevision = nil } }
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
            guard rev == revision else { return }
            sessionId = begun["id"] as? String
        }
        guard let sid = sessionId, rev == revision else { return }
        let resolved = try await resolveUploadSources([item], sessionId: sid)
        guard let preparedItem = resolved.first, rev == revision else {
            throw NSError(domain: "NativeQueue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Файл трека недоступен"])
        }
        let config: [String: Any] = ["sampleRate": 48000.0, "position": max(0.0, startPosition), "paused": paused, "gainDb": 0.0]
        let state = try await hostReply { host.prepareStart(id: sid, item: preparedItem, config: config, completion: $0) }
        guard rev == revision else { return }
        startingRevision = nil
        hostIndex = state["index"] as? Int ?? 0
        restoredPosition = 0

        beginPlay(entry)
        saveQueueState(position: max(0.0, startPosition))
        onStateChange?()
        scheduleSync()
        if isWave { Task { @MainActor in await topUpWaveIfNeeded() } }
        Task { @MainActor in await prefetchUpcomingIfNeeded() }
    }

    private func scheduleSync(offset: Int = 0, preservePendingSkip: Bool = false) {
        windowContinuation = nil
        syncTask?.cancel()
        syncTask = Task { @MainActor in
            await syncQueue(offset: offset, preservePendingSkip: preservePendingSkip)
        }
    }

    private func continueQueueIfNeeded(_ snapshot: [String: Any]) {
        guard let continuation = windowContinuation,
              let preparation = snapshot["preparation"] as? [String: Any], preparation["jobId"] as? String == continuation.job,
              preparation["running"] as? Bool == false, let count = snapshot["count"] as? Int, count <= hostIndex + 1 else { return }
        scheduleSync(offset: continuation.offset, preservePendingSkip: true)
    }

    private func syncQueue(offset: Int, preservePendingSkip: Bool) async {
        guard !Task.isCancelled, startingRevision == nil, let sid = sessionId, let current = currentEntry else { return }
        let host = NativeMixHost.shared
        let rev = revision
        let from = hostIndex + 1
        let anchor = index
        let loopsCurrent = repeatMode == "one" || (repeatMode == "all" && entries.count == 1)
        let wraps = repeatMode == "all"
        func isCurrent() -> Bool {
            !Task.isCancelled && rev == revision && currentEntry?.entryId == current.entryId && hostIndex + 1 == from
        }

        var items: [[String: Any]] = []
        var previousMeta: [String: Any] = ["entryId": current.entryId, "trackId": current.trackId, "duration": 0.0, "mixingAllowed": false]
        var settingsMeta: [String: Any] = ["enabled": automixEnabled]
        var nextOffset = offset
        var hasMore = false
        do {
            repeat {
                let window = NativeMixTimeline.queueWindow(count: entries.count, current: anchor, repeats: wraps, offset: nextOffset)
                let batch = loopsCurrent ? [current] : window.indices.map { entries[$0] }
                nextOffset = window.endOffset
                hasMore = !loopsCurrent && window.hasMore
                guard !batch.isEmpty else { break }
                let manifest = try await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
                    "entries": batch.enumerated().map { file, entry in
                        ["entryId": entry.entryId, "trackId": entry.trackId, "file": file] as [String: Any]
                    },
                    "previousId": current.trackId,
                    "nativeFiles": downloadedIds(for: batch.map(\.trackId)),
                ])
                guard isCurrent() else { return }
                items = try await resolveUploadSources(manifest["items"] as? [[String: Any]] ?? [], sessionId: sid)
                guard isCurrent() else { return }
                if let previous = manifest["previous"] as? [String: Any] {
                    previousMeta.merge(previous) { _, new in new }
                }
                if let settings = manifest["settings"] as? [String: Any] {
                    settingsMeta = settings
                    if let enabled = settings["enabled"] as? Bool { automixEnabled = enabled }
                }
            } while items.isEmpty && hasMore
        } catch {
            if isCurrent() { NativeShellStore.shared?.show(error.localizedDescription) }
            return
        }
        guard isCurrent() else { return }
        let hostManifest: [String: Any] = [
            "from": from,
            "queueEntryId": current.entryId,
            "queueHasMore": hasMore,
            "queueWraps": wraps && !loopsCurrent,
            "preservePendingSkip": preservePendingSkip,
            "items": loopsCurrent ? [] : items,
            "loopItems": loopsCurrent ? items : [],
            "replaceFuture": true,
            "previous": previousMeta,
            "settings": settingsMeta,
        ]
        if let state = try? await hostReply({ host.prepareQueue(id: sid, manifest: hostManifest, completion: $0) }),
           isCurrent(), hasMore, let preparation = state["preparation"] as? [String: Any],
           let job = preparation["jobId"] as? String {
            windowContinuation = (job, nextOffset)
            continueQueueIfNeeded(host.snapshot)
        }
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
        let request = waveRequestId
        guard isWave, !waveLoading, toppingUpWave != request, (force || entries.count - 1 - index <= 2) else { return }
        toppingUpWave = request
        defer { if toppingUpWave == request { toppingUpWave = nil } }
        let existing = Set(entries.map(\.trackId))
        let isOffline = waveOfflineOnly || (NativeShellStore.shared?.offline ?? waveOffline)
        let source = waveSource
        func isCurrent() -> Bool { request == waveRequestId && source == waveSource }
        func append(_ additions: [Entry]) {
            guard !additions.isEmpty else { return }
            entries.append(contentsOf: additions)
            onStateChange?()
            let snap = NativeMixHost.shared.snapshot
            if snap["ended"] as? Bool == true && snap["playing"] as? Bool != true && index + 1 < entries.count {
                Task { @MainActor in try? await self.startAt(self.index + 1, paused: false) }
            } else {
                scheduleSync()
            }
            Task { @MainActor in await prefetchUpcomingIfNeeded() }
        }

        if source == "yandex" {
            if !isOffline {
                var yBody: [String: Any] = ["count": 2, "queue": Array(yandexQueueIds.suffix(100))]
                if let yandexSessionId { yBody["session"] = yandexSessionId }
                if let res = try? await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: yBody) {
                    guard isCurrent() else { return }
                    let newEntries = await collectYandexWaveEntries(from: res, limit: 2, excluding: existing)
                    guard isCurrent() else { return }
                    if let s = (res["sessionId"] as? String) ?? (res["session"] as? String) { yandexSessionId = s }
                    rememberYandexEntries(newEntries)
                    if !newEntries.isEmpty {
                        waveFallbackActive = false
                        waveOffline = false
                        context = waveContext(for: "yandex", offlineFallback: false)
                        append(newEntries)
                        return
                    }
                }
            }
            guard isCurrent() else { return }
            pruneUndownloadedFuture()
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            guard isCurrent() else { return }
            if !fallback.isEmpty {
                waveFallbackActive = true
                context = waveContext(for: "yandex", offlineFallback: true)
                append(fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            }
            return
        }

        if source == "online" {
            if !isOffline,
               let radioEntries = try? await fetchOnlineRadioEntries(count: 2, excluding: existing),
               !radioEntries.isEmpty {
                guard isCurrent() else { return }
                waveFallbackActive = false
                waveOffline = false
                context = waveContext(for: "online", offlineFallback: false)
                append(radioEntries)
                return
            }
            guard isCurrent() else { return }
            pruneUndownloadedFuture()
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            guard isCurrent() else { return }
            if !fallback.isEmpty {
                waveFallbackActive = true
                context = waveContext(for: "online", offlineFallback: true)
                append(fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            }
            return
        }

        if isOffline {
            let fallback = await fetchOfflineWaveTrackIds(count: 3, excluding: existing)
            guard isCurrent() else { return }
            append(fallback.map { Entry(entryId: UUID().uuidString, trackId: $0) })
            return
        }

        var nextBody: [String: Any] = [
            "session": Array(entries.suffix(12).map(\.trackId)),
            "count": 3,
            "exclude": Array(existing.prefix(60)),
            "offline": false,
        ]
        if let currentId = currentEntry?.trackId { nextBody["currentId"] = currentId }
        guard let res = try? await NativeServerApp.request("POST", "/api/wave/next", body: nextBody), isCurrent() else { return }
        let picks = (res["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { !existing.contains($0) }
        append(picks.map { Entry(entryId: UUID().uuidString, trackId: $0) })
    }

    private func prefetchUpcomingIfNeeded() async {
        guard !waveOfflineOnly, !(NativeShellStore.shared?.offline ?? waveOffline) else { return }
        let request = waveRequestId
        let store = NativeShellStore.shared
        let keepWave: Int
        if let cached = cachedKeepWave, Date().timeIntervalSince(cached.at) < 60 {
            keepWave = cached.count
        } else {
            let settings = try? await NativeServerApp.request("GET", "/api/settings", body: nil)
            let downloads = settings?["downloads"] as? [String: Any]
            let count = (downloads?["keepWave"] as? NSNumber)?.intValue ?? 0
            cachedKeepWave = (count, Date())
            keepWave = count
        }
        guard request == waveRequestId, isWave, keepWave > 0 else { return }
        let upcoming = entries.dropFirst(index + 1).prefix(min(keepWave, 6))
        for entry in upcoming {
            guard request == waveRequestId else { return }
            let tid = entry.trackId
            guard !tid.isEmpty,
                  NativeDownloadManager.shared.localFile(tid) == nil,
                  store?.byId[tid]?.offline != true,
                  prefetchedIds.insert(tid).inserted else { continue }
            _ = try? await NativeDownloadManager.shared.enqueue(trackId: tid, album: store?.byId[tid]?.album ?? "")
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
                picked.append(Entry(entryId: UUID().uuidString, trackId: tid, yandexId: yid, yandexSessionId: sid, yandexBatchId: batchId))
            }
        }
        return picked
    }

    private func rememberYandexEntries(_ newEntries: [Entry]) {
        for id in newEntries.compactMap(\.yandexId) where !id.isEmpty && !yandexQueueIds.contains(id) {
            yandexQueueIds.append(id)
        }
    }

    private func sendYandexFeedback(sessionId: String, batchId: String?, event: [String: Any]) {
        var body: [String: Any] = ["sessionId": sessionId, "event": event]
        if let batchId, !batchId.isEmpty { body["batchId"] = batchId } else { body["batchId"] = NSNull() }
        Task { _ = try? await NativeServerApp.request("POST", "/api/providers/yandex/feedback", body: body) }
    }

    private func stopPlayback() {
        revision &+= 1
        startingRevision = nil
        syncTask?.cancel()
        windowContinuation = nil
        waveRequestId &+= 1
        waveLoading = false
        waveSource = nil
        waveOfflineOnly = false
        finishPlay(reason: "stop")
        sessionId = nil
        NativeMixHost.shared.stop { _ in }
        saveQueueState(position: 0)
        onStateChange?()
    }

    private func beginPlay(_ entry: Entry) {
        playStartedAt = Date()
        activePlayEntry = entry
        if let sid = entry.yandexSessionId, !sid.isEmpty, let yid = entry.yandexId, !yid.isEmpty {
            sendYandexFeedback(sessionId: sid, batchId: entry.yandexBatchId, event: ["type": "trackStarted", "trackId": yid])
        }
        let tid = entry.trackId, ctx = context.type
        activePlayRecord = Task {
            let res = try? await NativeServerApp.request("POST", "/api/plays", body: ["trackId": tid, "context": ctx])
            return res?["id"] as? Int
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
        guard let record = activePlayRecord else { return }
        activePlayRecord = nil
        let ms = Int(max(0, playedSec * 1000))
        Task {
            guard let id = await record.value else { return }
            _ = try? await NativeServerApp.request("PATCH", "/api/plays/\(id)", body: ["playedMs": ms, "endReason": reason])
        }
    }

    private func saveQueueState(position: Double? = nil) {
        let items: [[String: Any]] = entries.prefix(5000).map { [
            "entryId": $0.entryId,
            "trackId": $0.trackId,
            "origin": isWave ? "wave" : "user",
        ] }
        var ctx: [String: Any] = ["type": context.type, "label": context.label]
        if let cid = context.id { ctx["id"] = cid }
        let currentPos = position ?? (NativeMixHost.shared.active
            ? max(0.0, (NativeMixHost.shared.snapshot["position"] as? NSNumber)?.doubleValue ?? 0)
            : max(0.0, restoredPosition))
        var body: [String: Any] = [
            "items": items,
            "index": max(0, min(items.count - 1, index)),
            "position": currentPos,
            "context": ctx,
            "shuffle": shuffle,
            "repeat": repeatMode,
            "volume": 1.0,
            "waveOfflineOnly": waveOfflineOnly,
        ]
        if let originalOrder {
            body["unshuffledEntryIds"] = NativeMixTimeline.restoredOrder(originalOrder, available: entries.prefix(5000).map(\.entryId))
        }
        Task { _ = try? await NativeServerApp.request("PUT", "/api/queue", body: body) }
    }

    private func resolveUploadSources(_ items: [[String: Any]], sessionId sid: String) async throws -> [[String: Any]] {
        var out = items
        for i in out.indices {
            try Task.checkCancellation()
            if let tid = out[i]["trackId"] as? String, ((out[i]["duration"] as? NSNumber)?.doubleValue ?? 0) <= 0,
               let d = NativeShellStore.shared?.byId[tid]?.duration, d > 0 {
                out[i]["duration"] = d
            }
            guard let source = out[i]["source"] as? [String: Any], source["kind"] as? String == "upload" else { continue }
            let tid = source["trackId"] as? String ?? (out[i]["trackId"] as? String ?? "")
            let url: URL? = (source["serverPath"] as? String).flatMap { NativeMediaLoader.sharedFile($0, root: NativeServerApp.root) }
                ?? NativeDownloadManager.shared.localFile(tid)
            guard let url,
                  let reply = try? await hostReply({ NativeMixHost.shared.sourceFromDownload(id: sid, file: url, completion: $0) }),
                  let key = reply["key"] as? Int else { continue }
            out[i]["source"] = ["kind": "local", "file": key]
            out[i]["file"] = key
        }
        return out.filter { ($0["source"] as? [String: Any])?["kind"] as? String != "upload" }
    }

    private func downloadedIds(for trackIds: [String]) -> [String] {
        trackIds.filter { NativeDownloadManager.shared.localFile($0) != nil }
    }

    private func hostReply(_ call: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            call { continuation.resume(with: $0) }
        }
    }
}