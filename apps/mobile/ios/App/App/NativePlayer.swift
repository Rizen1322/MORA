import AVKit
import Combine
import MediaPlayer
import SwiftUI
import UIKit
import WebKit

/// iPhone full player over the WebView while NativeMixHost plays. It reads native state only,
/// so it keeps working while WebContent is suspended or reloading.
enum NativePlayerSheet {
    /// `finished` receives "close" or "more" («Ещё»: the page opens its own full player).
    static func present(host: NativeMixHost, from parent: UIViewController, finished: @escaping (String) -> Void) {
        let model = NativePlayerModel(host: host)
        let controller = UIHostingController(rootView: NativePlayerView(model: model))
        model.controller = controller
        model.onFinish = finished
        controller.modalPresentationStyle = .pageSheet
        controller.sheetPresentationController?.prefersGrabberVisible = true
        controller.overrideUserInterfaceStyle = .dark
        controller.view.backgroundColor = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
        parent.present(controller, animated: true)
    }
}

final class NativePlayerModel: ObservableObject {
    @Published var state = NativePlayerState()
    @Published private(set) var artwork: UIImage?
    @Published private(set) var artists: [NativeCatalogLink] = []
    @Published private(set) var albumPath: String?
    private var navigationTrack = ""
    /// The seek target from the moment the finger lifts until the host reports it.
    @Published var scrub: Double?
    @Published private(set) var reaction = 0
    @Published private(set) var modes = NativePlaybackModes()
    @Published private(set) var changingMode = false
    @Published var actionError: String?
    @Published private(set) var banner: String?
    /// When `state.position` was read: the scrubber runs the clock on from there between polls.
    private(set) var receivedAt = Date()
    weak var controller: UIViewController?
    var onFinish: ((String) -> Void)?
    private var action = "close"
    private let host: NativeMixHost
    private var timer: Timer?
    private var artworkKey = ""

    init(host: NativeMixHost) {
        self.host = host
        NativeShellStore.shared?.$ui.map(\.playback).removeDuplicates().assign(to: &$modes)
        NativeShellStore.shared?.$banner.assign(to: &$banner)
    }
    #if DEBUG
    var visualCheck = false
    func installVisualFixture() {
        visualCheck = true
        state = NativePlayerState(["active": true, "playing": true, "duration": 180.0, "position": 160.0,
            "entryId": "visual-a", "currentTrack": ["title": "MORA · Native Player", "artist": "Проверка интерфейса", "trackId": "visual-a"],
            "blend": ["index": 1, "progress": 0.4], "upcoming": [["entryId": "visual-b", "title": "Следующий трек", "artist": "Очередь AutoMix", "transition": ["method": "beatmatch_blend"]]]])
        modes = NativeShellStore.shared?.ui.playback ?? NativePlaybackModes()
        artists = [NativeCatalogLink(["id": "77", "title": "Native Artist", "path": "/catalog/artist/77"])!]
        albumPath = "/catalog/album/88"
        artwork = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 600)).image { ctx in
            UIColor(Color.moraMint).setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
            UIImage(systemName: "waveform", withConfiguration: UIImage.SymbolConfiguration(pointSize: 250))?.withTintColor(.black).draw(in: CGRect(x: 100, y: 170, width: 400, height: 260))
        }
    }
    #endif

    /// Polls only while the sheet is on screen and the app is in the foreground.
    func start() {
        #if DEBUG
        if visualCheck { return }
        #endif
        guard timer == nil else { return }
        refresh()
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
    func stop() { timer?.invalidate(); timer = nil }

    func refresh(then: (() -> Void)? = nil) {
        host.playerState { [weak self] result in
            defer { then?() }
            guard let self, case .success(let value) = result else { return }
            var next = NativePlayerState(value)
            // Show the requested queue immediately, while native resolves/copies its sources in batches.
            if let store = NativeShellStore.shared, let at = store.queue.firstIndex(where: { $0.entryId == next.entryId }) {
                let planned = Dictionary(next.upcoming.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                let known = Set(store.queue.dropFirst(at + 1).map(\.entryId))
                next.upcoming = store.queue.dropFirst(at + 1).compactMap { entry in
                    if let row = planned[entry.entryId] { return row }
                    guard let track = store.byId[entry.trackId] else { return nil }
                    return NativePlayerRow(id: entry.entryId, trackId: track.id, title: track.title, artist: track.artist, automix: false, cover: track.cover, artwork: nil)
                } + next.upcoming.filter { !known.contains($0.id) }
            }
            self.reaction = NativeShellStore.shared?.reaction(next.trackId) ?? 0
            if !next.active { self.stop(); self.close("close"); return }
            if next.entryId != self.state.entryId { self.scrub = nil }
            self.receivedAt = Date()
            if next != self.state { self.state = next }
            if next.trackId != self.navigationTrack { self.loadNavigation(next.trackId) }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                self.artwork = (value["artwork"] as? MPMediaItemArtwork)?.image(at: CGSize(width: 600, height: 600))
            }
        }
    }

    /// The same command path as the lock screen.
    private func send(_ action: String, time: Double? = nil, then: (() -> Void)? = nil) {
        // `then` runs once the post-command state is shown, so a seek target never flashes back to the old position.
        host.command(action, time: time, source: "player") { [weak self] _ in
            if let self { self.refresh(then: then) } else { then?() }
        }
    }
    func transport(_ action: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if action == "play" || action == "pause" { state.playing = action == "play" }
        send(action)
    }
    func seek(to time: Double) {
        scrub = time
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send("seekto", time: time) { [weak self] in
            if self?.scrub == time { self?.scrub = nil }
        }
    }

    func playbackMode(_ mode: String) {
        guard !changingMode, let store = NativeShellStore.shared else { return }
        changingMode = true
        UISelectionFeedbackGenerator().selectionChanged()
        Task { @MainActor in
            defer { changingMode = false }
            do { modes = NativePlaybackModes(try await store.call("playbackMode", ["mode": mode]) as? [String: Any] ?? [:]) }
            catch { actionError = error.localizedDescription }
        }
    }

    private func loadNavigation(_ id: String) {
        guard !id.isEmpty, let store = NativeShellStore.shared else { return }
        navigationTrack = id; artists = []; albumPath = nil
        Task { @MainActor in
            do {
                let value = try await store.call("trackLinks", ["id": id]) as? [String: Any]
                guard state.trackId == id else { return }
                artists = (value?["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
                albumPath = value?["album"] as? String
            } catch { if navigationTrack == id { navigationTrack = "" } }
        }
    }

    func navigate(_ path: String) {
        controller?.presentingViewController?.dismiss(animated: true) { NativeShellStore.shared?.go(path) }
    }

    func open(_ destination: String) {
        if destination == "album", let albumPath { navigate(albumPath); return }
        if destination == "artist", let artist = artists.first { navigate(artist.path); return }
        let id = state.trackId
        guard let store = NativeShellStore.shared else { return }
        Task { @MainActor in
            do {
                let value = try await store.call("trackLinks", ["id": id]) as? [String: Any]
                guard state.trackId == id else { return }
                let links = (value?["artists"] as? [[String: Any]] ?? []).compactMap(NativeCatalogLink.init)
                guard let path = destination == "album" ? value?["album"] as? String : links.first?.path else { throw NativeShellError.page }
                navigate(path)
            } catch { actionError = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription }
        }
    }

    func versions() {
        NativeShellStore.shared?.presentVersions(id: state.trackId, from: controller)
    }

    func react(_ value: Int) {
        guard let store = NativeShellStore.shared else { return }
        reaction = reaction == value ? 0 : value
        store.react(id: state.trackId, value: reaction)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func close(_ action: String) {
        self.action = action
        // From the presenter: dismissing this controller would only close the queue sheet above it.
        controller?.presentingViewController?.dismiss(animated: true)
    }
    /// Also reached by swipe-down, which dismisses without close().
    func finish() {
        stop()
        onFinish?(action); onFinish = nil
    }
}

extension Color {
    static let moraBackground = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)
    static let moraMint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
    static let moraGold = Color(red: 245 / 255, green: 200 / 255, blue: 110 / 255)
}

private struct IconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).contentTransition(.symbolEffect(.replace)).font(.title3.weight(.semibold))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }
}

private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = UIColor.white.withAlphaComponent(0.7)
        view.activeTintColor = UIColor(red: 74 / 255, green: 222 / 255, blue: 154 / 255, alpha: 1)
        view.prioritizesVideoDevices = false
        view.accessibilityLabel = "Устройство вывода"
        return view
    }
    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

struct NativePlayerView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var queueOpen = false
    @State private var showLyrics = false
    @Namespace private var playerLayout

    var body: some View {
        let s = model.state
        VStack(spacing: 0) {
            HStack {
                IconButton(symbol: "chevron.down", label: "Свернуть плеер") { model.close("close") }
                Spacer()
                Text("Сейчас играет").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                    .accessibilityHidden(true)
                Spacer()
                Menu {
                    Button("Другая версия", systemImage: "arrow.triangle.swap") { model.versions() }
                    Button("Перейти к исполнителю", systemImage: "music.mic") { model.open("artist") }
                    Button("Перейти к альбому", systemImage: "square.stack") { model.open("album") }.disabled(model.albumPath == nil)
                } label: {
                    Image(systemName: "ellipsis").font(.title3.weight(.semibold)).frame(width: 44, height: 44)
                }.accessibilityLabel("Действия с треком")
            }
            .padding(.horizontal, -10)
            Spacer(minLength: 12)
            if queueOpen {
                HStack(spacing: 12) {
                    NativeCover(url: nil, size: 64, radius: 10, image: model.artwork).matchedGeometryEffect(id: "cover", in: playerLayout)
                    metadata.matchedGeometryEffect(id: "metadata", in: playerLayout)
                }
                NativeQueueContent(model: model).frame(maxHeight: .infinity)
                    .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 16)))
            } else {
                cover(playing: s.playing).matchedGeometryEffect(id: "cover", in: playerLayout)
                Spacer(minLength: 16)
                metadata.matchedGeometryEffect(id: "metadata", in: playerLayout)
            }
            NativeScrubber(state: s, receivedAt: model.receivedAt, pending: model.scrub) { model.seek(to: $0) }
                .id(s.entryId).padding(.top, 18)
            transport(playing: s.playing).padding(.vertical, 12)
            Spacer(minLength: 8)
            NativeSystemVolume().frame(height: 32).padding(.top, 12)
            HStack {
                IconButton(symbol: "quote.bubble", label: "Текст песни") {
                    queueOpen = false; showLyrics.toggle()
                }.foregroundStyle(showLyrics ? Color.moraMint : .white.opacity(0.7))
                Spacer()
                RoutePicker().frame(width: 44, height: 44)
                Spacer()
                IconButton(symbol: "list.bullet", label: queueOpen ? "Показать обложку" : "Очередь") {
                    queueOpen.toggle()
                }.foregroundStyle(queueOpen ? Color.moraMint : .white.opacity(0.7))
            }
            .padding(.top, 10)
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .foregroundStyle(.white)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .background { backdrop.ignoresSafeArea() }
        .overlay(alignment: .top) {
            if let text = model.banner {
                Text(text).font(.footnote).padding(12).background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 58).padding(.horizontal, 20).allowsHitTesting(false)
                    .transition(.opacity).accessibilityHidden(true)
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.banner)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.48, dampingFraction: 0.86), value: queueOpen)
        .animation(.easeInOut(duration: 0.3), value: s.entryId)
        .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
        .alert("Не удалось выполнить действие", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(model.actionError ?? "") }
        .onAppear {
            model.start()
            #if DEBUG
            if model.visualCheck { Task { @MainActor in try? await Task.sleep(for: .seconds(4)); queueOpen = true } }
            #endif
        }
        .onDisappear { model.finish() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in model.stop() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in model.start() }

    }

    private var metadata: some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 4) {
                Button { model.open("album") } label: {
                    Text(model.state.title.isEmpty ? "MORA" : model.state.title).contentTransition(.opacity).font(.title2.bold()).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).disabled(model.albumPath == nil)
                    .accessibilityHint("Открыть альбом").accessibilityIdentifier("player.album")
                artistLine
            }.frame(maxWidth: .infinity, alignment: .leading)
            IconButton(symbol: model.reaction > 0 ? "heart.fill" : "heart", label: model.reaction > 0 ? "Убрать лайк" : "Нравится") { model.react(1) }
                .foregroundStyle(model.reaction > 0 ? Color.moraMint : .white)
                .accessibilityValue(model.reaction > 0 ? "Включено" : "Выключено")
            IconButton(symbol: model.reaction < 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown", label: "Не нравится") { model.react(-1) }
                .foregroundStyle(model.reaction < 0 ? Color.moraGold : .white.opacity(0.7))
                .accessibilityValue(model.reaction < 0 ? "Включено" : "Выключено")
        }
    }

    private var artistText: AttributedString {
        var value = AttributedString()
        for (index, artist) in model.artists.enumerated() {
            if index > 0 { value.append(AttributedString(", ")) }
            var part = AttributedString(artist.title)
            part.link = URL(string: "mora-native:" + artist.path)
            part.foregroundColor = Color.white.opacity(0.65)
            value.append(part)
        }
        return value
    }
    @ViewBuilder private var artistLine: some View {
        if model.artists.isEmpty {
            Button { model.open("artist") } label: { Text(model.state.artist).font(.title3).foregroundStyle(.white.opacity(0.65)).lineLimit(1) }.buttonStyle(.plain)
        } else {
            Text(artistText).font(.title3).lineLimit(1).contentTransition(.opacity)
                .environment(\.openURL, OpenURLAction { url in
                    guard url.scheme == "mora-native" else { return .discarded }
                    model.navigate(String(url.absoluteString.dropFirst("mora-native:".count)))
                    return .handled
                })
                .contextMenu { ForEach(model.artists) { artist in Button(artist.title) { model.navigate(artist.path) } } }
                .accessibilityIdentifier("player.artists")
        }
    }

    private var backdrop: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.10, green: 0.24, blue: 0.17), .moraBackground], startPoint: .top, endPoint: .bottom)
            if let image = model.artwork {
                Image(uiImage: image).resizable().scaledToFill().blur(radius: 60).opacity(0.35)
                    .id(model.state.entryId).transition(.opacity)
            }
        }
    }

    private func cover(playing: Bool) -> some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 430)
            .overlay {
                Group {
                        if showLyrics {
                            NativeLyricsView(model: model)
                        } else if let image = model.artwork {
                            Image(uiImage: image).resizable().scaledToFill().accessibilityHidden(true)
                        } else {
                            ZStack {
                                Color.moraMint.opacity(0.12)
                                Image(systemName: "music.note").font(.system(size: 64)).foregroundStyle(.white.opacity(0.4))
                            }
                            .accessibilityHidden(true)
                        }
                    }
                .id(showLyrics ? "lyrics" : model.state.entryId)
                .transition(.opacity)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.6), radius: playing ? 30 : 14, y: playing ? 20 : 10)
            .scaleEffect(showLyrics || playing || reduceMotion ? 1 : 0.84)
            .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.75), value: playing)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showLyrics)
            .layoutPriority(-1)
    }

    private func transport(playing: Bool) -> some View {
        HStack {
            Spacer()
            Button { model.transport("previoustrack") } label: {
                Image(systemName: "backward.fill").font(.system(size: 34)).frame(width: 64, height: 64)
            }
            .accessibilityLabel("Предыдущий")
            Spacer()
            Button { model.transport(playing ? "pause" : "play") } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill").contentTransition(.symbolEffect(.replace)).font(.system(size: 48, weight: .semibold))
                    .frame(width: 80, height: 80)
            }
            .accessibilityLabel(playing ? "Пауза" : "Играть")
            Spacer()
            Button { model.transport("nexttrack") } label: {
                Image(systemName: "forward.fill").font(.system(size: 34)).frame(width: 64, height: 64)
            }
            .accessibilityLabel("Следующий")
            Spacer()
        }
    }
}

private struct NativeLyrics {
    let status: String
    let plain: String
    let lines: [(time: Double, text: String)]
    let offset: Double

    init(_ value: [String: Any]) {
        status = value["status"] as? String ?? "none"
        plain = value["plain"] as? String ?? ""
        let raw = value["wordLines"] as? [[String: Any]] ?? value["lines"] as? [[String: Any]] ?? []
        lines = raw.compactMap { line in
            guard let time = (line["t"] as? NSNumber)?.doubleValue, let text = line["text"] as? String else { return nil }
            return (time, text)
        }
        offset = (value["offsetMs"] as? NSNumber)?.doubleValue ?? 0
    }
}

private struct NativeLyricsView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lyrics: NativeLyrics?
    @State private var failure: String?
    @State private var retry = 0

    var body: some View {
        let lines = lyrics?.lines ?? []
        let now = model.state.position + (lyrics?.offset ?? 0) / 1000
        let active = lines.lastIndex { $0.time <= now } ?? -1
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 16) {
                    if let failure {
                        Text(failure).foregroundStyle(.white.opacity(0.7))
                        Button("Повторить") { retry &+= 1 }.buttonStyle(.bordered)
                    } else if let lyrics {
                        if !lines.isEmpty {
                            ForEach(lines.indices, id: \.self) { index in
                                Button { model.seek(to: max(0, lines[index].time - lyrics.offset / 1000)) } label: {
                                    Text(lines[index].text.isEmpty ? "♪" : lines[index].text)
                                        .font(.body.weight(index == active ? .semibold : .regular))
                                        .foregroundStyle(index == active ? Color.moraMint : .white.opacity(0.58))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .id(index)
                            }
                        } else if lyrics.status == "plain" && !lyrics.plain.isEmpty {
                            Text(lyrics.plain).frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("Текст для этой песни не найден.")
                            Button("Поискать снова") { retry &+= 1 }.buttonStyle(.bordered)
                        }
                    } else {
                        ProgressView("Ищем текст…")
                    }
                }
                .padding(20)
                .padding(.bottom, 48)
            }
            .onChange(of: active) { _, index in
                if index >= 0 { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { proxy.scrollTo(index, anchor: .center) } }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.moraBackground)
        .task(id: "\(model.state.trackId)|\(retry)") { await load(model.state.trackId, refresh: retry > 0) }
    }

    @MainActor private func load(_ id: String, refresh: Bool) async {
        lyrics = nil; failure = nil
        guard !id.isEmpty else { failure = "Трек недоступен"; return }
        guard let webView = NativeShellStore.shared?.webView else { failure = "Медиатека ещё загружается"; return }
        do {
            let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any, Error>) in
                webView.callAsyncJavaScript("const response = await fetch('/api/tracks/' + encodeURIComponent(id) + '/lyrics' + (refresh ? '?refresh=1' : '')); if (!response.ok) throw new Error('HTTP ' + response.status); return await response.json()",
                                            arguments: ["id": id, "refresh": refresh], in: nil, in: .page) { continuation.resume(with: $0) }
            }
            guard !Task.isCancelled else { return }
            if let value = result as? [String: Any] { lyrics = NativeLyrics(value) }
            else { failure = "Не удалось прочитать текст" }
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}

private struct NativeQueueContent: View {
    @ObservedObject var model: NativePlayerModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                NativeQueueModes(model: model).padding(.top, 16)
                Text("Продолжение").font(.title2.bold())
                if let label = NativeShellStore.shared?.ui.now?.label, !label.isEmpty {
                    Text("Из: \(label)").font(.subheadline).foregroundStyle(.secondary)
                }
                if model.state.upcoming.isEmpty { Text("Очередь пуста").foregroundStyle(.secondary) }
                ForEach(model.state.upcoming) { row in
                    HStack(spacing: 12) {
                        NativeCover(url: row.cover ?? NativeShellStore.shared?.byId[row.trackId]?.cover, size: 48, radius: 7, embedded: row.artwork)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.title).font(.body.weight(.medium)).lineLimit(1)
                            Text(row.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            if let label = row.mixLabel {
                                Label(label, systemImage: "sparkles").font(.caption.weight(.medium)).foregroundStyle(Color.moraGold)
                            }
                        }
                        Spacer(minLength: 0)
                    }.accessibilityElement(children: .combine)
                        .transition(.opacity.combined(with: .offset(y: 10)))
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 16)
                .animation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.3), value: model.state.upcoming.map(\.id))
        }
    }
}


private struct NativeQueueModes: View {
    @ObservedObject var model: NativePlayerModel
    var body: some View {
        HStack(spacing: 10) {
            mode("shuffle", symbol: "shuffle", label: "Перемешать", on: model.modes.shuffle, disabled: !model.modes.canShuffle)
            mode("repeat", symbol: model.modes.repeatMode == "one" ? "repeat.1" : "repeat", label: model.modes.repeatLabel, on: model.modes.repeatMode != "off")
            mode("automix", symbol: "waveform", label: "AutoMix", on: model.modes.automix)
        }
        .disabled(model.changingMode)
        .animation(.easeInOut(duration: 0.2), value: model.modes)
    }
    private func mode(_ mode: String, symbol: String, label: String, on: Bool, disabled: Bool = false) -> some View {
        Button { model.playbackMode(mode) } label: {
            Group {
                if mode == "automix" {
                    HStack(spacing: -7) {
                        Circle().stroke(lineWidth: 2.5)
                        Circle().fill().overlay(Circle().fill(on ? Color.moraMint : Color.moraBackground).frame(width: 4, height: 4))
                    }.frame(width: 30, height: 19)
                } else { Image(systemName: symbol).font(.title3.weight(.semibold)).contentTransition(.symbolEffect(.replace)) }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(on ? Color.moraBackground : Color.white.opacity(0.65))
            .background(on ? Color.moraMint : Color.white.opacity(0.1), in: Capsule())
            .opacity(disabled ? 0.35 : 1)
        }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel(label).accessibilityValue(on ? "Включено" : "Выключено")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint(disabled ? "В волне порядок подбирается автоматически" : "Изменить режим воспроизведения")
        .accessibilityIdentifier("queue." + mode)
    }
}

private struct NativeSystemVolume: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView()
        view.showsRouteButton = false
        view.tintColor = UIColor.white.withAlphaComponent(0.65)
        view.accessibilityLabel = "Громкость"
        return view
    }
    func updateUIView(_ view: MPVolumeView, context: Context) {}
}


private struct NativeScrubber: View {
    let state: NativePlayerState
    let receivedAt: Date
    let pending: Double?
    let seek: (Double) -> Void
    @GestureState private var drag: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let duration = max(state.duration, 1)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !state.playing || drag != nil || pending != nil)) { context in
            let live = min(state.duration, state.position + (state.playing ? max(0, context.date.timeIntervalSince(receivedAt)) : 0))
            let shown = drag ?? pending ?? live
            VStack(spacing: 6) {
                GeometryReader { geo in
                    let width = geo.size.width
                    let x = width * min(1, max(0, shown / duration))
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.18)).frame(height: drag == nil ? 6 : 10)
                        Capsule().fill(.white.opacity(state.blending ? 0.95 : 0.65))
                            .frame(width: x, height: drag == nil ? 6 : 10)
                            .shadow(color: .white.opacity(state.blending ? 0.65 : 0), radius: 5)
                        if drag != nil {
                            Circle().fill(.white).frame(width: 20, height: 20).offset(x: x - 10)
                        }
                    }
                    .frame(width: width, height: 44)
                    .contentShape(Rectangle())
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: drag == nil)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: state.blending)
                    // GestureState resets when the sheet's own pan cancels the drag; a @State value stayed stuck there.
                    .gesture(DragGesture(minimumDistance: 4)
                        .updating($drag) { g, value, _ in
                            guard state.duration > 0 else { return }
                            if value == nil { UISelectionFeedbackGenerator().selectionChanged() }
                            value = min(state.duration, max(0, g.location.x / width * state.duration))
                        }
                        .onEnded { g in
                            guard state.duration > 0 else { return }
                            seek(min(state.duration, max(0, g.location.x / width * state.duration)))
                        })
                }
                .frame(height: 44)
                HStack {
                    Text(NativePlayerTime.text(shown))
                    Spacer()
                    if state.blending {
                        Text("Микширование").font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(reduceMotion || !state.playing ? 0.8 : 0.65 + 0.35 * sin(context.date.timeIntervalSinceReferenceDate * 3)))
                            .shadow(color: .white.opacity(0.25), radius: 3)
                            .transition(.opacity)
                        Spacer()
                    }
                    Text("−" + NativePlayerTime.text(max(0, state.duration - shown)))
                }
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(.white.opacity(0.55))
                .accessibilityHidden(true)
            }
            .accessibilityElement()
            .accessibilityLabel("Позиция")
            .accessibilityValue("\(NativePlayerTime.text(shown)) из \(NativePlayerTime.text(state.duration))" + (state.mixStart.map { ", AutoMix с \(NativePlayerTime.text($0))" } ?? ""))
            .accessibilityAdjustableAction { direction in
                guard state.duration > 0 else { return }
                seek(min(state.duration, max(0, shown + (direction == .increment ? 10 : -10))))
            }
        }
        .disabled(state.duration <= 0)
    }
}
