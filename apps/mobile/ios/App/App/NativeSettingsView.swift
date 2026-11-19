import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Settings are fetched and saved in the app-process server; no page description or page command.
struct NativeSettingsView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var settings: NativeSettingsState?
    @State private var confirmed: NativeSettingsState?
    @State private var busy = false
    @State private var loading = false
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
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                        Button("Повторить") { Task { await load() } }.disabled(busy)
                    }.listRowBackground(Color.moraSurface)
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) }.listRowBackground(Color.moraSurface) }
                if settings != nil {
                    overview
                    transitions
                    playback
                    downloads
                    appearance
                    more
                    backups
                    Section {
                        Toggle("Расширенные настройки", isOn: $advanced)
                    } footer: { Text("DJ-приёмы, пределы переходов и служебные сведения.") }
                        .listRowBackground(Color.moraSurface)
                    if advanced { advancedTransitions; services }
                } else if failure == nil { ProgressView("Загружаем настройки…").listRowBackground(Color.clear) }
                Section { Color.clear.frame(height: 56).listRowBackground(Color.clear) }
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
                    await load(silent: true) // The player and backup restore can change settings while this screen remains open.
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await load(silent: true) } }
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

    private var overview: some View {
        let yandexLinked = store.ui.wave.sources.contains(.yandex)
        return Section {
            HStack(spacing: 10) {
                statPill("AutoMix", off ? "Выкл" : "Вкл", tint: off ? .secondary : .moraMint)
                statPill("Яндекс", yandexLinked ? "Активен" : "Отключён", tint: yandexLinked ? .moraMint : .moraGold)
                statPill("Треков", "\(store.library.count)", tint: .white)
            }
            .padding(.vertical, 4)
            .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            .listRowBackground(Color.moraSurface)
        }
    }

    private func statPill(_ label: String, _ value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.white.opacity(0.55)).textCase(.uppercase)
            Text(value).font(.subheadline.weight(.bold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.moraSurfaceElevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var transitions: some View {
        Section {
            toggle("AutoMix", "automix", "enabled", true, "Плавные переходы между треками")
            picker("Характер", "automix", "style", "auto", [("auto", "Авто"), ("smooth", "Длинные и плавные"), ("tight", "Короткие, по фразе")], "В режиме «Авто» зависит от музыки", disabled: off)
            toggle("Сводить по «Следующий»", "automix", "mixOnNext", true, "Первое нажатие — короткий переход, второе — сразу", disabled: off)
        } header: { Text("Переходы") } footer: { Text(off ? "AutoMix выключен: треки играют подряд без наложения." : "AutoMix сводит песни в темп и по фразам.") }
            .listRowBackground(Color.moraSurface)
    }
    private var playback: some View {
        Section("Воспроизведение") {
            toggle("Радио после очереди", "wave", "continueRadio", true, "Когда альбом или плейлист закончился, играет похожая музыка")
            toggle("Альбомы без наложения", "automix", "respectAlbums", true, "Треки одного альбома идут подряд, как задумал автор", disabled: off)
            picker("Громкость", "automix", "loudnessTarget", "-16", [("off", "Выключено"), ("-14", "Громче (−14 LUFS)"), ("-16", "Обычно (−16 LUFS)"), ("-18", "Тише, больше запаса (−18 LUFS)")], "Выравнивает громкость разных треков", numeric: true)
        }.listRowBackground(Color.moraSurface)
    }
    private var downloads: some View {
        Section {
            toggle("Скачивать лайкнутые", "downloads", "autoLiked", false, "Любимое из YouTube, SoundCloud и Яндекса сохраняется на iPhone")
            toggle("Только Wi-Fi", "downloads", "wifiOnly", false, "Фоновые загрузки ждут Wi-Fi")
            picker("Держать волну скачанной", "downloads", "keepWave", "0", [("0", "Выключено"), ("5", "5 треков"), ("10", "10 треков"), ("20", "20 треков"), ("50", "50 треков")], "Следующие треки волны сохраняются с учётом лимита кэша", numeric: true)
            link("Загрузки", "/downloads", "arrow.down.circle.fill")
        } header: { Text("Офлайн") } footer: {
            Text(settings?.bool("downloads", "wifiOnly", fallback: false) == true ? "Фоновые загрузки ждут подключения к Wi-Fi." : "Загрузка идёт через любое подключение, в том числе мобильное.")
        }.listRowBackground(Color.moraSurface)
    }
    private var appearance: some View {
        Section("Внешний вид") {
            picker("Анимации", "ui", "motion", "system", [("system", "Как в системе"), ("full", "Полные"), ("reduced", "Минимум движения")], "Минимум заменяет визуализации статичным видом")
        }.listRowBackground(Color.moraSurface)
    }
    private var more: some View {
        Section("Ещё") {
            link("Звук", "/sound", "slider.vertical.3", detail: "Эквалайзер и пресеты")
            link("Яндекс Музыка", "/sources", "person.crop.circle.fill", detail: "Аккаунт и синхронизация", tint: .moraGold)
            Button { verifyLibrary() } label: {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: "checkmark.circle.fill", size: 28, tint: .moraMint)
                    Text("Проверить файлы медиатеки").foregroundStyle(.white)
                    Spacer()
                }
            }.disabled(busy)
        }.listRowBackground(Color.moraSurface)
    }
    private var backups: some View {
        Section {
            Button { exportBackup(library: true) } label: {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: "square.and.arrow.up", size: 28, tint: .moraMint)
                    Text("Экспорт медиатеки").foregroundStyle(.white)
                }
            }.disabled(busy)
            link("Автоматические копии", "/backups", "clock.arrow.circlepath", tint: .moraGold)
            Button { exportBackup(library: false) } label: {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: "square.and.arrow.up.on.square", size: 28, tint: .moraMint)
                    Text("Сохранить копию плейлистов").foregroundStyle(.white)
                }
            }.disabled(busy)
            Button { importing = true } label: {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: "square.and.arrow.down", size: 28, tint: .moraGold)
                    Text("Восстановить из файла").foregroundStyle(.white)
                }
            }.disabled(busy)
            if let backup {
                VStack(alignment: .leading, spacing: 4) {
                    Text(backup.name)
                    Text("Плейлистов: \(backup.count). Содержимое копии будет восстановлено.").font(.caption).foregroundStyle(.secondary)
                }
                Button("Восстановить") { restoreBackup() }.disabled(busy)
                Button("Отмена", role: .cancel) { self.backup = nil }.disabled(busy)
            }
        } header: { Text("Резервная копия") } footer: { Text("Медиатека: настройки, плейлисты, лайки и история. Копия плейлистов: названия и порядок песен. Аудиофайлы и аккаунты в копию не входят.") }
            .listRowBackground(Color.moraSurface)
    }
    @ViewBuilder private var advancedTransitions: some View {
        Section("Переходы подробно") {
            picker("Начало следующего трека", "automix", "entryMode", "smart", [("smart", "Умный вход"), ("preserve", "Сохранять начало")], "Умный вход может пропустить часть вступления", disabled: off)
        }.listRowBackground(Color.moraSurface)
        Section {
            toggle("Обмен басом", "automix", "eqHandoff", true, "Бас двух треков не звучит одновременно", disabled: off)
            toggle("DJ-подводки", "automix", "djPhrasing", true, "Фильтр и короткое эхо, не режущие вокал", disabled: off || !handoff || !stems)
            toggle("Стабильный темп вокала", "automix", "masterTempo", true, "Подстраивается следующий трек, а не текущий голос", disabled: off || !stems)
            toggle("Инструментальные петли", "automix", "loopBridges", true, "Затухающий финал держится повтором такта", disabled: off || !handoff || !stems)
        } header: { Text("DJ-приёмы") } footer: { if off { Text("Включите AutoMix, чтобы использовать DJ-приёмы.") } }
            .listRowBackground(Color.moraSurface)
        Section {
            if settings?.string("automix", "entryMode", fallback: "smart") != "preserve" {
                slider("Пропуск вступления", "maxEntrySkipSeconds", 45, 0...75, 1, "с", "Насколько глубоко входить в следующий трек")
            }
            slider("Изменение темпа", "maxStretchPercent", 12, 0...16, 0.5, "%", "Предел для трека, высота тона сохраняется")
            slider("Длина перехода", "maxBlendSeconds", 32, 8...48, 1, "с", "Сколько максимум звучат два трека вместе")
            slider("Резервный кроссфейд", "fallbackSeconds", 6, 1...12, 1, "с", "Пока анализ трека не готов")
        } header: { Text("Пределы переходов") } footer: { Text("Точные точки и длину AutoMix выбирает по анализу музыки.") }
            .listRowBackground(Color.moraSurface)
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
        }.listRowBackground(Color.moraSurface)
        Section { link("Как сводятся треки", "/diagnostics", "waveform.path.ecg", detail: "Диагностика AutoMix", tint: .moraGold) }
            .listRowBackground(Color.moraSurface)
    }

    private func label(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) }
    }
    private func toggle(_ title: String, _ group: String, _ key: String, _ fallback: Bool, _ detail: String, disabled: Bool = false) -> some View {
        Toggle(isOn: Binding(get: { settings?.bool(group, key, fallback: fallback) ?? fallback }, set: { save(group, key, $0) })) { label(title, detail) }.disabled(busy || disabled)
    }
    private func picker(_ title: String, _ group: String, _ key: String, _ fallback: String, _ options: [(String, String)], _ detail: String, disabled: Bool = false, numeric: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title).foregroundStyle(.white).lineLimit(1)
                Spacer(minLength: 8)
                Picker(title, selection: Binding(get: { settings?.picker(group, key, fallback: fallback) ?? fallback }, set: { value in
                    do { save(group, key, try NativeSettingsState.pickerValue(value, numeric: numeric)) }
                    catch { failure = error.localizedDescription }
                })) { ForEach(options.indices, id: \.self) { Text(options[$0].1).tag(options[$0].0) } }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize(horizontal: true, vertical: false)
                    .tint(Color.moraMint)
            }
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .disabled(busy || disabled)
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
    private func link(_ title: String, _ path: String, _ symbol: String, detail: String? = nil, tint: Color = .moraMint) -> some View {
        Button { store.go(path) } label: {
            HStack(spacing: 12) {
                NativeIconBadge(symbol: symbol, size: 28, tint: tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.white)
                    if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
            }
        }
    }
    private func integer(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private func megabytes(_ value: Any?) -> String { String(format: "%.0f МБ", ((value as? NSNumber)?.doubleValue ?? 0) / (1024 * 1024)) }

    @MainActor private func load(silent: Bool = false) async {
        guard !busy, !loading, !editingSlider else { return }
        if silent { loading = true } else { busy = true }
        defer { if silent { loading = false } else { busy = false } }
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
            let file = try await Task.detached(priority: .utility) { try NativeBackupFiles.prepareShare(raw, library: library) }.value
            shareCleanup = file.folder; share = NativeSettingsShareItem(url: file.url)
        }
    }
    private func inspectBackup(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            if (error as NSError).code != NSUserCancelledError { failure = error.localizedDescription }
        case .success(let urls):
            guard let url = urls.first else { return }
            backup = nil
            perform {
                let data = try await Task.detached(priority: .userInitiated) { try NativeBackupFiles.read(url) }.value
                backup = try NativeSettingsBackup(data: data, name: url.lastPathComponent)
            }
        }
    }
    private func restoreBackup() {
        guard let backup else { return }
        perform {
            let result = try await NativeServerApp.request("POST", "/api/backup/playlists/restore", body: backup.raw)
            self.backup = nil
            message = NativeBackupFiles.restoreMessage(result)
            store.refreshLibrary()
            do {
                let raw = try await NativeServerApp.request("GET", "/api/settings")
                let saved = try NativeSettingsState(raw)
                settings = saved; confirmed = saved
                NativeDownloadManager.shared.setWiFiOnly(saved.bool("downloads", "wifiOnly", fallback: false))
            } catch { failure = "Копия восстановлена, но настройки не удалось обновить: \(error.localizedDescription)" }
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
