import SwiftUI

struct NativeDownloadsView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var downloads = NativeDownloadsState()
    @State private var error: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var refreshing = false
    @State private var confirmation: Confirmation?
    private enum Confirmation: Identifiable {
        case clear, remove(NativeTrack), cancel(NativeDownloadsState.Job)
        var id: String {
            switch self { case .clear: return "clear"; case .remove(let track): return "remove:" + track.id; case .cancel(let job): return "cancel:" + job.identity }
        }
    }
    private var pinned: [NativeTrack] { downloads.downloaded(in: store.library, byId: store.byId) }
    private var own: [NativeTrack] { NativeDownloadsState.own(in: store.library) }

    var body: some View {
        List {
            if let error = actionError ?? error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Повторить") { actionError = nil; Task { await refresh() } }
                }
            }
            Section {
                Button { perform { try await downloadLiked() } } label: { Label("Скачать всё любимое", systemImage: "heart.fill") }
                    .accessibilityIdentifier("native-downloads-liked")
                Button { perform { try await downloadWaveForTrip() } } label: { Label("Скачать волну в дорогу (20 треков)", systemImage: "waveform.badge.plus") }
                    .accessibilityIdentifier("native-downloads-wave")
            } footer: { Text("Скачанные треки играют без интернета. Настройка Wi-Fi применяется к системным фоновым загрузкам.") }
            if !downloads.active.isEmpty {
                Section("Скачивается") {
                    ForEach(downloads.active, id: \.identity) { job in jobRow(job) }
                }
            }
            Section {
                if pinned.isEmpty {
                    Text(own.isEmpty ? "Пока пусто. В меню трека или результата поиска выберите «Скачать»." : "Скачанных из сети пока нет — свои файлы ниже.")
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(pinned.enumerated()), id: \.element.id) { index, track in
                    HStack {
                        NativeTrackRow(track: track) { store.play(pinned, at: index, type: "library", label: "Загрузки") }
                        Button(role: .destructive) { confirmation = .remove(track) } label: {
                            Image(systemName: "trash").frame(width: 44, height: 44)
                        }
                        .buttonStyle(.borderless).accessibilityLabel("Удалить загрузку: " + track.title)
                    }
                }
            } header: { Text("Скачано · \(pinned.count)") }
            if !own.isEmpty {
                Section {
                    ForEach(Array(own.enumerated()), id: \.element.id) { index, track in
                        NativeTrackRow(track: track) { store.play(own, at: index, type: "library", label: "Свои файлы") }
                    }
                } header: { Text("Свои файлы · \(own.count)") }
                footer: { Text("Файлы из «Файлов» и импорта сохранены внутри приложения. Убрать трек из медиатеки можно в его меню.") }
            }
            if let usage = downloads.usage {
                Section {
                    LabeledContent("Скачанное", value: NativeDownloadsState.space(usage.pinnedBytes + downloads.nativeBytes))
                    Text("Не удаляется автоматически").font(.footnote).foregroundStyle(.secondary)
                    LabeledContent("Кэш прослушанного", value: NativeDownloadsState.space(usage.cacheBytes))
                    Text("Старое удаляется само, когда превышен предел. Текущий и следующий трек защищены.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Предел кэша", selection: Binding(
                        get: { Int((usage.limitBytes / (1024 * 1024)).rounded()) },
                        set: { value in perform { _ = try await NativeServerApp.request("PUT", "/api/downloads/settings", body: ["cacheLimitMb": value]) } })) {
                        ForEach(cacheLimits(usage), id: \.self) { value in Text(NativeDownloadsState.space(Double(value) * 1024 * 1024)).tag(value) }
                    }
                    Button("Очистить кэш", role: .destructive) { confirmation = .clear }
                        .accessibilityIdentifier("native-downloads-clear-cache")
                } header: { Text("Место на диске") }
                footer: { if let free = usage.freeBytes { Text("Свободно на диске: " + NativeDownloadsState.space(free)) } }
            } else if error == nil { ProgressView("Загрузка сведений о месте на диске…") }
        }
        .disabled(busy)
        .scrollContentBackground(.hidden).background(Color.moraBackground)
        .navigationTitle("Загрузки")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") } }
        }
        .accessibilityIdentifier("native-downloads-screen")
        .refreshable { await refresh() }
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NativeDownloadManager.changed)) { _ in updateNative() }
        .alert(item: $confirmation) { action in
            switch action {
            case .clear:
                return Alert(title: Text("Очистить кэш?"), message: Text("Скачанное и свои файлы сохранятся. Текущий и следующий трек защищены."),
                    primaryButton: .destructive(Text("Очистить")) { perform { try await clearCache() } }, secondaryButton: .cancel())
            case .remove(let track):
                return Alert(title: Text("Удалить загрузку?"), message: Text("«\(track.title)» останется в медиатеке. Для сетевого трека может понадобиться интернет."),
                    primaryButton: .destructive(Text("Удалить")) { perform { try await remove(track) } }, secondaryButton: .cancel())
            case .cancel(let job):
                return Alert(title: Text("Отменить загрузку?"), message: Text(job.title),
                    primaryButton: .destructive(Text("Отменить загрузку")) { perform { try await act(job, "cancel") } }, secondaryButton: .cancel(Text("Продолжить")))
            }
        }
    }

    private func cacheLimits(_ usage: NativeDownloadsState.Usage) -> [Int] {
        Array(Set([512, 1024, 2048, 5120, 10240, 20480, Int((usage.limitBytes / (1024 * 1024)).rounded())])).sorted()
    }
    private func jobRow(_ job: NativeDownloadsState.Job) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(job.title.isEmpty ? "Трек" : job.title).font(.headline)
            Text(job.status + (job.state == "downloading" ? " · \(Int(job.progress * 100))%" : ""))
                .font(.subheadline).foregroundStyle(job.state == "failed" ? Color.red : Color.secondary)
            if job.state == "downloading" { ProgressView(value: job.progress).accessibilityValue("\(Int(job.progress * 100))%") }
            if job.totalBytes > 0 {
                Text("\(NativeDownloadsState.space(job.bytes)) / \(NativeDownloadsState.space(job.totalBytes))" +
                     (job.eta.map { " · осталось " + NativePlayerTime.text($0) } ?? ""))
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            HStack {
                if job.canPause { Button("Пауза", systemImage: "pause") { perform { try await act(job, "pause") } } }
                if job.canRetry {
                    Button(job.state == "paused" ? "Продолжить" : "Повторить", systemImage: "arrow.clockwise") {
                        perform { try await act(job, job.state == "paused" ? "resume" : "retry") }
                    }
                }
                Spacer()
                Button("Отменить", systemImage: "xmark", role: .destructive) { confirmation = .cancel(job) }
            }.buttonStyle(.borderless)
        }.padding(.vertical, 6).accessibilityIdentifier("native-download-job-" + job.identity)
    }
    @MainActor private func updateNative() {
        do { try downloads.receiveNative(NativeDownloadManager.shared.list()) }
        catch { self.error = error.localizedDescription }
    }
    @MainActor private func refresh() async {
        guard !refreshing, !busy else { return }
        refreshing = true; defer { refreshing = false }
        updateNative()
        do {
            let response = try await NativeServerApp.request("GET", "/api/downloads")
            try Task.checkCancellation()
            try downloads.receive(response); error = nil
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    @MainActor private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            var failure: String?
            do { try await work() } catch { failure = error.localizedDescription }
            busy = false; updateNative(); store.refreshLibrary(); await refresh()
            actionError = failure
        }
    }
    @MainActor private func act(_ job: NativeDownloadsState.Job, _ action: String) async throws {
        if job.native {
            if job.canRetry && action != "cancel" && !NativeDownloadManager.shared.hasTask(job.id) {
                guard let id = job.trackId else { throw NativeDownloadsState.Failure(message: "Трек загрузки не найден") }
                try await NativeDownloadManager.shared.enqueue(trackId: id, album: store.byId[id]?.album ?? "")
                if NativeDownloadManager.shared.jobs.contains(where: { $0.id == job.id && $0.state != .cancelled }) {
                    try NativeDownloadManager.shared.action(job.id, "cancel")
                }
            } else { try NativeDownloadManager.shared.action(job.id, action) }
        } else {
            _ = try await NativeServerApp.request("POST", "/api/downloads/\(NativeDownloadsState.component(job.id))/\(action)", body: [:])
        }
    }
    @MainActor private func downloadLiked() async throws {
        let available = Set(pinned.map(\.id))
        let ids = store.library.filter { $0.liked && $0.sourceKind == "remote" && !available.contains($0.id) }.map(\.id)
        var failed = 0
        var lastError = ""
        for id in ids {
            do { try await NativeDownloadManager.shared.enqueue(trackId: id, album: store.byId[id]?.album ?? "") }
            catch { failed += 1; lastError = error.localizedDescription }
        }
        if failed > 0 { throw NativeDownloadsState.Failure(message: "Не удалось добавить загрузки: \(failed). \(lastError)") }
        store.show(ids.isEmpty ? "Эти треки уже на iPhone или не скачиваются" : "Добавлено загрузок: \(ids.count)")
    }
    @MainActor private func downloadWaveForTrip() async throws {
        var candidateIds: [String] = []
        var seen = Set<String>()
        func appendId(_ id: String) {
            guard !id.isEmpty, seen.insert(id).inserted else { return }
            candidateIds.append(id)
        }

        let qc = NativeQueueController.shared
        if qc.isWave {
            for entry in qc.entries.dropFirst(qc.index + 1) {
                appendId(entry.trackId)
            }
        }
        if let waveRes = try? await NativeServerApp.request("POST", "/api/wave/next", body: ["count": 20, "offline": false]),
           let picks = waveRes["picks"] as? [[String: Any]] {
            for pick in picks {
                if let id = pick["id"] as? String { appendId(id) }
            }
        }
        if store.ui.wave.yandex && !store.offline && candidateIds.count < 20 {
            if let yRes = try? await NativeServerApp.request("POST", "/api/providers/yandex/wave", body: ["count": 10]),
               let items = yRes["items"] as? [[String: Any]] {
                for item in items {
                    guard candidateIds.count < 20 else { break }
                    if let id = item["trackId"] as? String, !id.isEmpty {
                        appendId(id)
                    } else if let track = item["track"] as? [String: Any],
                              let imp = try? await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": track]),
                              let id = imp["trackId"] as? String {
                        appendId(id)
                    }
                }
            }
        }

        let alreadyDownloaded = Set(pinned.map(\.id))
            .union(Set(downloads.active.compactMap(\.trackId)))
        let targets = candidateIds.filter { id in
            guard !alreadyDownloaded.contains(id) else { return false }
            if let track = store.byId[id] { return track.ok && !track.offline }
            return true
        }.prefix(20)

        var added = 0, failed = 0
        var lastError = ""
        for id in targets {
            do {
                try await NativeDownloadManager.shared.enqueue(trackId: id, album: store.byId[id]?.album ?? "")
                added += 1
            } catch {
                failed += 1; lastError = error.localizedDescription
            }
        }
        if failed > 0 { throw NativeDownloadsState.Failure(message: "Добавлено: \(added). Не удалось добавить: \(failed). \(lastError)") }
        store.show(added > 0 ? "В загрузку добавлено треков: \(added)" : "Треки волны уже скачаны")
    }
    @MainActor private func remove(_ track: NativeTrack) async throws {
        try NativeDownloadManager.shared.remove(track.id)
        if store.byId[track.id] != nil {
            _ = try await NativeServerApp.request("DELETE", "/api/tracks/\(NativeDownloadsState.component(track.id))/download")
        }
    }
    @MainActor private func clearCache() async throws {
        let result = try await NativeServerApp.request("POST", "/api/downloads/clear-cache", body: [:])
        let removed = (result["removed"] as? NSNumber)?.intValue ?? 0
        store.show(removed > 0 ? "Удалено файлов: \(removed)" : "Нечего очищать")
    }
}