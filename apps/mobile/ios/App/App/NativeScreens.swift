import SwiftUI
import UIKit

/// Native screens of the shell (NativeShell.swift). Anything they link to that is not ported
/// (albums, playlists, settings pages…) opens the web page through the page's router.

// MARK: Home

struct NativeHomeView: View {
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    NativeWaveHero(wave: store.ui.wave)
                    tiles
                    if store.ui.loaded && store.library.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Добавьте свою музыку").font(.title3.bold())
                            Text("Импортируйте файлы или плейлист, либо найдите музыку в поиске.").foregroundStyle(.white.opacity(0.65))
                            Button("Импорт") { store.go("/import") }.buttonStyle(.borderedProminent).frame(minHeight: 44)
                        }
                    }
                    rail("Недавно добавленные", Array(store.library.prefix(16)), type: "library", all: "/library")
                    rail("Любимое", Array(store.liked.prefix(16)), type: "liked", all: "/liked")
                    if !store.playlists.isEmpty { playlists }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "ru_RU"))))
                    .font(.subheadline.weight(.medium)).foregroundStyle(.white.opacity(0.6))
                Text(NativeText.greeting(hour: Calendar.current.component(.hour, from: .now)))
                    .font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            }
            Spacer()
            Button { store.go("/more") } label: {
                Image(systemName: "person.crop.circle").font(.title2).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Профиль и настройки")
        }
    }

    private var tiles: some View {
        let items: [(String, String, String, Bool)] = [("/liked", "Любимое", "heart.fill", false), ("/downloads", "Загрузки", "arrow.down.circle.fill", false),
                                                      ("/history", "История", "clock.arrow.circlepath", true), ("/import", "Импорт", "square.and.arrow.down.fill", true)]
        return HStack(alignment: .top, spacing: 8) {
            ForEach(items, id: \.0) { item in
                Button { store.go(item.0) } label: {
                    VStack(spacing: 6) {
                        Image(systemName: item.2).font(.title3)
                            .foregroundStyle(item.3 ? Color.moraGold : Color.moraMint)
                            .frame(width: 56, height: 56)
                            .background((item.3 ? Color.moraGold : Color.moraMint).opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        Text(item.1).font(.caption.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private func rail(_ title: String, _ tracks: [NativeTrack], type: String, all: String) -> some View {
        if !tracks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Показать все") { store.go(all) }.font(.subheadline.weight(.medium)).frame(minHeight: 44)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(Array(tracks.enumerated()), id: \.element.id) { i, t in
                            Button { store.play(tracks, at: i, type: type, label: title) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    NativeCover(url: t.cover, size: 140, radius: 12)
                                    Text(t.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    Text(t.artist).font(.caption).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                                }
                                .frame(width: 140, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Играть")
                            .contextMenu { NativeTrackActions(track: t, play: { store.play(tracks, at: i, type: type, label: title) }) }
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    private var playlists: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Плейлисты").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(store.playlists) { p in
                        Button { store.go("/playlist/\(p.id)") } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                NativeCover(url: p.cover, size: 140, radius: 12)
                                Text(p.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(NativeText.tracks(p.count)).font(.caption).foregroundStyle(.white.opacity(0.6))
                            }
                            .frame(width: 140, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .scrollClipDisabled()
        }
    }
}

/// «Моя волна»: source switch (Коллекция / Радио / Яндекс) and Play, as the web Home hero.
struct NativeWaveHero: View {
    let wave: NativeWave
    @EnvironmentObject private var store: NativeShellStore
    @State private var source: NativeWaveSource?

    var body: some View {
        let selected = source.flatMap { wave.sources.contains($0) ? $0 : nil } ?? wave.preferred
        let button = wave.button(selected)
        VStack(alignment: .leading, spacing: 14) {
            (Text("Моя волна") + Text(".").foregroundColor(.moraMint)).font(.title.bold()).accessibilityAddTraits(.isHeader)
            Text("Знакомое, любимое и то, что ещё предстоит открыть.").foregroundStyle(.white.opacity(0.7))
            Picker("Источник волны", selection: Binding(get: { selected }, set: { source = $0 })) {
                ForEach(wave.sources, id: \.self) { s in
                    Text(s == .own ? "Коллекция" : s == .online ? "Радио" : "Яндекс").tag(s)
                }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 10) {
                Button { store.run("wave", ["source": selected.rawValue]) } label: {
                    Label(button.title, systemImage: button.symbol).font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .foregroundStyle(Color.moraBackground)
                        .background(Color.moraMint.opacity(button.enabled ? 1 : 0.4), in: Capsule())
                }
                .disabled(!button.enabled)
                Button { store.go("/wave") } label: {
                    Image(systemName: "slider.horizontal.3").font(.headline).frame(width: 50, height: 50)
                        .background(.white.opacity(0.1), in: Circle())
                }
                .accessibilityLabel("Настроить волну")
            }
            if let error = wave.error, !error.isEmpty {
                Text(error).font(.footnote).foregroundStyle(Color(red: 1, green: 0.55, blue: 0.5))
            }
        }
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.10, green: 0.30, blue: 0.21), Color(red: 0.04, green: 0.11, blue: 0.08)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Color.moraMint.opacity(0.18)))
        }
        .onChange(of: wave.active) { _, active in if active != nil { source = nil } } // follow what plays now
    }
}

// MARK: Library and liked tracks

struct NativeTrackListView: View {
    let title: String
    let type: String
    let tracks: [NativeTrack]
    @EnvironmentObject private var store: NativeShellStore
    @State private var query = ""

    var body: some View {
        let shown = NativeSearchText.filter(tracks, query)
        NavigationStack {
            List {
                if !store.ui.loaded {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if shown.isEmpty {
                    let liked = type == "liked"
                    let title: String = !query.isEmpty ? "Ничего не найдено" : liked ? "Пока ничего любимого" : "Медиатека пуста"
                    let hint: String = !query.isEmpty ? "Попробуйте другой запрос." : liked ? "Отмечайте треки сердцем — они соберутся здесь." : "Добавьте музыку через импорт или поиск."
                    ContentUnavailableView(title, systemImage: liked ? "heart" : "music.note.list", description: Text(hint))
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                            NativeTrackRow(track: t) { store.play(shown, at: i, type: type, label: title) }
                        }
                    } header: {
                        Text(NativeText.tracks(shown.count)).font(.footnote).foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название, исполнитель, альбом")
            .navigationTitle(title)
            .toolbar {
                if type == "library" {
                    Menu {
                        Button("Альбомы") { store.go("/library/albums") }
                        Button("Исполнители") { store.go("/library/artists") }
                        Button("Плейлисты") { store.go("/library/playlists") }
                    } label: {
                        Image(systemName: "square.stack").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Разделы медиатеки")
                }
            }
        }
    }
}

struct NativeTrackRow: View {
    let track: NativeTrack
    let play: () -> Void
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        Button(action: play) {
            HStack(spacing: 12) {
                NativeCover(url: track.cover, size: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title).font(.body.weight(.medium)).lineLimit(1)
                    Text(track.artist).font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                }
                Spacer(minLength: 4)
                if track.liked {
                    Image(systemName: "heart.fill").font(.caption).foregroundStyle(Color.moraMint).accessibilityHidden(true)
                }
                Text(NativePlayerTime.text(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.white.opacity(0.5))
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
            .opacity(track.ok ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!track.ok)
        .listRowBackground(Color.clear)
        .accessibilityLabel("\(track.title), \(track.artist)\(track.liked ? ", в любимом" : "")")
        .accessibilityValue(NativePlayerTime.text(track.duration))
        .accessibilityHint(track.ok ? "Играть" : "Файл недоступен")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { store.queue(track, next: true) } label: { Label("Следующим", systemImage: "text.line.first.and.arrowtriangle.forward") }
                .tint(.moraMint)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { store.queue(track, next: false) } label: { Label("В очередь", systemImage: "text.append") }
                .tint(.indigo)
            Button { store.react(track, track.liked ? 0 : 1) } label: {
                Label(track.liked ? "Убрать" : "Нравится", systemImage: track.liked ? "heart.slash" : "heart")
            }
            .tint(.moraGold)
        }
        .contextMenu { NativeTrackActions(track: track, play: play) }
        .accessibilityAction(named: "Играть следующим") { store.queue(track, next: true) }
        .accessibilityAction(named: "Добавить в очередь") { store.queue(track, next: false) }
        .accessibilityAction(named: track.liked ? "Убрать из любимого" : "Нравится") { store.react(track, track.liked ? 0 : 1) }
    }
}

struct NativeTrackActions: View {
    let track: NativeTrack
    let play: () -> Void
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        Button(action: play) { Label("Играть", systemImage: "play") }.disabled(!track.ok)
        Button { store.queue(track, next: true) } label: { Label("Играть следующим", systemImage: "text.line.first.and.arrowtriangle.forward") }.disabled(!track.ok)
        Button { store.queue(track, next: false) } label: { Label("Добавить в очередь", systemImage: "text.append") }.disabled(!track.ok)
        Divider()
        Button { store.react(track, track.liked ? 0 : 1) } label: {
            Label(track.liked ? "Убрать из любимого" : "Нравится", systemImage: track.liked ? "heart.slash" : "heart")
        }
        Button { store.react(track, track.reaction < 0 ? 0 : -1) } label: {
            Label(track.reaction < 0 ? "Убрать «Не нравится»" : "Не нравится", systemImage: "hand.thumbsdown")
        }
        Divider()
        if !track.album.isEmpty {
            Button { store.run("open", ["id": track.id, "to": "album"]) } label: { Label("Перейти к альбому", systemImage: "square.stack") }
        }
        Button { store.run("open", ["id": track.id, "to": "artist"]) } label: { Label("Перейти к исполнителю", systemImage: "music.mic") }
    }
}

// MARK: Search

/// Catalog search: the collection, YouTube Music and SoundCloud (the web /search page, without its extras).
struct NativeSearchView: View {
    private static let sources: [(String, String)] = [("ytmusic", "YouTube Music"), ("soundcloud", "SoundCloud")]
    @EnvironmentObject private var store: NativeShellStore
    @State private var query = ""
    @State private var results: [String: [NativeTrack]] = [:]
    @State private var errors: [String: String] = [:]
    @State private var searching: Set<String> = []

    var body: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let local = trimmed.isEmpty ? [] : Array(NativeSearchText.filter(store.library, trimmed).prefix(4))
        NavigationStack {
            List {
                if let title = store.ui.preparing {
                    Label("Подготавливаем «\(title)»…", systemImage: "arrow.down.circle").foregroundStyle(Color.moraMint)
                        .listRowBackground(Color.clear)
                }
                if trimmed.isEmpty {
                    Text("Ищите исполнителей, треки или вставьте ссылку. Найденное можно сразу слушать или добавить в очередь.")
                        .foregroundStyle(.white.opacity(0.6)).listRowBackground(Color.clear)
                }
                if !local.isEmpty {
                    Section("Моя музыка") {
                        ForEach(Array(local.enumerated()), id: \.element.id) { i, t in
                            NativeTrackRow(track: t) { store.play(local, at: i, type: "search", label: trimmed) }
                        }
                    }
                }
                if !trimmed.isEmpty {
                    ForEach(Self.sources, id: \.0) { source, label in
                        Section(label) {
                            if let error = errors[source] {
                                Text(error).font(.footnote).foregroundStyle(.white.opacity(0.6)).listRowBackground(Color.clear)
                            } else if searching.contains(source) && results[source] == nil {
                                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                            } else if results[source]?.isEmpty == true {
                                Text("Ничего не найдено").foregroundStyle(.white.opacity(0.6)).listRowBackground(Color.clear)
                            }
                            ForEach(results[source] ?? []) { t in publicRow(t, source: source) }
                        }
                    }
                }
                if store.ui.wave.yandex {
                    Button { store.go("/yandex?" + Self.form(["q": trimmed, "type": "all"])) } label: {
                        Label("Искать в Яндекс Музыке", systemImage: "arrow.up.right.square").frame(minHeight: 44)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Исполнитель, трек или ссылка")
            .autocorrectionDisabled()
            .navigationTitle("Поиск")
            .task(id: trimmed) { await search(trimmed) }
        }
    }

    private func publicRow(_ t: NativeTrack, source: String) -> some View {
        Button { store.run("publicPlay", ["source": source, "id": t.id]) } label: {
            HStack(spacing: 12) {
                NativeCover(url: t.cover, size: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title).font(.body.weight(.medium)).lineLimit(1)
                    Text(t.artist).font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(NativePlayerTime.text(t.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.white.opacity(0.5))
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
            .opacity(t.ok ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!t.ok)
        .listRowBackground(Color.clear)
        .accessibilityLabel("\(t.title), \(t.artist)")
        .accessibilityHint(t.ok ? "Играть" : "Недоступно")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { store.run("publicQueue", ["source": source, "id": t.id]) } label: { Label("В очередь", systemImage: "text.append") }
                .tint(.indigo)
        }
        .contextMenu {
            Button { store.run("publicPlay", ["source": source, "id": t.id]) } label: { Label("Играть", systemImage: "play") }
            Button { store.run("publicQueue", ["source": source, "id": t.id]) } label: { Label("Добавить в очередь", systemImage: "text.append") }
        }
        .accessibilityAction(named: "Добавить в очередь") { store.run("publicQueue", ["source": source, "id": t.id]) }
    }

    private static func form(_ items: [String: String]) -> String {
        var c = URLComponents()
        c.queryItems = items.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return c.percentEncodedQuery ?? ""
    }

    /// Debounced; a newer query cancels this task, and its late results are dropped.
    @MainActor private func search(_ q: String) async {
        results = [:]; errors = [:]; searching = []
        guard !q.isEmpty else { return }
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        searching = Set(Self.sources.map(\.0))
        await withTaskGroup(of: Void.self) { group in
            for (source, _) in Self.sources {
                group.addTask { @MainActor in
                    do {
                        let rows = try await store.call("search", ["source": source, "q": q]) as? [[String: Any]] ?? []
                        if !Task.isCancelled { results[source] = rows.compactMap(NativeTrack.init) }
                    } catch {
                        if !Task.isCancelled { errors[source] = "Поиск недоступен: \(Self.message(error))" }
                    }
                    searching.remove(source)
                }
            }
        }
    }

    private static func message(_ error: Error) -> String {
        (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
    }
}

// MARK: «Ещё»

/// Grouped list of the app's other sections; they stay web pages.
struct NativeMoreView: View {
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        NavigationStack {
            List {
                Section("Музыка") {
                    link("/wave", "Моя волна", "Бесконечный поток под ваше настроение", "waveform")
                    link("/history", "История", "Что звучало и как сменялись треки", "clock.arrow.circlepath")
                    link("/downloads", "Загрузки", "Музыка на этом iPhone", "arrow.down.circle")
                    link("/import", "Импорт", "Плейлисты из Spotify, Apple Music, YouTube", "square.and.arrow.down")
                }
                if !store.playlists.isEmpty {
                    Section("Плейлисты") {
                        ForEach(store.playlists) { p in link("/playlist/\(p.id)", p.name, NativeText.tracks(p.count), "music.note.list") }
                    }
                }
                Section("Приложение") {
                    link("/sources", "Источники музыки", "Файлы, серверы и Яндекс Музыка", "powerplug")
                    link("/settings", "Настройки", "Переходы, громкость и офлайн", "gearshape")
                    link("/diagnostics", "Диагностика AutoMix", "Всё ли в порядке со звуком и переходами", "waveform.path.ecg")
                }
                Section {
                    Button { store.setShown(false) } label: {
                        Label("Перейти на веб-интерфейс", systemImage: "globe").frame(minHeight: 44)
                    }
                } footer: {
                    Text("Вернуть нативный интерфейс можно в «Ещё» веб-версии.\nMORA \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("Ещё")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.go("/") } label: { Label("Главная", systemImage: "chevron.backward") }
                        .accessibilityLabel("Назад, на главную")
                }
            }
        }
    }

    private func link(_ path: String, _ title: String, _ hint: String, _ symbol: String) -> some View {
        Button { store.go(path) } label: {
            HStack(spacing: 14) {
                Image(systemName: symbol).font(.body.weight(.semibold)).foregroundStyle(Color.moraMint).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.white)
                    Text(hint).font(.footnote).foregroundStyle(.white.opacity(0.55))
                }
                Spacer()
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(hint)
        .listRowBackground(Color.white.opacity(0.06))
    }
}
