import SwiftUI

struct NativeImportPicker: View {
    let target: NativeImportPick
    let choose: ([String: Any]) -> Void
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.dismiss) private var dismiss
    @State private var query: String
    @State private var source = "all"
    @State private var results: [[String: Any]] = []
    @State private var errors: [String] = []
    @State private var loading = false

    init(target: NativeImportPick, choose: @escaping ([String: Any]) -> Void) {
        self.target = target; self.choose = choose
        _query = State(initialValue: (target.artist + " " + target.title).trimmingCharacters(in: .whitespaces))
    }
    private var local: [NativeTrack] {
        guard source == "all" || source == "local" else { return [] }
        return Array(NativeSearchText.filter(Array(store.byId.values).filter(\.ok), query).sorted { $0.id < $1.id }.prefix(40))
    }
    var body: some View {
        NavigationStack {
            List {
                header
                localResults
                remoteResults
            }
            .scrollContentBackground(.hidden).background(Color.moraBackground)
            .navigationTitle("Выбрать запись")
            .searchable(text: $query, prompt: "Название и исполнитель")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
            .task(id: source + "|" + query) { await search() }
        }
    }
    private var header: some View {
        Section {
            Text(target.title).font(.headline)
            Text(target.artist).foregroundStyle(.secondary)
            Picker("Источник", selection: $source) {
                Text("Все").tag("all"); Text("Медиатека").tag("local"); Text("YouTube Music").tag("ytmusic")
                Text("YouTube").tag("youtube"); Text("SoundCloud").tag("soundcloud")
            }
        }
    }
    @ViewBuilder private var localResults: some View {
        if !local.isEmpty {
            Section("Медиатека") { ForEach(local) { track in localRow(track) } }
        }
    }
    private func localRow(_ track: NativeTrack) -> some View {
        Button { choose(["trackId": track.id]); dismiss() } label: {
            HStack(spacing: 12) {
                NativeCover(url: track.cover, size: 44)
                VStack(alignment: .leading) { Text(track.title); Text(track.artist).font(.caption).foregroundStyle(.secondary) }
            }.frame(minHeight: 44)
        }
    }
    private var remoteResults: some View {
        Section("Найденные записи") {
            if loading { ProgressView("Ищем записи…") }
            ForEach(results.indices, id: \.self) { index in remoteRow(results[index]) }
            ForEach(errors, id: \.self) { Text($0).foregroundStyle(.secondary) }
            if !loading && results.isEmpty && errors.isEmpty { Text("Записи не найдены").foregroundStyle(.secondary) }
        }
    }
    private func remoteRow(_ row: [String: Any]) -> some View {
        let title = row["title"] as? String ?? "", artist = row["artist"] as? String ?? "", provider = row["audioProvider"] as? String ?? ""
        return Button {
            do { choose(try NativeImportState.candidate(row)); dismiss() }
            catch { errors = [error.localizedDescription] }
        } label: {
            HStack(spacing: 12) {
                NativeCover(url: row["coverUrl"] as? String, size: 44)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                    Text(artist + " · " + provider).font(.caption).foregroundStyle(.secondary)
                }
            }.frame(minHeight: 44)
        }
    }
    @MainActor private func search() async {
        loading = true; results = []; errors = []
        defer { if !Task.isCancelled { loading = false } }
        let query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard !query.isEmpty, source != "local" else { return }
        do {
            try await Task.sleep(for: .milliseconds(300))
            var found: [[String: Any]] = [], failures: [String] = [], seen = Set<String>()
            for provider in source == "all" ? ["ytmusic", "youtube", "soundcloud"] : [source] {
                var url = URLComponents()
                url.path = "/api/search/" + provider; url.queryItems = [URLQueryItem(name: "q", value: query)]
                do {
                    let response = try await NativeServerApp.request("GET", url.string!)
                    try Task.checkCancellation()
                    for item in response["items"] as? [[String: Any]] ?? [] {
                        guard let candidate = try? NativeImportState.candidate(item), let id = candidate["externalId"] as? String,
                              let provider = candidate["provider"] as? String, seen.insert(provider + ":" + id).inserted else { continue }
                        found.append(item)
                    }
                } catch is CancellationError { return }
                catch { failures.append(provider + ": " + error.localizedDescription) }
                guard !Task.isCancelled else { return }
                results = found; errors = failures
            }
            guard !Task.isCancelled else { return }
            results = found; errors = failures
        } catch is CancellationError {} catch { errors = [error.localizedDescription] }
    }
}
