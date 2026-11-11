import SwiftUI
import UIKit

struct NativeBackupsView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var listing = NativeBackupFiles.Listing()
    @State private var loaded = false
    @State private var busy = false
    @State private var failure: String?
    @State private var message: String?
    @State private var selection: NativeBackupFiles.Selection?
    @State private var confirmation: NativeBackupFiles.Selection?
    @State private var share: Share?
    @State private var shareFolder: URL?
    private struct Share: Identifiable { let id = UUID(); let url: URL }

    var body: some View {
        NavigationStack {
            List {
                if let failure {
                    Section { Text(failure).foregroundStyle(.red) }
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
                if !listing.warnings.isEmpty {
                    Section { ForEach(listing.warnings, id: \.self) { Text($0).foregroundStyle(.secondary) } }
                }
                Section {
                    if !loaded { ProgressView("Загружаем копии…") }
                    else if listing.entries.isEmpty { Text(listing.warnings.isEmpty ? "Резервных копий пока нет" : "Доступных копий в списке нет").foregroundStyle(.secondary) }
                    ForEach(listing.entries) { entry in
                        Button { inspect(entry) } label: {
                            Label((entry.cloud ? "iCloud · " : "") + entry.name, systemImage: entry.cloud ? "icloud" : "clock.arrow.circlepath")
                        }.disabled(busy)
                    }
                    Button("Обновить список") { Task { await load() } }.disabled(busy)
                } footer: {
                    Text("Последние пять копий в каждом хранилище. Локальные копии удаляются вместе с приложением — сохраните важную через «Поделиться».")
                }
                if let selection {
                    Section {
                        Text(selection.backup.name).font(.headline)
                        LabeledContent("Плейлистов", value: String(selection.backup.count))
                        Text(selection.hasLibrary ? "Настройки, плейлисты, лайки и история будут восстановлены. Аудиофайлы и аккаунты в копию не входят." : "Будут восстановлены названия плейлистов и порядок песен. Аудиофайлы и аккаунты в копию не входят.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Восстановить") { confirmation = selection }.disabled(busy)
                            .accessibilityIdentifier("native-backups-restore")
                        Button { share(selection) } label: { Label("Поделиться", systemImage: "square.and.arrow.up") }.disabled(busy)
                        Button("Отмена", role: .cancel) { self.selection = nil }.disabled(busy)
                    } header: { Text("Выбранная копия") }
                }
            }
            .scrollContentBackground(.hidden).background(Color.moraBackground).tint(Color.moraMint)
            .navigationTitle("Резервные копии")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") } }
                if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
            }
            .accessibilityIdentifier("native-backups-screen")
            .task { await load() }
            .refreshable { await load() }
            .alert(item: $confirmation) { selected in
                Alert(title: Text("Восстановить копию?"),
                    message: Text(selected.hasLibrary ? "Будут восстановлены настройки, плейлисты, лайки и история из «\(selected.backup.name)». Существующие данные могут измениться." : "Будут восстановлены плейлисты из «\(selected.backup.name)». Ранее восстановленные плейлисты этой копии будут обновлены."),
                    primaryButton: .default(Text("Восстановить")) { restore(selected) }, secondaryButton: .cancel())
            }
            .sheet(item: $share, onDismiss: discardShare) { NativeBackupsShareSheet(url: $0.url) }
        }
    }
    @MainActor private func load() async {
        guard !busy else { return }
        busy = true; selection = nil; failure = nil
        defer { busy = false }
        let result = await Task.detached(priority: .utility) {
            var cloud: Result<URL, Error>?
            #if MORA_ICLOUD
            cloud = Result { try NativeBackupStore.cloudFolder() }
            #endif
            return NativeBackupFiles.listing(local: NativeBackupStore.folder, cloud: cloud)
        }.value
        guard !Task.isCancelled else { return }
        listing = result; loaded = true
    }
    @MainActor private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; failure = nil; message = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() } catch { failure = error.localizedDescription }
        }
    }
    private func inspect(_ entry: NativeBackupFiles.Entry) {
        selection = nil
        perform {
            do { selection = try await Task.detached(priority: .userInitiated) { try NativeBackupFiles.inspect(entry) }.value }
            catch {
                throw NativeSettingsState.Failure(message: "Не удалось открыть \(entry.cloud ? "копию iCloud" : "копию") «\(entry.name)»: \(error.localizedDescription)" +
                    (entry.cloud ? ". Дождитесь загрузки файла из iCloud и повторите." : ""))
            }
        }
    }
    private func share(_ selection: NativeBackupFiles.Selection) {
        perform {
            let file = try await Task.detached(priority: .utility) {
                try NativeBackupFiles.prepareShare(selection.backup.raw, library: selection.hasLibrary)
            }.value
            shareFolder = file.folder; share = Share(url: file.url)
        }
    }
    private func restore(_ selection: NativeBackupFiles.Selection) {
        perform {
            let result = try await NativeServerApp.request("POST", "/api/backup/playlists/restore", body: selection.backup.raw)
            self.selection = nil
            message = NativeBackupFiles.restoreMessage(result)
            store.refreshLibrary()
            do {
                let saved = try NativeSettingsState(try await NativeServerApp.request("GET", "/api/settings"))
                NativeDownloadManager.shared.setWiFiOnly(saved.bool("downloads", "wifiOnly", fallback: false))
            } catch { failure = "Копия восстановлена, но настройки не удалось обновить: \(error.localizedDescription)" }
        }
    }
    private func discardShare() {
        if let shareFolder { try? FileManager.default.removeItem(at: shareFolder) }
        shareFolder = nil
    }
}

private struct NativeBackupsShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
