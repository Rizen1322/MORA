import AVFoundation
import SwiftUI
import UIKit

private struct NativeVersionChoice: Identifiable {
    let id: String, track: NativeTrack, source: String, tags: String
    init?(_ value: [String: Any]) {
        guard let id = value["key"] as? String, let track = NativeTrack(value) else { return nil }
        self.id = id; self.track = track
        source = value["source"] as? String ?? ""
        tags = value["tags"] as? String ?? ""
    }
    init(id: String, track: NativeTrack, source: String, tags: String) {
        self.id = id; self.track = track; self.source = source; self.tags = tags
    }
}

private enum NativeVersionSource {
    case local(String)
    case remote(provider: String, externalId: String, raw: [String: Any])
    case yandex(externalId: String, raw: [String: Any])
}

@MainActor private final class NativeVersionModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    private static let parentheticalRegex = try! NSRegularExpression(pattern: #"\(.*?\)|\[.*?\]"#)
    private static let wordSeparatorRegex = try! NSRegularExpression(pattern: #"[^\p{L}\p{N}]+"#)
    nonisolated private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    let target: NativeTrack
    private let store: NativeShellStore
    @Published var rows: [NativeVersionChoice] = []
    @Published var errors: [String] = []
    @Published var loading = false
    @Published var busy: String?
    @Published var selected: String?
    @Published var previewing: String?
    @Published var previewPosition = 0.0
    @Published var previewDuration = 0.0
    private var clock: Timer?
    private var webPaused: [String: Any]?
    private var ownsPreviewSession = false
    private var session = ""
    private var nativeChoices: [String: NativeVersionSource] = [:]
    private var resolvedTrackIds: [String: String] = [:]
    private var searchGeneration = 0
    private var player: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?
    private var ticket: NativePreparationTicket?
    private var http: NativeMediaHTTP?
    private var folder: URL?
    private var generation = 0
    private var paused: [String: Any]?

    init(target: NativeTrack, store: NativeShellStore) { self.target = target; self.store = store }
    private var usesNativeLibrary: Bool { store.sharedLibrary && store.byId[target.id] != nil }
    private func args(_ key: String) -> [String: Any] { ["target": target.id, "session": session, "key": key] }

    nonisolated private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private static func sourceLabel(_ source: String) -> String {
        switch source {
        case "ytmusic": return "YouTube Music"
        case "youtube": return "YouTube"
        case "soundcloud": return "SoundCloud"
        case "yandex": return "Яндекс Музыка"
        default: return source
        }
    }

    private static func splitWords(_ text: String, stripParens: Bool) -> [String] {
        var normalized = text.precomposedStringWithCompatibilityMapping
            .lowercased(with: Locale(identifier: "ru_RU"))
            .replacingOccurrences(of: "ё", with: "е")
        if stripParens {
            let range = NSRange(normalized.startIndex..., in: normalized)
            normalized = parentheticalRegex.stringByReplacingMatches(in: normalized, range: range, withTemplate: " ")
        }
        let range = NSRange(normalized.startIndex..., in: normalized)
        let separated = wordSeparatorRegex.stringByReplacingMatches(in: normalized, range: range, withTemplate: "\u{1}")
        return separated.split(separator: "\u{1}").map(String.init)
    }

    /// Matches `sameSong` in VersionPanel.tsx: keeps tracks sharing >= 60% of the core title words.
    private static func sameSong(_ original: String, _ candidate: String) -> Bool {
        let core = splitWords(original, stripParens: true).filter {
            $0.count > 1 || $0.rangeOfCharacter(from: .decimalDigits) != nil
        }
        guard !core.isEmpty else { return true }
        let have = Set(splitWords(candidate, stripParens: false))
        let matched = core.filter { have.contains($0) }.count
        return Double(matched) / Double(core.count) >= 0.6
    }

    func search(_ query: String, source: String) async {
        searchGeneration &+= 1
        let gen = searchGeneration
        loading = true
        defer { if gen == searchGeneration { loading = false } }
        if !usesNativeLibrary {
            do {
                let value = try await store.call("versionSearch", ["target": target.id, "query": query, "source": source, "request": UUID().uuidString], timeout: 60) as? [String: Any]
                guard gen == searchGeneration, !Task.isCancelled else { return }
                session = value?["session"] as? String ?? ""
                rows = (value?["rows"] as? [[String: Any]] ?? []).compactMap(NativeVersionChoice.init)
                errors = value?["errors"] as? [String] ?? []
                selected = nil
            } catch { if gen == searchGeneration, !Task.isCancelled { rows = []; errors = [error.localizedDescription] } }
            return
        }

        guard ["all", "local", "ytmusic", "youtube", "soundcloud", "yandex"].contains(source) else {
            rows = []; errors = ["Неизвестный источник"]; selected = nil; return
        }
        let yandexConnected = store.ui.wave.yandex
        if source == "yandex" && !yandexConnected {
            rows = []; errors = ["Подключите Яндекс Музыку в разделе «Источники»"]; selected = nil; return
        }

        var choices: [String: NativeVersionSource] = [:]
        var builtRows: [NativeVersionChoice] = []
        for track in store.library where track.id != target.id && Self.sameSong(target.title, track.title) {
            let key = "local:\(track.id)"
            choices[key] = .local(track.id)
            builtRows.append(NativeVersionChoice(id: key, track: track, source: "Медиатека", tags: ""))
        }

        var available = ["ytmusic", "youtube", "soundcloud"]
        if yandexConnected { available.append("yandex") }
        let selectedSources: [String] = source == "local" ? [] : (source == "all" ? available : [source])
        let cleanQuery = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        var searchErrors: [String] = []

        if !selectedSources.isEmpty && !cleanQuery.isEmpty {
            var outcomes = Array<Result<[[String: Any]], Error>?>(repeating: nil, count: selectedSources.count)
            await withTaskGroup(of: (Int, Result<[[String: Any]], Error>).self) { group in
                for (index, src) in selectedSources.enumerated() {
                    group.addTask {
                        do {
                            let path = src == "yandex"
                                ? "/api/catalog/yandex/search?q=\(Self.enc(cleanQuery))&type=track&page=0"
                                : "/api/search/\(Self.enc(src))?q=\(Self.enc(cleanQuery))"
                            let res = try await NativeServerApp.request("GET", path, timeout: 60)
                            let items = (src == "yandex" ? res["tracks"] : res["items"]) as? [[String: Any]] ?? []
                            return (index, .success(items))
                        } catch {
                            return (index, .failure(error))
                        }
                    }
                }
                for await (index, outcome) in group {
                    outcomes[index] = outcome
                }
            }
            guard gen == searchGeneration, !Task.isCancelled else { return }

            for (index, src) in selectedSources.enumerated() {
                guard let outcome = outcomes[index] else { continue }
                let label = Self.sourceLabel(src)
                switch outcome {
                case .failure(let error):
                    if error is CancellationError { continue }
                    searchErrors.append("\(label): \(error.localizedDescription)")
                case .success(let items):
                    let matching = items.filter { Self.sameSong(target.title, $0["title"] as? String ?? "") }.prefix(8)
                    for item in matching {
                        let extId = (item["externalId"] as? String) ?? (item["id"] as? String) ?? ""
                        guard !extId.isEmpty else { continue }
                        let key = "\(src):\(extId)"
                        let audioProvider = src == "yandex" ? "yandex" : ((item["audioProvider"] as? String) ?? (src == "soundcloud" ? "soundcloud" : "youtube"))
                        let tags = (item["labels"] as? [[String: Any]] ?? []).compactMap { $0["tag"] as? String }.filter { !$0.isEmpty }.joined(separator: " · ")
                        var trackDict: [String: Any] = [
                            "id": key,
                            "title": item["title"] as? String ?? "",
                            "artist": item["artist"] as? String ?? "",
                            "album": item["album"] as? String ?? "",
                            "duration": (item["duration"] as? NSNumber)?.doubleValue ?? 0.0,
                            "ok": item["playable"] as? Bool != false,
                            "provider": audioProvider,
                        ]
                        if let cover = item["coverUrl"] as? String, !cover.isEmpty { trackDict["cover"] = cover }
                        guard let track = NativeTrack(trackDict) else { continue }
                        choices[key] = src == "yandex"
                            ? .yandex(externalId: extId, raw: item)
                            : .remote(provider: audioProvider, externalId: extId, raw: item)
                        builtRows.append(NativeVersionChoice(id: key, track: track, source: label, tags: tags))
                    }
                }
            }
        }

        guard gen == searchGeneration, !Task.isCancelled else { return }
        nativeChoices = choices
        rows = builtRows
        errors = searchErrors
        selected = nil
    }

    private func resolveChoice(_ key: String) async throws -> String {
        if let cached = resolvedTrackIds[key], store.byId[cached] != nil { return cached }
        guard let entry = nativeChoices[key] else {
            throw NativeLibraryActions.Failure(message: "Результат поиска устарел. Повторите поиск.")
        }
        switch entry {
        case .local(let id):
            return id
        case .yandex(let externalId, let raw):
            if let known = raw["libraryTrackId"] as? String, !known.isEmpty, store.byId[known] != nil { return known }
            if let local = store.localCatalogTrack(provider: "yandex", externalId: externalId) { return local.trackId }
            var payload = raw
            if payload["externalId"] == nil { payload["externalId"] = externalId }
            let res = try await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": payload], timeout: 60)
            guard let id = res["trackId"] as? String, !id.isEmpty else {
                throw NativeLibraryActions.Failure(message: "Не удалось загрузить трек")
            }
            resolvedTrackIds[key] = id
            return id
        case .remote(let provider, let externalId, let raw):
            if let known = raw["libraryTrackId"] as? String, !known.isEmpty, store.byId[known] != nil { return known }
            if let local = store.localCatalogTrack(provider: provider, externalId: externalId) { return local.trackId }
            let res = try await NativeServerApp.request("POST", "/api/public/prepare", body: [
                "provider": provider,
                "externalId": externalId,
                "priority": 0,
                "progressive": true,
            ], timeout: 120)
            guard let id = res["trackId"] as? String, !id.isEmpty else {
                throw NativeLibraryActions.Failure(message: "Не удалось подготовить трек")
            }
            resolvedTrackIds[key] = id
            return id
        }
    }

    private func hostState(command: String? = nil) async throws -> [String: Any] {
        guard let host = store.host else { return [:] }
        return try await withCheckedThrowingContinuation { continuation in
            let reply: NativeMixHost.Reply = { continuation.resume(with: $0) }
            if let command { host.command(command, source: "versionPreview", completion: reply) }
            else { host.state(reply) }
        }
    }

    func preview(_ choice: NativeVersionChoice) {
        if previewing == choice.id || busy == choice.id { stopPreview(); return }
        stopPreview(resume: false)
        let intent = generation, arguments = args(choice.id), nativeMode = usesNativeLibrary
        busy = choice.id
        let ticket = NativePreparationTicket()
        self.ticket = ticket
        previewTask = Task {
            defer { if generation == intent { busy = nil } }
            do {
                let source: [String: Any]
                var resolvedId = ""
                if nativeMode {
                    let trackId = try await resolveChoice(choice.id)
                    guard generation == intent, !Task.isCancelled else { return }
                    resolvedId = trackId
                    let nativeFiles: [String] = NativeDownloadManager.shared.localFile(trackId) != nil ? [trackId] : []
                    let manifest = try await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
                        "entries": [["trackId": trackId, "entryId": "version-preview", "file": 0]],
                        "previousId": trackId,
                        "nativeFiles": nativeFiles,
                    ], timeout: 90)
                    guard generation == intent, !Task.isCancelled else { return }
                    guard let item = (manifest["items"] as? [[String: Any]])?.first,
                          let itemSource = item["source"] as? [String: Any] else {
                        throw NativeLibraryActions.Failure(message: "Запись недоступна")
                    }
                    source = itemSource
                } else {
                    let value = try await store.call("versionSource", arguments, timeout: 90) as? [String: Any]
                    guard generation == intent, !Task.isCancelled, let itemSource = value?["source"] as? [String: Any] else { return }
                    source = itemSource
                }

                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mora-version-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                folder = directory
                let ext = (source["ext"] as? String).flatMap { $0.hasPrefix(".") && $0.count <= 8 ? $0 : nil } ?? ".media"
                let destination = directory.appendingPathComponent("preview\(ext)")
                let url: URL
                let kind = source["kind"] as? String ?? ""
                if nativeMode && (kind == "upload" || kind == "file") {
                    let tid = source["trackId"] as? String ?? resolvedId
                    let shared = ((source["serverPath"] as? String) ?? (source["path"] as? String)).flatMap {
                        NativeMediaLoader.sharedFile($0, root: NativeServerApp.root)
                    }
                    guard let localURL = shared ?? NativeDownloadManager.shared.localFile(tid) else {
                        throw NativeLibraryActions.Failure(message: "Запись недоступна")
                    }
                    url = localURL
                } else if !nativeMode && kind == "upload" {
                    FileManager.default.createFile(atPath: destination.path, contents: nil)
                    let file = try FileHandle(forWritingTo: destination)
                    defer { try? file.close() }
                    var offset = 0
                    repeat {
                        let chunk = try await store.call("versionAudio", arguments.merging(["offset": offset]) { _, new in new }, timeout: 90) as? [String: Any]
                        guard generation == intent, !Task.isCancelled else { return }
                        guard let total = chunk?["total"] as? Int, total > 0, total <= 128 * 1024 * 1024,
                              let base64 = chunk?["base64"] as? String, let data = Data(base64Encoded: base64),
                              !data.isEmpty, data.count <= 262144, offset + data.count <= total else { throw NativeShellError.page }
                        try file.write(contentsOf: data); offset += data.count
                        if offset == total { break }
                    } while true
                    url = destination
                } else {
                    var allowedHTTPHosts: Set<String> = []
                    if source["allowHTTP"] as? Bool == true,
                       let text = source["url"] as? String,
                       let host = URL(string: text)?.host {
                        allowedHTTPHosts.insert(host)
                    }
                    let loaderHTTP = NativeMediaHTTP(allowedHTTPHosts: allowedHTTPHosts, timeout: 90)
                    self.http = loaderHTTP
                    url = try await NativeMediaLoader(http: loaderHTTP).load(source, to: destination, folder: directory, ticket: ticket)
                }
                guard generation == intent, !Task.isCancelled else { return }
                let audio = try AVAudioPlayer(contentsOf: url)
                audio.prepareToPlay()
                if store.host?.active == true {
                    let current = try await hostState()
                    if current["playing"] as? Bool == true {
                        let snapshot = try await hostState(command: "pause")
                        guard generation == intent, !Task.isCancelled else { restoreMain(snapshot); return }
                        paused = snapshot
                    }
                } else {
                    if !nativeMode && webPaused == nil {
                        webPaused = try await store.call("versionPause") as? [String: Any]
                    }
                    try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                    try AVAudioSession.sharedInstance().setActive(true)
                    ownsPreviewSession = true
                }
                guard generation == intent, !Task.isCancelled else { return }
                audio.delegate = self; player = audio
                guard audio.play() else { throw NativeShellError.page }
                previewing = choice.id
                previewDuration = audio.duration; previewPosition = 0
                clock = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                    Task { @MainActor in self?.previewPosition = self?.player?.currentTime ?? 0 }
                }
            } catch {
                if generation == intent { errors = [error.localizedDescription]; stopPreview() }
            }
        }
    }

    func stopPreview(resume: Bool = true) {
        generation += 1; previewTask?.cancel(); previewTask = nil
        ticket?.cancel(); ticket = nil; http?.invalidate(); http = nil
        clock?.invalidate(); clock = nil
        player?.stop(); player = nil; previewing = nil; busy = nil
        if let folder { try? FileManager.default.removeItem(at: folder) }; folder = nil
        if resume, let webPaused {
            self.webPaused = nil
            Task { _ = try? await store.call("versionResume", webPaused) }
        }
        if resume, let previous = paused {
            paused = nil
            restoreMain(previous)
        }
        if resume, ownsPreviewSession {
            ownsPreviewSession = false
            if store.host?.active != true { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        }
    }

    private func restoreMain(_ snapshot: [String: Any]) {
        Task {
            guard let current = try? await hostState(), NativePreviewResume.allowed(current, after: snapshot) else { return }
            _ = try? await hostState(command: "play")
        }
    }

    func seekPreview(_ seconds: Double) {
        guard seconds.isFinite, let player else { return }
        player.currentTime = min(player.duration, max(0, seconds)); previewPosition = player.currentTime
    }

    func apply(_ mode: String) async -> Bool {
        guard selected != nil || mode == "restore" else { return false }
        let resume = paused != nil || webPaused?["playing"] as? Bool == true || store.miniPlaying
        let nativeMode = usesNativeLibrary
        stopPreview(resume: false); busy = "apply"
        defer { stopPreview() }
        do {
            if nativeMode {
                if mode == "separate" {
                    guard let key = selected else { return false }
                    let chosenId = try await resolveChoice(key)
                    _ = try await NativeServerApp.request("POST", "/api/tracks/\(Self.enc(chosenId))/save", body: ["saved": true])
                    try await store.refreshLibraryAfterMutation()
                    store.show("Версия добавлена отдельно")
                    return true
                }
                let assetId: Any = mode == "restore" ? NSNull() : try await resolveChoice(selected!)
                _ = try await NativeServerApp.request("POST", "/api/tracks/\(Self.enc(target.id))/binding", body: ["assetId": assetId])
                try await store.refreshLibraryAfterMutation()
                let qc = NativeQueueController.shared
                if qc.currentEntry?.trackId == target.id, let current = qc.currentEntry {
                    paused = nil
                    if qc.shuffle {
                        try await qc.editQueue(action: "jump", entryId: current.entryId)
                        if !resume { try? await qc.command("pause") }
                    } else {
                        try await qc.play(trackIds: qc.entries.map(\.trackId), at: qc.index, context: qc.context, startPaused: !resume, keepWave: qc.isWave)
                    }
                }
            } else {
                _ = try await store.call("versionApply", args(selected ?? "").merging(["mode": mode, "resume": resume]) { _, new in new }, timeout: 180)
            }
            store.show(mode == "restore" ? "Вернули исходную запись" : mode == "separate" ? "Версия добавлена отдельно" : "Запись заменена. Название и обложка сохранены")
            return true
        } catch { errors = [error.localizedDescription]; return false }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.stopPreview() }
    }
}

@MainActor struct NativeVersionView: View {
    @StateObject private var model: NativeVersionModel
    @Environment(\.dismiss) private var dismiss
    @State private var query: String
    @State private var variant = ""
    @State private var source = "all"
    private let yandex: Bool
    init(track: NativeTrack, store: NativeShellStore) {
        yandex = store.ui.wave.yandex
        _model = StateObject(wrappedValue: NativeVersionModel(target: track, store: store))
        _query = State(initialValue: "\(track.artist) \(track.title)".trimmingCharacters(in: .whitespaces))
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        NativeCover(url: model.target.cover, size: 56, radius: 8)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.target.title).font(.headline).lineLimit(2)
                            Text(model.target.artist).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Text("Название и обложка сохранятся").font(.footnote).foregroundStyle(.secondary)
                    Picker("Источник", selection: $source) {
                        Text("Все").tag("all"); Text("Медиатека").tag("local"); Text("YouTube Music").tag("ytmusic")
                        Text("YouTube").tag("youtube"); Text("SoundCloud").tag("soundcloud")
                        if yandex { Text("Яндекс Музыка").tag("yandex") }
                    }
                    Picker("Версия", selection: $variant) {
                        Text("Как есть").tag(""); Text("Explicit").tag("explicit"); Text("Без цензуры").tag("uncensored")
                        Text("Clean").tag("clean"); Text("Radio edit").tag("radio edit"); Text("Альбомная").tag("album version")
                        Text("Ремикс").tag("remix"); Text("Live").tag("live"); Text("Slowed").tag("slowed")
                    }
                }
                Section("Другие записи") {
                    if model.loading { ProgressView("Ищем версии…") }
                    ForEach(model.rows) { choice in choiceRow(choice) }
                    if !model.loading && model.rows.isEmpty { Text("Другие версии не найдены").foregroundStyle(.secondary) }
                    ForEach(model.errors, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Button("Добавить выбранную версию отдельно") { apply("separate") }.disabled(model.selected == nil || model.busy != nil)
                    if model.target.binding != nil {
                        Button("Вернуть исходную запись") { apply("restore") }.disabled(model.busy != nil)
                    }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Color.moraBackground)
            .navigationTitle("Другая версия").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Исполнитель и название")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() }.disabled(model.busy == "apply") } }
            .safeAreaInset(edge: .bottom) {
                Button { apply("bind") } label: {
                    HStack { if model.busy == "apply" { ProgressView() }; Text("Использовать для этого трека").fontWeight(.semibold) }
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).disabled(model.selected == nil || model.loading || model.busy != nil)
                .padding().background(.ultraThinMaterial)
            }
        }
        .tint(.moraMint)
        .animation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.25), value: model.selected)
        .animation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.25), value: model.rows.map(\.id))
        .task(id: "\(query)|\(variant)|\(source)") {
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            await model.search("\(query) \(variant)".trimmingCharacters(in: .whitespaces), source: source)
        }
        .onDisappear { model.stopPreview() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in model.stopPreview() }
        .interactiveDismissDisabled(model.busy == "apply")
    }
    private func choiceRow(_ choice: NativeVersionChoice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 10) {
            Button { model.selected = choice.id } label: {
                HStack(spacing: 10) {
                    NativeCover(url: choice.track.cover, size: 44, radius: 6)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(choice.track.title).foregroundStyle(.primary).lineLimit(2)
                        Text("\(choice.track.artist) · \(choice.source) · \(NativePlayerTime.text(choice.track.duration))").font(.caption).foregroundStyle(.secondary)
                        if !choice.tags.isEmpty { Text(choice.tags).font(.caption2).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                    if model.selected == choice.id { Image(systemName: "checkmark.circle.fill") }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!choice.track.ok || model.busy == "apply")
            Button { model.preview(choice) } label: {
                if model.busy == choice.id { ProgressView().frame(width: 44, height: 44) }
                else { Image(systemName: model.previewing == choice.id ? "stop.fill" : "play.fill").frame(width: 44, height: 44) }
            }.buttonStyle(.borderless).disabled(!choice.track.ok || model.busy == "apply")
                .accessibilityLabel(model.previewing == choice.id ? "Остановить прослушивание" : "Прослушать: \(choice.track.title)")
        }
        if model.previewing == choice.id {
            Slider(value: Binding(get: { model.previewPosition }, set: { model.seekPreview($0) }), in: 0...max(1, model.previewDuration))
                .accessibilityLabel("Позиция прослушивания")
            Text("\(NativePlayerTime.text(model.previewPosition)) / \(NativePlayerTime.text(model.previewDuration))")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        }
    }
    private func apply(_ mode: String) {
        Task { if await model.apply(mode) { dismiss() } }
    }
}
