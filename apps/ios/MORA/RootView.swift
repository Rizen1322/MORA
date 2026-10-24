import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @ObservedObject var library: LocalLibrary
    let player: NativePlayer
    @State private var selection = 0
    @State private var likedOnly = false
    @State private var importing = false
    @State private var expanded = false
    @Environment(\.scenePhase) private var phase

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                home.navigationTitle("MORA").navigationBarTitleDisplayMode(.inline)
                    .toolbar { importButton }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { miniPlayer }
            .tabItem { Label("Главная", systemImage: "house.fill") }.tag(0)

            NavigationStack {
                LibraryView(library: library, player: player, likedOnly: $likedOnly, searching: false, addFiles: { importing = true })
                    .navigationTitle("Медиатека").toolbar { importButton }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { miniPlayer }
            .tabItem { Label("Медиатека", systemImage: "square.stack.fill") }.tag(1)

            NavigationStack {
                LibraryView(library: library, player: player, likedOnly: .constant(false), searching: true, addFiles: { importing = true })
                    .navigationTitle("Поиск").toolbar { importButton }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { miniPlayer }
            .tabItem { Label("Поиск", systemImage: "magnifyingglass") }.tag(2)
        }
        .tint(MORAStyle.accent)
        .toolbarBackground(MORAStyle.background, for: .tabBar, .navigationBar)
        .toolbarBackground(.visible, for: .tabBar)
        .task { player.restore(from: library) }
        .onChange(of: phase) { _, phase in if phase != .active { player.checkpoint() } }
        .sheet(isPresented: $expanded) {
            PlayerView(library: library, player: player).presentationDragIndicator(.visible)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await library.importFiles(urls) }
            case .failure(let error): library.error = error.localizedDescription
            }
        }
        .modifier(PlaybackErrorAlert(library: library, player: player))
    }

    private var miniPlayer: some View {
        MiniPlayer(library: library, player: player) { expanded = true }
    }

    @ToolbarContentBuilder private var importButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { importing = true } label: {
                if library.importing { ProgressView() } else { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
            }.disabled(library.importing).accessibilityLabel("Добавить аудиофайлы")
        }
    }

    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(spacing: 18) {
                    Label("В твоём ритме", systemImage: "waveform").font(.subheadline.weight(.semibold)).foregroundStyle(MORAStyle.accent)
                    (Text("Твоя музыка") + Text(".").foregroundColor(MORAStyle.accent))
                        .font(.system(.largeTitle, design: .rounded, weight: .black))
                    Text("Любимые треки рядом.\nДаже без интернета.")
                        .font(.subheadline).foregroundStyle(MORAStyle.secondary).multilineTextAlignment(.center)
                    Button {
                        if library.tracks.isEmpty { importing = true }
                        else {
                            let tracks = library.tracks.shuffled()
                            if let first = tracks.first { player.play(first, from: tracks, library: library) }
                        }
                    } label: {
                        Label(library.tracks.isEmpty ? "Добавить музыку" : "Перемешать", systemImage: library.tracks.isEmpty ? "plus" : "shuffle")
                            .font(.headline).frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 18))
                    .foregroundStyle(MORAStyle.onAccent).disabled(library.importing && library.tracks.isEmpty)
                }
                .padding(28).padding(.vertical, 16).frame(maxWidth: .infinity)
                .background {
                    ZStack {
                        MORAStyle.surface
                        LinearGradient(colors: [MORAStyle.accent.opacity(0.16), .clear], startPoint: .topTrailing, endPoint: .bottomLeading)
                        // Static rings keep the web identity without a continuously rendered sculpture.
                        ForEach(0..<4) { index in
                            Ellipse().stroke(MORAStyle.accent.opacity(0.07), lineWidth: 1)
                                .frame(width: 210 + CGFloat(index) * 32, height: 280 + CGFloat(index) * 24)
                                .rotationEffect(.degrees(32)).offset(x: 70, y: -28)
                        }
                    }.accessibilityHidden(true)
                }
                .clipShape(RoundedRectangle(cornerRadius: 28))
                .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(MORAStyle.line) }

                HStack(spacing: 12) {
                    collectionLink("Медиатека", symbol: "square.stack", liked: false)
                    collectionLink("Любимое", symbol: "heart", liked: true)
                }

                if library.importing {
                    HStack(spacing: 12) { ProgressView(); Text("Добавляем музыку…").font(.subheadline) }
                        .foregroundStyle(MORAStyle.secondary)
                }
                if !library.tracks.isEmpty {
                    HStack {
                        Text("Недавно добавлено").font(.title2.bold())
                        Spacer(minLength: 8)
                        Button("Все") { likedOnly = false; selection = 1 }.frame(minWidth: 44, minHeight: 44)
                    }
                    LazyVStack(spacing: 12) {
                        ForEach(Array(library.tracks.prefix(8))) { track in
                            TrackRow(track: track, library: library) { player.play(track, from: library.tracks, library: library) }
                        }
                    }
                } else {
                    Label("Добавь файлы с iPhone или из iCloud Drive через +.", systemImage: "folder")
                        .font(.subheadline).foregroundStyle(MORAStyle.secondary)
                }
            }.padding(20).frame(maxWidth: 640).frame(maxWidth: .infinity)
        }.background(MORAStyle.background).foregroundStyle(MORAStyle.text)
    }

    private func collectionLink(_ title: String, symbol: String, liked: Bool) -> some View {
        Button { likedOnly = liked; selection = 1 } label: {
            Label(title, systemImage: symbol).font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 8)
                .background(MORAStyle.surface, in: RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain)
    }
}

// Observe playback here, so position ticks do not rebuild the home page and library.
private struct PlaybackErrorAlert: ViewModifier {
    @ObservedObject var library: LocalLibrary
    @ObservedObject var player: NativePlayer
    func body(content: Content) -> some View {
        content.alert("Не удалось завершить действие", isPresented: Binding(get: { library.error != nil || player.error != nil }, set: { if !$0 { library.error = nil; player.error = nil } })) {
            Button("Понятно", role: .cancel) { library.error = nil; player.error = nil }
        } message: { Text(library.error ?? player.error ?? "") }
    }
}
