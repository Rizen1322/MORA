import SwiftUI
import UIKit

/// Account forms talk to the app-process JSC API, including while WebContent is suspended.
struct NativeSourcesView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var account: NativeSourceAccount?
    @State private var settings: NativeSettingsState?
    @State private var values: [String: String] = [:]
    @State private var likes: NativeSourceLikes?
    @State private var likesFailure: String?
    @State private var failure: String?
    @State private var message: String?
    @State private var busy = false
    @State private var generation = 0
    @State private var readingLikes = false
    @State private var disconnecting = false
    @State private var cancellingImport = false

    private let request: NativeSourcesState.Request = { method, path, body in
        try await NativeServerApp.request(method, path, body: body)
    }
    private var importLikes: Bool { settings?.bool("yandex", "importLikes", fallback: true) != false }

    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                        Button("Повторить") { Task { await load(force: true) } }.disabled(busy)
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
                if let account {
                    connection(account)
                    if account.linked {
                        if settings != nil { synchronization }
                        if importLikes { likesImport }
                        Section {
                            Button { store.go("/search?src=yandex") } label: { Label("Поиск в Яндексе", systemImage: "magnifyingglass") }
                            Button { store.go("/yandex-playlists") } label: { Label("Мои плейлисты Яндекса", systemImage: "music.note.list") }
                            Button { store.waveSource = .yandex; store.go("/wave") } label: { Label("Моя волна Яндекса", systemImage: "waveform") }
                        }
                    }
                    if account.hasSecret || account.connected {
                        Section {
                            Button("Отключить аккаунт", role: .destructive) { disconnecting = true }.disabled(busy)
                        }
                    }
                } else if failure == nil { ProgressView("Проверяем подключение…") }
                Section {
                    Text("SoundCloud и YouTube Music доступны через поиск без подключения аккаунта.").foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("Источники")
            .accessibilityIdentifier("native-sources-screen")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") } }
                if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
            }
            .refreshable { await load(force: true) }
            .task { await load() }
            .task(id: account?.linked == true && importLikes) {
                guard account?.linked == true && importLikes else { return }
                while !Task.isCancelled {
                    await loadLikes()
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await load(force: true) } }
            .onDisappear { values.removeAll() }
            .confirmationDialog("Отключить Яндекс Музыку?", isPresented: $disconnecting, titleVisibility: .visible) {
                Button("Отключить", role: .destructive) { disconnect() }
            } message: { Text("Токен будет удалён. Музыка, уже добавленная в медиатеку, сохранится.") }
            .confirmationDialog("Завершить импорт лайков?", isPresented: $cancellingImport, titleVisibility: .visible) {
                Button("Завершить импорт", role: .destructive) { changeLikes("cancel") }
            } message: { Text("Уже добавленные треки останутся в медиатеке.") }
        }
    }

    private func connection(_ account: NativeSourceAccount) -> some View {
        Section {
            Label(account.label, systemImage: account.connected ? "checkmark.circle.fill" : "person.crop.circle.badge.exclamationmark")
                .foregroundStyle(account.connected ? Color.moraMint : Color.moraGold)
            if let name = account.name { Text(name) }
            if !account.detail.isEmpty { Text(account.detail).font(.footnote).foregroundStyle(.secondary) }
            if !account.connected {
                ForEach(account.fields) { field in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(field.title).font(.subheadline)
                        credential(field, account)
                        if !field.help.isEmpty { Text(field.help).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if !account.fields.isEmpty {
                    Button(account.hasSecret ? "Проверить подключение" : "Подключить Яндекс") { connect(account) }
                        .disabled(busy).accessibilityIdentifier("sources.connect")
                }
                ForEach(account.docs, id: \.absoluteString) { url in Link(url.host ?? "Помощь со входом", destination: url) }
            }
        } header: { Text("Яндекс Музыка") } footer: { Text("Аккаунт нужен для вашей волны, лайков и плейлистов Яндекса.") }
    }

    private func credential(_ field: NativeSourceAccount.Field, _ account: NativeSourceAccount) -> some View {
        let binding = Binding(get: { values[field.key] ?? (field.secret ? "" : account.config[field.key] ?? "") }, set: { values[field.key] = $0 })
        let placeholder = field.placeholder.isEmpty && field.secret && account.hasSecret ? "Сохранён — оставьте пустым" : field.placeholder
        return Group {
            if field.secure { SecureField(placeholder, text: binding) }
            else { TextField(placeholder, text: binding) }
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(busy).privacySensitive().accessibilityLabel(field.title)
    }

    private var synchronization: some View {
        Section {
            sync("Лайки", "syncLikes", "Нравится в MORA ставит лайк в Яндексе")
            sync("Дизлайки", "syncDislikes", "Не нравится в MORA ставит дизлайк в Яндексе")
            sync("Импорт лайков в медиатеку", "importLikes", "Коллекция Яндекса попадает в «Любимое»")
            sync("Обучение «Моей волны»", "waveFeedback", "Яндекс узнаёт, что прозвучало и что пропущено")
        } header: { Text("Синхронизация") }
    }

    private func sync(_ title: String, _ key: String, _ detail: String) -> some View {
        Toggle(isOn: Binding(get: { settings?.bool("yandex", key, fallback: true) == true }, set: { save(key, $0) })) {
            VStack(alignment: .leading, spacing: 4) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) }
        }.disabled(busy)
    }

    private var likesImport: some View {
        Section {
            if let likesFailure {
                Text(likesFailure).foregroundStyle(.red)
                Button("Обновить состояние") { Task { await loadLikes() } }.disabled(busy)
            } else {
                if let likes {
                    ProgressView(value: likes.progress) { Text(likes.title) }
                    Text("В Любимом: \(likes.done) из \(likes.total) · ошибок: \(likes.failed) · пропущено: \(likes.skipped)").font(.caption).foregroundStyle(.secondary)
                    if !likes.message.isEmpty { Text(likes.message).font(.caption).foregroundStyle(.secondary) }
                    if likes.active { Button("Приостановить") { changeLikes("pause") }.disabled(busy) }
                    else if !likes.finished { Button("Продолжить") { changeLikes("resume") }.disabled(busy || likes.busy) }
                    if likes.finished { Button("Обновить коллекцию") { changeLikes("start") }.disabled(busy || likes.busy) }
                    if !likes.active && likes.state != "cancelled" && likes.failed > 0 {
                        Button("Повторить ошибки") { changeLikes("retry") }.disabled(busy || likes.busy)
                    }
                    if !likes.finished { Button("Завершить импорт", role: .destructive) { cancellingImport = true }.disabled(busy) }
                    if likes.done > 0 { Button("Открыть Любимое") { store.go("/liked") } }
                } else {
                    Button("Добавить все лайки в Любимое") { changeLikes("start") }.disabled(busy)
                }
            }
        } header: { Text("Любимое из Яндекса") } footer: { Text("Перенесите коллекцию лайков в MORA. Подготовка треков продолжится после закрытия этой страницы.") }
    }

    @MainActor private func load(force: Bool = false) async {
        guard !busy else { return }
        busy = true; generation &+= 1
        defer { busy = false }
        do {
            let account = try await NativeSourcesState.account(force: force, request: request)
            self.account = account; store.updateYandexConnection(account.linked)
            settings = try NativeSettingsState(await request("GET", "/api/settings", nil))
            failure = nil
        } catch is CancellationError {} catch { failure = error.localizedDescription }
    }
    @MainActor private func loadLikes() async {
        guard !busy, !readingLikes else { return }
        let current = generation
        readingLikes = true
        defer { readingLikes = false }
        do {
            let value = try await NativeSourcesState.likes(request: request)
            guard !Task.isCancelled, current == generation else { return }
            likes = value; likesFailure = nil
        } catch is CancellationError {} catch {
            if !Task.isCancelled && current == generation { likesFailure = error.localizedDescription }
        }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; generation &+= 1; failure = nil; message = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() } catch { failure = error.localizedDescription }
        }
    }
    private func connect(_ account: NativeSourceAccount) {
        perform {
            let connected = try await NativeSourcesState.connect(account, values: values, request: request)
            values.removeAll(); self.account = connected; store.updateYandexConnection(connected.linked)
            message = "Яндекс подключён"
            settings = try NativeSettingsState(await request("GET", "/api/settings", nil))
        }
    }
    private func disconnect() {
        perform {
            try await NativeSourcesState.disconnect(request: request)
            values.removeAll(); account = nil; likes = nil; likesFailure = nil
            store.updateYandexConnection(false); message = "Аккаунт отключён"
            account = try await NativeSourcesState.account(request: request)
        }
    }
    private func save(_ key: String, _ value: Bool) {
        perform {
            settings = try NativeSettingsState(await request("PUT", "/api/settings", NativeSettingsState.patch("yandex", key, value)))
        }
    }
    private func changeLikes(_ action: String) {
        perform {
            try await NativeSourcesState.changeLikes(action, request: request)
            do { likes = try await NativeSourcesState.likes(request: request); likesFailure = nil }
            catch { likesFailure = "Команда выполнена. Не удалось обновить состояние: \(error.localizedDescription)" }
            store.refreshLibrary()
        }
    }
}
