import SwiftUI
import UIKit

struct NativeBackupsView: View {
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
        List {
            if let failure {
                Section { Text(failure).foregroundStyle(.red) }
                    .listRowBackground(Color.moraSurface)
            }
            if let message {
                Section { Text(message).foregroundStyle(.secondary) }
                    .listRowBackground(Color.moraSurface)
            }
            if !listing.warnings.isEmpty {
                Section { ForEach(listing.warnings, id: \.self) { Text($0).foregroundStyle(.secondary) } }
                    .listRowBackground(Color.moraSurface)
            }
            Section {
                if !loaded {
                    ProgressView("Загружаем копии…")
                } else if listing.entries.isEmpty {
                    Text(listing.warnings.isEmpty ? "Резервных копий пока нет" : "Доступных копий в списке нет").foregroundStyle(.secondary)
                }
                ForEach(listing.entries) { entry in
                    Button { inspect(entry) } label: {
                        HStack(spacing: 12) {
                            NativeIconBadge(
                                symbol: entry.cloud ? "icloud" : "clock.arrow.circlepath",
                                size: 30,
                                tint: entry.cloud ? .moraMint : .moraGold
                            )
                            Text((entry.cloud ? "iCloud · " : "") + entry.name)
                                .foregroundStyle(.white)
                                .lineLimit(2)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.forward")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.32))
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(MoraRowPressStyle())
                    .disabled(busy)
                }
                Button("Обновить список") { Task { await load() } }.disabled(busy)
            } footer: {
                Text("Последние пять копий в каждом хранилище. Локальные копии удаляются вместе с приложением — сохраните важную через «Поделиться».")
            }
            .listRowBackground(Color.moraSurface)
        }
        .scrollContentBackground(.hidden).background(Color.moraBackground).tint(Color.moraMint)
        .navigationTitle("Резервные копии")
        .toolbar {
            if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: loaded)
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: listing.entries.count)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: failure)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: message)
        .accessibilityIdentifier("native-backups-screen")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $selection) { selected in
            NavigationStack {
                Form {
                    Section {
                        Text(selected.backup.name).font(.headline)
                        LabeledContent("Плейлистов", value: String(selected.backup.count))
                        Text(selected.hasLibrary ? "Настройки, плейлисты, лайки и история будут восстановлены. Аудиофайлы и аккаунты в копию не входят." : "Будут восстановлены названия плейлистов и порядок песен. Аудиофайлы и аккаунты в копию не входят.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } header: { Text("Выбранная копия") }
                        .listRowBackground(Color.moraSurface)
                    Section {
                        Button("Восстановить") { confirmation = selected }.disabled(busy)
                            .accessibilityIdentifier("native-backups-restore")
                        Button { share(selected) } label: { Label("Поделиться", systemImage: "square.and.arrow.up") }.disabled(busy)
                    }
                    .listRowBackground(Color.moraSurface)
                }
                .scrollContentBackground(.hidden).background(Color.moraBackground)
                .navigationTitle("Резервная копия").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Готово") { selection = nil }
                    }
                }
                .confirmationDialog(
                    "Восстановить копию?",
                    isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
                    titleVisibility: .visible,
                    presenting: confirmation
                ) { item in
                    Button("Восстановить") {
                        selection = nil
                        restore(item)
                    }
                    Button("Отмена", role: .cancel) {}
                } message: { item in
                    Text(item.hasLibrary ? "Будут восстановлены настройки, плейлисты, лайки и история из «\(item.backup.name)». Существующие данные могут измениться." : "Будут восстановлены плейлисты из «\(item.backup.name)». Ранее восстановленные плейлисты этой копии будут обновлены.")
                }
                .sheet(item: $share, onDismiss: discardShare) { NativeBackupsShareSheet(url: $0.url) }
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
            .presentationBackground(Color.moraBackground)
            .tint(.moraMint)
            .preferredColorScheme(.dark)
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
