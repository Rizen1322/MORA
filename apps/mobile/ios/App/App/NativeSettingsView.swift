import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Settings are fetched and saved in the app-process server; no page description or page command.
struct NativeSettingsView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var settings: NativeSettingsState?
    @State private var confirmed: NativeSettingsState?
    @State private var busy = false
    @State private var editingSlider = false
    @State private var failure: String?
    @State private var message: String?
    @State private var advanced = false
    @State private var health: [String: Any]?
    @State private var healthFailure: String?
    @State private var importing = false
    @State private var backup: NativeSettingsBackup?
    @State private var clearCache = false
    @State private var share: NativeSettingsShareItem?
    @State private var shareCleanup: URL?

    private var off: Bool { settings?.bool("automix", "enabled", fallback: true) == false }
    private var stems: Bool { settings?.bool("automix", "stemMixing", fallback: true) != false }
    private var handoff: Bool { settings?.bool("automix", "eqHandoff", fallback: true) != false }

    var body: some View {
        NavigationStack {
            Form {
                if let failure { Section { Text(failure).foregroundStyle(.red); Button("Повторить") { Task { await load() } }.disabled(busy) } }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
                if settings != nil {
                    transitions
                    playback
                    downloads
                    appearance
                    more
                    backups
                    Section {
                        Toggle("Расширенные настройки", isOn: $advanced)
                    } footer: { Text("DJ-приёмы, пределы переходов и служебные сведения.") }
                    if advanced { advancedTransitions; services }
                } else if failure == nil { ProgressView("Загружаем настройки…") }
            }
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .tint(Color.moraMint)
            .navigationTitle("Настройки")
            .accessibilityIdentifier("native-settings-screen")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") } }
                if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
            }
            .refreshable { await load() }
            .task {
                await load()
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    await load() // The player and backup restore can change settings while this screen remains open.
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await load() } }
            .task(id: advanced) {
                guard advanced else { return }
                while !Task.isCancelled {
                    await loadHealth()
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                }
            }
            .confirmationDialog("Очистить кэш звука?", isPresented: $clearCache, titleVisibility: .visible) {
                Button("Очистить", role: .destructive) { clearAudioCache() }
            } message: { Text("Декодированный звук и сохранённые планы переходов будут созданы заново при воспроизведении. Медиатека, анализ и история сохранятся.") }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false, onCompletion: inspectBackup)
            .sheet(item: $share, onDismiss: discardShare) { NativeSettingsShareSheet(url: $0.url) }
        }
    }

    private var transitions: some View {
        Section {
            toggle("AutoMix", "automix", "enabled", true, "Плавные переходы между треками")
            picker("Характер", "automix", "style", "auto", [("auto", "Авто · рекомендуется"), ("smooth", "Длинные и плавные"), ("tight", "Короткие, по фразе")], "В режиме «Авто» зависит от музыки", disabled: off)
            toggle("Сводить по «Следующий»", "automix", "mixOnNext", true, "Первое нажатие — короткий переход, второе — сразу", disabled: off)
        } header: { Text("Переходы") } footer: { Text(off ? "AutoMix выключен: треки играют подряд без наложения." : "AutoMix сводит песни в темп и по фразам.") }
    }
    private var playback: some View {
        Section("Воспроизведение") {
            toggle("Радио после очереди", "wave", "continueRadio", true, "Когда альбом или плейлист закончился, играет похожая музыка")
            toggle("Альбомы без наложения", "automix", "respectAlbums", true, "Треки одного альбома идут подряд, как задумал автор", disabled: off)
            picker("Громкость", "automix", "loudnessTarget", "-16", [("off", "Выключено"), ("-14", "Громче (−14 LUFS)"), ("-16", "Обычно (−16 LUFS) · рекомендуется"), ("-18", "Тише, больше запаса (−18 LUFS)")], "Выравнивает громкость разных треков", numeric: true)
        }
    }
    private var downloads: some View {
        Section {
            toggle("Скачивать лайкнутые", "downloads", "autoLiked", false, "Любимое из YouTube, SoundCloud и Яндекса сохраняется на iPhone")
            toggle("Только Wi-Fi", "downloads", "wifiOnly", false, "Фоновые загрузки ждут Wi-Fi")
            picker("Держать волну скачанной", "downloads", "keepWave", "0", [("0", "Выключено"), ("5", "5 треков"), ("10", "10 треков"), ("20", "20 треков"), ("50", "50 треков")], "Следующие треки волны сохраняются с учётом лимита кэша", numeric: true)
            link("Загрузки", "/downloads", "arrow.down.circle")
        } header: { Text("Офлайн") } footer: {
            Text(settings?.bool("downloads", "wifiOnly", fallback: false) == true ? "Фоновые загрузки ждут подключения к Wi-Fi." : "Загрузка идёт через любое подключение, в том числе мобильное.")
        }
    }
    private var appearance: some View {
        Section("Внешний вид") {
            picker("Анимации", "ui", "motion", "system", [("system", "Как в системе"), ("full", "Полные"), ("reduced", "Минимум движения")], "Минимум заменяет визуализации статичным видом")
        }
    }
    private var more: some View {
        Section("Ещё") {
            link("Звук", "/sound", "slider.vertical.3", detail: "Эквалайзер и пресеты")
            link("Яндекс Музыка", "/sources", "person.crop.circle", detail: "Аккаунт и синхронизация")
            Button { verifyLibrary() } label: { Label("Проверить файлы медиатеки", systemImage: "checkmark.circle") }.disabled(busy)
        }
    }
    private var backups: some View {
        Section {
            Button { exportBackup(library: true) } label: { Label("Экспорт медиатеки", systemImage: "square.and.arrow.up") }.disabled(busy)
            link("Автоматические копии", "/backups", "clock.arrow.circlepath")
            Button { exportBackup(library: false) } label: { Label("Сохранить копию плейлистов", systemImage: "square.and.arrow.up") }.disabled(busy)
            Button { importing = true } label: { Label("Восстановить из файла", systemImage: "square.and.arrow.down") }.disabled(busy)
            if let backup {
                VStack(alignment: .leading, spacing: 4) {
                    Text(backup.name)
                    Text("Плейлистов: \(backup.count). Содержимое копии будет восстановлено.").font(.caption).foregroundStyle(.secondary)
                }
                Button("Восстановить") { restoreBackup() }.disabled(busy)
                Button("Отмена", role: .cancel) { self.backup = nil }.disabled(busy)
            }
        } header: { Text("Резервная копия") } footer: { Text("Медиатека: настройки, плейлисты, лайки и история. Копия плейлистов: названия и порядок песен. Аудиофайлы и аккаунты в копию не входят.") }
    }
    @ViewBuilder private var advancedTransitions: some View {
        Section("Переходы подробно") {
            picker("Начало следующего трека", "automix", "entryMode", "smart", [("smart", "Умный вход"), ("preserve", "Сохранять начало")], "Умный вход может пропустить часть вступления", disabled: off)
        }
        Section {
            toggle("Обмен басом", "automix", "eqHandoff", true, "Бас двух треков не звучит одновременно", disabled: off)
            toggle("DJ-подводки", "automix", "djPhrasing", true, "Фильтр и короткое эхо, не режущие вокал", disabled: off || !handoff || !stems)
            toggle("Стабильный темп вокала", "automix", "masterTempo", true, "Подстраивается следующий трек, а не текущий голос", disabled: off || !stems)
            toggle("Инструментальные петли", "automix", "loopBridges", true, "Затухающий финал держится повтором такта", disabled: off || !handoff || !stems)
        } header: { Text("DJ-приёмы") } footer: { if off { Text("Включите AutoMix, чтобы использовать DJ-приёмы.") } }
        Section {
            if settings?.string("automix", "entryMode", fallback: "smart") != "preserve" {
                slider("Пропуск вступления", "maxEntrySkipSeconds", 45, 0...75, 1, "с", "Насколько глубоко входить в следующий трек")
            }
            slider("Изменение темпа", "maxStretchPercent", 12, 0...16, 0.5, "%", "Предел для трека, высота тона сохраняется")
            slider("Длина перехода", "maxBlendSeconds", 32, 8...48, 1, "с", "Сколько максимум звучат два трека вместе")
            slider("Резервный кроссфейд", "fallbackSeconds", 6, 1...12, 1, "с", "Пока анализ трека не готов")
        } header: { Text("Пределы переходов") } footer: { Text("Точные точки и длину AutoMix выбирает по анализу музыки.") }
    }
    @ViewBuilder private var services: some View {
        Section("Служебные сведения") {
            if let health {
                LabeledContent("Декодер", value: health["decoder"] as? String ?? health["ffmpeg"] as? String ?? "Недоступен")
                if let analysis = health["analysis"] as? [String: Any] {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Анализ звука")
                        Text("Анализатор \(health["analyzer"] as? String ?? "—"), планировщик \(health["planner"] as? String ?? "—"), потоков \(integer(analysis["workers"])). В работе \(integer(analysis["running"])) · в очереди \(integer(analysis["queued"]))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Кэш звука")
                    Text("\(megabytes(health["pcmCacheBytes"])) из \(megabytes(health["pcmCacheLimit"])), сейчас используется \(megabytes(health["pcmCacheProtectedBytes"])). Старое удаляется само; текущий и следующий трек сохраняются.").font(.caption).foregroundStyle(.secondary)
                }
            } else if healthFailure == nil { ProgressView("Загружаем сведения…") }
            if let healthFailure { Text("Не удалось обновить сведения: \(healthFailure)").foregroundStyle(.secondary) }
            Button { exportDiagnostics() } label: { Label("Экспорт диагностики (ZIP)", systemImage: "square.and.arrow.up") }.disabled(busy || !MoraPlaybackJournal.enabled)
            Button("Очистить кэш звука", role: .destructive) { clearCache = true }.disabled(busy)
        }
        Section { link("Как сводятся треки", "/diagnostics", "waveform.path.ecg", detail: "Диагностика AutoMix") }
    }

    private func label(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) }
    }
    private func toggle(_ title: String, _ group: String, _ key: String, _ fallback: Bool, _ detail: String, disabled: Bool = false) -> some View {
        Toggle(isOn: Binding(get: { settings?.bool(group, key, fallback: fallback) ?? fallback }, set: { save(group, key, $0) })) { label(title, detail) }.disabled(busy || disabled)
    }
    private func picker(_ title: String, _ group: String, _ key: String, _ fallback: String, _ options: [(String, String)], _ detail: String, disabled: Bool = false, numeric: Bool = false) -> some View {
        Picker(selection: Binding(get: { settings?.picker(group, key, fallback: fallback) ?? fallback }, set: { value in
            do { save(group, key, try NativeSettingsState.pickerValue(value, numeric: numeric)) }
            catch { failure = error.localizedDescription }
        })) { ForEach(options.indices, id: \.self) { Text(options[$0].1).tag(options[$0].0) } } label: { label(title, detail) }
            .pickerStyle(.menu).disabled(busy || disabled)
    }
    private func slider(_ title: String, _ key: String, _ fallback: Double, _ range: ClosedRange<Double>, _ step: Double, _ unit: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(title); Spacer(); Text("\((settings?.number("automix", key, fallback: fallback) ?? fallback).formatted(.number.precision(.fractionLength(0...1)))) \(unit)").monospacedDigit().foregroundStyle(.secondary) }
            Slider(value: Binding(get: { settings?.number("automix", key, fallback: fallback) ?? fallback }, set: { settings = try? settings?.replacing("automix", key, with: $0) }), in: range, step: step, onEditingChanged: { editing in
                editingSlider = editing
                if !editing { save("automix", key, settings?.number("automix", key, fallback: fallback) ?? fallback) }
            }).accessibilityLabel(title)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }.disabled(busy || off)
    }
    private func link(_ title: String, _ path: String, _ symbol: String, detail: String? = nil) -> some View {
        Button { store.go(path) } label: {
            HStack { Label { VStack(alignment: .leading, spacing: 4) { Text(title); if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) } } } icon: { Image(systemName: symbol) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func integer(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private func megabytes(_ value: Any?) -> String { String(format: "%.0f МБ", ((value as? NSNumber)?.doubleValue ?? 0) / (1024 * 1024)) }

    @MainActor private func load() async {
        guard !busy, !editingSlider else { return }
        busy = true
        defer { busy = false }
        do {
            let raw = try await NativeServerApp.request("GET", "/api/settings")
            let value = try NativeSettingsState(raw)
            settings = value; confirmed = value; failure = nil
            NativeDownloadManager.shared.setWiFiOnly(value.bool("downloads", "wifiOnly", fallback: false))
        } catch { failure = error.localizedDescription }
    }
    private func save(_ group: String, _ key: String, _ value: Any) {
        guard !busy, settings != nil else { return }
        busy = true; failure = nil; message = nil
        settings = try? settings?.replacing(group, key, with: value)
        Task { @MainActor in
            defer { busy = false }
            do {
                let raw = try await NativeServerApp.request("PUT", "/api/settings", body: NativeSettingsState.patch(group, key, value))
                let saved = try NativeSettingsState(raw)
                settings = saved; confirmed = saved
                NativeDownloadManager.shared.setWiFiOnly(saved.bool("downloads", "wifiOnly", fallback: false))
            } catch { settings = confirmed; failure = "Настройки не сохранены: \(error.localizedDescription)" }
        }
    }
    @MainActor private func loadHealth() async {
        do { health = try await NativeServerApp.request("GET", "/api/health"); healthFailure = nil }
        catch { healthFailure = error.localizedDescription }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; failure = nil; message = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() } catch { failure = error.localizedDescription }
        }
    }
    private func verifyLibrary() {
        perform {
            let result = try await NativeServerApp.request("POST", "/api/library/verify")
            let missing = integer(result["missing"])
            message = missing > 0 ? "Не найдено файлов: \(missing)" : "Все файлы на месте"
            store.refreshLibrary()
        }
    }
    private func clearAudioCache() {
        perform { _ = try await NativeServerApp.request("POST", "/api/system/clear-cache"); message = "Кэш звука очищен"; await loadHealth() }
    }
    private func exportBackup(library: Bool) {
        perform {
            let raw = try await NativeServerApp.request("GET", "/api/backup/playlists" + (library ? "?library=1" : ""))
            let data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MORA-backup-\(UUID().uuidString)", isDirectory: true)
            let url = folder.appendingPathComponent(library ? "MORA-library.json" : "MORA-playlists.json")
            try await Task.detached(priority: .utility) {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                do { try data.write(to: url, options: .atomic) }
                catch { try? FileManager.default.removeItem(at: folder); throw error }
            }.value
            shareCleanup = folder; share = NativeSettingsShareItem(url: url)
        }
    }
    private func inspectBackup(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            if (error as NSError).code != NSUserCancelledError { failure = error.localizedDescription }
        case .success(let urls):
            guard let url = urls.first else { return }
            perform {
                let data = try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let file = try FileHandle(forReadingFrom: url)
                    defer { try? file.close() }
                    return try file.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data()
                }.value
                backup = try NativeSettingsBackup(data: data, name: url.lastPathComponent)
            }
        }
    }
    private func restoreBackup() {
        guard let backup else { return }
        perform {
            let result = try await NativeServerApp.request("POST", "/api/backup/playlists/restore", body: backup.raw)
            self.backup = nil
            let missing = integer(result["missingFiles"])
            message = "Восстановлено плейлистов: \(integer(result["playlists"]))." + (missing > 0 ? " Не найдено локальных файлов: \(missing). Их места в плейлистах сохранены." : "")
            let raw = try await NativeServerApp.request("GET", "/api/settings")
            let saved = try NativeSettingsState(raw)
            settings = saved; confirmed = saved
            NativeDownloadManager.shared.setWiFiOnly(saved.bool("downloads", "wifiOnly", fallback: false))
            store.refreshLibrary()
        }
    }
    private func exportDiagnostics() {
        perform { let url = try await store.exportDiagnostics(); shareCleanup = url; share = NativeSettingsShareItem(url: url) }
    }
    private func discardShare() {
        if let shareCleanup { try? FileManager.default.removeItem(at: shareCleanup) }
        shareCleanup = nil
    }
}

private struct NativeSettingsShareItem: Identifiable {
    let id = UUID()
    let url: URL
}
private struct NativeSettingsShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
