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
}

@MainActor private final class NativeVersionModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
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
    private var player: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?
    private var ticket: NativePreparationTicket?
    private var http: NativeMediaHTTP?
    private var folder: URL?
    private var generation = 0
    private var paused: [String: Any]?

    init(target: NativeTrack, store: NativeShellStore) { self.target = target; self.store = store }
    private func args(_ key: String) -> [String: Any] { ["target": target.id, "session": session, "key": key] }

    func search(_ query: String, source: String) async {
        loading = true
        defer { if !Task.isCancelled { loading = false } }
        do {
            let value = try await store.call("versionSearch", ["target": target.id, "query": query, "source": source, "request": UUID().uuidString], timeout: 60) as? [String: Any]
            guard !Task.isCancelled else { return }
            session = value?["session"] as? String ?? ""
            rows = (value?["rows"] as? [[String: Any]] ?? []).compactMap(NativeVersionChoice.init)
            errors = value?["errors"] as? [String] ?? []
            selected = nil
        } catch { if !Task.isCancelled { rows = []; errors = [error.localizedDescription] } }
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
        let intent = generation, arguments = args(choice.id)
        busy = choice.id
        let ticket = NativePreparationTicket(), http = NativeMediaHTTP(timeout: 90)
        self.ticket = ticket; self.http = http
        previewTask = Task {
            defer { if generation == intent { busy = nil } }
            do {
                let value = try await store.call("versionSource", arguments, timeout: 90) as? [String: Any]
                guard generation == intent, !Task.isCancelled, let source = value?["source"] as? [String: Any] else { return }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mora-version-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                folder = directory
                let destination = directory.appendingPathComponent("preview.media")
                let url: URL
                if source["kind"] as? String == "upload" {
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
                    url = try await NativeMediaLoader(http: http).load(source, to: destination, folder: directory, ticket: ticket)
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
                    if webPaused == nil { webPaused = try await store.call("versionPause") as? [String: Any] }
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
        stopPreview(resume: false); busy = "apply"
        defer { stopPreview() }
        do {
            _ = try await store.call("versionApply", args(selected ?? "").merging(["mode": mode, "resume": resume]) { _, new in new }, timeout: 180)
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
    init(track: NativeTrack, store: NativeShellStore) {
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
                        Text("Все").tag("all"); Text("YouTube Music").tag("ytmusic")
                        Text("YouTube").tag("youtube"); Text("SoundCloud").tag("soundcloud")
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
