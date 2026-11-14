import SwiftUI
import UIKit

extension NativeShellStore {
    /// true means handled, including no-op input; supported errors never retry through WebContent.
    @MainActor func executeLibraryAction(_ name: String, _ args: [String: Any] = [:]) async throws -> Bool {
        guard sharedLibrary else { return false }
        let action = name == "act" ? args["name"] as? String ?? "" : name
        let values = name == "act" ? args["args"] as? [String: Any] ?? [:] : args
        if action == "likeAll" {
            guard let ids = values["ids"] as? [String], !ids.isEmpty else { throw NativeLibraryActions.Failure(message: "Треки не найдены") }
            likeAll(ids)
            return true
        }
        guard NativeLibraryActions.supports(action) else { return false }
        let result: NativeLibraryActions.Result
        do {
            guard let handled = try await NativeLibraryActions.execute(action, values, request: { method, path, body in
                try await NativeServerApp.request(method, path, body: body)
            }) else { return false }
            result = handled
        } catch {
            refreshLibrary()
            throw error
        }
        if result.mutated {
            do { try await refreshLibraryAfterMutation() }
            catch {
                show("Изменения сохранены. Не удалось обновить медиатеку: \(error.localizedDescription)")
                return true
            }
        }
        if let export = result.export { try await shareLibraryExport(export) }
        if let go = result.go { self.go(go) }
        if let message = result.message { show(message) }
        return true
    }

    @MainActor private func shareLibraryExport(_ export: NativeLibraryActions.Export) async throws {
        guard var parent = presenter else { throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт") }
        while let presented = parent.presentedViewController { parent = presented }
        guard parent.view.window != nil, !parent.isBeingDismissed, !parent.isBeingPresented else {
            throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт. Повторите после закрытия окна.")
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MORA-playlist-\(UUID().uuidString)", isDirectory: true)
        let url = folder.appendingPathComponent(export.name)
        try await Task.detached(priority: .utility) {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            do { try export.text.write(to: url, atomically: true, encoding: .utf8) }
            catch { try? FileManager.default.removeItem(at: folder); throw error }
        }.value
        guard parent.view.window != nil, parent.presentedViewController == nil, !parent.isBeingDismissed, !parent.isBeingPresented else {
            try? FileManager.default.removeItem(at: folder)
            throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт. Повторите после закрытия окна.")
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        sheet.popoverPresentationController?.sourceView = parent.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: parent.view.bounds.midX, y: parent.view.bounds.midY, width: 1, height: 1)
        parent.present(sheet, animated: true)
    }
}

/// SwiftUI screens of the shell; navigation still uses the page's router.

/// A white symbol on a tinted rounded square, as in iOS Settings; the tint follows the symbol so rows stay stable.
struct NativeIconBadge: View {
    let symbol: String
    var size: CGFloat = 30
    private static let palette: [Color] = [Color(red: 0.10, green: 0.52, blue: 0.36), .blue, .indigo, .orange, .pink, .teal, .purple]

    var body: some View {
        let sum: Int = symbol.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        let tint = Self.palette[sum % Self.palette.count]
        Image(systemName: symbol).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: Home

struct NativeHomeView: View {
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    NativeWaveHero(wave: store.ui.wave)
                    stations
                    tiles
                    if store.ui.loaded && store.library.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Добавьте свою музыку").font(.title3.bold())
                            Text("Импортируйте файлы или плейлист, либо найдите музыку в поиске.").foregroundStyle(.white.opacity(0.65))
                            Button("Импорт") { store.go("/import") }.buttonStyle(.borderedProminent).tint(.moraMint).frame(minHeight: 44)
                        }
                        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
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

    @ViewBuilder private var stations: some View {
        let items = NativeArtistStation.build(Array(store.byId.values))
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Станции для вас").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(items) { station in
                            Button { store.run("artistRadio", ["artist": station.artist]) } label: {
                                VStack(alignment: .leading, spacing: 7) {
                                    ZStack(alignment: .bottomLeading) {
                                        RoundedRectangle(cornerRadius: 18).fill(Color.indigo.gradient)
                                        NativeCover(url: station.cover, size: 128, radius: 64).padding(22)
                                        Image(systemName: "waveform").font(.title2.bold()).padding(12)
                                    }
                                    .frame(width: 172, height: 172)
                                    Text(station.artist + " и похожие").font(.subheadline.weight(.semibold)).lineLimit(2)
                                    Text("Радиостанция").font(.caption).foregroundStyle(.white.opacity(0.6))
                                }
                                .frame(width: 172, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .disabled(store.offline || store.ui.wave.loading)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint(store.offline ? "Для станции нужен интернет" : "Слушать артиста и похожую музыку")
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    private var tiles: some View {
        let items: [(String, String, String, Bool, String?)] = [
            ("/liked", "Любимое", "heart.fill", false, store.liked.isEmpty ? nil : NativeText.tracks(store.liked.count)),
            ("/downloads", "Загрузки", "arrow.down.circle.fill", false, nil),
            ("/history", "История", "clock.arrow.circlepath", true, nil),
            ("/import", "Импорт", "square.and.arrow.down.fill", true, nil)]
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(items, id: \.0) { item in
                let tint = item.3 ? Color.moraGold : Color.moraMint
                Button { store.go(item.0) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: item.2).font(.body.weight(.semibold))
                            .foregroundStyle(tint)
                            .frame(width: 38, height: 38)
                            .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.1).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            if let detail = item.4 { Text(detail).font(.caption).foregroundStyle(.white.opacity(0.55)).lineLimit(1) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
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
                    Button { store.go(all) } label: {
                        HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Показать все: " + title)
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

    var body: some View {
        let selected = store.waveSource.flatMap { wave.sources.contains($0) ? $0 : nil } ?? wave.preferred
        let button = wave.button(selected)
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Label(wave.active != nil ? "Сейчас в эфире" : "Для вас", systemImage: "waveform")
                    .font(.caption.weight(.bold)).foregroundStyle(Color.moraMint)
                (Text("Моя волна") + Text(".").foregroundColor(.moraMint)).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text("Знакомое, любимое и то, что ещё предстоит открыть.").font(.subheadline).foregroundStyle(.white.opacity(0.7))
            }
            Picker("Источник волны", selection: Binding(get: { selected }, set: { store.waveSource = $0 })) {
                ForEach(wave.sources, id: \.self) { s in
                    Text(s == .own ? "Коллекция" : s == .online ? "Радио" : "Яндекс").tag(s)
                }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 10) {
                Button { store.run("wave", ["source": selected.rawValue]) } label: {
                    Label(button.title, systemImage: button.symbol).font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .foregroundStyle(Color.moraBackground)
                        .background(Color.moraMint.opacity(button.enabled ? 1 : 0.4), in: Capsule())
                }
                .disabled(!button.enabled)
                Button { store.waveSource = selected; store.go("/wave") } label: {
                    Image(systemName: "slider.horizontal.3").font(.headline).frame(width: 54, height: 54)
                        .background(.white.opacity(0.1), in: Circle())
                }
                .accessibilityLabel("Настроить волну").accessibilityIdentifier("wave.settings")
            }
            if let error = wave.error, !error.isEmpty {
                Text(error).font(.footnote).foregroundStyle(Color(red: 1, green: 0.55, blue: 0.5))
            }
        }
        .padding(20)
        .background {
            let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
            ZStack(alignment: .topTrailing) {
                shape.fill(LinearGradient(colors: [Color(red: 0.10, green: 0.30, blue: 0.21), Color(red: 0.04, green: 0.11, blue: 0.08)],
                                          startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "waveform").font(.system(size: 130, weight: .ultraLight))
                    .foregroundStyle(Color.moraMint.opacity(0.10)).offset(x: 28, y: -6).accessibilityHidden(true)
            }
            .clipShape(shape)
            .overlay(shape.stroke(Color.moraMint.opacity(0.18)))
        }
        .onChange(of: wave.active) { _, active in if active != nil { store.waveSource = nil } } // follow what plays now
    }
}

// MARK: Library and liked tracks

struct NativeTrackListView: View {
    let title: String
    let type: String
    let tracks: [NativeTrack]
    @EnvironmentObject private var store: NativeShellStore
    @State private var query = ""
    /// Non-nil while choosing tracks: rows toggle instead of playing and a bar of bulk actions shows.
    @State private var selection: Set<String>?
    @State private var confirmDelete = false

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
                    if query.isEmpty && selection == nil {
                        HStack(spacing: 10) {
                            playButton("Слушать", "play.fill", prominent: true) { store.play(shown, at: 0, type: type, label: title) }
                            playButton("Вперемешку", "shuffle", prominent: false) { store.play(shown.shuffled(), at: 0, type: type, label: title) }
                        }
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    Section {
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                            if let selection {
                                NativeTrackRow(track: t, play: { self.selection = selection.symmetricDifference([t.id]) }, selected: selection.contains(t.id))
                            } else {
                                NativeTrackRow(track: t) { store.play(shown, at: i, type: type, label: title) }
                            }
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
            .navigationTitle(selection.map { $0.isEmpty ? "Выберите треки" : NativeText.tracks($0.count) } ?? title)
            .navigationBarTitleDisplayMode(selection == nil ? .automatic : .inline)
            .safeAreaInset(edge: .bottom) { if let selection { bulkBar(shown.filter { selection.contains($0.id) }) } }
            .confirmationDialog("Удалить из медиатеки?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Удалить: " + NativeText.tracks(selection?.count ?? 0), role: .destructive) {
                    bulk("deleteTracks", shown.filter { selection?.contains($0.id) == true })
                }
            } message: { Text("Скачанные копии и файлы в папке приложения тоже удалятся. Исходные файлы на устройстве не затрагиваются.") }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !shown.isEmpty || selection != nil {
                        Button(selection == nil ? "Выбрать" : "Готово") { selection = selection == nil ? [] : nil }
                            .frame(minHeight: 44)
                    }
                }
                if let selection {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(selection.count == shown.count ? "Снять все" : "Все") {
                            self.selection = selection.count == shown.count ? [] : Set(shown.map(\.id))
                        }.frame(minHeight: 44)
                    }
                } else if type == "liked" && !tracks.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { store.run("act", ["name": "downloadTracks", "args": ["ids": tracks.map(\.id)]]) } label: {
                            Image(systemName: "arrow.down.circle").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Скачать всё любимое на iPhone")
                    }
                }
                if type == "library" && selection == nil {
                    ToolbarItem(placement: .topBarTrailing) {
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

    private func playButton(_ title: String, _ symbol: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.headline)
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(prominent ? Color.moraBackground : Color.moraMint)
                .background(prominent ? Color.moraMint : Color.moraMint.opacity(0.15), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func bulkBar(_ chosen: [NativeTrack]) -> some View {
        let playable = chosen.filter(\.ok)
        return HStack(spacing: 4) {
            bulkButton("Следующим", "text.line.first.and.arrowtriangle.forward", disabled: playable.isEmpty) {
                store.run("queue", ["ids": playable.map(\.id), "next": true]); selection = nil
            }
            bulkButton("В очередь", "text.append", disabled: playable.isEmpty) {
                store.run("queue", ["ids": playable.map(\.id), "next": false]); selection = nil
            }
            bulkButton("В плейлист", "text.badge.plus", disabled: chosen.isEmpty) { store.playlistTarget = chosen; selection = nil }
            bulkButton("Скачать", "arrow.down.circle", disabled: chosen.isEmpty) { bulk("downloadTracks", chosen) }
            bulkButton("Удалить", "trash", disabled: chosen.isEmpty) { confirmDelete = true }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .moraGlass(Capsule())
        .padding(.horizontal, 12).padding(.bottom, 8)
    }

    private func bulkButton(_ title: String, _ symbol: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.body.weight(.semibold))
                Text(title).font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    private func bulk(_ action: String, _ chosen: [NativeTrack]) {
        guard !chosen.isEmpty else { return }
        store.run("act", ["name": action, "args": ["ids": chosen.map(\.id)]])
        selection = nil
    }
}

struct NativeTrackRow: View {
    let track: NativeTrack
    let play: () -> Void
    /// A page's own action for the row (remove from a playlist, delete a download).
    var remove: (title: String, symbol: String, run: () -> Void)? = nil
    /// Set while the list is choosing tracks: a tap toggles this row.
    var selected: Bool? = nil
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        Button(action: play) {
            HStack(spacing: 12) {
                if let selected {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.title3)
                        .foregroundStyle(selected ? Color.moraMint : .white.opacity(0.4))
                        .accessibilityHidden(true)
                }
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
            .opacity(track.ok || selected != nil ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!track.ok && selected == nil)
        .listRowBackground(Color.clear)
        .accessibilityLabel("\(track.title), \(track.artist)\(track.liked ? ", в любимом" : "")")
        .accessibilityValue(NativePlayerTime.text(track.duration))
        .accessibilityHint(selected != nil ? "Выбрать" : track.ok ? "Играть" : "Файл недоступен")
        .accessibilityAddTraits(selected == true ? .isSelected : [])
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
        .contextMenu {
            NativeTrackActions(track: track, play: play)
            if let remove {
                Divider()
                Button(role: .destructive, action: remove.run) { Label(remove.title, systemImage: remove.symbol) }
            }
        }
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
        Button { store.playlistTarget = [track] } label: { Label("Добавить в плейлист", systemImage: "text.badge.plus") }
        Divider()
        Button { store.react(track, track.liked ? 0 : 1) } label: {
            Label(track.liked ? "Убрать из любимого" : "Нравится", systemImage: track.liked ? "heart.slash" : "heart")
        }
        Button { store.react(track, track.reaction < 0 ? 0 : -1) } label: {
            Label(track.reaction < 0 ? "Убрать «Не нравится»" : "Не нравится", systemImage: "hand.thumbsdown")
        }
        Divider()
        if let url = URL(string: "mora://track/" + track.id) { ShareLink(item: url) { Label("Поделиться треком", systemImage: "square.and.arrow.up") } }
        // The page's version picker takes over the screen (lib/native-ui.ts `versions`); the shell steps aside.
        Button { store.run("versions", ["id": track.id]) } label: { Label("Заменить трек", systemImage: "arrow.triangle.swap") }
        Button { store.go("/track-edit/\(track.id)") } label: { Label("Сведения о треке", systemImage: "pencil") }
        if !track.album.isEmpty {
            Button { store.run("open", ["id": track.id, "to": "album"]) } label: { Label("Перейти к альбому", systemImage: "square.stack") }
        }
        Button { store.run("open", ["id": track.id, "to": "artist"]) } label: { Label("Перейти к исполнителю", systemImage: "music.mic") }
    }
}

/// «Добавить в плейлист» from the track menu: an existing playlist or a new one, without leaving the screen.
struct NativePlaylistPicker: View {
    let tracks: [NativeTrack]
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var name = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { name = ""; creating = true } label: { Label("Новый плейлист", systemImage: "plus") }
                        .accessibilityIdentifier("playlist.new")
                } footer: {
                    Text(subject)
                }
                Section("Мои плейлисты") {
                    if store.playlists.isEmpty {
                        Text("Плейлистов пока нет — создайте первый.").foregroundStyle(.white.opacity(0.6))
                    }
                    ForEach(store.playlists) { playlist in
                        Button { add(to: playlist.id) } label: {
                            HStack(spacing: 12) {
                                NativeCover(url: playlist.cover, size: 36, radius: 6)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(playlist.name).lineLimit(1)
                                    Text(NativeText.tracks(playlist.count)).font(.caption).foregroundStyle(.white.opacity(0.55))
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "plus.circle.fill").foregroundStyle(Color.moraMint)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Добавить в «\(playlist.name)»")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("В плейлист")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
            .alert("Новый плейлист", isPresented: $creating) {
                TextField("Название", text: $name)
                Button("Создать") { create() }
                Button("Отмена", role: .cancel) { name = "" }
            } message: { Text(subject + " — в новый плейлист.") }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .tint(.moraMint)
        .preferredColorScheme(.dark)
    }

    private var subject: String { tracks.count == 1 ? "«\(tracks[0].title)» — \(tracks[0].artist)" : NativeText.tracks(tracks.count) }

    private func add(to playlistId: String) {
        store.run("addToPlaylist", ["ids": tracks.map(\.id), "playlistId": playlistId])
        dismiss()
    }

    private func create() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        store.run("addToPlaylist", ["ids": tracks.map(\.id), "name": value])
        dismiss()
    }
}

// MARK: Search

/// Catalog search: the collection, YouTube Music and SoundCloud (the web /search page, without its extras).
struct NativeSearchView: View {
    private static let publicSources = ["ytmusic", "youtube", "soundcloud"]
    @EnvironmentObject private var store: NativeShellStore
    @State private var results: [String: NativeSearchResults] = [:]
    @State private var errors: [String: String] = [:]
    @State private var searching: Set<String> = []
    @State private var recent = UserDefaults.standard.stringArray(forKey: "mora.nativeSearchRecent") ?? []
    @State private var busy = false
    @State private var failure: String?
    private var query: String { store.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var source: String { store.searchSource }
    private var scope: String { store.searchScope }
    private var key: String { query + "|" + source + "|" + scope }
    private var sources: [String] { source == "all" ? Self.publicSources + (store.ui.wave.yandex ? ["yandex"] : []) : source == "local" ? [] : [source] }
    private var local: [NativeTrack] { query.isEmpty ? [] : NativeSearchText.filter(store.library, query) }

    var body: some View {
        NavigationStack {
            List {
                filters
                if let title = store.ui.preparing {
                    HStack {
                        ProgressView()
                        Text("Подготавливаем «\(title)»…").font(.subheadline)
                        Spacer()
                        Button("Отмена") { store.run("searchCancel") }
                    }.listRowBackground(Color.clear)
                }
                if query.isEmpty { history }
                if source == "yandex" && !store.ui.wave.yandex {
                    ContentUnavailableView("Подключите Яндекс Музыку", systemImage: "music.note", description: Text("Войдите в аккаунт для поиска по каталогу."))
                    Button("Подключить") { store.go("/sources") }
                } else {
                    if !query.isEmpty && (source == "all" || source == "local") { localSection }
                    ForEach(sources, id: \.self) { value in
                        if !query.isEmpty || source == "yandex" { remoteSection(value) }
                    }
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(Color.moraBackground)
            .scrollDismissesKeyboard(.interactively)
            .searchable(text: $store.searchQuery, placement: .navigationBarDrawer(displayMode: .always), prompt: "Исполнитель, трек, альбом или ссылка")
            .autocorrectionDisabled().textInputAutocapitalization(.never).submitLabel(.search)
            .onSubmit(of: .search) { remember() }
            .navigationTitle(source == "yandex" ? "Яндекс Музыка" : "Поиск")
            .task(id: key) { await search() }
            .onChange(of: store.searchSource) { _, value in if value != "yandex" { store.searchScope = "all" } }
            .onChange(of: store.searchQuery) { _, value in if value.count > 200 { store.searchQuery = String(value.prefix(200)) } }
            .alert("Не удалось выполнить", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(failure ?? "") }
        }
    }
    private static func title(_ value: String) -> String {
        switch value {
        case "all": return "Все источники"
        case "local": return "Моя музыка"
        case "ytmusic": return "YouTube Music"
        case "youtube": return "YouTube"
        case "soundcloud": return "SoundCloud"
        default: return "Яндекс Музыка"
        }
    }
    private var filters: some View {
        Section {
            Picker("Где искать", selection: $store.searchSource) {
                ForEach(["all", "local"] + Self.publicSources + ["yandex"], id: \.self) { value in Text(Self.title(value)).tag(value) }
            }.accessibilityIdentifier("search.source")
            if source == "yandex" {
                Picker("Что искать", selection: $store.searchScope) {
                    Text("Всё").tag("all"); Text("Треки").tag("track"); Text("Артисты").tag("artist"); Text("Альбомы").tag("album")
                }.pickerStyle(.segmented).accessibilityIdentifier("search.scope")
            }
        }.listRowBackground(Color.clear)
    }
    @ViewBuilder private var history: some View {
        if recent.isEmpty && source != "yandex" {
            ContentUnavailableView("Найдите свою музыку", systemImage: "magnifyingglass", description: Text("Поиск по медиатеке, YouTube Music, YouTube, SoundCloud и Яндексу. Можно вставить ссылку на трек."))
                .listRowBackground(Color.clear)
        } else if !recent.isEmpty {
            Section {
                ForEach(recent, id: \.self) { text in
                    Button { store.searchQuery = text } label: { Label(text, systemImage: "clock").frame(minHeight: 36) }
                        .swipeActions { Button("Удалить", role: .destructive) { recent.removeAll { $0 == text }; saveRecent() } }
                }
            } header: {
                HStack { Text("Недавно искали"); Spacer(); Button("Очистить") { recent = []; saveRecent() } }
            }
        }
    }
    private var localSection: some View {
        let matches = local
        return Section("Моя музыка") {
            if matches.isEmpty { Text("Ничего не найдено").foregroundStyle(.secondary) }
            ForEach(Array(matches.prefix(source == "all" ? 4 : matches.count).enumerated()), id: \.element.id) { index, track in
                NativeTrackRow(track: track) { remember(); store.play(matches, at: index, type: "search", label: query) }
            }
            if source == "all" && matches.count > 4 { Button("Все треки медиатеки") { store.searchSource = "local" } }
        }
    }
    private func remoteSection(_ value: String) -> some View {
        Section(Self.title(value)) {
            if let error = errors[value] {
                Text(error).font(.footnote).foregroundStyle(.secondary)
                Button("Повторить") { retry(value) }
            }
            if searching.contains(value) { ProgressView("Ищем…").frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            if let found = results[value] {
                if found.isEmpty && !searching.contains(value) { Text("Ничего не найдено").foregroundStyle(.secondary) }
                ForEach(Array(found.artists.prefix(source == "all" ? 4 : found.artists.count))) { item in linkRow(item, symbol: "music.mic") }
                ForEach(Array(found.albums.prefix(source == "all" ? 4 : found.albums.count))) { item in linkRow(item, symbol: "square.stack") }
                ForEach(Array(found.tracks.prefix(source == "all" ? 6 : found.tracks.count))) { item in hitRow(item, source: value, session: found.session) }
                if source == "all" && (!found.artists.isEmpty || !found.albums.isEmpty || found.tracks.count > 6) {
                    Button("Все результаты · " + Self.title(value)) { store.searchSource = value }
                } else if source == "yandex" && found.more {
                    Button("Показать ещё") { retry(value, more: true) }.disabled(searching.contains(value))
                }
            }
        }
    }
    private func linkRow(_ item: NativeCatalogLink, symbol: String) -> some View {
        Button { remember(); store.go(item.path) } label: {
            HStack(spacing: 12) {
                NativeCover(url: item.cover, size: 48, radius: symbol == "music.mic" ? 24 : 8)
                VStack(alignment: .leading, spacing: 3) { Text(item.title).fontWeight(.medium); Text(item.detail).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
            }.frame(minHeight: 56)
        }.buttonStyle(.plain).listRowBackground(Color.clear)
    }
    private func hitRow(_ hit: NativeSearchHit, source: String, session: String) -> some View {
        let track = hit.track
        return Button { act("play", track: track, source: source, session: session) } label: {
            HStack(spacing: 12) {
                NativeCover(url: track.cover, size: 48, radius: 8)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) { Text(track.title).font(.body.weight(.medium)).lineLimit(1); if hit.explicit { Text("E").font(.caption2.bold()).foregroundStyle(.secondary) } }
                    Text(track.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    if !hit.tags.isEmpty { Text(hit.tags).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if track.liked { Image(systemName: "heart.fill").font(.caption).foregroundStyle(Color.moraMint) }
                if hit.saved { Image(systemName: "checkmark").font(.caption).foregroundStyle(.secondary) }
                Text(NativePlayerTime.text(track.duration)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }.frame(minHeight: 56).contentShape(Rectangle()).opacity(track.ok ? 1 : 0.45)
        }
        .buttonStyle(.plain).disabled(!track.ok || busy).listRowBackground(Color.clear)
        .contextMenu {
            actionButton("Играть следующим", "text.line.first.and.arrowtriangle.forward", "next", track, source, session)
            actionButton("В очередь", "text.append", "queue", track, source, session)
            actionButton(track.liked ? "Убрать лайк" : "Нравится", "heart", "like", track, source, session)
            actionButton(track.reaction < 0 ? "Убрать дизлайк" : "Не нравится", "hand.thumbsdown", "dislike", track, source, session)
            if !hit.saved { actionButton("Сохранить в медиатеку", "plus", "save", track, source, session) }
            if !store.playlists.isEmpty {
                Menu("В плейлист", systemImage: "music.note.list") {
                    ForEach(store.playlists) { playlist in Button(playlist.name) { act("playlist", track: track, source: source, session: session, playlist: playlist.id) } }
                }
            }
            actionButton("Скачать", "arrow.down.circle", "download", track, source, session)
            actionButton("Другая версия", "arrow.triangle.swap", "versions", track, source, session)
            actionButton("Исполнитель", "music.mic", "artist", track, source, session)
            if !track.album.isEmpty { actionButton("Альбом", "square.stack", "album", track, source, session) }
            actionButton("Радио по треку", "dot.radiowaves.left.and.right", "radio", track, source, session)
        }
        .swipeActions(edge: .leading) { actionButton("Следующим", "text.line.first.and.arrowtriangle.forward", "next", track, source, session).tint(.moraMint) }
        .swipeActions(edge: .trailing) { actionButton(track.liked ? "Убрать лайк" : "Нравится", "heart", "like", track, source, session).tint(.moraGold) }
        .accessibilityLabel(track.title + ", " + track.artist)
    }
    private func actionButton(_ title: String, _ symbol: String, _ kind: String, _ track: NativeTrack, _ source: String, _ session: String) -> some View {
        Button { act(kind, track: track, source: source, session: session) } label: { Label(title, systemImage: symbol) }
    }
    private func act(_ kind: String, track: NativeTrack, source: String, session: String, playlist: String? = nil) {
        guard !busy else { return }
        remember(); busy = true
        let requested = key, origin = store.path
        Task { @MainActor in
            defer { busy = false }
            do {
                var args: [String: Any] = ["kind": kind, "id": track.id, "session": session]
                if let playlist { args["playlist"] = playlist }
                let value = try await store.call("searchAction", args, timeout: 180) as? [String: Any]
                guard key == requested, store.path == origin else { return }
                if let path = value?["go"] as? String { store.go(path) }
                if let id = value?["versions"] as? String { store.presentVersions(id: id) }
                if ["like", "dislike", "save", "playlist"].contains(kind) { await load(source, key: key) }
            } catch { failure = Self.message(error) }
        }
    }
    private func remember() {
        guard !query.isEmpty else { return }
        recent = [query] + Array(recent.filter { $0 != query }.prefix(11)); saveRecent()
    }
    private func saveRecent() { UserDefaults.standard.set(recent, forKey: "mora.nativeSearchRecent") }
    private func retry(_ source: String, more: Bool = false) { Task { @MainActor in await load(source, key: key, more: more) } }
    @MainActor private func search() async {
        results = [:]; errors = [:]; searching = []
        guard !query.isEmpty || source == "yandex", source != "local", source != "yandex" || store.ui.wave.yandex else { return }
        do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
        let requested = key
        await withTaskGroup(of: Void.self) { group in
            for source in sources { group.addTask { @MainActor in await load(source, key: requested) } }
        }
    }
    @MainActor private func load(_ source: String, key requested: String, more: Bool = false) async {
        guard key == requested, !searching.contains(source) else { return }
        searching.insert(source); errors[source] = nil
        defer { if key == requested && !Task.isCancelled { searching.remove(source) } }
        do {
            var args: [String: Any] = ["source": source, "q": query, "scope": source == "yandex" ? scope : "all", "more": more]
            if more { args["session"] = results[source]?.session }
            let value = try await store.call("search", args, timeout: 60)
            guard key == requested, !Task.isCancelled else { return }
            guard let found = NativeSearchResults(value) else { throw NativeShellError.page }
            results[source] = found
        } catch { if key == requested && !Task.isCancelled { errors[source] = Self.message(error) } }
    }
    private static func message(_ error: Error) -> String { (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription }
}

// MARK: «Ещё»

/// Grouped list of the app's other sections (native pages, NativePages.swift).
struct NativeMoreView: View {
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        NavigationStack {
            List {
                Section("Музыка") {
                    link("/wave", "Моя волна", "Бесконечный поток под ваше настроение", "waveform")
                    link("/history", "История", "Что звучало и как сменялись треки", "clock.arrow.circlepath")
                    link("/statistics", "Статистика", "Музыка за последние 30 дней", "chart.bar")
                    link("/duplicates", "Дубликаты", "Объединить одинаковые файлы", "square.on.square")
                    link("/smart-playlists", "Умные плейлисты", "Подборки по вашим правилам", "sparkles")
                    link("/downloads", "Загрузки", "Музыка на этом iPhone", "arrow.down.circle")
                    link("/import", "Импорт", "Плейлисты из Spotify, Apple Music, YouTube", "square.and.arrow.down")
                }
                if !store.playlists.isEmpty {
                    Section("Плейлисты") {
                        ForEach(store.playlists) { p in link("/playlist/\(p.id)", p.name, NativeText.tracks(p.count), "music.note.list") }
                    }
                }
                Section("Приложение") {
                    link("/sources", "Яндекс Музыка", "Аккаунт и синхронизация лайков", "person.crop.circle")
                    link("/settings", "Настройки", "Переходы, громкость и офлайн", "gearshape")
                    link("/sound", "Звук", "Эквалайзер и пресеты", "slider.vertical.3")
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
                NativeIconBadge(symbol: symbol)
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


struct NativeLibraryView: View {
    @EnvironmentObject private var store: NativeShellStore
    private var likedArtists: [NativeTrack] {
        var seen = Set<String>()
        return store.liked.filter { !$0.artist.isEmpty && seen.insert($0.artist).inserted }
            .sorted { $0.artist.localizedCaseInsensitiveCompare($1.artist) == .orderedAscending }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    destination("Любимое", "heart", "/liked")
                    destination("Плейлисты", "music.note.list", "/library/playlists")
                    destination("Артисты", "music.mic", "/library/artists")
                    destination("Альбомы", "square.stack", "/library/albums")
                    destination("Песни", "music.note", "/library/tracks")
                    destination("Загруженные", "arrow.down.circle", "/downloads")
                }
                if !store.liked.isEmpty {
                    Section("Артисты любимых треков") {
                        ForEach(likedArtists) { track in
                            Button { store.run("open", ["id": track.id, "to": "artist"]) } label: {
                                Label(track.artist, systemImage: "music.mic")
                            }.listRowBackground(Color.clear)
                        }
                    }
                }
                Section("Недавно добавлено") {
                    ForEach(Array(store.library.prefix(8).enumerated()), id: \.element.id) { index, track in
                        NativeTrackRow(track: track) { store.play(store.library, at: index, type: "library", label: "Медиатека") }
                    }
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .background(Color.moraBackground).navigationTitle("Медиатека")
        }
    }
    private func destination(_ title: String, _ symbol: String, _ path: String) -> some View {
        Button { store.go(path) } label: {
            HStack(spacing: 14) {
                NativeIconBadge(symbol: symbol, size: 34)
                Text(title).font(.title3).foregroundStyle(.white)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }.buttonStyle(.plain).listRowBackground(Color.clear)
    }
}
